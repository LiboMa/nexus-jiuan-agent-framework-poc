#!/usr/bin/env bash
# 构建测试台用的九安副本：复制九安开发包的 code/（不带 tests、deploy、node_modules）→ 按文件名顺序打补丁 → 装上锁定版本的依赖。
# source/ 下的开发包只读：这里只从它复制，不在它里面跑任何命令。依赖由 poc/bench/package.json 锁定，安装一律 --ignore-scripts。
# 先在临时目录里构建，全部成功才换到输出目录；任何一步失败，输出目录保持原样。
# 用法：build-jiuan.sh [--out <目录>] [--patches <目录>]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SOURCE="$ROOT/source/审核平台-测试环境开发包-v0.5.3/code"
OUT="$ROOT/.build/jiuan"
PATCHES="$ROOT/patches/jiuan-v0.5.3"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --patches) PATCHES="$2"; shift 2 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done
[[ -f "$SOURCE/analysis-server.mjs" ]] || { echo "找不到九安开发包：$SOURCE" >&2; exit 1; }

mkdir -p "$(dirname "$OUT")"
WORK="$(mktemp -d "${OUT%/}.build.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

rsync -a --exclude tests --exclude deploy --exclude node_modules --exclude .DS_Store "$SOURCE/" "$WORK/"

if [[ -d "$PATCHES" ]]; then
  while IFS= read -r file; do
    patch -p1 -N -s -d "$WORK" -i "$file" || { echo "补丁打不上：$file" >&2; exit 1; }
  done < <(find "$PATCHES" -maxdepth 1 -type f -name '*.patch' | LC_ALL=C sort)
fi

installed="$(node -e "try{process.stdout.write(require('$HERE/node_modules/mysql2/package.json').version)}catch{}")"
[[ "$installed" == "3.14.3" ]] || npm ci --ignore-scripts --omit=dev --no-audit --no-fund --prefix "$HERE" >/dev/null
rsync -a "$HERE/node_modules/" "$WORK/node_modules/"

rm -rf "$OUT"
mv "$WORK" "$OUT"
trap - EXIT
echo "JIUAN_BUILD_OK $OUT"
