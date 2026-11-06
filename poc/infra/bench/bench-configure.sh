#!/usr/bin/env bash
# 部署时配置测试台上的九安 v0.7.10（deploy.sh 经 SSM 或 SSH 调用，root 运行；在重启服务之前）：
#   0. 以前的 v0.5.3 PoC（andon-finance-poc 服务，它占着 4180、按 Host 把这个站点转给 4181）实例上还有就停掉、删掉单元；
#      2026-11-02 之前的名字（andon-jiuan07、用户 jiuan07……）原地改成现在的（legacy-07），数据不动；
#   1. 系统用户 jiuan（读不到 /etc/andon-finance/secrets.env，那个文件只有 root 能读）；工作目录 /var/lib/jiuan（含「我的规则」的 custom-rules/）；
#   2. /etc/andon-finance/jiuan/：从 secrets.env 取库口令（db_app_password）、数据密钥和两个账号的口令写成文件（root:jiuan 0640），
#      实例上已有的数据密钥只认原值；虚构的汇联易凭据（假汇联易不校验）；服务的 env 文件（外壳连库的设置 POC_DB_*）；
#   3. PostgreSQL：装好或确认容器 jiuan-pg（pg-install.sh），在里面建库 jiuan 和它的属主 jiuan_app（pg-database.sh，口令只经标准输入进容器）。
#      MySQL 2026-11-06 删了：实例上留下的两个 MySQL 口令文件（mysql_app_password、bench/mysql_root_password）每次都清掉；
#   4. /etc/hosts 堵掉九安代码里写死的外部地址（整段带标记，可以整段删）；
#   5. systemd 单元 andon-jiuan.service：外壳直接听 0.0.0.0:4180（安全组只放 CloudFront 回源）。
# 用法：bench-configure.sh <站点主机名> <Nexus 地址> [<kb 方式> [<知识库 Agent 发布编号>]]。不打印任何密钥。AI 独立建议发给哪个发布不在这里配：由「Agent 接入」页上的启用记录决定。
#   kb 方式：pg（缺省，PG 知识库 Agent）或 s3vectors（知识库文档管家，读写 S3 Vectors）。两种方式「制度知识库」页都经 Nexus 上的这个 Agent（A2A），
#   测试台不直连知识库的 PG；发布编号可以不给（页面说「知识库 Agent 还没配置」），给了就要是 pub_ 加 16 位十六进制。Agent 的调用密钥在「Agent 接入」页上启用，不经过这里。
set -euo pipefail
DOMAIN="${1:-}"; NEXUS="${2:-}"; KB_MODE="${3:-pg}"; KB_PUBLICATION="${4:-}"
[[ "$DOMAIN" =~ ^[a-z0-9.-]+$ && "$NEXUS" =~ ^https://[a-z0-9.-]+$ ]] || { echo "用法：bench-configure.sh <站点主机名> <Nexus 地址> [<kb 方式> [<知识库 Agent 发布编号>]]" >&2; exit 2; }
[[ "$KB_MODE" == pg || "$KB_MODE" == s3vectors ]] || { echo "kb 方式只能是 pg 或 s3vectors" >&2; exit 2; }
[[ -z "$KB_PUBLICATION" || "$KB_PUBLICATION" =~ ^pub_[0-9a-f]{16}$ ]] || { echo "知识库 Agent 的发布编号应是 pub_ 加 16 位十六进制" >&2; exit 2; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SECRETS=/etc/andon-finance/secrets.env
DIR=/etc/andon-finance/jiuan

# >>> legacy-poc
# v0.5.3 PoC 拿掉之前的实例：先停掉它（它占着 4180），删掉单元、补充配置和转发设置；它的数据另行清理（docs/delivery/operations.md）
if [[ -f /etc/systemd/system/andon-finance-poc.service ]]; then
  systemctl disable --now andon-finance-poc.service >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/andon-finance-poc.service
fi
rm -rf /etc/systemd/system/andon-finance-poc.service.d
rm -f /etc/andon-finance/jiuan07-forward.env
# <<< legacy-poc

# >>> legacy-07
# 2026-11-02 之前的名字：服务 andon-jiuan07、用户和组 jiuan07、目录 /var/lib/jiuan07 和 /etc/andon-finance/jiuan07。
# 停掉旧服务、删掉单元，用户、组、目录原地改名（数据不动，uid / gid 不变）。
# 新名字已经有了就不动旧的：只在第一次部署新代码时真的做事，以后每次都是空跑
if [[ -f /etc/systemd/system/andon-jiuan07.service ]]; then
  systemctl disable --now andon-jiuan07.service >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/andon-jiuan07.service
  systemctl daemon-reload
fi
if id jiuan07 >/dev/null 2>&1 && ! id jiuan >/dev/null 2>&1; then
  usermod -l jiuan jiuan07
  groupmod -n jiuan jiuan07
fi
if [[ -d /var/lib/jiuan07 && ! -e /var/lib/jiuan ]]; then mv /var/lib/jiuan07 /var/lib/jiuan; fi
if id jiuan >/dev/null 2>&1 && [[ "$(getent passwd jiuan | cut -d: -f6)" == /var/lib/jiuan07 ]]; then usermod -d /var/lib/jiuan jiuan; fi
if [[ -d /etc/andon-finance/jiuan07 && ! -e /etc/andon-finance/jiuan ]]; then mv /etc/andon-finance/jiuan07 /etc/andon-finance/jiuan; fi
# <<< legacy-07

id jiuan >/dev/null 2>&1 || useradd --system --home-dir /var/lib/jiuan --create-home --shell /sbin/nologin jiuan
install -d -o jiuan -g jiuan -m 0700 /var/lib/jiuan /var/lib/jiuan/nexus /var/lib/jiuan/custom-rules
install -d -o root -g jiuan -m 0750 "$DIR"

# >>> jiuan-secret-files
# 数据密钥：数据按原来的密钥加密，secrets.env 里的值和实例上的不一样时一个文件都不写，直接失败。
# 库口令 db_app_password 不用钉住：PG 的账号口令每次部署都由 pg-database.sh 按 secrets.env 重设。
SECRET_FILES=(JIUAN_PG_APP_PASSWORD:db_app_password JIUAN_DATA_KEY:analysis_data_key REVIEWER_PASSWORD:reviewer_password CHECKER_PASSWORD:checker_password)
PINNED=(analysis_data_key)
secret_value() { sed -n "s/^$1=//p" "$SECRETS" | head -1; }
for pair in "${SECRET_FILES[@]}"; do
  key="${pair%%:*}"; file="${pair#*:}"; value="$(secret_value "$key")"
  [[ -n "$value" ]] || { echo "secrets.env 里缺少 ${key}" >&2; exit 1; }
  if [[ " ${PINNED[*]} " == *" $file "* && -f "$DIR/$file" && "$(cat "$DIR/$file")" != "$value" ]]; then
    echo "实例上的 ${file} 和 secrets.env 里的 ${key} 不一样，拒绝替换：v0.7.10 的库里的数据是按原来的值加密的" >&2
    exit 1
  fi
done
[[ "$(secret_value JIUAN_DATA_KEY)" =~ ^[A-Za-z0-9+/]{43}=$ ]] || { echo "secrets.env 里的 JIUAN_DATA_KEY 不是 32 字节的 base64" >&2; exit 1; }
[[ "$(secret_value JIUAN_PG_APP_PASSWORD)" =~ ^[0-9a-f]{32}$ ]] || { echo "secrets.env 里的 JIUAN_PG_APP_PASSWORD 应是 32 位十六进制" >&2; exit 1; }
# 2026-11-06 删了 MySQL：它留下的两个口令文件（没有也不出错）
rm -f "$DIR/mysql_app_password" /etc/andon-finance/bench/mysql_root_password
write_secret() {   # 文件名 值：root:jiuan 0640，先写临时文件再改名
  ( umask 077; printf '%s' "$2" > "$DIR/$1.new" )
  chown root:jiuan "$DIR/$1.new"; chmod 0640 "$DIR/$1.new"; mv "$DIR/$1.new" "$DIR/$1"
}
for pair in "${SECRET_FILES[@]}"; do write_secret "${pair#*:}" "$(secret_value "${pair%%:*}")"; done
# 假汇联易不校验凭据，九安的测试环境客户端只要求两个文件存在且非空
write_secret hly_app_id fake-hly-app-id-jiuan
write_secret hly_app_secret fake-hly-app-secret-jiuan
# <<< jiuan-secret-files

# >>> jiuan-kb
# 「规则库 › 制度知识库」两种 kb 方式一个样（服务的 env 里写 POC_KB_MODE，给了发布编号就写 POC_KB_PUBLICATION_ID）：
# 只建上传文件目录 /var/lib/jiuan/kb-uploads（0700）。不读 PG 主机的配置、不写任何密钥文件、不建 Python 环境
# （Agent 的调用密钥在「Agent 接入」页上启用）；以前直连 PG 时留下的连库密码文件有就删掉，上传目录里那时的解析结果 <id>.rules.json
# （从制度派生的规则全文）也删掉：只删这个目录第一层的普通文件，原文件、上传历史和别的都不动。
install -d -o jiuan -g jiuan -m 0700 /var/lib/jiuan/kb-uploads
rm -f "$DIR/kb_pg_password"
find "/var/lib/jiuan/kb-uploads" -maxdepth 1 -type f -name '*.rules.json' -delete
KB_LINES=""
[[ -z "$KB_PUBLICATION" ]] || KB_LINES="POC_KB_PUBLICATION_ID=$KB_PUBLICATION"
# <<< jiuan-kb

cat > "$DIR/env.new" <<ENV
POC_ORIGIN=https://$DOMAIN
POC_PORT=4180
POC_BIND=0.0.0.0
POC_SECRETS_DIR=$DIR
POC_DB_HOST=127.0.0.1
POC_DB_PORT=5433
POC_DB_NAME=jiuan
POC_DB_USER=jiuan_app
NEXUS_ORIGIN=$NEXUS
JIUAN_DIR=/opt/andon-finance/current/jiuan
NEXUS_OPERATOR=/opt/andon-finance/current/operator/scripts/nexus.py
POC_NEXUS_HOME=/var/lib/jiuan/nexus
TZ=Asia/Shanghai
NODE_ENV=production
POC_KB_MODE=$KB_MODE
${KB_LINES}
ENV
chown root:jiuan "$DIR/env.new"; chmod 0640 "$DIR/env.new"; mv "$DIR/env.new" "$DIR/env"

# >>> jiuan-database
bash "$HERE/pg-install.sh"
bash "$HERE/pg-database.sh" jiuan
# <<< jiuan-database

# >>> jiuan-hosts
# 九安 v0.7.10 代码里写死的外部地址（真汇联易、汇联易附件、九安内网、钉钉、OpenAI、SAP）：测试台上一律指到本机不存在的服务
HOSTS=(api.huilianyi.com apistage.huilianyi.com huoshantstapi.huilianyi.com helioscloud-uat.huilianyi.com oss-huilianyi.jiuan.com
  oapi.dingtalk.com api.openai.com finmcp.jiuan.local sap-mcp.local sub1api.jiuan.com sub1api.theunifiedcare.com)
sed -i '/^# >>> jiuan-blackhole/,/^# <<< jiuan-blackhole/d' /etc/hosts
{
  echo '# >>> jiuan-blackhole（bench-configure.sh 写入：九安 v0.7.10 写死的外部地址，测试台上不通）'
  for host in "${HOSTS[@]}"; do printf '0.0.0.0 %s\n:: %s\n' "$host" "$host"; done
  echo '# <<< jiuan-blackhole'
} >> /etc/hosts
# <<< jiuan-hosts

install -m 0644 "$HERE/andon-jiuan.service" /etc/systemd/system/andon-jiuan.service
systemctl daemon-reload
systemctl enable andon-jiuan.service >/dev/null 2>&1
echo "JIUAN_CONFIGURED $DOMAIN"
