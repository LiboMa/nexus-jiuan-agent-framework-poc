#!/usr/bin/env bash
#
# 只读：在 PG 主机上（经 SSM）报告容器、扩展与规则表状态。用于 verify / status。
#
# 输入：PG_CONTAINER_NAME PG_DB_NAME PG_DB_USER RULES_TABLE；可选 E2E_QUESTION_B64（verify 用来核对语义检索的前 3 名）
set -uo pipefail
: "${PG_CONTAINER_NAME:?}" "${PG_DB_NAME:?}" "${PG_DB_USER:?}" "${RULES_TABLE:?}"

if ! command -v docker >/dev/null 2>&1; then echo "RESULT docker=absent"; exit 0; fi
if ! docker inspect "$PG_CONTAINER_NAME" >/dev/null 2>&1; then echo "RESULT container_state=absent"; exit 0; fi
echo "RESULT container_state=$(docker inspect -f '{{.State.Status}}' "$PG_CONTAINER_NAME")"
echo "RESULT container_image=$(docker inspect -f '{{.Config.Image}}' "$PG_CONTAINER_NAME")"
echo "RESULT port_binding=$(docker inspect -f '{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}{{.HostIp}}:{{.HostPort}} {{end}}{{end}}' "$PG_CONTAINER_NAME" | xargs)"
# 以应用用户查（容器内本地 socket，官方镜像是 trust）：表和函数里有应用用户（也就是连接器）能改的，
# 超级用户会话里去读、去调，等于把超级用户交出去；也顺带核对连接器实际拿到的权限
q() { docker exec "$PG_CONTAINER_NAME" psql -X -At -U "$PG_DB_USER" -d "$PG_DB_NAME" -c "$1" 2>/dev/null; }
echo "RESULT pg_version=$(q "show server_version")"
echo "RESULT vector_version=$(q "select extversion from pg_extension where extname='vector'")"
if [ "$(q "select to_regclass('public.${RULES_TABLE}') is not null")" = "t" ]; then
  echo "RESULT rules_table=present"
  echo "RESULT rules_rows=$(q "select count(*) from ${RULES_TABLE}")"
  echo "RESULT rules_rows_without_embedding=$(q "select count(*) from ${RULES_TABLE} where embedding is null")"
  echo "RESULT rules_by_type=$(q "select string_agg(rule_type||':'||n, ',' order by rule_type) from (select rule_type, count(*) n from ${RULES_TABLE} group by 1) t")"
  echo "RESULT rules_sources=$(q "select string_agg(distinct coalesce(source_tag,'<null>')||'@'||coalesce(source_doc,'?'), ' ; ') from ${RULES_TABLE}" 2>/dev/null || q "select string_agg(distinct coalesce(source_doc,'?'), ' ; ') from ${RULES_TABLE}")"
else
  echo "RESULT rules_table=absent"
fi
# 库内语义检索：PL/Python 装了没有、kb_search 能不能用；给了 E2E_QUESTION_B64 就取这个问题的前 3 名
echo "RESULT plpython=$(q "select count(*) from pg_extension where extname='plpython3u'")"
if [ "$(q "select to_regprocedure('kb_search(text,integer,text,text)') is not null")" = "t" ]; then
  # 探测放在只读事务里：verify / dry-run 不写检索日志和向量缓存，也顺带核对只读事务里能检索（每次现算问题向量，调一次 Bedrock）。
  # 用不了时把 PG 报的第一行 ERROR 带回来（常见：实例角色没有 bedrock:InvokeModel、容器取不到凭证、模型没开通）
  if err="$(printf '%s\n' "BEGIN READ ONLY; select count(*) from kb_search('ping', 1, NULL, 'verify'); ROLLBACK;" \
      | docker exec -i "$PG_CONTAINER_NAME" psql -X -At -U "$PG_DB_USER" -d "$PG_DB_NAME" -v ON_ERROR_STOP=1 2>&1 >/dev/null)"; then
    echo "RESULT kb_search=ready"
  else
    echo "RESULT kb_search=error"
    echo "RESULT kb_search_error=$(printf '%s\n' "$err" | grep -m1 'ERROR' | tr -d '\r' | cut -c1-300)"
  fi
  if [ -n "${E2E_QUESTION_B64:-}" ]; then
    question="$(printf '%s' "$E2E_QUESTION_B64" | base64 -d)"
    echo "RESULT kb_search_top3=$(printf '%s\n' "BEGIN READ ONLY; select string_agg(rule_id, ',') from kb_search(:'question', 3, NULL, 'verify'); ROLLBACK;" \
      | docker exec -i "$PG_CONTAINER_NAME" psql -X -At -U "$PG_DB_USER" -d "$PG_DB_NAME" -v question="$question" 2>/dev/null | grep -v -x -e BEGIN -e ROLLBACK)"
  fi
else
  echo "RESULT kb_search=absent"
fi
