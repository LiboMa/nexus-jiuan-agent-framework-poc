#!/usr/bin/env bash
# 建 S3 Vectors 知识库的 AWS 资源（幂等，已存在的照原样保留）：
#   向量桶 + chunks / docs / audit 三个索引 + 规则模块的 rules（名字取 RULES_INDEX）/ rule_sources 两个索引
#   + 写入用 IAM 用户及其内联策略（只授权这一个向量桶）
#   可选：APP_IAM_USER（前端后端直连用：本桶读写 + 调 Cohere Embed v4）
# 缺省只打印计划（每行 ~ 表示将要创建，= 表示已存在且一致）；加 --apply 才执行。
# 不创建访问密钥：密钥请在 IAM 控制台创建，直接填进 Nexus「密钥管理」（不经过任何脚本与对话）。
#
# 用法：infra/aws_setup.sh [--apply] [--env deploy.env]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$HERE/../deploy.env"
APPLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --env) ENV_FILE="$2"; shift ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
  shift
done
[ -f "$ENV_FILE" ] || { echo "找不到 $ENV_FILE（先复制 deploy.env.example）" >&2; exit 2; }
# shellcheck disable=SC1090
. "$ENV_FILE"
: "${AWS_REGION:?}" "${VECTOR_BUCKET:?}" "${WRITER_IAM_USER:?}"
APP_IAM_USER="${APP_IAM_USER:-}"
RULES_INDEX="${RULES_INDEX:-rules}"

die() { echo "✗ $*" >&2; exit 1; }
plan() { echo "  ~ $*"; }
same() { echo "  = $*"; }
run() { if [ "$APPLY" = 1 ]; then "$@" >/dev/null; fi; }

# ── 桶名检查：与 Nexus 的平台桶判定（nexus_utils/platform_buckets.py）对齐 ──
[[ "$VECTOR_BUCKET" =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]] || die "VECTOR_BUCKET 只能用小写字母、数字、连字符，3~63 位"
case "$VECTOR_BUCKET" in
  nexus-ai-vectors-*|*-vectors-system|*-vectors-agent|*-vectors-avatar|*-vectors-system-*|*-vectors-agent-*|*-vectors-avatar-*)
    die "VECTOR_BUCKET=$VECTOR_BUCKET 会被 Nexus 当成平台向量桶，连接器拒绝访问；请换一个名字" ;;
esac
# ── 规则索引名：S3 Vectors 索引名规则（3~63 位小写字母、数字、连字符、点，首尾是字母或数字），且不和其余索引同名 ──
[[ "$RULES_INDEX" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || die "RULES_INDEX 只能用小写字母、数字、连字符、点，3~63 位"
case "$RULES_INDEX" in
  chunks|docs|audit|rule_sources) die "RULES_INDEX=$RULES_INDEX 与本桶的其他索引同名；请换一个名字（缺省 rules）" ;;
esac

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
echo "AWS 账号 ****${ACCOUNT_ID: -4} · 区域 $AWS_REGION · 向量桶 $VECTOR_BUCKET · $([ "$APPLY" = 1 ] && echo 执行 || echo 只看计划)"

# ── 向量桶 ──
echo "[向量桶]"
if aws s3vectors get-vector-bucket --region "$AWS_REGION" --vector-bucket-name "$VECTOR_BUCKET" >/dev/null 2>&1; then
  same "向量桶 $VECTOR_BUCKET 已存在"
else
  plan "创建向量桶 $VECTOR_BUCKET（SSE-S3 加密）"
  run aws s3vectors create-vector-bucket --region "$AWS_REGION" --vector-bucket-name "$VECTOR_BUCKET" \
      --tags '{"project":"knowbase-s3vectors-agent"}'
fi

# ── 索引：名字 维度 不可过滤的元数据键 ──
# chunks：Cohere Embed v4 原生 1536 维 = Nexus s3_vector 连接器查询时的维度；正文与文件名不参与过滤，不占 2 KB 可过滤额度
echo "[索引]"
ensure_index() {
  local name="$1" dim="$2" nonf="$3" got
  if got="$(aws s3vectors get-index --region "$AWS_REGION" --vector-bucket-name "$VECTOR_BUCKET" --index-name "$name" \
            --query 'index.[dimension,distanceMetric,dataType]' --output text 2>/dev/null)"; then
    local want; want="$(printf '%s\t%s\t%s' "$dim" cosine float32)"
    [ "$got" = "$want" ] || die "索引 $name 已存在但配置不同（现有：$got；需要：$want）。索引建好后不能修改，请换桶或先删掉它"
    local have; have="$(aws s3vectors get-index --region "$AWS_REGION" --vector-bucket-name "$VECTOR_BUCKET" --index-name "$name" \
            --query 'index.metadataConfiguration.nonFilterableMetadataKeys' --output json | python3 -I -c 'import json,sys; print(",".join(sorted(json.load(sys.stdin) or [])))')"
    local need; need="$(python3 -I -c 'import json,sys; print(",".join(sorted(json.loads(sys.argv[1]))))' "$nonf")"
    [ "$have" = "$need" ] || die "索引 $name 的不可过滤键不同（现有：$have；需要：$need）"
    same "索引 $name：${dim} 维、cosine、不可过滤 $need"
  else
    plan "创建索引 $name：${dim} 维、cosine、float32、不可过滤 $nonf"
    run aws s3vectors create-index --region "$AWS_REGION" --vector-bucket-name "$VECTOR_BUCKET" --index-name "$name" \
        --data-type float32 --dimension "$dim" --distance-metric cosine \
        --metadata-configuration "{\"nonFilterableMetadataKeys\":$nonf}"
  fi
}
ensure_index chunks 1536 '["text","file_name"]'
ensure_index docs 1536 '["file_name","doc_hash","embedding_model","page_or_row_count","quality_flag"]'
ensure_index audit 1 '["detail"]'
# 规则模块（s3vectors_rules_tools.py）：rules 一条规则一个向量，键 = 规则编号，规则全文 text 不可过滤，
# 板块、金额档、上下线标记都是可过滤键；rule_sources 一份制度一条登记（1 维常量向量）
ensure_index "$RULES_INDEX" 1536 '["text"]'
ensure_index rule_sources 1 '["title","file_name","doc_hash"]'

# ── IAM 用户与内联策略 ──
render_policy() {
  sed -e "s|__REGION__|$AWS_REGION|g" -e "s|__ACCOUNT_ID__|$ACCOUNT_ID|g" -e "s|__VECTOR_BUCKET__|$VECTOR_BUCKET|g" "$1"
}
ensure_user() {
  local user="$1" tmpl="$2" policy_name="$3" doc
  doc="$(render_policy "$tmpl")"
  if aws iam get-user --user-name "$user" >/dev/null 2>&1; then
    same "IAM 用户 $user 已存在"
  else
    plan "创建 IAM 用户 $user（无控制台密码、无访问密钥）"
    run aws iam create-user --user-name "$user" --tags Key=project,Value=knowbase-s3vectors-agent
  fi
  local current=""
  current="$(aws iam get-user-policy --user-name "$user" --policy-name "$policy_name" --query PolicyDocument --output json 2>/dev/null || true)"
  if [ -n "$current" ] && python3 -I -c 'import json,sys; sys.exit(0 if json.loads(sys.argv[1]) == json.loads(sys.argv[2]) else 1)' "$current" "$doc"; then
    same "内联策略 $policy_name 已是最新"
  else
    plan "写入内联策略 $policy_name（$(basename "$tmpl" .json.tmpl)：只授权 bucket/$VECTOR_BUCKET）"
    run aws iam put-user-policy --user-name "$user" --policy-name "$policy_name" --policy-document "$doc"
  fi
}
echo "[IAM]"
ensure_user "$WRITER_IAM_USER" "$HERE/writer-policy.json.tmpl" knowbase-s3vectors-rw
if [ -n "$APP_IAM_USER" ]; then
  ensure_user "$APP_IAM_USER" "$HERE/app-policy.json.tmpl" knowbase-s3vectors-app
fi

echo
if [ "$APPLY" = 1 ]; then
  echo "完成。下一步（GUIDE 第 3 步）：在 IAM 控制台为 $WRITER_IAM_USER 创建访问密钥（用途选「在 AWS 外部运行的应用程序」），"
  echo "然后直接在 Nexus「密钥管理」新建「AWS 凭证」类型的密钥并粘贴进去；不要发到聊天里，也不要写进文件。"
else
  echo "以上是计划，没有做任何改动。确认后加 --apply 执行。"
fi
