#!/usr/bin/env bash
#
# db 阶段的防混用（lib/common.sh 的 embed_guard）：库里登记的向量模型 × 配置的模型 × --migrate-embeddings / --restore-embeddings
# → apply / migrate / restore / refuse:<原因>。另核对：两个主机脚本里读登记的那段代码相同；deploy.sh 的新选项只配 db / regress。
#
#   bash kb/tests/test_embed_guard.sh          # 不连 AWS、不连库；macOS 自带的 /bin/bash（3.2）也要能跑
#
# deploy.sh 的选项检查在读配置之前：这里给一个不存在的配置文件，PATH 最前面放一个假的 aws / uv（被调到就记下来并失败），
# 检查漏了也只会停在「找不到配置文件」，碰不到 AWS。
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KB="$(cd "$HERE/.." && pwd)"
# shellcheck source=../lib/common.sh
. "$KB/lib/common.sh"

COHERE=cohere.embed-v4:0
TITAN=amazon.titan-embed-text-v2:0
n=0; fails=0
fail() { fails=$((fails + 1)); printf 'FAIL %s\n' "$*"; }

# guard <期望：apply|migrate|restore|refuse> <登记的> <配置的> <migrate> <restore>
guard() {
  local want="$1" got lines; shift
  n=$((n + 1))
  got="$(embed_guard "$@")"
  lines="$(printf '%s\n' "$got" | wc -l | tr -d ' ')"
  [ "$lines" = 1 ] || { fail "embed_guard $* 输出了 $lines 行：$got"; return; }
  case "$want:$got" in
    apply:apply|migrate:migrate|restore:restore) ;;
    refuse:refuse:?*) ;;
    *) fail "embed_guard $* → '$got'（期望 ${want}）" ;;
  esac
}

# ---- 计划里列的用例 ----
guard apply   none            "$COHERE" false false
guard refuse  titan-inferred  "$COHERE" false false
guard migrate titan-inferred  "$COHERE" true  false
guard apply   "$COHERE"       "$COHERE" false false
guard refuse  "$COHERE"       "$COHERE" true  false     # 已经是 Cohere
guard refuse  "$COHERE"       "$TITAN"  false false
guard restore "$COHERE"       "$TITAN"  false true
guard refuse  titan-inferred  "$COHERE" true  true      # 两个都给
guard refuse  "$COHERE"       "$TITAN"  true  true

# ---- 补充 ----
# 配置给的是推理配置文件的 id（us. / global. 前缀）：按模型族比
guard migrate titan-inferred  "us.$COHERE"     true  false
guard apply   "$COHERE"       "us.$COHERE"     false false
guard apply   "$COHERE"       "global.$COHERE" false false
# Titan 时代的库继续用 Titan：照旧重建 kb_search.sql
guard apply   titan-inferred  "$TITAN" false false
guard apply   "$TITAN"        "$TITAN" false false
guard refuse  "$TITAN"        "$TITAN" false true       # 已经是 Titan，没有可回退的
# 还没有向量：不用迁移，也没有可回退的
guard refuse  none            "$COHERE" true  false
guard refuse  none            "$TITAN"  false true
# 回退只回到 Titan（备份表 <表>_titan_backup 里是 Titan 的向量）；迁移只从 Titan 迁出
guard refuse  titan-inferred  "$COHERE" false true
guard refuse  "$COHERE"       "$TITAN"  true  false
# 读不到登记（查询出错、空、乱码）：一律停下，不能当成 none
guard refuse  error           "$COHERE" false false
guard refuse  ""              "$COHERE" false false
guard refuse  'x;rm -rf /'    "$COHERE" false false
# migrate / restore 只认 true / false
guard refuse  titan-inferred  "$COHERE" yes   false

# 原因是中文的一句话，说清楚怎么办
r="$(embed_guard titan-inferred "us.$COHERE" false false)"; n=$((n + 1))
case "$r" in *--migrate-embeddings*) ;; *) fail "titan-inferred + cohere 的原因里没提 --migrate-embeddings：$r" ;; esac
r="$(embed_guard "$COHERE" "$TITAN" false false)"; n=$((n + 1))
case "$r" in *--restore-embeddings*) ;; *) fail "cohere + titan 的原因里没提 --restore-embeddings：$r" ;; esac

# model_family：去掉区域前缀
n=$((n + 1))
[ "$(model_family "us.$COHERE")" = "$COHERE" ] && [ "$(model_family "$TITAN")" = "$TITAN" ] \
  && [ "$(model_family "apac.$COHERE")" = "$COHERE" ] || fail "model_family 不对"

# ---- 两个主机脚本里读登记的代码（# >>> embed_model … # <<< embed_model）必须相同 ----
block() { sed -n '/^# >>> embed_model$/,/^# <<< embed_model$/p' "$1"; }
n=$((n + 1))
a="$(block "$KB/host/pgvector-status.sh")"; b="$(block "$KB/host/pgvector-up.sh")"
if [ -z "$a" ] || [ "$a" != "$b" ]; then fail "host/pgvector-status.sh 与 host/pgvector-up.sh 的 embed_model 段不同（或缺）"; fi

# ---- deploy.sh：新选项只配对应的阶段（检查在读配置之前）----
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"
for t in aws uv session-manager-plugin; do
  printf '#!/bin/sh\necho "%s $*" >> "%s/called"\nexit 97\n' "$t" "$tmp" > "$tmp/bin/$t"; chmod +x "$tmp/bin/$t"
done
# deploy_rejects <期望的报错片段> <参数…>
deploy_rejects() {
  local want="$1" out rc; shift
  n=$((n + 1))
  out="$(PATH="$tmp/bin:$PATH" bash "$KB/deploy.sh" "$@" --config "$tmp/none.env" 2>&1)"; rc=$?
  [ "$rc" -ne 0 ] || { fail "deploy.sh $* 应当失败：$out"; return; }
  case "$out" in *"$want"*) ;; *) fail "deploy.sh $* 的报错里没有「${want}」：$out" ;; esac
}
deploy_rejects "只用于 db 阶段" ingest --migrate-embeddings
deploy_rejects "只用于 db 阶段" verify --restore-embeddings
deploy_rejects "只用于 db 阶段" regress --migrate-embeddings --questions-dir "$tmp" --label x
deploy_rejects "不能同时给" db --migrate-embeddings --restore-embeddings
deploy_rejects "只用于 regress" db --label x
deploy_rejects "只用于 regress" verify --questions-dir "$tmp"
deploy_rejects "--compare <a.json> <b.json>" regress --compare "$tmp/a.json"
# 合法的组合：过了选项检查，停在读配置（这里只看没被选项检查拦下：读配置那一步的报错不归这里管）
n=$((n + 1))
out="$(PATH="$tmp/bin:$PATH" bash "$KB/deploy.sh" db --migrate-embeddings --config "$tmp/none.env" 2>&1)" && fail "没有配置文件也成功了：$out"
case "$out" in *只用于*|*不能同时给*|*未知选项*) fail "db --migrate-embeddings 被选项检查拦下了：$out" ;; esac
n=$((n + 1))
[ ! -e "$tmp/called" ] || fail "检查选项时调到了外部命令：$(cat "$tmp/called")"
help="$(bash "$KB/deploy.sh" --help)"
for w in --migrate-embeddings --restore-embeddings regress --questions-dir --label --out --compare; do
  n=$((n + 1))
  case "$help" in *"$w"*) ;; *) fail "deploy.sh --help 里没有 $w" ;; esac
done

# ---- 主机脚本（在 PG 主机上由 bash 5 跑）：假的 docker / systemctl / ss，不连库 ----
#   pgvector-status.sh 的 embed_model；pgvector-up.sh 执行前再读一次登记、migrate 时 SQL 拼接、NOTICE 转成 [host] 行、出错整段停
if [ "${BASH_VERSINFO[0]}" -ge 4 ]; then
  H="$tmp/host"; mkdir -p "$H/bin" "$H/base"
  cat > "$H/bin/docker" <<'FAKE'
#!/usr/bin/env bash
# 假 docker：按参数回话；库里的状态在 $FAKE_STATE 下的文件里（meta=t|f、model、vec=t|f、fail、sqlfail、model_after）
S="$FAKE_STATE"; echo "$*" >> "$S/calls"; last="${!#}"
case "$*" in
  "version --format"*) echo 25.0.0 ;;
  "inspect -f {{.State.Running}}"*) echo true ;;
  "inspect -f {{.State.Status}}"*) echo running ;;
  "inspect -f {{.Config.Image}}"*) echo "$PG_IMAGE" ;;
  "inspect -f {{range"*) echo "$PG_BIND_IP:$PG_PORT" ;;
  "inspect -f {{index"*) echo pgvector-rules-kb ;;
  "inspect "*) exit 0 ;;
  "image inspect"*) echo "pgvector/pgvector@sha256:0" ;;
  *pg_isready*) exit 0 ;;
  *"psql -X -q -1 -U postgres"*)
    cat > "$S/sql.txt"
    if [ -e "$S/sqlfail" ]; then echo 'psql:<stdin>:3: NOTICE:  relation "kb_meta" already exists, skipping' >&2; echo 'psql:<stdin>:9: ERROR:  boom' >&2; exit 3; fi
    echo 'psql:<stdin>:40: NOTICE:  relation "kb_meta" already exists, skipping' >&2
    if grep -q 'migrate_embeddings' "$S/sql.txt"; then echo 'psql:<stdin>:500: NOTICE:  migrate_embeddings：approval_rules 重算 3 行（cohere.embed-v4:0，1024 维）' >&2; fi
    if [ -e "$S/model_after" ]; then cp "$S/model_after" "$S/model"; echo t > "$S/meta"; fi ;;
  *"read -r PGPASSWORD"*) cat > /dev/null; echo "17.6|0.8.0|scram-sha-256" ;;
  *"sh -c"*) cat > /dev/null ;;
  *"-U postgres"*pg_available_extensions*) echo 1 ;;
  *"psql -X -At -U nexus"*)
    [ ! -e "$S/fail" ] || exit 2
    case "$last" in
      *"to_regclass('public.kb_meta')"*) cat "$S/meta" ;;
      *"from kb_meta where key = 'embed_model'"*) cat "$S/model" 2>/dev/null || true ;;
      *"to_regclass('public.approval_rules')"*) echo t ;;
      *"to_regclass('public.approval_rules_"*) echo f ;;
      *"embedding is not null)"*) cat "$S/vec" ;;
      *"count(*)"*) echo 3 ;;
      *) echo "" ;;
    esac ;;
  *) echo "假 docker 没预设：$*" >&2; exit 9 ;;
esac
FAKE
  printf '#!/bin/sh\nexit 0\n' > "$H/bin/systemctl"
  printf '#!/bin/sh\necho "LISTEN 0 4096 10.0.0.5:5432 0.0.0.0:*"\n' > "$H/bin/ss"
  chmod +x "$H/bin/docker" "$H/bin/systemctl" "$H/bin/ss"
  printf 'POSTGRES_PASSWORD=p1\nNEXUS_DB_USER=nexus\nNEXUS_DB_PASSWORD=p2\nNEXUS_DB_NAME=nexus\n' > "$H/base/.env"
  # state <meta> <model> <vec>：重置假库
  state() { rm -rf "$H/s"; mkdir -p "$H/s"; echo "$1" > "$H/s/meta"; printf '%s' "$2" > "$H/s/model"; echo "$3" > "$H/s/vec"; }
  hostenv() { env PATH="$H/bin:$PATH" FAKE_STATE="$H/s" PG_CONTAINER_NAME=nexus-pgvector PG_DB_NAME=nexus PG_DB_USER=nexus RULES_TABLE=approval_rules "$@"; }
  status_model() { hostenv bash "$KB/host/pgvector-status.sh" | sed -n 's/^RESULT embed_model=//p'; }
  expect_eq() { n=$((n + 1)); [ "$2" = "$3" ] || fail "$1：得到 '$2'，期望 '$3'"; }
  state f "" t; expect_eq "status：没有 kb_meta、有向量" "$(status_model)" titan-inferred
  state t "$COHERE" t; expect_eq "status：kb_meta 登记了" "$(status_model)" "$COHERE"
  state t "" t; expect_eq "status：kb_meta 是空的、有向量" "$(status_model)" titan-inferred
  state f "" f; expect_eq "status：都没有" "$(status_model)" none
  state f "" t; : > "$H/s/fail"; expect_eq "status：查询出错不能当成 none" "$(status_model)" error
  state f "" t; st="$(hostenv bash "$KB/host/pgvector-status.sh")"
  expect_eq "status：规则表有向量的行" "$(printf '%s\n' "$st" | sed -n 's/^RESULT rules_embedded=//p')" 3
  expect_eq "status：归档表" "$(printf '%s\n' "$st" | sed -n 's/^RESULT archive_table=//p')" absent
  expect_eq "status：备份表" "$(printf '%s\n' "$st" | sed -n 's/^RESULT titan_backup=//p')" absent

  KBS="$(base64 < "$KB/sql/kb_search.sql" | tr -d '\n')"; MIG="$(base64 < "$KB/sql/migrate_embeddings.sql" | tr -d '\n')"
  up() { hostenv PG_IMAGE=pgvector/pgvector:pg17 PG_PORT=5432 PG_BIND_IP=10.0.0.5 PG_DATA_VOLUME=v PG_MEMORY_LIMIT=2g PG_BASE_DIR="$H/base" \
           PG_INSTALL_DOCKER=true KB_SEARCH_SQL_B64="$KBS" EMBED_MODEL_ID="us.$COHERE" EMBED_DIM=1024 AWS_REGION=us-east-1 \
           EMBED_MODEL_FAMILY="$COHERE" "$@" bash "$KB/host/pgvector-up.sh"; }
  filled() { python3 -I -c 'import sys
def f(name): return open(name, encoding="utf-8").read()
s = f(sys.argv[1]) + ("\n" + f(sys.argv[2]) if len(sys.argv) > 2 else "")
for k, v in (("{table}", "approval_rules"), ("{dim}", "1024"), ("{model}", "us.cohere.embed-v4:0"), ("{region}", "us-east-1"),
             ("{app_user}", "nexus"), ("{model_family}", "cohere.embed-v4:0")):
    s = s.replace(k, v)
sys.stdout.write(s)' "$@"; }
  # migrate：登记与 deploy.sh 判断时相同 → kb_search.sql + migrate_embeddings.sql 一个事务；NOTICE 里的计数转成 [host] 行
  state f "" t; echo "$COHERE" > "$H/s/model_after"
  out="$(up EMBED_ACTION=migrate EMBED_EXPECT=titan-inferred EMBED_SQL_B64="$MIG" 2>"$H/err")"; rc=$?
  expect_eq "up migrate：退出码" "$rc" 0
  expect_eq "up migrate：执行的 SQL = kb_search.sql + 换行 + migrate_embeddings.sql（占位符已填）" \
    "$(cksum < "$H/s/sql.txt")" "$(filled "$KB/sql/kb_search.sql" "$KB/sql/migrate_embeddings.sql" | cksum)"
  expect_eq "up migrate：embed_action" "$(printf '%s\n' "$out" | sed -n 's/^RESULT embed_action=//p')" migrate
  expect_eq "up migrate：之后的登记" "$(printf '%s\n' "$out" | sed -n 's/^RESULT embed_model=//p')" "$COHERE"
  n=$((n + 1)); case "$out" in *"[host] migrate_embeddings：approval_rules 重算 3 行"*) ;; *) fail "up migrate：没把重算行数转成 [host] 行：$out" ;; esac
  n=$((n + 1)); case "$out$(cat "$H/err")" in *skipping*) fail "up migrate：别的 NOTICE 不该打出来" ;; esac
  n=$((n + 1)); grep -q -- '-U nexus' "$H/s/calls" && ! grep -q -- 'psql -X -At -U postgres -d nexus -c select' "$H/s/calls" || fail "up：登记要以应用用户读"
  # apply：只有 kb_search.sql
  state t "$COHERE" t
  out="$(up EMBED_ACTION=apply EMBED_EXPECT="$COHERE" 2>"$H/err")"; rc=$?
  expect_eq "up apply：退出码" "$rc" 0
  expect_eq "up apply：执行的 SQL = kb_search.sql" "$(cksum < "$H/s/sql.txt")" "$(filled "$KB/sql/kb_search.sql" | cksum)"
  # 登记变了（deploy.sh 读过之后有人迁移 / 回退过）：停下，什么 SQL 都不执行
  state f "" t
  out="$(up EMBED_ACTION=apply EMBED_EXPECT="$COHERE" 2>"$H/err")"; rc=$?
  expect_eq "up：登记变了要失败" "$rc" 1
  n=$((n + 1)); [ ! -e "$H/s/sql.txt" ] || fail "up：登记变了还执行了 SQL"
  n=$((n + 1)); grep -q '登记的向量模型变了' "$H/err" || fail "up：登记变了的报错不对：$(cat "$H/err")"
  # 动作和脚本对不上：停下
  state f "" t
  up EMBED_ACTION=migrate EMBED_EXPECT=titan-inferred >/dev/null 2>"$H/err"; rc=$?
  expect_eq "up：migrate 没带脚本要失败" "$rc" 1
  n=$((n + 1)); [ ! -e "$H/s/sql.txt" ] || fail "up：migrate 没带脚本还执行了 SQL"
  n=$((n + 1)); ! grep -q "$MIG" "$H/err" || fail "up：报错里带了整段 base64"
  # SQL 出错：退出码非 0，报 ERROR 行，不刷别的 NOTICE
  state f "" t; : > "$H/s/sqlfail"
  up EMBED_ACTION=migrate EMBED_EXPECT=titan-inferred EMBED_SQL_B64="$MIG" >/dev/null 2>"$H/err"; rc=$?
  expect_eq "up：SQL 出错要失败" "$rc" 1
  n=$((n + 1)); grep -q 'ERROR:  boom' "$H/err" && ! grep -q skipping "$H/err" || fail "up：SQL 出错的输出不对：$(cat "$H/err")"
else
  echo "（bash ${BASH_VERSION} < 4：跳过主机脚本的用例，它们在 PG 主机上由 bash 5 跑）"
fi

if [ "$fails" -eq 0 ]; then echo "OK test_embed_guard.sh（$n 项，bash ${BASH_VERSION}）"; exit 0; fi
echo "FAILED test_embed_guard.sh：$fails / $n 项不对"; exit 1
