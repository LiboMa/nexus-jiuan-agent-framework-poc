#!/usr/bin/env bash
# 部署时在重启服务之前配置测试台（deploy.sh 经 SSM 调用，root 运行）：
#   1. 从 /etc/andon-finance/secrets.env 取出三项测试台密钥，写成 /etc/andon-finance/bench/ 下的文件（root:andon 0640）；实例上已有的值只认原值；
#   2. 写 /etc/andon-finance/bench.env，装服务的 systemd 补充配置（它读 bench.env）；
#   3. mysql 模式下装好或确认 MySQL（mysql-install.sh）；memory 模式不碰 MySQL。
# 用法：bench-configure.sh <memory|mysql>。不打印任何密钥。
set -euo pipefail
STORE="${1:-}"
case "$STORE" in memory|mysql) ;; *) echo "用法：bench-configure.sh <memory|mysql>" >&2; exit 2 ;; esac
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SECRETS=/etc/andon-finance/secrets.env
DIR=/etc/andon-finance/bench
install -d -o root -g andon -m 0750 "$DIR"
# >>> bench-secret-files（测试会单独跑这一段）
# 实例上已有的值只认原值：MySQL 容器和九安的库都是按原来的值建的，换了服务就起不来。secrets.env 里的值和实例上的不一样时，
# 一个文件都不写，直接失败（deploy.sh 这一步失败，不会重启服务）。真要换值，先有意重建测试台。
SECRET_FILES=(BENCH_MYSQL_ROOT_PASSWORD:mysql_root_password BENCH_MYSQL_APP_PASSWORD:mysql_app_password BENCH_DATA_KEY:analysis_data_key)
secret_value() { sed -n "s/^$1=//p" "$SECRETS" | head -1; }
for pair in "${SECRET_FILES[@]}"; do
  key="${pair%%:*}"; file="${pair#*:}"; value="$(secret_value "$key")"
  [[ -n "$value" ]] || { echo "secrets.env 里缺少 ${key}" >&2; exit 1; }
  if [[ -f "$DIR/$file" && "$(cat "$DIR/$file")" != "$value" ]]; then
    echo "实例上的 ${file} 和 secrets.env 里的 ${key} 不一样，拒绝替换：MySQL 和九安的库用的是原来的值。要换就先有意重建测试台" >&2
    exit 1
  fi
done
[[ "$(secret_value BENCH_DATA_KEY)" =~ ^[A-Za-z0-9+/]{43}=$ ]] || { echo "secrets.env 里的 BENCH_DATA_KEY 不是 32 字节的 base64" >&2; exit 1; }
for pair in "${SECRET_FILES[@]}"; do
  key="${pair%%:*}"; file="${pair#*:}"; value="$(secret_value "$key")"
  ( umask 077; printf '%s' "$value" > "$DIR/$file.new" )
  chown root:andon "$DIR/$file.new"
  chmod 0640 "$DIR/$file.new"
  mv "$DIR/$file.new" "$DIR/$file"
done
# <<< bench-secret-files
cat > /etc/andon-finance/bench.env.new <<ENV
POC_STORE=$STORE
BENCH_MYSQL_HOST=127.0.0.1
BENCH_MYSQL_PORT=3306
BENCH_MYSQL_DATABASE=jiuan_analysis
BENCH_MYSQL_USER=jiuan_app
BENCH_SECRETS_DIR=$DIR
ENV
chmod 0644 /etc/andon-finance/bench.env.new
mv /etc/andon-finance/bench.env.new /etc/andon-finance/bench.env
# >>> store-setup（测试会单独跑这一段）
# systemd 补充配置两种存储都要（服务靠它读 bench.env）；MySQL 只在 mysql 模式下装和等：回到内存存储是 MySQL 坏了时的退路，不能被它拦住。
install -d -m 0755 /etc/systemd/system/andon-finance-poc.service.d
install -m 0644 "$HERE/andon-finance-bench.conf" /etc/systemd/system/andon-finance-poc.service.d/andon-finance-bench.conf
systemctl daemon-reload
if [[ "$STORE" == mysql ]]; then bash "$HERE/mysql-install.sh"; fi
# <<< store-setup
echo "BENCH_CONFIGURED $STORE"
