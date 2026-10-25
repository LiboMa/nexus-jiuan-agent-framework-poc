#!/usr/bin/env bash
# 对测试台上的九安 v0.7.10（https://jiuan-v0710.tinyboat.blog）跑端到端测试。先重置：bench07-reset.sh 删掉并重建库 jiuan07 再起服务，
# 单据从模拟汇联易重新同步；「Agent 接入」的启用记录也在这个库里，测试里由管理员重新启用。PoC 的库和服务不动。
# 两个账号的口令和发布的调用密钥从 infra/secrets.env 读进本进程的环境变量，只在进程内使用（调用密钥在九安「Agent 接入」页粘贴，九安加密存库）。
# 真实调用 Nexus：每张对公付款单一次 AI 独立建议（约 0.1–0.3 美元），一轮约 5 张。用法：run07.sh [node --test 的参数，例如 --test-name-pattern 登录]
set -euo pipefail
REGION="${AWS_REGION:-us-east-1}"
STACK="andon-finance-poc"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SECRETS="$HERE/../../../infra/secrets.env"
[[ -f "$SECRETS" ]] || { echo "找不到 ${SECRETS}：先运行 infra/deploy.sh" >&2; exit 1; }
secret() { sed -n "s/^$1=//p" "$SECRETS" | head -1; }
cd "$HERE"
[[ -d node_modules/playwright ]] || PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-audit --no-fund
output() { aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
SITE="$(output Jiuan07Url)"
INSTANCE="$(output InstanceId)"
echo "重置九安 v0.7.10：$INSTANCE"
COMMAND_ID="$(aws ssm send-command --region "$REGION" --instance-ids "$INSTANCE" --document-name AWS-RunShellScript --comment 'jiuan07 e2e reset' \
  --parameters 'commands=["/opt/andon-finance/current/bench/bench07-reset.sh"]' --query Command.CommandId --output text)"
aws ssm wait command-executed --region "$REGION" --command-id "$COMMAND_ID" --instance-id "$INSTANCE"
[[ "$(aws ssm get-command-invocation --region "$REGION" --command-id "$COMMAND_ID" --instance-id "$INSTANCE" --query StandardOutputContent --output text)" == *JIUAN07_RESET_OK* ]] \
  || { echo "重置没有成功：sudo journalctl -u andon-jiuan07 -n 200" >&2; exit 1; }
export E2E07_BASE_URL="$SITE" E2E07_INSTANCE="$INSTANCE"
E2E_REVIEWER_PASSWORD="$(secret REVIEWER_PASSWORD)"
E2E_CHECKER_PASSWORD="$(secret CHECKER_PASSWORD)"
E2E07_CALL_KEY="$(secret NEXUS_A2A_KEY_pub_5c53e70d8dc7ddea)"
export E2E_REVIEWER_PASSWORD E2E_CHECKER_PASSWORD E2E07_CALL_KEY
node --test --test-concurrency=1 "$@" jiuan07.e2e.mjs
