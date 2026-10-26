#!/usr/bin/env bash
#
# 只读：在 PG 主机上（经 SSM）报告容器、扩展与规则表状态。用于 verify / status。
#
# 输入：PG_CONTAINER_NAME PG_DB_NAME PG_DB_USER RULES_TABLE
set -uo pipefail
: "${PG_CONTAINER_NAME:?}" "${PG_DB_NAME:?}" "${RULES_TABLE:?}"

if ! command -v docker >/dev/null 2>&1; then echo "RESULT docker=absent"; exit 0; fi
if ! docker inspect "$PG_CONTAINER_NAME" >/dev/null 2>&1; then echo "RESULT container_state=absent"; exit 0; fi
echo "RESULT container_state=$(docker inspect -f '{{.State.Status}}' "$PG_CONTAINER_NAME")"
echo "RESULT container_image=$(docker inspect -f '{{.Config.Image}}' "$PG_CONTAINER_NAME")"
echo "RESULT port_binding=$(docker inspect -f '{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}{{.HostIp}}:{{.HostPort}} {{end}}{{end}}' "$PG_CONTAINER_NAME" | xargs)"
q() { docker exec "$PG_CONTAINER_NAME" psql -X -At -U postgres -d "$PG_DB_NAME" -c "$1" 2>/dev/null; }
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
