#!/usr/bin/env bash
# 升级测试台之前的备份（需要本机 AWS 凭证）：
#   1. 根卷快照（标签 andon-finance-poc-backup），等它完成；
#   2. 经 SSM 在实例上把账号目录（users、nexus）打包到 /root/andon-backup-<时间>.tgz（0600）。
# 恢复：用快照建卷替换根卷；或者把打包文件解回 /var/lib/andon-finance（属主 andon:andon，目录 0700、文件 0600）。
set -euo pipefail
REGION="${AWS_REGION:-us-east-1}"
STACK="andon-finance-poc"
output() { aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
INSTANCE="$(output InstanceId)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
VOLUME="$(aws ec2 describe-instances --region "$REGION" --instance-ids "$INSTANCE" --query 'Reservations[0].Instances[0].BlockDeviceMappings[0].Ebs.VolumeId' --output text)"
SNAPSHOT="$(aws ec2 create-snapshot --region "$REGION" --volume-id "$VOLUME" --description "andon-finance-poc backup ${STAMP}" \
  --tag-specifications "ResourceType=snapshot,Tags=[{Key=Name,Value=andon-finance-poc-backup},{Key=project,Value=andon-finance-poc}]" \
  --query SnapshotId --output text)"
echo "根卷 ${VOLUME} 的快照 ${SNAPSHOT} 已开始，等它完成（可能要十几分钟）"
done_wait=false
for attempt in 1 2 3; do
  if aws ec2 wait snapshot-completed --region "$REGION" --snapshot-ids "$SNAPSHOT" 2>/dev/null; then done_wait=true; break; fi
done
$done_wait || { echo "快照 ${SNAPSHOT} 还没完成，先不要升级" >&2; exit 1; }
echo "快照完成：${SNAPSHOT}"
ARCHIVE="/root/andon-backup-${STAMP}.tgz"
COMMANDS="$(printf '{"commands":["umask 077 && tar -czf /root/andon-backup-%s.tgz -C /var/lib/andon-finance users nexus && ls -l /root/andon-backup-%s.tgz"]}' "$STAMP" "$STAMP")"
COMMAND_ID="$(aws ssm send-command --region "$REGION" --instance-ids "$INSTANCE" --document-name AWS-RunShellScript --comment 'andon-finance-poc backup' \
  --parameters "$COMMANDS" --query Command.CommandId --output text)"
aws ssm wait command-executed --region "$REGION" --command-id "$COMMAND_ID" --instance-id "$INSTANCE" || true
aws ssm get-command-invocation --region "$REGION" --command-id "$COMMAND_ID" --instance-id "$INSTANCE" --query '[Status,StandardOutputContent,StandardErrorContent]' --output text
[[ "$(aws ssm get-command-invocation --region "$REGION" --command-id "$COMMAND_ID" --instance-id "$INSTANCE" --query Status --output text)" == "Success" ]] \
  || { echo "实例上的打包没有成功" >&2; exit 1; }
echo "备份完成：快照 ${SNAPSHOT}；实例上 ${ARCHIVE}"
