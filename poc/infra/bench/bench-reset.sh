#!/usr/bin/env bash
# 端到端测试前重置测试台：停服务 → 删掉并重建 jiuan_analysis 库 → 开服务（启动时迁移、写种子单据）。
# 只动这一个库；每个账号的连接与启用在实例磁盘上的账号目录里，不受影响。以 root 运行（run.sh 经 SSM 调用）。
set -euo pipefail
systemctl stop andon-finance-poc
docker exec -i jiuan-mysql sh -c 'MYSQL_PWD="$(cat /run/bench-secrets/mysql_root_password)" mysql -uroot' <<'SQL'
DROP DATABASE IF EXISTS jiuan_analysis;
CREATE DATABASE jiuan_analysis CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL ON jiuan_analysis.* TO 'jiuan_app'@'%';
SQL
systemctl start andon-finance-poc
echo "BENCH_RESET_OK"
