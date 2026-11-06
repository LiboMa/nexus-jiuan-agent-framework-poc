#!/usr/bin/env bash
# 远端测试用的库（root，在实例上；远端跑测试和换库的准备阶段调用）：
#   create  PostgreSQL（jiuan-pg）和 MySQL（jiuan-mysql）里各建一个 jiuan_test 和同名账号；先删再建，每次都是空库
#   drop    两边都删掉（库、账号）和口令文件
# 九安自带的集成测试要求库名以 _test 结尾。口令放在 /etc/andon-finance/test/ 下（root 0600），没有就生成；只经标准输入进容器。
# 不碰九安在用的库 jiuan。MySQL 容器不在（切换以后）就只管 PostgreSQL 那边。
set -euo pipefail
DIR=/etc/andon-finance/test
pg() { docker exec -i -u postgres jiuan-pg psql -X -q -v ON_ERROR_STOP=1 -d postgres; }
mysql_root() { docker exec -i jiuan-mysql sh -c 'MYSQL_PWD="$(cat /run/bench-secrets/mysql_root_password)" exec mysql -uroot'; }
have_mysql() { docker inspect -f '{{.State.Running}}' jiuan-mysql 2>/dev/null | grep -q true; }
password() {
  local file="$DIR/$1"
  [[ -s "$file" ]] || ( umask 077; openssl rand -hex 16 | tr -d '\n' > "$file" )
  chmod 0600 "$file"; cat "$file"
}

case "${1:-}" in
  create)
    install -d -o root -g root -m 0700 "$DIR"
    pg <<SQL
DROP DATABASE IF EXISTS jiuan_test WITH (FORCE);
DROP ROLE IF EXISTS jiuan_test;
CREATE ROLE jiuan_test LOGIN PASSWORD '$(password pg_test_password)';
CREATE DATABASE jiuan_test OWNER jiuan_test ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0;
ALTER DATABASE jiuan_test SET timezone = 'Asia/Shanghai';
SQL
    if have_mysql; then
      mysql_root <<SQL
DROP DATABASE IF EXISTS \`jiuan_test\`;
DROP USER IF EXISTS 'jiuan_test'@'%';
CREATE DATABASE \`jiuan_test\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'jiuan_test'@'%' IDENTIFIED BY '$(password mysql_test_password)';
GRANT ALL PRIVILEGES ON \`jiuan_test\`.* TO 'jiuan_test'@'%';
SQL
    fi
    echo "TEST_DATABASES_READY"
    ;;
  drop)
    pg <<'SQL'
DROP DATABASE IF EXISTS jiuan_test WITH (FORCE);
DROP ROLE IF EXISTS jiuan_test;
SQL
    if have_mysql; then
      mysql_root <<'SQL'
DROP DATABASE IF EXISTS `jiuan_test`;
DROP USER IF EXISTS 'jiuan_test'@'%';
SQL
    fi
    rm -f "$DIR/pg_test_password" "$DIR/mysql_test_password"
    echo "TEST_DATABASES_DROPPED"
    ;;
  *) echo "用法：test-databases.sh create|drop" >&2; exit 2 ;;
esac
