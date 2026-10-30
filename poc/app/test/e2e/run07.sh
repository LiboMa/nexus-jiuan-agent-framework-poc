#!/usr/bin/env bash
# 对测试台上的九安 v0.7.10（https://jiuan-v0710.tinyboat.blog）跑端到端测试。先重置：bench07-reset.sh 删掉并重建库 jiuan07 再起服务，
# 单据从模拟汇联易重新同步；「Agent 接入」的启用记录保留（重置脚本导出后写回）。PoC 的库和服务不动。
# 两个账号的口令从 infra/secrets.env 读进本进程的环境变量。调用密钥不经过这里：管理员在九安「后台配置 › Agent 接入」页上粘贴一次。
# 知识库方式（DEPLOY_ENV 的 KB_MODE，不写是 pg）和这种方式的知识库 Agent 的发布编号（KB_PG_PUBLICATION_ID / KB_S3V_PUBLICATION_ID）交给测试；
# s3vectors 方式另给向量桶和规则索引（测试用本机凭证只读查规则编号）。KB_E2E_DOCX=<本机的制度 .docx> 时「制度知识库」用例在页面上传它。
# 真实调用 Nexus：一轮约 8 次 AI 独立建议（每次约 0.1–0.3 美元），另有几次知识库 Agent 的调用。
# 用法：[DEPLOY_ENV=…] [KB_E2E_DOCX=…] run07.sh [node --test 的参数，例如 --test-name-pattern 登录]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/../../../infra/lib/deploy-env.sh"
load_deploy_env
REGION="${AWS_REGION:-us-east-1}"
STACK="${STACK:-andon-finance-poc}"
SECRETS="$HERE/../../../infra/secrets.env"
[[ -f "$SECRETS" ]] || { echo "找不到 ${SECRETS}：先运行 infra/deploy.sh" >&2; exit 1; }
secret() { sed -n "s/^$1=//p" "$SECRETS" | head -1; }
cd "$HERE"
[[ -d node_modules/playwright ]] || PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-audit --no-fund
output() { aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
output_param() { aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" --query "Stacks[0].Parameters[?ParameterKey=='$1'].ParameterValue" --output text; }
SITE="$(output Jiuan07Url)"
INSTANCE="$(output InstanceId)"
echo "重置九安 v0.7.10：$INSTANCE"
COMMAND_ID="$(aws ssm send-command --region "$REGION" --instance-ids "$INSTANCE" --document-name AWS-RunShellScript --comment 'jiuan07 e2e reset' \
  --parameters 'commands=["/opt/andon-finance/current/bench/bench07-reset.sh"]' --query Command.CommandId --output text)"
aws ssm wait command-executed --region "$REGION" --command-id "$COMMAND_ID" --instance-id "$INSTANCE"
[[ "$(aws ssm get-command-invocation --region "$REGION" --command-id "$COMMAND_ID" --instance-id "$INSTANCE" --query StandardOutputContent --output text)" == *JIUAN07_RESET_OK* ]] \
  || { echo "重置没有成功：sudo journalctl -u andon-jiuan07 -n 200" >&2; exit 1; }
# 区域和 Nexus 的主机名给测试用（经 SSM 查库、核对出站拦截记录里没有 Nexus）
E2E07_REGION="$REGION"
E2E07_NEXUS_HOST="$(output_param NexusOrigin | sed -E 's#^https?://##; s#[/:].*$##')"
export E2E07_BASE_URL="$SITE" E2E07_INSTANCE="$INSTANCE" E2E07_REGION E2E07_NEXUS_HOST
# 知识库方式和「公司制度」经的知识库 Agent 的发布（Agent 接入那条核对它已启用、不是审批 Agent）；没写发布编号时测试失败并说明
E2E07_KB_MODE="${KB_MODE:-pg}"
if [[ "$E2E07_KB_MODE" == s3vectors ]]; then
  E2E07_KB_PUBLICATION_ID="${KB_S3V_PUBLICATION_ID:-}"
  E2E07_KB_S3V_BUCKET="${KB_S3V_BUCKET:-}"
  E2E07_KB_S3V_RULES_INDEX="${KB_S3V_RULES_INDEX:-}"
  export E2E07_KB_S3V_BUCKET E2E07_KB_S3V_RULES_INDEX
else
  E2E07_KB_PUBLICATION_ID="${KB_PG_PUBLICATION_ID:-}"
fi
export E2E07_KB_MODE E2E07_KB_PUBLICATION_ID
E2E_REVIEWER_PASSWORD="$(secret REVIEWER_PASSWORD)"
E2E_CHECKER_PASSWORD="$(secret CHECKER_PASSWORD)"
export E2E_REVIEWER_PASSWORD E2E_CHECKER_PASSWORD
node --test --test-concurrency=1 "$@" jiuan07.e2e.mjs
