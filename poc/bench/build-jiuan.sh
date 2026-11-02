#!/usr/bin/env bash
# 构建测试台用的九安 v0.7.10 副本：按清单复制开发包里运行时要的文件 → 按文件名顺序打补丁（patches/jiuan-v0.7.10）→ 装上锁定版本的依赖。
# 清单照九安自己的 .dockerignore，但不带 scripts/ 和 seeds/：启动由 PoC 的外壳负责（poc/app），种子用我们的虚构版。
# seeds/（未脱敏的银行账号等）、database/、tests/、deploy/ 一律不进构件；source/ 下的开发包只读，只从它复制。
# 先在临时目录里构建，全部成功才换到输出目录；任何一步失败，输出目录保持原样。
# 用法：build-jiuan.sh [--out <目录>] [--patches <目录>]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SOURCE="$ROOT/source/九安自助审核平台-测试环境开发包-v0.7.10"
OUT="$ROOT/.build/jiuan"
PATCHES="$ROOT/patches/jiuan-v0.7.10"
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

cp "$SOURCE/analysis-server.mjs" "$SOURCE/package.json" "$WORK/"
# 旧版页面、密钥类文件和缓存不带（同九安 .dockerignore）
rsync -a --exclude '.env' --exclude '.env.*' --exclude 'secrets/' --exclude '*.pem' --exclude '*.key' --exclude '*.pfx' --exclude '*.dpapi' \
  --exclude '*.enc.json' --exclude '*.log' --exclude '__pycache__/' --exclude '*.pyc' --exclude '.DS_Store' \
  --exclude '/public/index.html' --exclude '/public/app.js' --exclude '/public/styles.css' --exclude '/public/stage.*' --exclude '/public/attachment-viewer.*' \
  --include '/src/***' --include '/providers/***' --include '/public/***' --exclude '*' \
  "$SOURCE/" "$WORK/"

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
