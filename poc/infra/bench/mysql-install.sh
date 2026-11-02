#!/usr/bin/env bash
# 在实例上装好测试台的 MySQL（可以重复运行；bench07-configure.sh 调用，root 运行）：
#   1. 从 /etc/andon-finance/secrets.env 取 BENCH_MYSQL_ROOT_PASSWORD，写成 /etc/andon-finance/bench/mysql_root_password（root 0600）；
#      实例上已有的值只认原值（库是按它建的，换了就连不上），不一样就失败，什么都不写；
#   2. Docker → 容器 jiuan-mysql（mysql:8.0，只听 127.0.0.1:3306，参数照九安的 compose.test.yaml）→ 等它就绪。
# 九安 v0.7.10 的库 jiuan07 和它的账号由 bench07-configure.sh 建。密码只经文件传给容器（*_FILE，目录只读挂进容器），不出现在命令行和日志里。
set -euo pipefail
SECRETS=/etc/andon-finance/secrets.env
DIR=/etc/andon-finance/bench
KEY=BENCH_MYSQL_ROOT_PASSWORD
value="$(sed -n "s/^${KEY}=//p" "$SECRETS" | head -1)"
[[ -n "$value" ]] || { echo "secrets.env 里缺少 ${KEY}" >&2; exit 1; }
install -d -o root -g root -m 0700 "$DIR"
if [[ -f "$DIR/mysql_root_password" && "$(cat "$DIR/mysql_root_password")" != "$value" ]]; then
  echo "实例上的 mysql_root_password 和 secrets.env 里的 BENCH_MYSQL_ROOT_PASSWORD 不一样，拒绝替换：MySQL 是按原来的值建的" >&2
  exit 1
fi
( umask 077; printf '%s' "$value" > "$DIR/mysql_root_password.new" )
chown root:root "$DIR/mysql_root_password.new"; chmod 0600 "$DIR/mysql_root_password.new"
mv "$DIR/mysql_root_password.new" "$DIR/mysql_root_password"
if ! command -v docker >/dev/null 2>&1; then
  for attempt in 1 2 3; do dnf install -y docker && break; sleep 10; done
fi
systemctl enable --now docker
if ! docker inspect jiuan-mysql >/dev/null 2>&1; then
  mkdir -p /var/lib/jiuan-mysql
  docker run -d --name jiuan-mysql --restart unless-stopped \
    -p 127.0.0.1:3306:3306 \
    -v /var/lib/jiuan-mysql:/var/lib/mysql \
    -v "$DIR":/run/bench-secrets:ro \
    -e TZ=Asia/Shanghai \
    -e MYSQL_ROOT_PASSWORD_FILE=/run/bench-secrets/mysql_root_password \
    mysql:8.0 --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci --skip-log-bin >/dev/null
fi
docker start jiuan-mysql >/dev/null
ready=false
for attempt in $(seq 1 60); do
  if docker exec jiuan-mysql sh -c 'MYSQL_PWD="$(cat /run/bench-secrets/mysql_root_password)" mysqladmin ping -uroot --silent' >/dev/null 2>&1; then ready=true; break; fi
  sleep 2
done
$ready || { echo "MySQL 没有在 120 秒内就绪" >&2; exit 1; }
echo "BENCH_MYSQL_READY"
