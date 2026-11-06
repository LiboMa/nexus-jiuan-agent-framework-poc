#!/usr/bin/env bash
# 升级测试台之前的备份（需要本机 AWS 凭证）：根卷快照（标签 andon-finance-poc-backup），等它完成。
# 根卷上有九安的 PostgreSQL（/var/lib/jiuan-pg）、知识库的 PG、切换前留着做回退的 MySQL 的数据目录和九安 v0.7.10 的状态目录 /var/lib/jiuan，
# 所以一个快照就够；不登实例（经 SSM 或 SSH 都不用）。
# 恢复：用快照建卷替换根卷。只搬数据到另一台机器用 migrate-data.sh。
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/lib/deploy-env.sh"
load_deploy_env
REGION="${AWS_REGION:-us-east-1}"
STACK="${STACK:-andon-finance-poc}"
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
echo "备份完成：快照 ${SNAPSHOT}"
