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
  say "单元测试与命令行测试"
  (cd "$ROOT/poc/app" && node --test "test/unit/**/*.test.mjs" >/dev/null) && echo "单元测试通过"
  # 九安 v0.7.10 测试台的外壳：先构建九安副本（打补丁），外壳的测试要用到副本里的契约
  bash "$ROOT/poc/bench/build-jiuan07.sh" >/dev/null && (cd "$ROOT/poc/app07" && node --test "test/unit/**/*.test.mjs" >/dev/null) && echo "九安 v0.7.10 外壳的单元测试通过"
  # 知识库工具：脚本语法与 Python 编译检查（它的部署和验证要线上环境，见 kb/GUIDE.md）
  for f in "$ROOT"/kb/deploy.sh "$ROOT"/kb/lib/common.sh "$ROOT"/kb/host/*.sh "$ROOT"/poc/infra/kb.sh; do bash -n "$f"; done
  python3 -B -c 'import ast,sys; [ast.parse(open(f, encoding="utf-8").read(), f) for f in sys.argv[1:]]' "$ROOT"/kb/lib/*.py && echo "知识库工具的语法检查通过"
  (cd "$ROOT" && python3 -B -m unittest discover -s kb/tests >/dev/null 2>&1) && echo "知识库工具的单元测试通过"
  # 文档管家（S3 Vectors 版）：脚本语法与 Python 编译检查（它的本地测试要 boto3 等依赖，见 knowbase-s3vectors-agent/GUIDE.zh.md）
  S3V="$ROOT/knowbase-s3vectors-agent"
  for f in "$S3V"/infra/*.sh "$S3V"/scripts/*.sh; do bash -n "$f"; done
  python3 -B -c 'import ast,sys; [ast.parse(open(f, encoding="utf-8").read(), f) for f in sys.argv[1:]]' "$S3V"/{tools,scripts,frontend,tests,build}/*.py && node --check "$S3V"/frontend/*.mjs && echo "文档管家的语法检查通过"
  (cd "$ROOT" && python3 -B -m unittest discover -s audit-agent/tests >/dev/null 2>&1) && echo "审核 Agent 下发脚本的单元测试通过"
  (cd "$ROOT" && python3 -B -m unittest discover -s skills/agent-access/tests >/dev/null 2>&1) && echo "命令行测试通过"
  say "图和 HTML 是不是最新的"
  "$ROOT/docs/build-html.sh" --check
  say "参考补丁"
  "$ROOT/docs/delivery/patches/make-reference-patch.sh"
fi

say "按白名单暂存"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
stage="$work/$NAME"
mkdir -p "$stage"
EXCLUDES=(--exclude .DS_Store --exclude node_modules --exclude __pycache__ --exclude '*.tmp' --exclude '.gallery.html')
# 设计、过程和评审记录：只在开发仓库，不进交接仓库，也不进交付包
NOT_HANDOVER=(--exclude /docs/specs --exclude /docs/plans --exclude /docs/progress.html --exclude /docs/assessment.md --exclude '/docs/feasibility-round2.*'
  --exclude /docs/compromise-round3.md --exclude /docs/poc-a2a-round4.md --exclude /docs/replication-feasibility.md
  --exclude /docs/agent-discovery-registration.html --exclude '/docs/delivery/code-review-*' --exclude '/docs/assets/diagrams/review-quadrant.*'
  --exclude /docs/delivery/sanitize.conf
  # 客户的制度原文（知识库的来源文档）只在本机和测试台的知识库里，不进交接仓库和交付包
  --exclude /docs/sample-docs)
copy() { mkdir -p "$stage/$(dirname "$1")"; rsync -a "${EXCLUDES[@]}" "${@:2}" "$ROOT/$1" "$stage/$(dirname "$1")/"; }
copy README.md
copy VERSION
copy CHANGELOG.md
copy docs "${NOT_HANDOVER[@]}"
copy poc/app --exclude /app/public
copy poc/app07
copy poc/bench
copy patches
copy audit-agent
copy kb --exclude /kb/.state --exclude /kb/.build --exclude /kb/deploy.env --include /kb/tests/fixtures/sample-matrix.docx --exclude '*.docx' --exclude '*.doc'
# 文档管家（S3 Vectors 版）：部署人的设置、状态（含 A2A 调用密钥）、生成物不出包；制度原文（.docx）不出包，tests/fixtures 的仿真文档除外
copy knowbase-s3vectors-agent --exclude /knowbase-s3vectors-agent/.state --exclude /knowbase-s3vectors-agent/.build --exclude /knowbase-s3vectors-agent/build/out \
  --exclude /knowbase-s3vectors-agent/deploy.env --include '/knowbase-s3vectors-agent/tests/fixtures/*.docx' --exclude '*.docx' --exclude '*.doc'
copy poc/infra --exclude secrets.env --exclude kb.env --include /infra/env/example.env --exclude '/infra/env/*.env' --exclude design-jiuan-nexus-integrate.md
copy poc/tools
copy poc/README.md
copy skills
copy knowledge-agent
copy contract
[[ -n "$EXPORT" ]] || copy evidence
cat > "$stage/.gitignore" <<'EOF'
# 密钥：只在本机，当面交接；样例 secrets.env.example 进仓库
poc/infra/secrets.env
poc/infra/secrets.env.*
!poc/infra/secrets.env.example
# 知识库：部署人的设置、生成的配置与状态（实例、网段等环境信息）
poc/infra/kb.env
kb/deploy.env
kb/.state/
kb/.build/
# 文档管家（S3 Vectors 版）：部署人的设置、状态（含 A2A 调用密钥）、生成物
knowbase-s3vectors-agent/deploy.env
knowbase-s3vectors-agent/.state/
knowbase-s3vectors-agent/.build/
knowbase-s3vectors-agent/build/out/
# 九安开发包：第三方代码，按版本号另行存放
source/
# 生成物与依赖
.build/
node_modules/
poc/app/public/
dist/
__pycache__/
*.pyc
.DS_Store
EOF

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
  echo "检查：$($CHECKS && echo '单元测试、命令行测试、图和 HTML、参考补丁都通过' || echo '跳过了测试与文档检查（--skip-checks）')；密钥检查通过"
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
