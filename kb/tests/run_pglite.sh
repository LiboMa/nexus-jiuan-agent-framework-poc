#!/usr/bin/env bash
#
# 本机测试用的 PostgreSQL：PGlite（WASM 里的 PostgreSQL）+ pgvector，经 TCP 给 psycopg 连（127.0.0.1，postgres 超级用户，
# 不校验密码，库在内存里：每次启动都是空库）。前台运行，Ctrl-C 停。
#
#   bash kb/tests/run_pglite.sh [port]          # 缺省 55432；8765 是项目负责人的服务，拒绝
#   KB_TEST_PG_PORT=55432 python3 -B -m unittest discover -s kb/tests -v
#
# 包装在 ${XDG_CACHE_HOME:-$HOME/.cache}/kb-pglite（不进仓库），没装才装。版本是 2026-10-30 在本机实测过的：
# PGlite 0.5.13（PostgreSQL 18.6）、pglite-socket 0.2.16、pglite-pgvector 0.0.14（pgvector 0.8.7）。
#
# --max-connections：PGlite 只有一个后端。缺省只收 1 个连接，第 2 个会被直接断开；放宽后可以同时连多个，
# 但同一时刻只有一个事务在跑，其余连接排队等它结束（见 pg_harness.py 的说明）。
set -euo pipefail

port="${1:-55432}"
case "$port" in
  ''|*[!0-9]*) echo "端口要是数字：$port" >&2; exit 2 ;;
  8765) echo "8765 是项目负责人的服务，换一个端口（缺省 55432）" >&2; exit 2 ;;
esac

dir="${XDG_CACHE_HOME:-$HOME/.cache}/kb-pglite"
pkgs=(@electric-sql/pglite@0.5.13 @electric-sql/pglite-socket@0.2.16 @electric-sql/pglite-pgvector@0.0.14)

command -v npm >/dev/null 2>&1 || { echo "没有 npm（Node.js）：先装 Node 20+" >&2; exit 1; }
mkdir -p "$dir"
if [ ! -x "$dir/node_modules/.bin/pglite-server" ] || [ ! -f "$dir/node_modules/@electric-sql/pglite-pgvector/package.json" ]; then
  echo "[pglite] 安装到 $dir：${pkgs[*]}" >&2
  [ -f "$dir/package.json" ] || printf '{"name":"kb-pglite","private":true}\n' > "$dir/package.json"
  (cd "$dir" && npm install --save-exact --no-fund --no-audit --loglevel=error "${pkgs[@]}")
fi

cd "$dir"
echo "[pglite] 127.0.0.1:$port（Ctrl-C 停）" >&2
exec node_modules/.bin/pglite-server --host=127.0.0.1 --port="$port" --max-connections=8 \
  --extensions=@electric-sql/pglite-pgvector:vector
