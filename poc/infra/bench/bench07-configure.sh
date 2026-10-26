#!/usr/bin/env bash
# 部署时配置测试台上的九安 v0.7.10（deploy.sh 经 SSM 调用，root 运行；在 PoC 服务重启之前，因为 PoC 要读这里写的转发设置）：
#   1. 系统用户 jiuan07，不进 andon 组（读不到 PoC 的 secrets.env）；工作目录 /var/lib/jiuan07；
#   2. /etc/andon-finance/jiuan07/：从 secrets.env 取库密码、数据密钥和两个账号的口令写成文件（root:jiuan07 0640），
#      实例上已有的库密码和数据密钥只认原值；虚构的汇联易凭据（假汇联易不校验）；服务的 env 文件；
#   3. MySQL：在 jiuan-mysql 里建库 jiuan07 和只能看这个库的账号 jiuan07_app（密码只经标准输入进容器）；
#   4. /etc/hosts 堵掉九安代码里写死的外部地址（整段带标记，可以整段删）；
#   5. systemd 单元 andon-jiuan07.service；PoC 服务按 Host 转发的设置（jiuan07-forward.env + 补充配置）。
# 用法：bench07-configure.sh <站点主机名> <Nexus 地址>。不打印任何密钥。AI 独立建议发给哪个发布不在这里配：由「Agent 接入」页上的启用记录决定。
set -euo pipefail
DOMAIN="${1:-}"; NEXUS="${2:-}"
[[ "$DOMAIN" =~ ^[a-z0-9.-]+$ && "$NEXUS" =~ ^https://[a-z0-9.-]+$ ]] || { echo "用法：bench07-configure.sh <站点主机名> <Nexus 地址>" >&2; exit 2; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SECRETS=/etc/andon-finance/secrets.env
DIR=/etc/andon-finance/jiuan07

id jiuan07 >/dev/null 2>&1 || useradd --system --home-dir /var/lib/jiuan07 --create-home --shell /sbin/nologin jiuan07
install -d -o jiuan07 -g jiuan07 -m 0700 /var/lib/jiuan07 /var/lib/jiuan07/nexus
install -d -o root -g jiuan07 -m 0750 "$DIR"

# >>> jiuan07-secret-files
# 库密码和数据密钥：库是按原来的值建的、数据按原来的密钥加密，secrets.env 里的值和实例上的不一样时一个文件都不写，直接失败。
SECRET_FILES=(JIUAN07_MYSQL_APP_PASSWORD:mysql_app_password JIUAN07_DATA_KEY:analysis_data_key REVIEWER_PASSWORD:reviewer_password CHECKER_PASSWORD:checker_password)
PINNED=(mysql_app_password analysis_data_key)
secret_value() { sed -n "s/^$1=//p" "$SECRETS" | head -1; }
for pair in "${SECRET_FILES[@]}"; do
  key="${pair%%:*}"; file="${pair#*:}"; value="$(secret_value "$key")"
  [[ -n "$value" ]] || { echo "secrets.env 里缺少 ${key}" >&2; exit 1; }
  if [[ " ${PINNED[*]} " == *" $file "* && -f "$DIR/$file" && "$(cat "$DIR/$file")" != "$value" ]]; then
    echo "实例上的 ${file} 和 secrets.env 里的 ${key} 不一样，拒绝替换：v0.7.10 的库用的是原来的值。要换就先运行 bench07-reset.sh 重建库" >&2
    exit 1
  fi
done
[[ "$(secret_value JIUAN07_DATA_KEY)" =~ ^[A-Za-z0-9+/]{43}=$ ]] || { echo "secrets.env 里的 JIUAN07_DATA_KEY 不是 32 字节的 base64" >&2; exit 1; }
[[ "$(secret_value JIUAN07_MYSQL_APP_PASSWORD)" =~ ^[0-9a-f]{32}$ ]] || { echo "secrets.env 里的 JIUAN07_MYSQL_APP_PASSWORD 应是 32 位十六进制" >&2; exit 1; }
write_secret() {   # 文件名 值：root:jiuan07 0640，先写临时文件再改名
  ( umask 077; printf '%s' "$2" > "$DIR/$1.new" )
  chown root:jiuan07 "$DIR/$1.new"; chmod 0640 "$DIR/$1.new"; mv "$DIR/$1.new" "$DIR/$1"
}
for pair in "${SECRET_FILES[@]}"; do write_secret "${pair#*:}" "$(secret_value "${pair%%:*}")"; done
# 假汇联易不校验凭据，九安的测试环境客户端只要求两个文件存在且非空
write_secret hly_app_id fake-hly-app-id-jiuan07
write_secret hly_app_secret fake-hly-app-secret-jiuan07
# <<< jiuan07-secret-files

# >>> jiuan07-kb
# 「规则库 › 制度知识库」：知识库（kb/）的 PG 容器在本机，由 infra/kb.sh 部署。只有它已部署（PG 主机的 .env 在）才开这个功能：
#   连库密码从 PG 主机的 .env 复制成 kb_pg_password（root:jiuan07 0640），不打印；上传文件目录 /var/lib/jiuan07/kb-uploads（0700）；
#   入库进程用的 Python venv（钉 psycopg 版本，Bedrock 由库里的 kb_embed 调，这里不需要 boto3）。
KB_ENV=/opt/nexus-pgvector/.env
KB_LINES=""
if [[ -s "$KB_ENV" ]]; then
  kb_pw="$(sed -n 's/^NEXUS_DB_PASSWORD=//p' "$KB_ENV" | head -1)"
  kb_user="$(sed -n 's/^NEXUS_DB_USER=//p' "$KB_ENV" | head -1)"
  kb_db="$(sed -n 's/^NEXUS_DB_NAME=//p' "$KB_ENV" | head -1)"
  [[ -n "$kb_pw" && -n "$kb_user" && -n "$kb_db" ]] || { echo "$KB_ENV 缺 NEXUS_DB_USER / NEXUS_DB_PASSWORD / NEXUS_DB_NAME" >&2; exit 1; }
  write_secret kb_pg_password "$kb_pw"
  unset kb_pw
  install -d -o jiuan07 -g jiuan07 -m 0700 /var/lib/jiuan07/kb-uploads
  if ! /opt/andon-finance/kb-venv/bin/python -c 'import psycopg' >/dev/null 2>&1; then
    python3 -m venv /opt/andon-finance/kb-venv
    /opt/andon-finance/kb-venv/bin/pip install -q --disable-pip-version-check 'psycopg[binary]==3.2.9'
  fi
  kb_token="$(curl -sf -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')"
  kb_host="$(curl -sf -H "X-aws-ec2-metadata-token: $kb_token" http://169.254.169.254/latest/meta-data/local-ipv4)"
  [[ -n "$kb_host" ]] || { echo "从 IMDS 取不到私网 IP（知识库的 PG 只绑这个地址）" >&2; exit 1; }
  KB_LINES="POC07_KB_PG_HOST=$kb_host
POC07_KB_USER=$kb_user
POC07_KB_DB=$kb_db
POC07_KB_DIR=/opt/andon-finance/current/kb
POC07_KB_PYTHON=/opt/andon-finance/kb-venv/bin/python"
fi
# <<< jiuan07-kb

cat > "$DIR/env.new" <<ENV
POC07_ORIGIN=https://$DOMAIN
POC07_PORT=4181
POC07_BIND=127.0.0.1
POC07_SECRETS_DIR=$DIR
NEXUS_ORIGIN=$NEXUS
JIUAN07_DIR=/opt/andon-finance/current/jiuan07
NEXUS_OPERATOR=/opt/andon-finance/current/operator/scripts/nexus.py
POC07_NEXUS_HOME=/var/lib/jiuan07/nexus
TZ=Asia/Shanghai
NODE_ENV=production
${KB_LINES}
ENV
chown root:jiuan07 "$DIR/env.new"; chmod 0640 "$DIR/env.new"; mv "$DIR/env.new" "$DIR/env"

# >>> jiuan07-database
for attempt in $(seq 1 60); do
  docker exec jiuan-mysql sh -c 'MYSQL_PWD="$(cat /run/bench-secrets/mysql_root_password)" mysqladmin ping -uroot --silent' >/dev/null 2>&1 && break
  [[ "$attempt" == 60 ]] && { echo "MySQL 没有就绪（jiuan-mysql）" >&2; exit 1; }
  sleep 2
done
docker exec -i jiuan-mysql sh -c 'MYSQL_PWD="$(cat /run/bench-secrets/mysql_root_password)" mysql -uroot' <<SQL
CREATE DATABASE IF NOT EXISTS \`jiuan07\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'jiuan07_app'@'%' IDENTIFIED BY '$(secret_value JIUAN07_MYSQL_APP_PASSWORD)';
ALTER USER 'jiuan07_app'@'%' IDENTIFIED BY '$(secret_value JIUAN07_MYSQL_APP_PASSWORD)';
GRANT ALL PRIVILEGES ON \`jiuan07\`.* TO 'jiuan07_app'@'%';
FLUSH PRIVILEGES;
SQL
# <<< jiuan07-database

# >>> jiuan07-hosts
# 九安 v0.7.10 代码里写死的外部地址（真汇联易、汇联易附件、九安内网、钉钉、OpenAI、SAP）：测试台上一律指到本机不存在的服务
HOSTS=(api.huilianyi.com apistage.huilianyi.com huoshantstapi.huilianyi.com helioscloud-uat.huilianyi.com oss-huilianyi.jiuan.com
  oapi.dingtalk.com api.openai.com finmcp.jiuan.local sap-mcp.local sub1api.jiuan.com sub1api.theunifiedcare.com)
sed -i '/^# >>> jiuan07-blackhole/,/^# <<< jiuan07-blackhole/d' /etc/hosts
{
  echo '# >>> jiuan07-blackhole（bench07-configure.sh 写入：九安 v0.7.10 写死的外部地址，测试台上不通）'
  for host in "${HOSTS[@]}"; do printf '0.0.0.0 %s\n:: %s\n' "$host" "$host"; done
  echo '# <<< jiuan07-blackhole'
} >> /etc/hosts
# <<< jiuan07-hosts

install -m 0644 "$HERE/andon-jiuan07.service" /etc/systemd/system/andon-jiuan07.service
cat > /etc/andon-finance/jiuan07-forward.env <<ENV
POC_FORWARD_HOST=$DOMAIN
POC_FORWARD_PORT=4181
ENV
chmod 0644 /etc/andon-finance/jiuan07-forward.env
install -d -m 0755 /etc/systemd/system/andon-finance-poc.service.d
printf '%s\n' '# bench07-configure.sh 写入：PoC 进程把九安 v0.7.10 站点的请求转给本机 4181（poc/app/host-proxy.mjs）' '[Service]' \
  'EnvironmentFile=-/etc/andon-finance/jiuan07-forward.env' > /etc/systemd/system/andon-finance-poc.service.d/jiuan07-forward.conf
systemctl daemon-reload
systemctl enable andon-jiuan07.service >/dev/null 2>&1
echo "JIUAN07_CONFIGURED $DOMAIN"
