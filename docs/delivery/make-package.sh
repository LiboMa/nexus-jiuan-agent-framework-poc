#!/usr/bin/env bash
# 生成交付包，或把交接内容导出到交接仓库的工作副本。说明见 package-guide.md。
#   docs/delivery/make-package.sh                   跑完全部检查再出包：dist/<版本>.tar.gz（+ .sha256，包内有 MANIFEST.txt）
#   docs/delivery/make-package.sh --export <目录>    跑完全部检查，把交接内容同步到 <目录>（交接仓库的工作副本：.git 保留，多余的文件删掉）
#   加 --skip-checks 跳过测试与文档检查（只在排查打包问题时用；密钥检查永远会跑）
# 交接内容 = 下面白名单里的文件，不含设计稿、实现计划、进度看板、历次评估、评审记录（它们只在开发仓库）；交付包另外带上 evidence/（测试证据）。
# 版本取自根目录的 VERSION，空格换成 -（如 Finance-Audit-Nexus-PoC-v0.1.0）。
# 暂存目录里出现 secrets.env、像密钥的字符串、或本机 secrets.env 里任何一个真实的值，就不出包、不导出（只报文件名，不打印值）。
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
EXPORT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-checks) CHECKS=false; shift ;;
    --export) [[ -n "${2:-}" ]] || { echo "--export 后面要跟目录" >&2; exit 2; }; EXPORT="$2"; shift 2 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done
if [[ -n "$EXPORT" ]]; then
  mkdir -p "$EXPORT"
  EXPORT="$(cd "$EXPORT" && pwd)"
  [[ "$EXPORT" != "$ROOT" ]] || { echo "不能导出到工作目录本身" >&2; exit 2; }
fi

if $CHECKS; then
  say "单元测试"
  # 哪一项没过就停下、不出包。别用 && 把「通过」接在检查后面：在 set -e 下那样没过也会接着出包。输出不打印，没过时去对应目录手动跑一遍看原因
  stop() { echo "${1}没过，不出包" >&2; exit 1; }
  # 部署脚本、栈模板、测试台脚本（poc/infra/test；九安 v0.7.10 副本的构建测试要本机有开发包，没有就跳过那几条）
  (cd "$ROOT/poc/infra" && node --test "test/**/*.test.mjs" >/dev/null) || stop "部署脚本和栈模板的测试"
  echo "部署脚本和栈模板的测试通过"
  # 九安 v0.7.10 测试台的外壳：先构建九安副本（打补丁），外壳的测试要用到副本里的契约
  bash "$ROOT/poc/bench/build-jiuan.sh" >/dev/null || stop "九安 v0.7.10 副本的构建"
  (cd "$ROOT/poc/app" && node --test "test/unit/**/*.test.mjs" >/dev/null) || stop "九安 v0.7.10 外壳的单元测试"
  echo "九安 v0.7.10 外壳的单元测试通过"
  # 知识库工具：脚本语法与 Python 编译检查（它的部署和验证要线上环境，见 kb/GUIDE.md）
  for f in "$ROOT"/kb/deploy.sh "$ROOT"/kb/lib/common.sh "$ROOT"/kb/host/*.sh "$ROOT"/poc/infra/kb.sh; do bash -n "$f" || stop "知识库工具的语法检查（${f}）"; done
  python3 -B -c 'import ast,sys; [ast.parse(open(f, encoding="utf-8").read(), f) for f in sys.argv[1:]]' "$ROOT"/kb/lib/*.py || stop "知识库工具的语法检查"
  echo "知识库工具的语法检查通过"
  # 单元测试要 openpyxl、pdfplumber 等，在 uv 的临时环境里跑（要连真 PG 的几条没设 PG 就跳过）
  (cd "$ROOT" && uv run --quiet --no-project --python 3.12 --with 'psycopg[binary]' --with pyyaml --with cryptography --with boto3 --with openpyxl --with pdfplumber --with reportlab \
    python -B -m unittest discover -s kb/tests >/dev/null 2>&1) || stop "知识库工具的单元测试"
  echo "知识库工具的单元测试通过"
  # 文档管家（S3 Vectors 版）：脚本语法与 Python 编译检查（它的本地测试要 boto3 等依赖，见 knowbase-s3vectors-agent/GUIDE.zh.md）
  S3V="$ROOT/knowbase-s3vectors-agent"
  for f in "$S3V"/infra/*.sh "$S3V"/scripts/*.sh; do bash -n "$f" || stop "文档管家的语法检查（${f}）"; done
  python3 -B -c 'import ast,sys; [ast.parse(open(f, encoding="utf-8").read(), f) for f in sys.argv[1:]]' "$S3V"/{tools,scripts,frontend,tests,build}/*.py || stop "文档管家的语法检查"
  for f in "$S3V"/frontend/*.mjs; do node --check "$f" || stop "文档管家的语法检查（${f}）"; done
  echo "文档管家的语法检查通过"
  # 文档管家（PG 版）：脚本语法、Python 编译与 Node 语法检查（它的本地测试要 PGlite 等依赖，见 knowledgebase-writer-agent-pg/README.md）
  PGA="$ROOT/knowledgebase-writer-agent-pg"
  for f in "$PGA"/scripts/*.sh; do bash -n "$f" || stop "文档管家（PG 版）的语法检查（${f}）"; done
  python3 -B -c 'import ast,sys; [ast.parse(open(f, encoding="utf-8").read(), f) for f in sys.argv[1:]]' "$PGA"/{tools,scripts,probe,tests}/*.py || stop "文档管家（PG 版）的语法检查"
  for f in "$PGA"/scripts/*.mjs "$PGA"/tests/*.mjs; do node --check "$f" || stop "文档管家（PG 版）的语法检查（${f}）"; done
  echo "文档管家（PG 版）的语法检查通过"
  (cd "$ROOT" && python3 -B -m unittest discover -s audit-agent/tests >/dev/null 2>&1) || stop "审核 Agent 下发脚本的单元测试"
  echo "审核 Agent 下发脚本的单元测试通过"
  say "图和 HTML 是不是最新的"
  "$ROOT/docs/build-html.sh" --check
fi

say "按白名单暂存"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
stage="$work/$NAME"
mkdir -p "$stage"
EXCLUDES=(--exclude .DS_Store --exclude node_modules --exclude __pycache__ --exclude '*.tmp' --exclude '.gallery.html')
# 设计稿、实现计划（以后再写的也放这几个目录）和脱敏对照表：只在开发仓库，不进交接仓库，也不进交付包。
# 2026-11-05 起历史的评估、设计稿、计划和进度看板都从仓库里删了（见 git 历史）
NOT_HANDOVER=(--exclude /docs/specs --exclude /docs/plans --exclude /docs/superpowers
  --exclude /docs/delivery/sanitize.conf
  # 客户的制度原文（知识库的来源文档）只在本机和测试台的知识库里，不进交接仓库和交付包
  --exclude /docs/sample-docs)
copy() { mkdir -p "$stage/$(dirname "$1")"; rsync -a "${EXCLUDES[@]}" "${@:2}" "$ROOT/$1" "$stage/$(dirname "$1")/"; }
copy README.md
copy VERSION
copy CHANGELOG.md
copy docs "${NOT_HANDOVER[@]}"
copy poc/app
copy poc/web --exclude /web/dist
copy poc/bench
copy patches
copy audit-agent
copy kb --exclude /kb/.state --exclude /kb/.build --exclude /kb/deploy.env --include /kb/tests/fixtures/sample-matrix.docx --exclude '*.docx' --exclude '*.doc'
# 文档管家（S3 Vectors 版）：部署人的设置、状态（含 A2A 调用密钥）、生成物不出包；制度原文（.docx）不出包，tests/fixtures 的仿真文档除外
copy knowbase-s3vectors-agent --exclude /knowbase-s3vectors-agent/.state --exclude /knowbase-s3vectors-agent/.build --exclude /knowbase-s3vectors-agent/build/out \
  --exclude /knowbase-s3vectors-agent/deploy.env --include '/knowbase-s3vectors-agent/tests/fixtures/*.docx' --exclude '*.docx' --exclude '*.doc'
# 文档管家（PG 版）：部署人的设置、状态（导入结果、A2A 调用密钥）、生成物（拼装出的工具、压缩包、端到端测试文档）不出包；
# 制度原文（.docx）不出包（本包没有仿真 .docx）
copy knowledgebase-writer-agent-pg --exclude /knowledgebase-writer-agent-pg/.state --exclude /knowledgebase-writer-agent-pg/.build \
  --exclude /knowledgebase-writer-agent-pg/deploy.env --exclude '*.docx' --exclude '*.doc'
# 文档管家（PG 版）的客户部署交付件（从交付仓库 nexus-customer-deploy 收进来，交付版本 1.0.1）：文档、部署手册、发布 zip。
# zip 和 SHA256SUMS 对不上就不出包（zip 由它自己的 make_release.sh 打，打包时已按它的去敏词表查过）
(cd "$ROOT/customer-deploy/knowledgebase-writer-agent-pg/release" && shasum -a 256 -c SHA256SUMS --quiet) \
  || { echo "customer-deploy/knowledgebase-writer-agent-pg/release 里的 zip 和 SHA256SUMS 对不上" >&2; exit 1; }
copy customer-deploy
# 两个文档管家的提示词共用片段在 kb/prompt（render.py 从包旁边的 ../kb/prompt 读），随上面的 kb 出包；少了就渲染不出提示词
[[ -f "$stage/kb/prompt/kb_rules_v1.zh.md" ]] || { echo "暂存目录里没有 kb/prompt/kb_rules_v1.zh.md（文档管家的提示词共用片段）" >&2; exit 1; }
copy poc/infra --exclude secrets.env --exclude kb.env --include /infra/env/example.env --exclude '/infra/env/*.env' --exclude /infra/.state --exclude design-jiuan-nexus-integrate.md
copy poc/README.md
copy skills
[[ -n "$EXPORT" ]] || copy evidence
cat > "$stage/.gitignore" <<'EOF'
# 密钥：只在本机，当面交接；样例 secrets.env.example 进仓库
poc/infra/secrets.env
poc/infra/secrets.env.*
!poc/infra/secrets.env.example
# 知识库：部署人的设置、生成的配置与状态（实例、网段等环境信息）
poc/infra/kb.env
poc/infra/.state/
kb/deploy.env
kb/.state/
kb/.build/
# 文档管家（S3 Vectors 版）：部署人的设置、状态（含 A2A 调用密钥）、生成物
knowbase-s3vectors-agent/deploy.env
knowbase-s3vectors-agent/.state/
knowbase-s3vectors-agent/.build/
knowbase-s3vectors-agent/build/out/
# 文档管家（PG 版）：部署人的设置、状态（含 A2A 调用密钥）、生成物
knowledgebase-writer-agent-pg/deploy.env
knowledgebase-writer-agent-pg/.state/
knowledgebase-writer-agent-pg/.build/
# 九安开发包：第三方代码，按版本号另行存放
source/
# 生成物与依赖
.build/
node_modules/
dist/
__pycache__/
*.pyc
.DS_Store
EOF

# 只带进了 git 的文件（提交过或 git add 过）：白名单目录里没进 git 的（草稿、本机的笔记）从暂存目录拿掉，列出名字。
# evidence/ 本来就不进 git、只进交付包；.gitignore 是上面写的。
tracked="$work/tracked.txt"; untracked="$work/untracked.txt"
git -C "$ROOT" -c core.quotePath=false ls-files | LC_ALL=C sort > "$tracked"
(cd "$stage" && find . -type f ! -path './evidence/*' ! -path './.gitignore' | sed 's|^\./||' | LC_ALL=C sort) | LC_ALL=C comm -23 - "$tracked" > "$untracked"
if [[ -s "$untracked" ]]; then
  echo "没进 git（没有 git add 过），不带："
  while IFS= read -r file; do echo "  $file"; rm -f "$stage/$file"; done < "$untracked"
  find "$stage" -mindepth 1 -type d -empty -delete
fi

say "脱敏：AWS 账户与 EC2 的标识换成 AWS 文档的示例值"
python3 -B "$HERE/sanitize.py" "$stage" "$HERE/sanitize.conf"

say "密钥检查"
hits="$work/hits.txt"; : > "$hits"
find "$stage" \( -name 'secrets.env*' ! -name 'secrets.env.example' \) -o -name '*.pem' -o -name 'credentials.json' -o -name 'connection.json' | sed "s|$stage/||" >> "$hits"
# 制度原文（例如《财务事项审批及授权管理办法》的 .docx）不管放在哪个目录都不能出包
find "$stage" \( -iname '*管理办法*' -o -iname '*.docx' -path '*/docs/*' \) | sed "s|$stage/||" >> "$hits"
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

if [[ -n "$EXPORT" ]]; then
  say "导出到交接仓库"
  rsync -a --delete --exclude /.git "$stage/" "$EXPORT/"
  echo "已导出到 ${EXPORT}（$(cd "$stage" && find . -type f | wc -l | tr -d ' ') 个文件）"
  exit 0
fi

say "清单与打包"
{
  echo "交付包：${NAME}（${VERSION_NAME}）"
  echo "生成时间：$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "检查：$($CHECKS && echo '单元测试（部署脚本与栈模板、外壳、知识库工具、审核 Agent）、语法检查、图和 HTML 都通过' || echo '跳过了测试与文档检查（--skip-checks）')；密钥检查通过"
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
