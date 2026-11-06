#!/usr/bin/env bash
# 远端测试用的库（root，在实例上；remote-jiuan-tests.sh 每次跑测试前 create、跑完 drop）：
#   create  起两个单独的、用完即删的容器，数据只在内存里（--tmpfs），每次都是空库：
#             jiuan-test-mysql（mysql:8.0，127.0.0.1:3307——九安自带的集成测试只认这个隔离端口）
#             jiuan-test-pg（postgres:17，127.0.0.1:5434）
#           各有一个 jiuan_test 库和同名账号（PG 那边账号不是超级用户、是库的属主，和九安在用的 jiuan_app 一样；UTF8 / C / 上海时区）
#   drop    删掉这两个容器和口令文件
# 口令放在 /etc/andon-finance/test/ 下（root 0600），没有就生成；以只读文件挂进容器，不上命令行。
# 不碰在用的 jiuan-mysql、jiuan-pg 和它们的库。九安的集成测试还要求库名以 _test 结尾。
set -euo pipefail
DIR=/etc/andon-finance/test
password() {
  local file="$DIR/$1"
  [[ -s "$file" ]] || ( umask 077; openssl rand -hex 16 | tr -d '\n' > "$file" )
  chmod 0600 "$file"
}
wait_for() {
  local what="$1"; shift
  for _ in $(seq 1 90); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "$what 没起来" >&2
  return 1
}

case "${1:-}" in
  create)
    install -d -o root -g root -m 0700 "$DIR"
    for name in mysql_test_root_password mysql_test_password pg_test_superuser_password pg_test_password; do password "$name"; done
    docker rm -f jiuan-test-mysql jiuan-test-pg >/dev/null 2>&1 || true
    docker run -d --name jiuan-test-mysql \
      -p 127.0.0.1:3307:3306 \
      --tmpfs /var/lib/mysql:rw,size=2g \
      -v "$DIR":/run/test-secrets:ro \
      -e TZ=Asia/Shanghai \
      -e MYSQL_ROOT_PASSWORD_FILE=/run/test-secrets/mysql_test_root_password \
      -e MYSQL_DATABASE=jiuan_test -e MYSQL_USER=jiuan_test \
      -e MYSQL_PASSWORD_FILE=/run/test-secrets/mysql_test_password \
      mysql:8.0 --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci --skip-log-bin >/dev/null
    docker run -d --name jiuan-test-pg \
      -p 127.0.0.1:5434:5432 \
      --tmpfs /var/lib/postgresql/data:rw,size=2g \
      -v "$DIR":/run/test-secrets:ro \
      -e TZ=Asia/Shanghai \
      -e POSTGRES_PASSWORD_FILE=/run/test-secrets/pg_test_superuser_password \
      postgres:17 -c timezone=Asia/Shanghai -c log_timezone=Asia/Shanghai >/dev/null
    # 经 TCP 连得上才算好（初始化时的临时服务只开本地套接字）
    wait_for "jiuan-test-mysql" docker exec jiuan-test-mysql sh -c 'MYSQL_PWD="$(cat /run/test-secrets/mysql_test_password)" mysql -h127.0.0.1 -ujiuan_test jiuan_test -e "SELECT 1"'
    wait_for "jiuan-test-pg" docker exec jiuan-test-pg pg_isready -h 127.0.0.1 -U postgres -q
    docker exec -i -u postgres jiuan-test-pg psql -X -q -v ON_ERROR_STOP=1 -d postgres <<SQL >/dev/null
CREATE ROLE jiuan_test LOGIN PASSWORD '$(cat "$DIR/pg_test_password")';
CREATE DATABASE jiuan_test OWNER jiuan_test ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0;
ALTER DATABASE jiuan_test SET timezone = 'Asia/Shanghai';
REVOKE CONNECT ON DATABASE jiuan_test FROM PUBLIC;
SQL
    echo "TEST_DATABASES_READY"
    ;;
  drop)
    docker rm -f jiuan-test-mysql jiuan-test-pg >/dev/null 2>&1 || true
    rm -f "$DIR"/mysql_test_root_password "$DIR"/mysql_test_password "$DIR"/pg_test_superuser_password "$DIR"/pg_test_password
    echo "TEST_DATABASES_DROPPED"
    ;;
  *) echo "用法：test-databases.sh create|drop" >&2; exit 2 ;;
esac
