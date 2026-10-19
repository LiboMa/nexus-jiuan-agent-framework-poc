#!/usr/bin/env bash
# 生成交付文档的图和 HTML。Markdown 和 .mmd 是唯一的源：改文档改 .md，改图改 assets/diagrams/*.mmd，再运行本脚本。
#   docs/build-html.sh          先把 assets/diagrams/*.mmd 画成同名 .svg，再把下面清单里的文档生成同目录、同名的 .html
#   docs/build-html.sh --check  只检查图和 HTML 是不是最新的（有过期的就退出 1），适合放进推送前检查
# 需要 pandoc ≥ 3、mermaid-cli（mmdc）和本机 Chrome（CHROME_PATH 可改）。
# 只处理清单里的文档，不会覆盖手工做的 HTML（如 agent-discovery-registration.html）；
# assets/diagrams/ 里没有同名 .mmd 的 .svg（如 arch-overview.svg）是手工画的，脚本不动它。
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"
command -v pandoc >/dev/null || { echo "需要 pandoc：brew install pandoc" >&2; exit 1; }
command -v mmdc >/dev/null || { echo "需要 mermaid-cli：npm install -g @mermaid-js/mermaid-cli" >&2; exit 1; }
CHROME_PATH="${CHROME_PATH:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
[[ -x "$CHROME_PATH" ]] || { echo "找不到 Chrome：${CHROME_PATH}（用 CHROME_PATH 指定）" >&2; exit 1; }

# 清单：相对 docs/ 的路径。新增交付文档时加在这里。
DOCS=(
  delivery/README.md
  delivery/package-guide.md
  delivery/skills-guide.md
  delivery/handover.md
  delivery/integration.md
  delivery/deploy-iteration.md
  delivery/operations.md
  delivery/code-review-2026-10-17.md
  delivery/rules-binding.md
  delivery/call-chains.md
  delivery/agent-framework.md
  delivery/agent-interface.md
  delivery/first-review-contract.md
  architecture.md
  agent-developer-workflow.md
  specs/2026-10-17-agent-registry-design.md
  specs/2026-10-17-agent-access-skills-design.md
  specs/2026-10-19-agent-framework-design.md
)
CONVERTED="$(IFS=,; echo "${DOCS[*]}")"
CHECK=false
[[ "${1:-}" == "--check" ]] && CHECK=true
stale=0
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# 1. 图：flowchart / stateDiagram 末尾追加统一的节点配色（html-kit/mermaid-classes.mmd）；
#    每张图都加一条「减少动态效果」规则，系统设置了减少动态效果时箭头不再流动。
printf '{ "executablePath": "%s", "headless": "shell" }\n' "$CHROME_PATH" > "$work/puppeteer.json"
REDUCED='<style>@media (prefers-reduced-motion: reduce){*{animation:none!important;transition:none!important}}</style>'
for src in assets/diagrams/*.mmd; do
  name="$(basename "$src" .mmd)"
  input="$work/$name.mmd"
  cp "$src" "$input"
  if grep -m1 -vE '^\s*(%%|$)' "$src" | grep -qE '^\s*(flowchart|graph|stateDiagram)'; then
    printf '\n' >> "$input"; cat html-kit/mermaid-classes.mmd >> "$input"
  fi
  mmdc -q -i "$input" -o "$work/$name.raw.svg" -c html-kit/mermaid.json -p "$work/puppeteer.json" -b transparent --svgId "fig-$name" >/dev/null
  # 根 <svg> 换成固定的宽高（mermaid 默认 width=100%，放进 <img> 会被拉伸到整栏），并插入减少动态效果的规则
  python3 - "$work/$name.raw.svg" "$work/$name.svg" "$REDUCED" <<'PY'
import re, sys
src, dst, style = sys.argv[1:4]
svg = open(src, encoding='utf-8').read()
head = re.search(r'<svg\b[^>]*>', svg)
tag = head.group(0)
box = re.search(r'viewBox="[-\d.]+ [-\d.]+ ([\d.]+) ([\d.]+)"', tag)
width, height = (round(float(box.group(1))), round(float(box.group(2)))) if box else (None, None)
new = re.sub(r'\swidth="[^"]*"', '', tag)
new = re.sub(r'\sheight="[^"]*"', '', new)
new = re.sub(r'max-width:\s*[\d.]+px;?', '', new)
if width:
    new = new.replace('<svg', f'<svg width="{width}" height="{height}"', 1)
open(dst, 'w', encoding='utf-8').write(svg[:head.start()] + new + style + svg[head.end():])
PY
  out="assets/diagrams/$name.svg"
  if $CHECK; then
    cmp -s "$work/$name.svg" "$out" || { echo "过期：$out"; stale=1; }
  else
    mv "$work/$name.svg" "$out"; chmod 0644 "$out"; echo "已画好 $out"
  fi
done

# 2. 文档：第一行的一级标题当页面标题；其余元数据写在文档开头的 YAML 里（date、status、stamp、scope、audience、subtitle）。
for doc in "${DOCS[@]}"; do
  [[ -f "$doc" ]] || { echo "清单里的文件不存在：$doc" >&2; exit 1; }
  out="${doc%.md}.html"
  dir="$(dirname "$doc")"; [[ "$dir" == "." ]] && dir=""
  tmp="$work/page.html"
  pandoc "$doc" --from gfm+yaml_metadata_block+implicit_figures --to html5 --standalone \
    --template html-kit/template.html --lua-filter html-kit/links.lua \
    --shift-heading-level-by=-1 --toc --toc-depth=2 --syntax-highlighting=none \
    --metadata srcdir="$dir" --metadata converted="$CONVERTED" --metadata source="docs/$doc" \
    --output "$tmp"
  if $CHECK; then
    cmp -s "$tmp" "$out" || { echo "过期：$out"; stale=1; }
  else
    mv "$tmp" "$out"; chmod 0644 "$out"; echo "已生成 $out"
  fi
done
if $CHECK; then
  [[ $stale -eq 0 ]] && echo "图和 HTML 都是最新的"
  exit $stale
fi
