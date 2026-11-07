#!/usr/bin/env bash
# 一次性的 MySQL → PostgreSQL 搬迁（九安 v0.7.10 测试台换库用，本机运行，经 SSH 在实例上执行）：
#   本机 build-jiuan.sh 构建当前的九安副本 → 连同工具 poc/bench/mysql-to-pg.mjs、它的依赖（poc/bench/node_modules：mysql2、pg）、
#   外壳（poc/app，不带测试）和 bench/pg-database.sh 打包，经 SSH 传到实例上只有自己能读的临时目录 /var/tmp/jiuan-migrate.*
#   → 实例上以 root：（--create-db）按 pg-database.sh 建目标库 → 用口令文件拼两边的地址（MySQL 用 root 读库 jiuan，PG 用 jiuan_app 连目标库），
#   只经环境变量交给工具（只核对时只读，以 PG 的超级用户连：那时 jiuan_app 可能还没建）→ 工具建表（--create-schema 九安副本、--shell 外壳）、在一个事务里搬、逐表核对 → 删掉临时目录。
#   MySQL 只读（一致的只读快照），服务照常跑也可以（演练）；正式搬到库 jiuan 时服务必须停着（快照之后的写入就不会丢），还在跑就停下。
# 用法：DEPLOY_ENV=poc/infra/env/<环境>.env bash poc/infra/migrate-mysql-to-pg.sh --target jiuan|jiuan_rehearsal [--create-db] [--dry-run] [--replace]
#       DEPLOY_ENV=… bash poc/infra/migrate-mysql-to-pg.sh --target jiuan_rehearsal --drop-db
#   --create-db  先建目标库（属主 jiuan_app、UTF8 / C、上海时区；已有就只核对）；和 --dry-run 一起时不建（只核对，库不在就报 PENDING）
#   --dry-run    只读两边、逐表报会搬多少行或是否一致，不写 PG
#   --replace    目标表不是空的也搬（同一个事务里先清空）
#   --drop-db    删掉演练库 jiuan_rehearsal（只认这个库，不和别的参数一起用）
# 输出工具的每表一行（TABLE …）、最后一行 MIGRATE_OK / MIGRATE_PENDING / MIGRATE_FAILED，再加 MIGRATE_SECONDS <用时>。不打印口令和数据内容。
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
TARGET="" DRY_RUN=false CREATE_DB=false DROP_DB=false REPLACE=false PRINT_REMOTE=false
bad() { echo "$1" >&2; exit 2; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) [[ $# -ge 2 ]] || bad "--target 要跟库名"; TARGET="$2"; shift 2 ;;
    --create-db) CREATE_DB=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --replace) REPLACE=true; shift ;;
    --drop-db) DROP_DB=true; shift ;;
    --print-remote) PRINT_REMOTE=true; shift ;;   # 只打印实例上要跑的脚本（占位的临时目录），不连任何东西（单元测试用）
    *) bad "不认识的参数：$1" ;;
  esac
done
[[ "$TARGET" == jiuan || "$TARGET" == jiuan_rehearsal ]] || bad "--target 只能是 jiuan 或 jiuan_rehearsal"
if $DROP_DB; then
  [[ "$TARGET" == jiuan_rehearsal ]] || bad "--drop-db 只删演练库 jiuan_rehearsal"
  ! $DRY_RUN && ! $CREATE_DB && ! $REPLACE || bad "--drop-db 不和 --dry-run、--create-db、--replace 一起用"
fi
! { $DRY_RUN && $REPLACE; } || bad "--dry-run 只读，不和 --replace 一起用"

# 实例上以 root 跑的部分：变量放最前面（remote_script 拼），下面是固定的
REMOTE_BODY="$(cat <<'SH'
set -euo pipefail
trap '[ -z "$d" ] || rm -rf "$d"' EXIT
if $DROP_DB; then
  docker exec -u postgres jiuan-pg psql -X -q -v ON_ERROR_STOP=1 -d postgres -c 'DROP DATABASE IF EXISTS jiuan_rehearsal WITH (FORCE)'
  echo "MIGRATE_DB_DROPPED jiuan_rehearsal"
  exit 0
fi
if [ "$TARGET" = jiuan ] && ! $DRY_RUN && systemctl is-active --quiet andon-jiuan.service; then
  echo "andon-jiuan 还在跑：正式搬到库 jiuan 之前要先停服务（systemctl stop andon-jiuan），免得快照之后的写入丢掉" >&2
  exit 3
fi
if $CREATE_DB; then
  if $DRY_RUN; then echo "dry-run：不建库 ${TARGET}"; else BENCH_SECRETS_FILE="$SECRETS" bash "$d/pg-database.sh" "$TARGET"; fi
fi
KEY=JIUAN_PG_APP_PASSWORD
mysql_pw="$(cat "$BENCH_DIR/mysql_root_password")"
if $DRY_RUN; then pg_user=postgres; pg_pw="$(cat "$BENCH_DIR/pg_superuser_password")"; else pg_user=jiuan_app; pg_pw="$(sed -n "s/^${KEY}=//p" "$SECRETS" | head -1)"; fi
[[ "$mysql_pw" =~ ^[0-9a-f]{32}$ && "$pg_pw" =~ ^[0-9a-f]{32}$ ]] || { echo "口令文件不对：mysql_root_password、pg_superuser_password 和 secrets.env 的 JIUAN_PG_APP_PASSWORD 应是 32 位十六进制" >&2; exit 1; }
export MIGRATE_MYSQL_URL="mysql://root:${mysql_pw}@127.0.0.1:3306/jiuan"
export MIGRATE_PG_URL="postgres://${pg_user}:${pg_pw}@127.0.0.1:5433/${TARGET}"
unset mysql_pw pg_pw
if $DRY_RUN; then args=(--dry-run); else args=(--create-schema "$d/jiuan" --shell "$d/shell"); fi
if $REPLACE; then args+=(--replace); fi
[ -x "$NODE" ] || NODE=node
started=$SECONDS
set +e
"$NODE" "$d/mysql-to-pg.mjs" "${args[@]}"
rc=$?
set -e
echo "MIGRATE_SECONDS $((SECONDS - started))"
exit "$rc"
SH
)"
# remote_script <实例上的临时目录（--drop-db 时为空）>
remote_script() {
  printf 'd=%q\nTARGET=%q\nDRY_RUN=%s\nCREATE_DB=%s\nDROP_DB=%s\nREPLACE=%s\nSECRETS=%q\nBENCH_DIR=%q\nNODE=%q\n%s\n' \
    "$1" "$TARGET" "$DRY_RUN" "$CREATE_DB" "$DROP_DB" "$REPLACE" /etc/andon-finance/secrets.env /etc/andon-finance/bench /usr/bin/node-24 "$REMOTE_BODY"
}
if $PRINT_REMOTE; then remote_script /var/tmp/jiuan-migrate.XXXXXX; exit 0; fi

source "$HERE/lib/deploy-env.sh"
load_deploy_env
source "$HERE/lib/remote.sh"
REGION="${AWS_REGION:-us-east-1}"
STACK="${STACK:-andon-finance-poc}"
output() { aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
[[ "$(remote_mode)" == ssh ]] || { echo "搬迁要经 SSH（环境配置写 SSH_KEY_FILE）" >&2; exit 2; }
ssh_check_key || exit 2
INSTANCE="$(output InstanceId)"
ssh_setup "$(output ElasticIp)" "$INSTANCE" || exit 1

remote_dir=""
if ! $DROP_DB; then
  local_work="$(mktemp -d)"; trap 'rm -rf "$local_work"' EXIT
  mkdir -p "$local_work/pkg"
  bash "$HERE/../bench/build-jiuan.sh" --out "$local_work/pkg/jiuan" >/dev/null
  rsync -a --exclude 'node_modules/' --exclude 'test/' --exclude '.DS_Store' "$HERE/../app/" "$local_work/pkg/shell/"
  rsync -a "$HERE/../bench/node_modules/" "$local_work/pkg/node_modules/"
  cp "$HERE/../bench/mysql-to-pg.mjs" "$local_work/pkg/"
  cp "$HERE/bench/pg-database.sh" "$local_work/pkg/"
  remote_dir="$(COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs -C "$local_work/pkg" -czf - . \
    | ssh "${SSH_OPTS[@]}" "$SSH_TARGET" 'd=$(mktemp -d /var/tmp/jiuan-migrate.XXXXXX) && chmod 0700 "$d" && tar -C "$d" -xzf - && echo "$d"')"
  [[ "$remote_dir" =~ ^/var/tmp/jiuan-migrate\.[A-Za-z0-9]+$ ]] || { echo "远端临时目录不对：$remote_dir" >&2; exit 1; }
fi
rc=0
out="$(remote_root "$(remote_script "$remote_dir")")" || rc=$?
printf '%s\n' "$out"
last="$(grep -E '^MIGRATE_(OK|PENDING|FAILED|DB_DROPPED)' <<< "$out" | tail -1 || true)"
[[ "$rc" == 0 && "$last" =~ ^(MIGRATE_OK|MIGRATE_PENDING|MIGRATE_DB_DROPPED) ]] || { echo "搬迁没有成功（${last:-没有结果行}）" >&2; exit 1; }
