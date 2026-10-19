#!/usr/bin/env bash
# 生成交付包：dist/<版本>.tar.gz（版本取自根目录的 VERSION，空格换成 -，如 Finance-Audit-Nexus-PoC-v0.1；+ .sha256，包内有 MANIFEST.txt）。说明见 package-guide.md。
#   docs/delivery/make-package.sh               跑完全部检查再出包
#   docs/delivery/make-package.sh --skip-checks 跳过测试与文档检查（只在排查打包问题时用；密钥检查永远会跑）
# 只按白名单拷文件；暂存目录里出现 secrets.env、像密钥的字符串、或本机 secrets.env 里任何一个真实的值，就不出包（只报文件名，不打印值）。
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
VERSION_NAME="$(head -1 "$ROOT/VERSION")"
[[ -n "$VERSION_NAME" ]] || { echo "根目录的 VERSION 是空的" >&2; exit 1; }
NAME="${VERSION_NAME// /-}"
DIST="$ROOT/dist"
SECRETS="$ROOT/poc/infra/secrets.env"
say() { printf '\n== %s\n' "$*"; }
CHECKS=true
[[ "${1:-}" == "--skip-checks" ]] && CHECKS=false

if $CHECKS; then
  say "单元测试与命令行测试"
  (cd "$ROOT/poc/app" && node --test "test/unit/**/*.test.mjs" >/dev/null) && echo "单元测试通过"
  (cd "$ROOT" && python3 -B -m unittest discover -s skills/agent-access/tests >/dev/null 2>&1) && echo "命令行测试通过"
  say "图和 HTML 是不是最新的"
  "$ROOT/docs/build-html.sh" --check
  say "参考补丁"
  "$ROOT/docs/delivery/patches/make-reference-patch.sh"
  say "开发进度：校验清单、重出快照（docs/progress.html）"
  node "$ROOT/tools/progress/check.mjs"
  node "$ROOT/tools/progress/snapshot.mjs"
fi

say "按白名单暂存"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
stage="$work/$NAME"
mkdir -p "$stage"
EXCLUDES=(--exclude .DS_Store --exclude node_modules --exclude __pycache__ --exclude '*.tmp' --exclude '.gallery.html')
copy() { mkdir -p "$stage/$(dirname "$1")"; rsync -a "${EXCLUDES[@]}" "${@:2}" "$ROOT/$1" "$stage/$(dirname "$1")/"; }
copy README.md
copy VERSION
copy CHANGELOG.md
copy docs
copy poc/app --exclude /app/public
copy poc/infra --exclude secrets.env --exclude design-jiuan-nexus-integrate.md
copy poc/bench
copy poc/tools
copy tools
copy progress.json
copy poc/README.md
copy skills
copy knowledge-agent
copy contract
copy evidence

say "密钥检查"
hits="$work/hits.txt"; : > "$hits"
find "$stage" -name 'secrets.env*' -o -name '*.pem' -o -name 'credentials.json' | sed "s|$stage/||" >> "$hits"
grep -rIlE 'nx[acp]_[A-Za-z0-9_-]{20,}|afp_[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----' "$stage" | sed "s|$stage/||" >> "$hits" || true
if [[ -f "$SECRETS" ]]; then
  # 本机 secrets.env 里每个长度 ≥ 8 的值都不能出现在包里（值只在本进程的内存里，不打印）
  values="$work/values.txt"
  sed -nE 's/^[A-Za-z_][A-Za-z0-9_]*=(.{8,})$/\1/p' "$SECRETS" | sed -E "s/^(['\"])(.*)\\1$/\\2/" > "$values"
  if [[ -s "$values" ]]; then grep -rIlF -f "$values" "$stage" | sed "s|$stage/||" >> "$hits" || true; fi
  rm -f "$values"
fi
if [[ -s "$hits" ]]; then
  echo "密钥检查没通过，不出包。可疑文件：" >&2
  sort -u "$hits" >&2
  exit 1
fi
echo "没有发现密钥"

say "清单与打包"
{
  echo "交付包：${NAME}（${VERSION_NAME}）"
  echo "生成时间：$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "检查：$($CHECKS && echo '单元测试、命令行测试、图和 HTML、参考补丁、进度清单都通过' || echo '跳过了测试与文档检查（--skip-checks）')；密钥检查通过"
  echo "校验：shasum -a 256 -c MANIFEST.txt --quiet"
  echo "说明：docs/delivery/package-guide.md（HTML 版 package-guide.html）"
} > "$stage/PACKAGE-INFO.txt"
(cd "$stage" && find . -type f ! -name MANIFEST.txt | LC_ALL=C sort | sed 's|^\./||' | while IFS= read -r f; do shasum -a 256 "$f"; done) > "$work/manifest.body"
mv "$work/manifest.body" "$stage/MANIFEST.txt"
mkdir -p "$DIST"
COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs -czf "$DIST/$NAME.tar.gz" -C "$work" "$NAME"
(cd "$DIST" && shasum -a 256 "$NAME.tar.gz" > "$NAME.tar.gz.sha256")
echo "已生成 $DIST/$NAME.tar.gz（$(du -h "$DIST/$NAME.tar.gz" | cut -f1)，$(wc -l < "$stage/MANIFEST.txt" | tr -d ' ') 个文件）"
echo "校验文件 $DIST/$NAME.tar.gz.sha256"
