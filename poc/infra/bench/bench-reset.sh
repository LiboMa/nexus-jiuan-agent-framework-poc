#!/usr/bin/env bash
# 重置测试台上的九安 v0.7.10（端到端测试用，root 运行）：单据、AI 独立建议、流水线记录都清空，从模拟汇联易重新同步。
# 保留管理员在「后台配置 › Agent 接入」页上的启用记录（状态表 agent-enablement:v1:<租户> 那一行，九安用数据密钥加密）：
# 停服务 → 导出这一行（PG 的 COPY 文本格式，bytea 成 \\x 十六进制，原样回得去）→ 删掉库 jiuan、按原参数重建（pg-database.sh）、
# 删掉种子时间锚点 → 起服务跑迁移 → 停服务写回这一行 → 起服务（启动时读到启用记录）→ 等健康检查。
# 库或表还不在（第一次部署）就没有要留的；表在却导不出来就停（库不删）。调用密钥只在页面上粘贴，这里不读也不写任何密钥文件。
# 中途失败（例如写回时外键对不上）：导出的那一行留在 /var/tmp/jiuan-reset.*/enablement.copy（0600，只给 root）不删，并说出路径；
# 不管成功失败，退出时服务都会起来（站点不会因为重置失败一直停着）。
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KEEP="$(mktemp -d /var/tmp/jiuan-reset.XXXXXX)"
chmod 0700 "$KEEP"
finish() {
  local rc=$?
  systemctl start andon-jiuan.service || true
  if [[ "$rc" == 0 ]]; then rm -rf "$KEEP"
  elif [[ -s "$KEEP/enablement.copy" ]]; then echo "重置没走完；「Agent 接入」的启用记录导出在 $KEEP/enablement.copy，没删" >&2
  else rm -rf "$KEEP"; fi
}
trap finish EXIT
healthy() {
  for attempt in $(seq 1 60); do
    [[ "$(curl -fsS http://127.0.0.1:4180/poc/healthz 2>/dev/null)" == ok ]] && return 0
    sleep 3
  done
  echo "九安 v0.7.10 没有在 3 分钟内就绪：journalctl -u andon-jiuan -n 200" >&2
  return 1
}
psql_in() { local db="$1"; shift; docker exec -u postgres jiuan-pg psql -X -q -v ON_ERROR_STOP=1 -d "$db" "$@"; }

systemctl stop andon-jiuan.service
( umask 077; : > "$KEEP/enablement.copy" )
chmod 0600 "$KEEP/enablement.copy"
has_table=f
if [[ "$(docker exec -u postgres jiuan-pg psql -X -At -d postgres -c "SELECT count(*) FROM pg_database WHERE datname = 'jiuan'")" == 1 ]]; then
  has_table="$(docker exec -u postgres jiuan-pg psql -X -At -d jiuan -c "SELECT to_regclass('public.analysis_sync_states') IS NOT NULL")"
fi
if [[ "$has_table" == t ]]; then
  psql_in jiuan -c "COPY (SELECT * FROM analysis_sync_states WHERE scope_key LIKE 'agent-enablement:%') TO STDOUT" > "$KEEP/enablement.copy"
fi
psql_in postgres -c 'DROP DATABASE IF EXISTS jiuan WITH (FORCE)'
bash "$HERE/pg-database.sh" jiuan >/dev/null
rm -f /var/lib/jiuan/seed-anchor.json   # 新库：种子单据的时间锚点重算（seed-anchor.mjs）
systemctl start andon-jiuan.service   # 启动时跑完迁移，建出空表
healthy
if [[ -s "$KEEP/enablement.copy" ]]; then
  systemctl stop andon-jiuan.service
  docker exec -i -u postgres jiuan-pg psql -X -q -v ON_ERROR_STOP=1 -d jiuan -c 'COPY analysis_sync_states FROM STDIN' < "$KEEP/enablement.copy"
  systemctl start andon-jiuan.service
  healthy
  echo "JIUAN_ENABLEMENT_KEPT"
fi
echo "JIUAN_RESET_OK"
