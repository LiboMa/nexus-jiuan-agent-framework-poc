#!/usr/bin/env bash
#
# 在 PG 主机上（经 SSM，以 root）为应用用户生成新密码并写回 .env（旧文件备份为 .env.bak.<时间>）。
# 只改文件；库里的密码由随后的 db 阶段（ALTER ROLE，取 .env 的值）同步，Nexus 密钥由 connector 阶段同步。
# 由 ./deploy.sh rotate-db-password 调用（它依次执行本脚本、db、connector），不要单独跑。
#
# 输入：PG_BASE_DIR
set -euo pipefail
: "${PG_BASE_DIR:?}"
ENV_FILE="$PG_BASE_DIR/.env"
[ -s "$ENV_FILE" ] || { echo "$ENV_FILE 不存在（先跑 db 阶段）" >&2; exit 1; }
ts="$(date -u +%Y%m%d%H%M%S)"
cp -p "$ENV_FILE" "$ENV_FILE.bak.$ts"
new="$(openssl rand -hex 24)"
tmp="$(mktemp "$PG_BASE_DIR/.env.XXXX")"
sed "s/^NEXUS_DB_PASSWORD=.*/NEXUS_DB_PASSWORD=$new/" "$ENV_FILE" > "$tmp"
chmod 600 "$tmp"; mv "$tmp" "$ENV_FILE"
echo "RESULT rotated=$ts"
echo "RESULT backup=$ENV_FILE.bak.$ts"
