#!/usr/bin/env bash
# 在实例上装好测试台的 MySQL（可以重复运行）：Docker → 容器 jiuan-mysql（mysql:8.0，只听 127.0.0.1:3306，参数照九安的 compose.test.yaml）
# → 等它就绪。以 root 运行（bench-configure.sh 在 mysql 模式下调用；服务的 systemd 补充配置由 bench-configure.sh 装）。
# 密码只经文件传给容器（*_FILE，目录只读挂进容器），不出现在命令行和日志里。
set -euo pipefail
SECRETS=/etc/andon-finance/bench
for file in mysql_root_password mysql_app_password; do
  [[ -s "$SECRETS/$file" ]] || { echo "缺少 $SECRETS/$file" >&2; exit 1; }
done
if ! command -v docker >/dev/null 2>&1; then
  for attempt in 1 2 3; do dnf install -y docker && break; sleep 10; done
fi
systemctl enable --now docker
if ! docker inspect jiuan-mysql >/dev/null 2>&1; then
  mkdir -p /var/lib/jiuan-mysql
  docker run -d --name jiuan-mysql --restart unless-stopped \
    -p 127.0.0.1:3306:3306 \
    -v /var/lib/jiuan-mysql:/var/lib/mysql \
    -v "$SECRETS":/run/bench-secrets:ro \
    -e TZ=Asia/Shanghai \
    -e MYSQL_ROOT_PASSWORD_FILE=/run/bench-secrets/mysql_root_password \
    -e MYSQL_DATABASE=jiuan_analysis \
    -e MYSQL_USER=jiuan_app \
    -e MYSQL_PASSWORD_FILE=/run/bench-secrets/mysql_app_password \
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
