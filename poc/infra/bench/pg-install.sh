#!/usr/bin/env bash
# 在实例上装好九安 v0.7.10 的 PostgreSQL（可以重复运行；bench-configure.sh 调用，换库的准备阶段也先跑一次；root 运行）：
#   1. 从 /etc/andon-finance/secrets.env 取 BENCH_PG_SUPERUSER_PASSWORD，写成 /etc/andon-finance/bench/pg_superuser_password（root 0600）；
#      实例上已有的值只认原值（库是按它初始化的），不一样就失败，什么都不写；
#   2. Docker → 容器 jiuan-pg（postgres:17，只听 127.0.0.1:5433，上海时区，和原来的 MySQL 一样）→ 等它就绪。
# 九安的库 jiuan 和账号 jiuan_app 由 bench-configure.sh 建。超级用户口令只经文件交给容器（POSTGRES_PASSWORD_FILE，目录只读挂进容器），
# 不出现在命令行和日志里；容器的入口脚本以 root 读这个文件，所以它可以只给 root 读。知识库的那个 PG 容器不归这里管。
set -euo pipefail
SECRETS=/etc/andon-finance/secrets.env
DIR=/etc/andon-finance/bench
KEY=BENCH_PG_SUPERUSER_PASSWORD
value="$(sed -n "s/^${KEY}=//p" "$SECRETS" | head -1)"
[[ -n "$value" ]] || { echo "secrets.env 里缺少 ${KEY}" >&2; exit 1; }
install -d -o root -g root -m 0700 "$DIR"
if [[ -f "$DIR/pg_superuser_password" && "$(cat "$DIR/pg_superuser_password")" != "$value" ]]; then
  echo "实例上的 pg_superuser_password 和 secrets.env 里的 BENCH_PG_SUPERUSER_PASSWORD 不一样，拒绝替换：PostgreSQL 是按原来的值初始化的" >&2
  exit 1
fi
( umask 077; printf '%s' "$value" > "$DIR/pg_superuser_password.new" )
chown root:root "$DIR/pg_superuser_password.new"; chmod 0600 "$DIR/pg_superuser_password.new"
mv "$DIR/pg_superuser_password.new" "$DIR/pg_superuser_password"
if ! command -v docker >/dev/null 2>&1; then
  for attempt in 1 2 3; do dnf install -y docker && break; sleep 10; done
fi
systemctl enable --now docker
# 容器在但参数不对（镜像、端口、时区）：只换容器，数据目录 /var/lib/jiuan-pg 原样挂回去
if docker inspect jiuan-pg >/dev/null 2>&1; then
  image="$(docker inspect -f '{{.Config.Image}}' jiuan-pg)"
  ports="$(docker inspect -f '{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}{{.HostIp}}:{{.HostPort}}->{{$p}} {{end}}{{end}}' jiuan-pg)"
  tz="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' jiuan-pg | sed -n 's/^TZ=//p')"
  if [[ "$image" != postgres:17 || "$ports" != "127.0.0.1:5433->5432/tcp " || "$tz" != Asia/Shanghai ]]; then
    docker rm -f jiuan-pg >/dev/null
    echo "BENCH_PG_CONTAINER_REPLACED"
  fi
fi
if ! docker inspect jiuan-pg >/dev/null 2>&1; then
  mkdir -p /var/lib/jiuan-pg
  docker run -d --name jiuan-pg --restart unless-stopped \
    -p 127.0.0.1:5433:5432 \
    -v /var/lib/jiuan-pg:/var/lib/postgresql/data \
    -v "$DIR":/run/bench-secrets:ro \
    -e TZ=Asia/Shanghai \
    -e POSTGRES_PASSWORD_FILE=/run/bench-secrets/pg_superuser_password \
    postgres:17 -c timezone=Asia/Shanghai -c log_timezone=Asia/Shanghai >/dev/null
fi
docker start jiuan-pg >/dev/null
ready=false
for attempt in $(seq 1 60); do
  if docker exec -u postgres jiuan-pg pg_isready -q -h 127.0.0.1 -p 5432 >/dev/null 2>&1; then ready=true; break; fi
  sleep 2
done
$ready || { echo "PostgreSQL 没有在 120 秒内就绪（jiuan-pg）" >&2; exit 1; }
echo "BENCH_PG_READY"
