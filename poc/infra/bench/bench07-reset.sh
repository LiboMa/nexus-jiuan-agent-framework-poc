#!/usr/bin/env bash
# 重置测试台上的九安 v0.7.10（端到端测试用，root 运行）：停服务 → 删掉并重建库 jiuan07 → 起服务 → 等健康检查。
# 单据从假汇联易重新同步，AI 独立建议重新发起；「Agent 接入」的启用记录也在这个库里，重置后要重新启用。PoC 的库不动。
set -euo pipefail
systemctl stop andon-jiuan07.service
docker exec -i jiuan-mysql sh -c 'MYSQL_PWD="$(cat /run/bench-secrets/mysql_root_password)" mysql -uroot' <<'SQL'
DROP DATABASE IF EXISTS `jiuan07`;
CREATE DATABASE `jiuan07` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
SQL
systemctl start andon-jiuan07.service
for attempt in $(seq 1 60); do
  [[ "$(curl -fsS http://127.0.0.1:4181/poc/healthz 2>/dev/null)" == ok ]] && { echo "JIUAN07_RESET_OK"; exit 0; }
  sleep 3
done
echo "九安 v0.7.10 没有在 3 分钟内就绪：journalctl -u andon-jiuan07 -n 200" >&2
exit 1
