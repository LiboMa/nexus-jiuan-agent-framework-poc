#!/usr/bin/env bash
# 准备九安的 PostgreSQL（换库的第一步，本机运行）：不碰正在跑的服务、不改外壳的配置，只在实例上加东西。
#   1. 补密钥：本机 secrets.env 缺 BENCH_PG_SUPERUSER_PASSWORD、JIUAN_PG_APP_PASSWORD 就补上（lib/bench-secrets.sh，只补不换）
#   2. 和 deploy.sh 一样经构件桶（服务端加密）把 secrets.env 装到实例的 /etc/andon-finance/secrets.env（root 0600）
#   3. 实例上跑 bench/pg-install.sh（容器 jiuan-pg）和 bench/test-databases.sh create（远端测试用的 jiuan_test）
# 用法：DEPLOY_ENV=poc/infra/env/<环境>.env bash poc/infra/pg-prepare.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
source "$HERE/lib/deploy-env.sh"
load_deploy_env
source "$HERE/lib/remote.sh"
source "$HERE/lib/bench-secrets.sh"
REGION="${AWS_REGION:-us-east-1}"
STACK="${STACK:-andon-finance-poc}"
SECRETS="$HERE/secrets.env"
[[ -f "$SECRETS" ]] || { echo "找不到 ${SECRETS}：先运行 deploy.sh" >&2; exit 1; }
output() { aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
REMOTE="$(remote_mode)"
[[ "$REMOTE" == ssm ]] || ssh_check_key || exit 2

ensure_bench_secrets "$SECRETS"
BUCKET="$(output ArtifactBucketName)"
INSTANCE="$(output InstanceId)"
aws s3 cp --region "$REGION" --only-show-errors --sse AES256 "$SECRETS" "s3://$BUCKET/secrets/secrets.env"
if [[ "$REMOTE" == ssh ]]; then ssh_setup "$(output ElasticIp)" "$INSTANCE" && ssh_wait 30 || exit 1; fi

# 两个脚本按原文传过去（base64，免得引号出问题；里面没有密钥）
PG_INSTALL_B64="$(base64 < "$HERE/bench/pg-install.sh" | tr -d '\n')"
TEST_DATABASES_B64="$(base64 < "$HERE/bench/test-databases.sh" | tr -d '\n')"
SCRIPT="$(cat <<SH
set -euo pipefail
work="\$(mktemp -d /var/tmp/jiuan-pg-prepare.XXXXXX)"; trap 'rm -rf "\$work"' EXIT
aws s3 cp s3://$BUCKET/secrets/secrets.env /etc/andon-finance/secrets.env.new --region $REGION --only-show-errors
chown root:root /etc/andon-finance/secrets.env.new; chmod 0600 /etc/andon-finance/secrets.env.new
mv /etc/andon-finance/secrets.env.new /etc/andon-finance/secrets.env
echo "$PG_INSTALL_B64" | base64 -d > "\$work/pg-install.sh"
echo "$TEST_DATABASES_B64" | base64 -d > "\$work/test-databases.sh"
bash "\$work/pg-install.sh"
bash "\$work/test-databases.sh" create
SH
)"
out="$(run_root "$INSTANCE" "$SCRIPT" 900)" || { printf '%s\n' "$out"; echo "准备 PostgreSQL 没有成功" >&2; exit 1; }
printf '%s\n' "$out"
[[ "$out" == *BENCH_PG_READY* && "$out" == *TEST_DATABASES_READY* ]] || { echo "没有看到 BENCH_PG_READY / TEST_DATABASES_READY" >&2; exit 1; }
echo "PG_PREPARE_OK"
