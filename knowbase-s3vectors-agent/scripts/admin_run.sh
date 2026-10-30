#!/usr/bin/env bash
# 用管理员账号跑 nexus_admin.py（S3 Vectors 版与 PG 版两个交付包共用这一份）。管理员密码只给本次进程用，结束即删，不经命令行、不打印。
#   包：NEXUS_PKG_ROOT=<包目录>，缺省是本脚本所在的包（knowbase-s3vectors-agent）。读这个包的 deploy.env，并把 --package 传给
#       nexus_admin.py（工具模块、密钥声明读它的 nexus-package.json）。PG 版的 scripts/admin_run.sh 设好它再 exec 本脚本。
#   密码：deploy.env 里给了 NEXUS_PASSWORD_FILE（本地 600 文件）→ 直接用；
#       否则给 NEXUS_ADMIN_PASSWORD_SSM=<deployer 实例 ID>:<deploy.yaml 绝对路径> → 借同仓库知识库工具的密封读取（SSM 命令历史里
#       只有密文）：先找包旁边的 kb/，没有再找 pgvector-rules-kb/（它原来的名字）。
# 用法：scripts/admin_run.sh <import|check|publish|verify|bind|key-create|issue-call-key> [参数…]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${NEXUS_PKG_ROOT:-$HERE/..}" && pwd)"
[ -f "$ROOT/nexus-package.json" ] || { echo "$ROOT 里没有 nexus-package.json（NEXUS_PKG_ROOT 要指向一个交付包的目录）" >&2; exit 2; }
set -a
# shellcheck disable=SC1091
. "$ROOT/deploy.env"
set +a
: "${NEXUS_URL:?}" "${NEXUS_ADMIN_USER:=admin}" "${AWS_REGION:=us-east-1}"
if [ -n "${NEXUS_PASSWORD_FILE:-}" ]; then
  [ -f "$NEXUS_PASSWORD_FILE" ] || { echo "NEXUS_PASSWORD_FILE 不存在" >&2; exit 2; }
else
  : "${NEXUS_ADMIN_PASSWORD_SSM:?deploy.env 里需要 NEXUS_PASSWORD_FILE 或 NEXUS_ADMIN_PASSWORD_SSM}"
  # PKG_DIR 是知识库工具的目录：它的 lib/common.sh 按这个名字找 lib/seal.py
  PKG_DIR=""
  for d in "$ROOT/../kb" "$ROOT/../pgvector-rules-kb"; do
    if [ -f "$d/lib/common.sh" ]; then PKG_DIR="$(cd "$d" && pwd)"; break; fi
  done
  [ -n "$PKG_DIR" ] || { echo "SSM 方式需要同仓库的知识库工具 kb/（或旧名 pgvector-rules-kb/）" >&2; exit 2; }
  # shellcheck disable=SC2034  # common.sh 用它：SSM 命令的说明写「<DEPLOY_NAME>: <脚本名>」
  DEPLOY_NAME="$(basename "$ROOT")"
  # shellcheck disable=SC1091
  . "$PKG_DIR/lib/common.sh"
  SECRETS_DIR="$ROOT/.build/secrets.$$"; mkdir -p "$SECRETS_DIR"; chmod 700 "$SECRETS_DIR"
  trap 'rm -rf "$SECRETS_DIR"' EXIT
  inst="${NEXUS_ADMIN_PASSWORD_SSM%%:*}"; ypath="${NEXUS_ADMIN_PASSWORD_SSM#*:}"
  f="$SECRETS_DIR/nexus-admin"; : > "$f"; chmod 600 "$f"
  ssm_read_secret "$inst" "$PKG_DIR/host/read-admin-password.sh" "$f" "YAML_PATH=$ypath" || { echo "读取管理员密码失败" >&2; exit 1; }
  NEXUS_PASSWORD_FILE="$f"
fi
export NEXUS_URL NEXUS_ADMIN_USER NEXUS_PASSWORD_FILE
uv run --quiet --no-project --python 3.12 --with boto3 python -I "$HERE/nexus_admin.py" --package "$ROOT" "$@"
