#!/usr/bin/env bash
# 清理 andon-finance PoC：清空构件桶（含 secrets/secrets.env）→ 删栈（EC2、Elastic IP、CloudFront、DNS 记录、安全组、角色）→ 删早期版本留在 /andon-finance/poc 下的参数（如有）。
# 不可恢复。Nexus 上的发布与调用密钥不受影响。
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
STACK="andon-finance-poc"
PREFIX="/andon-finance/poc"

read -r -p "将删除栈 ${STACK}、它的构件桶内容，以及 $PREFIX 下的全部参数。请输入栈名确认：" answer
[[ "$answer" == "$STACK" ]] || { echo "已取消。"; exit 1; }

BUCKET="$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='ArtifactBucketName'].OutputValue" --output text 2>/dev/null || true)"
if [[ -n "$BUCKET" && "$BUCKET" != "None" ]]; then
  aws s3 rm --region "$REGION" "s3://$BUCKET" --recursive --only-show-errors
fi

aws cloudformation delete-stack --region "$REGION" --stack-name "$STACK"
echo "等待删栈完成（删除 CloudFront 约需 5–15 分钟）…"
aws cloudformation wait stack-delete-complete --region "$REGION" --stack-name "$STACK"

NAMES="$(aws ssm get-parameters-by-path --region "$REGION" --path "$PREFIX" --recursive --query 'Parameters[].Name' --output text)"
if [[ -n "$NAMES" ]]; then
  # delete-parameters 一次最多 10 个名字
  printf '%s\n' $NAMES | xargs -n 10 aws ssm delete-parameters --region "$REGION" --names >/dev/null
fi
echo "清理完成。本机的 infra/secrets.env 没有删除；如果不再需要，请删掉它，并在 Nexus 网页停用这台 EC2 的 API 密钥和发布的调用密钥。"
