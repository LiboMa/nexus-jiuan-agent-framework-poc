#!/usr/bin/env bash
# 重置测试台上的九安 v0.7.10（端到端测试用，root 运行）：单据、AI 独立建议、流水线记录都清空，从模拟汇联易重新同步。
# 保留管理员在「后台配置 › Agent 接入」页上的启用记录（状态表 agent-enablement:v1:<租户> 那一行，九安用数据密钥加密）：
# 停服务 → 导出这一行 → 删掉并重建库 jiuan、删掉种子时间锚点 → 起服务跑迁移 → 停服务写回这一行 → 起服务（启动时读到启用记录）→ 等健康检查。
# 调用密钥只在页面上粘贴，这里不读也不写任何密钥文件。
# 中途失败（例如写回时外键对不上）：导出的那一行留在 /var/tmp/jiuan-reset.*/enablement.sql（0600，只给 root）不删，并说出路径；
# 不管成功失败，退出时服务都会起来（站点不会因为重置失败一直停着）。
set -euo pipefail
SQL_ROOT='MYSQL_PWD="$(cat /run/bench-secrets/mysql_root_password)"'
KEEP="$(mktemp -d /var/tmp/jiuan-reset.XXXXXX)"
chmod 0700 "$KEEP"
finish() {
  local rc=$?
  systemctl start andon-jiuan.service || true
  if [[ "$rc" == 0 ]]; then rm -rf "$KEEP"
  elif [[ -s "$KEEP/enablement.sql" ]]; then echo "重置没走完；「Agent 接入」的启用记录导出在 $KEEP/enablement.sql，没删" >&2
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

systemctl stop andon-jiuan.service
docker exec jiuan-mysql sh -c "$SQL_ROOT mysqldump -uroot --no-create-info --skip-triggers --compact --complete-insert --hex-blob jiuan analysis_sync_states --where=\"scope_key LIKE 'agent-enablement:%'\"" \
  > "$KEEP/enablement.sql" 2>/dev/null || : > "$KEEP/enablement.sql"
chmod 0600 "$KEEP/enablement.sql"
docker exec -i jiuan-mysql sh -c "$SQL_ROOT mysql -uroot" <<'SQL'
DROP DATABASE IF EXISTS `jiuan`;
CREATE DATABASE `jiuan` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
SQL
rm -f /var/lib/jiuan/seed-anchor.json   # 新库：种子单据的时间锚点重算（seed-anchor.mjs）
systemctl start andon-jiuan.service   # 启动时跑完迁移，建出空表
healthy
if [[ -s "$KEEP/enablement.sql" ]]; then
  systemctl stop andon-jiuan.service
  docker exec -i jiuan-mysql sh -c "$SQL_ROOT mysql -uroot jiuan" < "$KEEP/enablement.sql"
  systemctl start andon-jiuan.service
  healthy
  echo "JIUAN_ENABLEMENT_KEPT"
fi
echo "JIUAN_RESET_OK"
