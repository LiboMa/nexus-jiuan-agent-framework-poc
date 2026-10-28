#!/usr/bin/env bash
# 用管理员账号跑 nexus_admin.py。管理员密码只给本次进程用，结束即删，不经命令行、不打印。
#   deploy.env 里给了 NEXUS_PASSWORD_FILE（本地 600 文件）→ 直接用；
#   否则给 NEXUS_ADMIN_PASSWORD_SSM=<deployer 实例 ID>:<deploy.yaml 绝对路径> → 借同仓库 pgvector-rules-kb 的
#   密封读取（SSM 命令历史里只有密文）。
# 用法：scripts/admin_run.sh <import|check|publish|verify> [参数…]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
set -a
# shellcheck disable=SC1091
. "$ROOT/deploy.env"
set +a
: "${NEXUS_URL:?}" "${NEXUS_ADMIN_USER:=admin}" "${AWS_REGION:=us-east-1}"
if [ -n "${NEXUS_PASSWORD_FILE:-}" ]; then
  [ -f "$NEXUS_PASSWORD_FILE" ] || { echo "NEXUS_PASSWORD_FILE 不存在" >&2; exit 2; }
else
  : "${NEXUS_ADMIN_PASSWORD_SSM:?deploy.env 里需要 NEXUS_PASSWORD_FILE 或 NEXUS_ADMIN_PASSWORD_SSM}"
  PKG_DIR="$(cd "$ROOT/../pgvector-rules-kb" 2>/dev/null && pwd)" || { echo "SSM 方式需要同仓库的 pgvector-rules-kb" >&2; exit 2; }
  DEPLOY_NAME=knowbase-s3vectors-agent
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
uv run --quiet --no-project --python 3.12 --with boto3 python -I "$HERE/nexus_admin.py" "$@"
