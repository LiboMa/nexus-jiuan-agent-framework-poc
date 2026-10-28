#!/usr/bin/env bash
# 删除 aws_setup.sh 建的 AWS 资源：三个索引（连同其中全部向量）、向量桶、写入用 IAM 用户（先删它的访问密钥与内联策略）。
# 不可恢复。缺省只打印计划；必须同时给 --confirm <向量桶名> 和 --apply 才执行。
#
# 用法：infra/aws_teardown.sh --confirm <VECTOR_BUCKET> [--apply] [--env deploy.env] [--keep-users]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$HERE/../deploy.env"
APPLY=0 CONFIRM="" KEEP_USERS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --confirm) CONFIRM="$2"; shift ;;
    --env) ENV_FILE="$2"; shift ;;
    --keep-users) KEEP_USERS=1 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
  shift
done
# shellcheck disable=SC1090
. "$ENV_FILE"
: "${AWS_REGION:?}" "${VECTOR_BUCKET:?}" "${WRITER_IAM_USER:?}"
APP_IAM_USER="${APP_IAM_USER:-}"
[ "$CONFIRM" = "$VECTOR_BUCKET" ] || { echo "要删除请加 --confirm $VECTOR_BUCKET（防止删错桶）" >&2; exit 2; }
run() { if [ "$APPLY" = 1 ]; then "$@" >/dev/null; fi; }
echo "区域 $AWS_REGION · 向量桶 $VECTOR_BUCKET · $([ "$APPLY" = 1 ] && echo 执行删除 || echo 只看计划)"

for idx in chunks docs audit; do
  if aws s3vectors get-index --region "$AWS_REGION" --vector-bucket-name "$VECTOR_BUCKET" --index-name "$idx" >/dev/null 2>&1; then
    echo "  - 删除索引 $idx（其中的向量一并删除）"
    run aws s3vectors delete-index --region "$AWS_REGION" --vector-bucket-name "$VECTOR_BUCKET" --index-name "$idx"
  fi
done
if aws s3vectors get-vector-bucket --region "$AWS_REGION" --vector-bucket-name "$VECTOR_BUCKET" >/dev/null 2>&1; then
  echo "  - 删除向量桶 $VECTOR_BUCKET"
  run aws s3vectors delete-vector-bucket --region "$AWS_REGION" --vector-bucket-name "$VECTOR_BUCKET"
fi

drop_user() {
  local user="$1" policy="$2"
  aws iam get-user --user-name "$user" >/dev/null 2>&1 || return 0
  for kid in $(aws iam list-access-keys --user-name "$user" --query 'AccessKeyMetadata[].AccessKeyId' --output text); do
    echo "  - 删除 $user 的访问密钥 ****${kid: -4}（Nexus 里引用它的密钥随之失效）"
    run aws iam delete-access-key --user-name "$user" --access-key-id "$kid"
  done
  if aws iam get-user-policy --user-name "$user" --policy-name "$policy" >/dev/null 2>&1; then
    echo "  - 删除内联策略 $policy"
    run aws iam delete-user-policy --user-name "$user" --policy-name "$policy"
  fi
  echo "  - 删除 IAM 用户 $user"
  run aws iam delete-user --user-name "$user"
}
if [ "$KEEP_USERS" = 0 ]; then
  drop_user "$WRITER_IAM_USER" knowbase-s3vectors-rw
  [ -n "$APP_IAM_USER" ] && drop_user "$APP_IAM_USER" knowbase-s3vectors-app
fi
[ "$APPLY" = 1 ] && echo "已删除。" || echo "以上是计划，没有做任何改动。"
