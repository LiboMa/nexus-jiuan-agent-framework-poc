#!/usr/bin/env bash
# 换实例类型，只允许「停机再开」，不允许替换实例（替换会丢掉账号目录和 MySQL 数据）：
#   建变更集（只改 InstanceType，其余参数沿用）→ 实例要被替换就删掉变更集并退出 → 打印变更 → 输入栈名确认 → 执行 → 健康检查。
# 用法：upgrade-instance.sh <m7g.large|m7g.xlarge|t3.small|t3.medium|t3.large>（同一种架构之间换：arm64 的 m7g 之间、x86 的 t3 之间）。先跑 backup.sh。会停机几分钟。
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/lib/deploy-env.sh"
load_deploy_env
REGION="${AWS_REGION:-us-east-1}"
STACK="${STACK:-andon-finance-poc}"
TYPE="${1:-}"
case "$TYPE" in m7g.large|m7g.xlarge|t3.small|t3.medium|t3.large) ;; *) echo "用法：upgrade-instance.sh <m7g.large|m7g.xlarge|t3.small|t3.medium|t3.large>" >&2; exit 2 ;; esac
output() { aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
# AMI 不换：新类型要和它同一种架构（arm64 的 m7g 之间、x86 的 t3 之间），不然停机再开后起不来
IMAGE="$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" --query "Stacks[0].Parameters[?ParameterKey=='ImageId'].ParameterValue" --output text)"
IMAGE_ARCH="$(aws ec2 describe-images --region "$REGION" --image-ids "$IMAGE" --query 'Images[0].Architecture' --output text)"
TYPE_ARCH="$(aws ec2 describe-instance-types --region "$REGION" --instance-types "$TYPE" --query 'InstanceTypes[0].ProcessorInfo.SupportedArchitectures' --output text | grep -qw arm64 && echo arm64 || echo x86_64)"
[[ "$IMAGE_ARCH" == "$TYPE_ARCH" ]] || { echo "栈 $STACK 的 AMI 是 ${IMAGE_ARCH}，${TYPE} 是 ${TYPE_ARCH}：不能就地换，另建一个栈" >&2; exit 2; }
NAME="instance-type-$(date -u +%Y%m%d%H%M%S)"
PARAMS=()
for key in $(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" --query 'Stacks[0].Parameters[].ParameterKey' --output text); do
  if [[ "$key" == "InstanceType" ]]; then PARAMS+=("ParameterKey=InstanceType,ParameterValue=${TYPE}"); else PARAMS+=("ParameterKey=${key},UsePreviousValue=true"); fi
done
drop() { aws cloudformation delete-change-set --region "$REGION" --stack-name "$STACK" --change-set-name "$NAME" >/dev/null 2>&1 || true; }
aws cloudformation create-change-set --region "$REGION" --stack-name "$STACK" --change-set-name "$NAME" \
  --template-body "file://$HERE/andon-finance-poc.yaml" --capabilities CAPABILITY_IAM --parameters "${PARAMS[@]}" >/dev/null
if ! aws cloudformation wait change-set-create-complete --region "$REGION" --stack-name "$STACK" --change-set-name "$NAME"; then
  aws cloudformation describe-change-set --region "$REGION" --stack-name "$STACK" --change-set-name "$NAME" --query StatusReason --output text >&2 || true
  drop; exit 1
fi
aws cloudformation describe-change-set --region "$REGION" --stack-name "$STACK" --change-set-name "$NAME" \
  --query 'Changes[].ResourceChange.[LogicalResourceId,Action,Replacement]' --output table
REPLACEMENT="$(aws cloudformation describe-change-set --region "$REGION" --stack-name "$STACK" --change-set-name "$NAME" \
  --query "Changes[?ResourceChange.LogicalResourceId=='Instance'].ResourceChange.Replacement" --output text)"
# CloudFormation 把 InstanceType 的变化一律标成 Conditional（只有实例存储的实例才会被替换）。
# 所以：False 直接放行；Conditional 只在「实例这一项唯一变化的属性是 InstanceType、根卷是 EBS」时放行（AWS 文档：EBS 实例换型只停机再开）；其余一律不执行。
CAUSES="$(aws cloudformation describe-change-set --region "$REGION" --stack-name "$STACK" --change-set-name "$NAME" \
  --query "Changes[?ResourceChange.LogicalResourceId=='Instance'].ResourceChange.Details[].Target.Name" --output text | tr '\t' '\n' | sort -u | tr '\n' ' ' | sed 's/ $//')"
ROOT_DEVICE="$(aws ec2 describe-instances --region "$REGION" --instance-ids "$(output InstanceId)" --query 'Reservations[0].Instances[0].RootDeviceType' --output text)"
if [[ "$REPLACEMENT" == "False" ]]; then
  :
elif [[ "$REPLACEMENT" == "Conditional" ]] && [[ "$CAUSES" == "InstanceType" ]] && [[ "$ROOT_DEVICE" == "ebs" ]]; then
  echo "实例这一项是 Conditional，但唯一的变化是 InstanceType、根卷是 EBS：只会停机再开。"
else
  echo "实例这一项的 Replacement 是「${REPLACEMENT}」（变化的属性：${CAUSES:-无}；根卷：${ROOT_DEVICE}）：会替换或可能替换实例，已删掉变更集，没有执行。" >&2
  drop; exit 1
fi
read -r -p "实例只会停机再开。输入栈名 ${STACK} 确认执行：" answer
[[ "$answer" == "$STACK" ]] || { echo "没有确认，已删掉变更集" >&2; drop; exit 1; }
aws cloudformation execute-change-set --region "$REGION" --stack-name "$STACK" --change-set-name "$NAME"
aws cloudformation wait stack-update-complete --region "$REGION" --stack-name "$STACK"
INSTANCE="$(output InstanceId)"
echo "实例 ${INSTANCE} 现在是：$(aws ec2 describe-instances --region "$REGION" --instance-ids "$INSTANCE" --query 'Reservations[0].Instances[0].InstanceType' --output text)"
SITE="$(output Jiuan07Url)"
for attempt in $(seq 1 36); do
  if curl -fsS "$SITE/poc/healthz" >/dev/null 2>&1; then echo "健康检查通过：$SITE"; exit 0; fi
  sleep 10
done
echo "健康检查没有通过" >&2
exit 1
