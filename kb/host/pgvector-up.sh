#!/usr/bin/env bash
#
# 在 PG 主机上（经 SSM，以 root）启动 PostgreSQL + pgvector 容器，并确保应用库 / 用户 / vector 扩展存在。幂等。
#
# 输入（由 deploy.sh 以环境变量传入）：
#   PG_IMAGE PG_CONTAINER_NAME PG_PORT PG_BIND_IP PG_DATA_VOLUME PG_MEMORY_LIMIT PG_BASE_DIR
#   PG_DB_NAME PG_DB_USER PG_INSTALL_DOCKER
#   可选：KB_SEARCH_SQL_B64（sql/kb_search.sql 的 base64）+ EMBED_MODEL_ID EMBED_DIM AWS_REGION RULES_TABLE：
#         装 PL/Python（容器里就地装，不重启）并建库内语义检索 kb_embed / kb_search、上传历史、检索日志
#
# 行为：
#   - 新建的主机（create 模式）先等 cloud-init（user data 装 Docker）结束。
#   - 没有 Docker：PG_INSTALL_DOCKER=true 时用 dnf/yum 安装并启动，否则失败。
#   - 密码：首次运行在 $PG_BASE_DIR/.env（600）生成 postgres 超级用户与应用用户的随机密码，并写标记文件
#     $PG_BASE_DIR/.managed-by-pgvector-rules-kb（destroy --purge-data 只删带标记的目录）；之后复用。
#   - 容器已存在：运行中 → 不动；已停止 → docker start。端口绑定 / 镜像与配置不一致只告警，不自动重建
#     （重建会中断在用的连接，需人工确认后按 GUIDE.md 处理）。
#   - 应用密码的唯一来源是 .env：容器启动时的环境变量（官方镜像只在初始化时用）一概不用，因此接管别人起的容器、
#     或轮换密码（rotate-db-password）都不需要重建容器。
#   - 本脚本新建的容器与数据卷带 label managed-by=pgvector-rules-kb（destroy 只删带 label 的）。
#   - 每次都执行幂等 SQL：建应用用户（已存在则把密码同步为 .env 里的值）、建库（owner = 应用用户）、建 vector 扩展。
#     密码经 stdin 传给 psql，不出现在进程参数里。
#
# 输出：以 "RESULT key=value" 开头的行供 deploy.sh 解析；不输出任何密码。
set -euo pipefail

: "${PG_IMAGE:?}" "${PG_CONTAINER_NAME:?}" "${PG_PORT:?}" "${PG_DATA_VOLUME:?}" "${PG_MEMORY_LIMIT:?}"
: "${PG_BASE_DIR:?}" "${PG_DB_NAME:?}" "${PG_DB_USER:?}" "${PG_INSTALL_DOCKER:=true}" "${PG_BIND_IP:=}"

say() { echo "[host] $*"; }
result() { echo "RESULT $1=$2"; }

# ---- 1. Docker ----
# 新主机：等 user data（dnf install docker）跑完，避免与本脚本的 dnf 抢锁
if command -v cloud-init >/dev/null 2>&1; then timeout 600 cloud-init status --wait >/dev/null 2>&1 || true; fi
if ! command -v docker >/dev/null 2>&1; then
  [ "$PG_INSTALL_DOCKER" = "true" ] || { echo "目标主机没有 Docker，且 PG_INSTALL_DOCKER!=true" >&2; exit 1; }
  say "安装 Docker"
  if command -v dnf >/dev/null 2>&1; then dnf -y -q install docker; else yum -y -q install docker; fi
fi
systemctl is-active --quiet docker || systemctl enable --now docker
result docker_version "$(docker version --format '{{.Server.Version}}')"

# ---- 2. 绑定地址 ----
if [ -z "$PG_BIND_IP" ]; then
  tok="$(curl -sf -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' || true)"
  PG_BIND_IP="$(curl -sf -H "X-aws-ec2-metadata-token: $tok" http://169.254.169.254/latest/meta-data/local-ipv4 || true)"
  [ -n "$PG_BIND_IP" ] || { echo "无法从 IMDS 取得私网 IP，请在 deploy.env 里设置 PG_BIND_IP" >&2; exit 1; }
fi
result bind_ip "$PG_BIND_IP"

# ---- 3. 密码文件 ----
ENV_FILE="$PG_BASE_DIR/.env"
mkdir -p "$PG_BASE_DIR"; chmod 700 "$PG_BASE_DIR"
if [ ! -s "$ENV_FILE" ]; then
  umask 077
  printf 'POSTGRES_PASSWORD=%s\nNEXUS_DB_USER=%s\nNEXUS_DB_PASSWORD=%s\nNEXUS_DB_NAME=%s\n' \
    "$(openssl rand -hex 24)" "$PG_DB_USER" "$(openssl rand -hex 24)" "$PG_DB_NAME" > "$ENV_FILE"
  echo "created $(date -u +%Y-%m-%dT%H:%M:%SZ) container=$PG_CONTAINER_NAME volume=$PG_DATA_VOLUME" > "$PG_BASE_DIR/.managed-by-pgvector-rules-kb"
  result env_file created
else
  result env_file reused
fi
chmod 600 "$ENV_FILE"
for k in POSTGRES_PASSWORD NEXUS_DB_USER NEXUS_DB_PASSWORD NEXUS_DB_NAME; do
  grep -q "^$k=" "$ENV_FILE" || { echo "$ENV_FILE 缺少 $k" >&2; exit 1; }
done
APP_PW="$(sed -n 's/^NEXUS_DB_PASSWORD=//p' "$ENV_FILE")"
[ -n "$APP_PW" ] || { echo "$ENV_FILE 里的 NEXUS_DB_PASSWORD 为空" >&2; exit 1; }
case "$APP_PW" in *"'"*|*"\\"*) echo "$ENV_FILE 里的 NEXUS_DB_PASSWORD 含引号或反斜杠，请改用 openssl rand -hex 生成的值" >&2; exit 1 ;; esac
env_user="$(sed -n 's/^NEXUS_DB_USER=//p' "$ENV_FILE")"
env_db="$(sed -n 's/^NEXUS_DB_NAME=//p' "$ENV_FILE")"
if [ "$env_user" != "$PG_DB_USER" ] || [ "$env_db" != "$PG_DB_NAME" ]; then
  echo "$ENV_FILE 里的 NEXUS_DB_USER/NEXUS_DB_NAME（$env_user/$env_db）与配置（$PG_DB_USER/$PG_DB_NAME）不一致；" \
       "请改 deploy.env 与之对齐，或备份后删掉该文件重新生成" >&2
  exit 1
fi

# ---- 4. 容器 ----
if docker inspect "$PG_CONTAINER_NAME" >/dev/null 2>&1; then
  running="$(docker inspect -f '{{.State.Running}}' "$PG_CONTAINER_NAME")"
  if [ "$running" = "true" ]; then
    result container_action unchanged
  else
    docker start "$PG_CONTAINER_NAME" >/dev/null
    result container_action started
  fi
  cur_image="$(docker inspect -f '{{.Config.Image}}' "$PG_CONTAINER_NAME")"
  cur_bind="$(docker inspect -f '{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}{{.HostIp}}:{{.HostPort}} {{end}}{{end}}' "$PG_CONTAINER_NAME" | xargs)"
  [ "$cur_image" = "$PG_IMAGE" ] || echo "[host] WARN 容器镜像 $cur_image 与配置 $PG_IMAGE 不一致（未自动重建）"
  [ "$cur_bind" = "$PG_BIND_IP:$PG_PORT" ] || echo "[host] WARN 容器端口绑定 '$cur_bind' 与配置 '$PG_BIND_IP:$PG_PORT' 不一致（未自动重建）"
  result managed_label "$(docker inspect -f '{{index .Config.Labels "managed-by"}}' "$PG_CONTAINER_NAME")"
else
  if ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq "^(0\.0\.0\.0|\*|\[::\]|${PG_BIND_IP//./\\.}):${PG_PORT}$"; then
    echo "主机上已有其他进程监听 ${PG_BIND_IP}:${PG_PORT}（或 0.0.0.0:${PG_PORT}），换一个 PG_PORT" >&2
    exit 1
  fi
  say "拉取镜像 $PG_IMAGE"
  docker pull -q "$PG_IMAGE" >/dev/null
  if docker volume inspect "$PG_DATA_VOLUME" >/dev/null 2>&1; then
    result volume_action reused
  else
    docker volume create --label "managed-by=pgvector-rules-kb" "$PG_DATA_VOLUME" >/dev/null
    result volume_action created
  fi
  docker run -d --name "$PG_CONTAINER_NAME" --restart unless-stopped --memory "$PG_MEMORY_LIMIT" \
    -p "$PG_BIND_IP:$PG_PORT:5432" --env-file "$ENV_FILE" \
    -v "$PG_DATA_VOLUME:/var/lib/postgresql/data" \
    --label "managed-by=pgvector-rules-kb" \
    "$PG_IMAGE" >/dev/null
  result container_action created
fi
result image_digest "$(docker image inspect "$PG_IMAGE" --format '{{index .RepoDigests 0}}' 2>/dev/null || echo unknown)"

# ---- 5. 等待就绪（首次初始化约 5~15 秒）----
ready=false
for _ in $(seq 1 60); do
  if docker exec "$PG_CONTAINER_NAME" pg_isready -h 127.0.0.1 -q 2>/dev/null; then ready=true; break; fi
  sleep 2
done
$ready || { docker logs --tail 40 "$PG_CONTAINER_NAME" >&2; echo "PostgreSQL 120 秒内没有就绪" >&2; exit 1; }

# ---- 6. 应用用户 / 库 / 扩展（幂等）----
# 经容器内本地 socket 以 postgres 超级用户执行；应用密码取自 .env，经 stdin 的 \set 传入（不进进程参数）。
{ printf "\\set app_pw '%s'\n" "$APP_PW"; cat <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'app_user', :'app_pw')
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'app_user') \gexec
SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', :'app_user', :'app_pw') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'app_db', :'app_user')
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'app_db') \gexec
\connect :app_db
CREATE EXTENSION IF NOT EXISTS vector;
SQL
} | docker exec -i -e APP_USER="$PG_DB_USER" -e APP_DB="$PG_DB_NAME" "$PG_CONTAINER_NAME" sh -c \
  'psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres -v app_user="$APP_USER" -v app_db="$APP_DB"'

# ---- 6b. 库内语义检索（sql/kb_search.sql）：给了 KB_SEARCH_SQL_B64 才做 ----
# 官方镜像不带 PL/Python：没有就在运行中的容器里用 apt 装（PGDG 源镜像里已配好）。PG 在 CREATE EXTENSION 时才加载它，
# 不重启、不停机，数据卷和端口绑定都不动。装的东西在容器的可写层里：容器被重建后，下一次 db 阶段会再装。
if [ -n "${KB_SEARCH_SQL_B64:-}" ]; then
  : "${EMBED_MODEL_ID:?}" "${EMBED_DIM:?}" "${AWS_REGION:?}" "${RULES_TABLE:?}"
  avail="$(docker exec "$PG_CONTAINER_NAME" psql -X -At -U postgres -d "$PG_DB_NAME" -c "SELECT count(*) FROM pg_available_extensions WHERE name = 'plpython3u'")"
  if [ "$avail" = "0" ]; then
    say "在容器里装 PL/Python（postgresql-plpython3-17、python3-boto3；不重启 PostgreSQL）"
    docker exec -u 0 "$PG_CONTAINER_NAME" sh -c 'apt-get update -qq && apt-get install -y -qq --no-install-recommends postgresql-plpython3-17 python3-boto3' >/dev/null
    result plpython installed
  else
    result plpython present
  fi
  printf '%s' "$KB_SEARCH_SQL_B64" | base64 -d \
    | sed -e "s/{table}/$RULES_TABLE/g" -e "s/{dim}/$EMBED_DIM/g" -e "s|{model}|$EMBED_MODEL_ID|g" -e "s/{region}/$AWS_REGION/g" -e "s/{app_user}/$PG_DB_USER/g" \
    | docker exec -i "$PG_CONTAINER_NAME" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$PG_DB_NAME" >/dev/null
  result kb_search ready
fi

# ---- 7. 自检：用应用用户经 TCP（SCRAM）登录，密码取自 .env，经 stdin 传入 ----
printf '%s\n' "$APP_PW" | docker exec -i -e APP_USER="$PG_DB_USER" -e APP_DB="$PG_DB_NAME" "$PG_CONTAINER_NAME" sh -c \
  'read -r PGPASSWORD; export PGPASSWORD; psql -X -At -h 127.0.0.1 -U "$APP_USER" -d "$APP_DB" -c "select current_setting('"'"'server_version'"'"'), (select extversion from pg_extension where extname='"'"'vector'"'"'), current_setting('"'"'password_encryption'"'"')"' \
  | awk -F'|' '{print "RESULT pg_version="$1; print "RESULT vector_version="$2; print "RESULT password_encryption="$3}'
result listen "$(ss -ltnH 2>/dev/null | awk '{print $4}' | grep -E ":${PG_PORT}$" | xargs)"
result container_state "$(docker inspect -f '{{.State.Status}}' "$PG_CONTAINER_NAME")"
