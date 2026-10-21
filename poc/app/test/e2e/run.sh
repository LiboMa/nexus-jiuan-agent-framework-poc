#!/usr/bin/env bash
# 对线上地址跑端到端测试。先重置：测试台上用 bench-reset.sh 删掉并重建九安的库再开服务（单据回到 8 张种子、审批流清空）；
# 实例上还没有这个脚本时退回到重启服务（清空内存状态）。各账号的连接与启用存在磁盘上，都不受影响。两个账号的口令从 infra/secrets.env 读进环境变量，只在本进程里使用；
# Agent 的调用密钥和 Nexus 连接用审核员本人在前端「Nexus Agent」页上的，不从文件读。
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
SITE="$(output SiteUrl)"
INSTANCE="$(output InstanceId)"
echo "重置测试台（或重启服务）：$INSTANCE"
COMMAND_ID="$(aws ssm send-command --region "$REGION" --instance-ids "$INSTANCE" --document-name AWS-RunShellScript --comment 'andon-finance-poc e2e reset' \
  --parameters 'commands=["if [ -x /opt/andon-finance/current/bench/bench-reset.sh ]; then /opt/andon-finance/current/bench/bench-reset.sh; else systemctl restart andon-finance-poc.service; fi"]' --query Command.CommandId --output text)"
aws ssm wait command-executed --region "$REGION" --command-id "$COMMAND_ID" --instance-id "$INSTANCE"
healthy=false
for attempt in $(seq 1 30); do
  if curl -fsS "$SITE/api/health" >/dev/null 2>&1; then healthy=true; break; fi
  sleep 5
done
$healthy || { echo "服务重启后健康检查没有通过" >&2; exit 1; }
export E2E_BASE_URL="$SITE"
E2E_REVIEWER_PASSWORD="$(secret REVIEWER_PASSWORD)"
E2E_CHECKER_PASSWORD="$(secret CHECKER_PASSWORD)"
export E2E_REVIEWER_PASSWORD E2E_CHECKER_PASSWORD
# 不带参数时跑全部端到端测试；也可以只跑某几个文件，例如 run.sh attachments.e2e.mjs。
FILES=("$@")
[[ ${#FILES[@]} -gt 0 ]] || FILES=(poc.e2e.mjs attachments.e2e.mjs access.e2e.mjs)
# 开发目录里有进度看板（tools/progress）时，结果另记一份（每行一条用例）：evidence/e2e/last-run.jsonl；交接仓库里没有看板，只输出到终端。
ROOT="$(cd "$HERE/../../../.." && pwd)"
REPORT=()
if [[ -f "$ROOT/tools/progress/reporter.mjs" ]]; then
  mkdir -p "$ROOT/evidence/e2e"
  REPORT=(--test-reporter="file://$ROOT/tools/progress/reporter.mjs" --test-reporter-destination="$ROOT/evidence/e2e/last-run.jsonl")
fi
node --test --test-concurrency=1 --test-reporter=spec --test-reporter-destination=stdout ${REPORT[@]+"${REPORT[@]}"} "${FILES[@]}"
