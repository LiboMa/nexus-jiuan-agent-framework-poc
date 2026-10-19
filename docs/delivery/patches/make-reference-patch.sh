#!/usr/bin/env bash
# 生成「PoC 现状的前端改动」参考补丁：九安 v0.5.3 原前端（public/）→ PoC 的前端副本（build-public.mjs 的输出）。
#   docs/delivery/patches/make-reference-patch.sh
# 输出 v0.5.3/poc-frontend-reference.patch，并在一份干净的副本上用 patch --dry-run --fuzz=0 验证能原样打上。
# 这是参考，不是交付给九安的补丁：里面包含只给 PoC 演示用的改动（口令登录、横幅、导航裁剪），见 ../integration.md 第 5 节。
# 只读九安开发包，不执行其中任何东西。
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
JIUAN_CODE_DIR="${JIUAN_CODE_DIR:-$ROOT/source/审核平台-测试环境开发包-v0.5.3/code}"
SRC="$JIUAN_CODE_DIR/public"
OUT="$HERE/v0.5.3/poc-frontend-reference.patch"
[[ -f "$SRC/analysis.js" ]] || { echo "找不到九安原前端：$SRC" >&2; exit 1; }

(cd "$ROOT/poc/app" && JIUAN_CODE_DIR="$JIUAN_CODE_DIR" node scripts/build-public.mjs >/dev/null)

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp -R "$SRC" "$work/a"
cp -R "$ROOT/poc/app/public" "$work/b"
# PoC 不带钉钉 SDK（vendor/），交给九安时它照旧在：不算改动。
[[ -d "$work/a/vendor" && ! -d "$work/b/vendor" ]] && cp -R "$work/a/vendor" "$work/b/vendor"
find "$work" -name .DS_Store -delete
mkdir -p "$(dirname "$OUT")"
# 去掉文件时间戳，同样的输入生成同样的补丁。
(cd "$work" && { command diff -ruN a b || [[ $? -eq 1 ]]; }) \
  | awk -F'\t' '/^(---|\+\+\+) / && /\t[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] / { print $1; next } { print }' > "$OUT"

cp -R "$SRC" "$work/check"
(cd "$work/check" && patch -p1 --dry-run --fuzz=0 --quiet < "$OUT")
echo "已生成 ${OUT}（$(grep -c '^@@' "$OUT") 处改动，$(grep -c '^+++ ' "$OUT") 个文件），在干净的副本上 --dry-run --fuzz=0 通过"
