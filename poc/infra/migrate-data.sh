#!/usr/bin/env bash
# 把测试台的数据从一个环境搬到另一个环境（换机器用）：
#   九安 v0.7.10 的库 jiuan（容器 jiuan-pg 里的 PostgreSQL：单据、AI 建议、复核、「Agent 接入」的启用记录……整库）、
#   知识库的 PG 库 nexus（规则、上传历史、检索日志、向量模型登记……整库）、
#   实例上的状态目录 /var/lib/jiuan（「我的规则」、上传暂存、种子单据的时间锚点、Nexus 登录）。
# 用法：
#   FROM_ENV=poc/infra/env/<旧环境>.env DEPLOY_ENV=poc/infra/env/<新环境>.env bash poc/infra/migrate-data.sh [--dry-run] [--skip-pg]
#   --dry-run  只读：两边核对一遍、列出要搬什么、新环境上要换掉什么，什么都不改
#   --skip-pg  知识库的 PG 库 nexus 不动（只搬九安的库和状态目录）。Nexus 的连接器已经切到新环境的知识库 PG 之后再同步，就要加它：那时新的才是在用的那份
# 旧环境经 SSM，只读（导出、打包、加密、上传；旧实例上的服务和库都不停、不改）。新环境经 SSH（它的配置要写 SSH_KEY_FILE）。
# 两边都要已经换成 PostgreSQL（2026-11 之后的构件）。新环境要先部署好（deploy.sh：容器 jiuan-pg 在、账号 jiuan_app 在）；
# 不加 --skip-pg 时还要先跑过知识库的 db 阶段（kb.sh db：容器 nexus-pgvector 在、装了 PL/Python）。
# 两边实例上的 /etc/andon-finance/secrets.env 要是同一份（同一个本机 secrets.env 部署的）：九安的库和 Agent 接入记录是用里面的密钥加密的，不同就停。
# 新环境上：停服务 → 删掉九安的库 jiuan、按原参数重建（bench/pg-database.sh）、pg_restore →（不加 --skip-pg 时）删掉知识库的库 nexus、从导出重建 →
#   换掉状态目录（顶层的点文件不动）→ 逐表数行数（知识库的规则表另比整表的 md5；起服务之前数）→ 起服务 → 等健康检查 → 和旧环境导出前一刻数的比，对不上就报错。
# 加密：旧实例上随机生成 AES-256 密钥加密整包，这个密钥用本机这次运行的一次性 RSA 公钥加密后回给本机（SSM 的命令历史里只有密文）。
#   整包经预签名 URL（15 分钟有效）放进新环境的构件桶 migration/ 下，新实例取下来校验 sha256、解密；搬完就删。
# 不打印任何密码、密钥和数据内容。
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
source "$HERE/lib/deploy-env.sh"
load_deploy_env
source "$HERE/lib/remote.sh"
REGION="${AWS_REGION:-us-east-1}"
STACK="${STACK:-andon-finance-poc}"
DRY_RUN=false; SKIP_PG=false; PRINT_SCRIPTS=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --skip-pg) SKIP_PG=true ;;
    --print-scripts) PRINT_SCRIPTS=true ;;
    *) echo "不认识的参数：${arg}（只有 --dry-run、--skip-pg）" >&2; exit 2 ;;
  esac
done
PG_FLAG="$($SKIP_PG && echo 0 || echo 1)"

# 两边都用的一段：逐表数行数（九安的库 jiuan 的 public 表、知识库的库 nexus 的 public 表、规则表整表的 md5、状态目录的文件数和字节数），
# 一行一项，tab 分隔。以 root 在实例上跑；知识库那段在 COUNT_PG=1 时才数
COUNTS="$(cat <<'SH'
jiuan_q() { docker exec -i -u postgres jiuan-pg psql -X -At -F "$(printf '\t')" -d "$1" -v ON_ERROR_STOP=1; }
if [ "$(echo "SELECT count(*) FROM pg_database WHERE datname = 'jiuan'" | jiuan_q postgres)" != 1 ]; then printf 'jiuan\tmissing\n'
else
  echo "SELECT format('SELECT %L, count(*) FROM %I.%I;', 'jiuan.' || tablename, schemaname, tablename) FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename" | jiuan_q jiuan | jiuan_q jiuan
fi
if [ "${COUNT_PG:-1}" = 1 ]; then
  pg_q() { docker exec -i nexus-pgvector psql -X -At -F "$(printf '\t')" -U postgres -d nexus -v ON_ERROR_STOP=1; }
  echo "SELECT format('SELECT %L, count(*) FROM %I.%I;', 'pg.' || tablename, schemaname, tablename) FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename" | pg_q | pg_q
  if [ "$(echo "SELECT to_regclass('public.approval_rules') IS NOT NULL" | pg_q)" = t ]; then
    echo "SELECT 'pg.approval_rules.md5', md5(string_agg(t::text, '|' ORDER BY t::text)) FROM approval_rules t" | pg_q
  fi
fi
for d in /var/lib/jiuan; do
  printf 'files.%s\t%s\t%s\n' "$d" "$(find "$d" -mindepth 1 -not -path '*/.*' -type f | wc -l)" "$(find "$d" -mindepth 1 -not -path '*/.*' -type f -printf '%s\n' | awk '{s+=$1} END {print s+0}')"
done
SH
)"

# 导出、导入的脚本：变量放最前面，再接固定的部分。一个 $(…) 里只放一个 heredoc（bash 5 在同一个 $(…) 里解析第二个 heredoc 会出错，2026-11-02 第一次实跑撞上过）
EXPORT_PRE="$(cat <<'SH'
set -euo pipefail
w="$(mktemp -d /var/tmp/andon-migrate.XXXXXX)"; trap 'rm -rf "$w"' EXIT; chmod 700 "$w"; mkdir "$w/b"
# 导出前紧接着数一遍（和导出隔得越近，旧环境上的新写入越不容易让核对对不上）
SH
)"
EXPORT_MAIN="$(cat <<'SH'
counts > "$w/counts.txt"
# 一致的快照：pg_dump 本身就在一个快照里
docker exec -u postgres jiuan-pg pg_dump -Fc jiuan > "$w/b/jiuan.pgdump"
$SKIP_PG || docker exec nexus-pgvector pg_dump -U postgres -Fc nexus > "$w/b/nexus.pgdump"
tar -C /var/lib -cf "$w/b/files.tar" --exclude 'jiuan/.*' jiuan
openssl rand -hex 32 > "$w/k"
tar -C "$w/b" -czf - . | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$w/k" -out "$w/bundle.bin"
curl -fsS -X PUT -T "$w/bundle.bin" "$PUT_URL"
printf '%s' "$PUB_B64" | base64 -d > "$w/pub.pem"
echo "BUNDLE_SHA256 $(sha256sum "$w/bundle.bin" | cut -c1-64)"
echo "BUNDLE_BYTES $(stat -c %s "$w/bundle.bin")"
echo "SEALED_KEY $(openssl pkeyutl -encrypt -pubin -inkey "$w/pub.pem" -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 -pkeyopt rsa_mgf1_md:sha256 -in "$w/k" | base64 | tr -d '\n')"
echo COUNTS_BEGIN
cat "$w/counts.txt"
SH
)"
IMPORT_MAIN="$(cat <<'SH'
set -euo pipefail
w="$(mktemp -d /var/tmp/andon-migrate.XXXXXX)"; trap 'rm -rf "$w"' EXIT; chmod 700 "$w"; mkdir "$w/b"
curl -fsS -o "$w/bundle.bin" "$GET_URL"
[ "$(sha256sum "$w/bundle.bin" | cut -c1-64)" = "$SHA" ] || { echo "下载的整包 sha256 对不上" >&2; exit 1; }
printf '%s\n' "$KEY" > "$w/k"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$w/k" -in "$w/bundle.bin" | tar -xzf - -C "$w/b"
systemctl stop andon-jiuan.service
docker exec -u postgres jiuan-pg psql -X -q -d postgres -v ON_ERROR_STOP=1 -c 'DROP DATABASE IF EXISTS jiuan WITH (FORCE)'
bash /opt/andon-finance/current/bench/pg-database.sh jiuan
docker exec -i -u postgres jiuan-pg pg_restore -d jiuan --exit-on-error < "$w/b/jiuan.pgdump"
if ! $SKIP_PG; then
  docker exec nexus-pgvector psql -X -q -U postgres -d postgres -v ON_ERROR_STOP=1 -c 'DROP DATABASE IF EXISTS nexus WITH (FORCE)' -c 'CREATE DATABASE nexus OWNER nexus'
  docker exec -i nexus-pgvector pg_restore -U postgres -d nexus --exit-on-error < "$w/b/nexus.pgdump"
fi
find /var/lib/jiuan -mindepth 1 -maxdepth 1 -not -name '.*' -exec rm -rf {} +
tar -C /var/lib -xpf "$w/b/files.tar"
# 起服务之前数：服务一起来，九安每分钟的同步就会往批次、运行记录表里写
counts > "$w/counts.txt"
systemctl start andon-jiuan.service
for i in $(seq 1 60); do
  [ "$(curl -fsS http://127.0.0.1:4180/poc/healthz 2>/dev/null)" = ok ] && break
  [ "$i" = 60 ] && { echo "服务 3 分钟内没有就绪：journalctl -u andon-jiuan" >&2; exit 1; }
  sleep 3
done
echo IMPORT_OK
cat "$w/counts.txt"
SH
)"
# export_script <公钥 base64> <预签名 PUT URL>
export_script() {
  printf 'SKIP_PG=%s\nCOUNT_PG=%s\nPUB_B64=%q\nPUT_URL=%q\n%s\ncounts() {\n%s\n}\n%s\n' \
    "$SKIP_PG" "$PG_FLAG" "$1" "$2" "$EXPORT_PRE" "$COUNTS" "$EXPORT_MAIN"
}
# import_script <预签名 GET URL> <整包 sha256> <AES 密钥>
import_script() {
  printf 'SKIP_PG=%s\nGET_URL=%q\nSHA=%q\nKEY=%q\nCOUNT_PG=%s\ncounts() {\n%s\n}\n%s\n' \
    "$SKIP_PG" "$1" "$2" "$3" "$PG_FLAG" "$COUNTS" "$IMPORT_MAIN"
}
# --print-scripts：只打印拼出来的导出、导入脚本（占位的值），不读配置、不连任何东西（单元测试拿它查语法）
if $PRINT_SCRIPTS; then
  printf '# ---- export ----\n%s\n# ---- import ----\n%s\n' "$(export_script PUB PUT_URL)" "$(import_script GET_URL 0000 KEY)"
  exit 0
fi
[[ -n "${DEPLOY_ENV:-}" && -n "${FROM_ENV:-}" ]] || { echo "要给 FROM_ENV（旧环境的配置）和 DEPLOY_ENV（新环境的配置）" >&2; exit 2; }
[[ "$(remote_mode)" == ssh ]] || { echo "新环境（${DEPLOY_ENV}）要经 SSH 管理：它的配置要写 SSH_KEY_FILE" >&2; exit 2; }
ssh_check_key || exit 2

# 旧环境的栈名、区域：在子 shell 里清掉新环境的键再读 FROM_ENV（免得没写的键沿用新环境的值）
from_value() { ( unset -v DEPLOY_ENV "${DEPLOY_ENV_KEYS[@]}"; DEPLOY_ENV="$FROM_ENV"; load_deploy_env 2>/dev/null; printf '%s' "${!1:-}" ); }
SRC_STACK="$(from_value STACK)"; SRC_REGION="$(from_value AWS_REGION)"
[[ -n "$SRC_STACK" && -n "$SRC_REGION" ]] || { echo "读不出 ${FROM_ENV} 的 STACK / AWS_REGION" >&2; exit 2; }
[[ -z "$(from_value SSH_KEY_FILE)" ]] || { echo "旧环境（${FROM_ENV}）经 SSH 管理：本脚本的导出只走 SSM，还不支持" >&2; exit 2; }
[[ "$SRC_STACK/$SRC_REGION" != "$STACK/$REGION" ]] || { echo "旧环境和新环境是同一个栈（${STACK}）" >&2; exit 2; }

say() { printf '\n== %s\n' "$*"; }
stack_output() { aws cloudformation describe-stacks --region "$1" --stack-name "$2" --query "Stacks[0].Outputs[?OutputKey=='$3'].OutputValue" --output text; }
SRC_INSTANCE="$(stack_output "$SRC_REGION" "$SRC_STACK" InstanceId)"
TGT_INSTANCE="$(stack_output "$REGION" "$STACK" InstanceId)"
TGT_BUCKET="$(stack_output "$REGION" "$STACK" ArtifactBucketName)"
TGT_IP="$(stack_output "$REGION" "$STACK" ElasticIp)"
WORK="$(mktemp -d)"; chmod 700 "$WORK"
OBJECT=""
cleanup() {
  [[ -n "$OBJECT" ]] && aws s3 rm --region "$REGION" --only-show-errors "s3://$TGT_BUCKET/$OBJECT" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT


# 旧实例上以 root 跑（经 SSM，lib/remote.sh 的 ssm_root），回标准输出；不成功就停
src_root() { ssm_root "$SRC_INSTANCE" "$1" "$2" "$SRC_REGION" || { echo "旧实例 $SRC_INSTANCE 上的命令没有成功" >&2; exit 1; }; }

say "旧环境 ${SRC_STACK}（${SRC_INSTANCE}，经 SSM）→ 新环境 ${STACK}（${TGT_INSTANCE}，${TGT_IP}，经 SSH）$($SKIP_PG && echo '；知识库的 PG 不动')"
ssh_setup "$TGT_IP" "$TGT_INSTANCE" && ssh_wait 6 || exit 1

say "核对两边"
# 新实例上要有的容器和脚本（不加 --skip-pg 时还有知识库的 PG 容器和 PL/Python）
TGT_READY="$(cat <<'SH'
docker inspect -f '{{.State.Running}}' jiuan-pg 2>/dev/null | grep -qx true || { echo "新实例上没有运行中的 jiuan-pg：先跑 deploy.sh" >&2; exit 3; }
[ -f /opt/andon-finance/current/bench/pg-database.sh ] || { echo "新实例上的构件还没换成 PostgreSQL（没有 bench/pg-database.sh）：先跑 deploy.sh --code-only" >&2; exit 3; }
if [ "$COUNT_PG" = 1 ]; then
  docker inspect -f '{{.State.Running}}' nexus-pgvector 2>/dev/null | grep -qx true || { echo "新实例上没有运行中的 nexus-pgvector：先跑 kb.sh db" >&2; exit 3; }
  [ "$(docker exec nexus-pgvector psql -X -At -U postgres -d postgres -c "SELECT count(*) FROM pg_available_extensions WHERE name = 'plpython3u'")" = 1 ] \
    || { echo "新实例的 PG 容器里没有 PL/Python：先跑 kb.sh db" >&2; exit 3; }
fi
SH
)"
# 第一行是 secrets.env 的 sha256（只比两边是否相同），后面是 COUNTS 的行
check_script() { printf 'COUNT_PG=%s\nset -euo pipefail\n%s\nsha256sum /etc/andon-finance/secrets.env | cut -c1-64\n%s\n' "$1" "$2" "$COUNTS"; }
src_check="$(src_root "$(check_script "$PG_FLAG" '')" 120)"
tgt_check="$(remote_root "$(check_script "$PG_FLAG" "$TGT_READY")")" || exit 1
[[ "$(head -1 <<< "$src_check")" == "$(head -1 <<< "$tgt_check")" ]] \
  || { echo "两边的 /etc/andon-finance/secrets.env 不是同一份：九安的库和 Agent 接入记录解不开。用同一个本机 secrets.env 部署新环境（deploy.sh --code-only）再来" >&2; exit 1; }
echo "两边的密钥配置相同"
summary() { awk -F'\t' '$1 == "jiuan" && $2 == "missing" { jm = 1 } $1 ~ /^jiuan\./ { jn++; jr += $2 }
  $1 ~ /^pg\./ && $1 !~ /md5$/ { pn++; pr += $2 } $1 ~ /^files\./ { f[$1] = $2 " 个文件，" $3 " 字节" }
  END { if (jm) print "  九安的库 jiuan（没有这个库）"; else printf "  九安的库 jiuan：%d 张表，%d 行\n", jn, jr;
        if (pn) printf "  知识库的库 nexus：%d 张表，%d 行\n", pn, pr; for (k in f) printf "  %s：%s\n", substr(k, 7), f[k] }' | sort; }
echo "旧环境（要搬过去的）："; tail -n +2 <<< "$src_check" | summary
echo "新环境（会被换掉的）："; tail -n +2 <<< "$tgt_check" | summary
if $DRY_RUN; then
  echo
  echo "[dry-run] 实跑时：旧实例只读导出 → 加密 → 预签名 URL 放进 s3://$TGT_BUCKET/migration/（搬完删）→ 新实例上停服务、换掉上面列的$($SKIP_PG || echo '（含知识库的库 nexus）')、起服务 → 逐表核对"
  exit 0
fi

say "旧实例上导出、加密、上传（只读：服务和库都不动）"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$WORK/seal.key" 2>/dev/null
PUB_B64="$(openssl pkey -in "$WORK/seal.key" -pubout 2>/dev/null | base64 | tr -d '\n')"
OBJECT="migration/$(date -u +%Y%m%dT%H%M%SZ)-$SRC_STACK.bin"
PUT_URL="$(uv run --quiet --no-project --python 3.12 --with 'boto3>=1.34' python -I -c '
import boto3, sys
from botocore.config import Config
s3 = boto3.client("s3", region_name=sys.argv[1], config=Config(signature_version="s3v4"))
print(s3.generate_presigned_url("put_object", Params={"Bucket": sys.argv[2], "Key": sys.argv[3]}, ExpiresIn=900))' "$REGION" "$TGT_BUCKET" "$OBJECT")"
exported="$(src_root "$(export_script "$PUB_B64" "$PUT_URL")" 600)"
SHA="$(sed -n 's/^BUNDLE_SHA256 //p' <<< "$exported")"; BYTES="$(sed -n 's/^BUNDLE_BYTES //p' <<< "$exported")"
sed -n 's/^SEALED_KEY //p' <<< "$exported" | base64 -d > "$WORK/key.sealed"
[[ "$SHA" =~ ^[0-9a-f]{64}$ && -s "$WORK/key.sealed" ]] || { echo "旧实例的导出没有回来完整的结果" >&2; exit 1; }
(umask 077; openssl pkeyutl -decrypt -inkey "$WORK/seal.key" -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 -pkeyopt rsa_mgf1_md:sha256 -in "$WORK/key.sealed" -out "$WORK/key")
[[ "$(wc -c < "$WORK/key" | tr -d ' ')" == 65 ]] || { echo "解不开旧实例回来的密钥" >&2; exit 1; }
echo "已上传加密的整包（$BYTES 字节）：s3://$TGT_BUCKET/$OBJECT"

say "新实例上换掉数据（停服务 → 九安的库$($SKIP_PG || echo ' → 知识库的库') → 状态目录 → 起服务 → 健康检查）"
GET_URL="$(aws s3 presign --region "$REGION" "s3://$TGT_BUCKET/$OBJECT" --expires-in 900)"
imported="$(remote_root "$(import_script "$GET_URL" "$SHA" "$(cat "$WORK/key")")")" || { echo "新实例上换数据没有成功（见上面的输出）。旧环境没动；新环境的服务可能停着：再跑一次本脚本，或 deploy.sh --code-only" >&2; exit 1; }
grep -qx IMPORT_OK <<< "$imported" || { echo "新实例上没有走完" >&2; exit 1; }
aws s3 rm --region "$REGION" --only-show-errors "s3://$TGT_BUCKET/$OBJECT"; OBJECT=""
echo "已删掉 s3://$TGT_BUCKET/migration/ 下的整包"

say "逐表核对"
want="$(sed -n '/^COUNTS_BEGIN$/,$p' <<< "$exported" | tail -n +2 | sort)"
got="$(sed -n '/^IMPORT_OK$/,$p' <<< "$imported" | tail -n +2 | sort)"
if [[ "$want" == "$got" ]]; then
  echo "两边一致（$(wc -l <<< "$want" | tr -d ' ') 项）："; summary <<< "$got"
else
  echo "两边对不上（旧环境是导出前一刻数的；那一刻和导出之间旧环境上有新写入也会这样）：" >&2
  diff <(printf '%s\n' "$want") <(printf '%s\n' "$got") | grep '^[<>]' | head -40 >&2
  exit 1
fi
