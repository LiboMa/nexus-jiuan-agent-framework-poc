#!/usr/bin/env bash
# review_advice@1 冒烟测试：先确保九安 v0.7.10 构件在（bench/build-jiuan07.sh），再跑 review-advice-smoke.mjs，
# 最后经 SSM 到测试台的知识库（容器 nexus-pgvector，库 nexus，表 approval_rules）里核对 Agent 引用的规则编号都存在。
# 调用密钥从 infra/secrets.env 读进本进程的环境变量，不打印、不落盘。真实调用 Nexus：每张用例约 0.1–0.3 美元。
# 用法：review-advice-smoke.sh [--only id,id] [--probe-only]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POC="$(cd "$HERE/../.." && pwd)"
SECRETS="$POC/infra/secrets.env"
REGION="${AWS_REGION:-us-east-1}"
STACK="andon-finance-poc"

[[ -d "$POC/../.build/jiuan07/providers" ]] || bash "$POC/bench/build-jiuan07.sh" >/dev/null
NEXUS_SMOKE_KEY="$(sed -n 's/^NEXUS_A2A_KEY_pub_5c53e70d8dc7ddea=//p' "$SECRETS" | head -1)"
export NEXUS_SMOKE_KEY
OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT
status=0
node "$HERE/review-advice-smoke.mjs" "$@" | tee "$OUT" || status=$?

ids="$(sed -n 's/^RULE_IDS //p' "$OUT")"
[[ -n "$ids" ]] || exit "$status"
# 编号只允许 C05-3.4、C05-NOTE、G-08 这种写法，才拼进 SQL
[[ "$ids" =~ ^[A-Z0-9.,-]+$ ]] || { echo "规则编号格式不对：$ids" >&2; exit 1; }
list="'${ids//,/\',\'}'"
SQL="SELECT string_agg(rule_id, ',' ORDER BY rule_id) FROM approval_rules WHERE rule_id IN ($list);"
INSTANCE="$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" --output text)"
PARAMS="$(python3 -c 'import json,sys; print(json.dumps({"commands":["docker exec nexus-pgvector psql -U postgres -d nexus -X -tAc \"" + sys.argv[1] + "\""]}))' "$SQL")"
CID="$(aws ssm send-command --region "$REGION" --instance-ids "$INSTANCE" --document-name AWS-RunShellScript --comment 'kb rule-id check (read-only)' \
  --parameters "$PARAMS" --query Command.CommandId --output text)"
aws ssm wait command-executed --region "$REGION" --command-id "$CID" --instance-id "$INSTANCE" 2>/dev/null || true
found="$(aws ssm get-command-invocation --region "$REGION" --command-id "$CID" --instance-id "$INSTANCE" --query StandardOutputContent --output text | tr -d '[:space:]')"
missing="$(comm -23 <(tr ',' '\n' <<<"$ids" | sort -u) <(tr ',' '\n' <<<"$found" | sort -u))"
if [[ -n "$missing" ]]; then
  echo "知识库里没有这些编号（Agent 编造或写错）：$(tr '\n' ' ' <<<"$missing")" >&2
  exit 1
fi
echo "KB_CHECK_OK 引用的规则都在知识库里：$ids"
exit "$status"
