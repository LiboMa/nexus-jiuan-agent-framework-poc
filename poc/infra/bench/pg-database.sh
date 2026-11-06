#!/usr/bin/env bash
# 在容器 jiuan-pg 里建好九安的库和账号（可以重复运行；root 运行。bench-configure.sh 建 jiuan、bench-reset.sh 重建 jiuan、
# migrate-data.sh 换库、migrate-mysql-to-pg.sh --create-db 建目标库时调用；容器由 pg-install.sh 起）：
#   账号 jiuan_app：没有才建；能登录，不是超级用户、不能建库建角色；口令每次都按 secrets.env 的 JIUAN_PG_APP_PASSWORD 重设
#   （所以实例上的 db_app_password 不用钉住原值：换了口令，下一次部署两边一起换）；
#   库 <库名>（缺省 jiuan）：没有才建，属主 jiuan_app、UTF8、排序和字符类别 C（TEMPLATE template0）；已有的核对编码和排序，不对就停；
#   库的时区设成 Asia/Shanghai（和原来的 MySQL 一样，库自己生成的时间是上海时间）；REVOKE CONNECT … FROM PUBLIC，只有属主连得上。
# 口令只经标准输入进容器里的 psql，不上命令行；这个会话出错的语句不写进 PG 的日志（log_min_error_statement）。不打印口令。
# 用法：pg-database.sh [jiuan | jiuan_<小写字母数字>]
set -euo pipefail
DB="${1:-jiuan}"
SECRETS="${BENCH_SECRETS_FILE:-/etc/andon-finance/secrets.env}"
[[ "$DB" =~ ^jiuan(_[a-z0-9]+)*$ ]] || { echo "库名应是 jiuan 或 jiuan_<小写字母数字>：${DB}" >&2; exit 2; }
KEY=JIUAN_PG_APP_PASSWORD
password="$(sed -n "s/^${KEY}=//p" "$SECRETS" | head -1)"
[[ "$password" =~ ^[0-9a-f]{32}$ ]] || { echo "secrets.env 里的 JIUAN_PG_APP_PASSWORD 应是 32 位十六进制" >&2; exit 1; }
docker exec -i -u postgres jiuan-pg psql -X -q -v ON_ERROR_STOP=1 -v db="$DB" -d postgres <<SQL >/dev/null
SET log_min_error_statement = panic;
SELECT 'CREATE ROLE jiuan_app' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jiuan_app') \gexec
ALTER ROLE jiuan_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '$password';
SELECT format('CREATE DATABASE %I OWNER jiuan_app ENCODING %L LC_COLLATE %L LC_CTYPE %L TEMPLATE template0', :'db', 'UTF8', 'C', 'C')
  WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') \gexec
DO \$\$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_database WHERE datname = '$DB' AND (pg_encoding_to_char(encoding) <> 'UTF8' OR datcollate <> 'C' OR datctype <> 'C')) THEN
    RAISE EXCEPTION 'database % exists but is not UTF8 / C', '$DB';
  END IF;
END \$\$;
ALTER DATABASE :"db" OWNER TO jiuan_app;
ALTER DATABASE :"db" SET timezone = 'Asia/Shanghai';
REVOKE CONNECT ON DATABASE :"db" FROM PUBLIC;
SQL
echo "JIUAN_PG_DATABASE_READY $DB"
