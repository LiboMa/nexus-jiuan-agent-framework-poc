#!/usr/bin/env bash
# 在测试台上跑要 MySQL 的单元测试（本机不起 MySQL）：
#   把 poc/app（含测试）打包上传到构件桶 releases/bench-tests.tgz → 经 SSM 在实例上解包 → 建测试库 jiuan_bench_test
#   → 用实例上的九安副本跑测试 → 打印结果。测试会清空 jiuan_bench_test，不碰服务用的 jiuan_analysis。
# 用法：bench-test.sh [--mutate '<相对 poc/app 的文件>|<sed 表达式>'] [测试文件…]（默认三个 bench-*.test.mjs）
#   --mutate：先在实例上的测试副本里用 sed 把一个文件改坏再跑——证明测试能抓住这种错（这时期望失败）。
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/lib/deploy-env.sh"
load_deploy_env
REGION="${AWS_REGION:-us-east-1}"
STACK="${STACK:-andon-finance-poc}"
APP_DIR="$(cd "$HERE/../app" && pwd)"
MUTATE=""
if [[ "${1:-}" == "--mutate" ]]; then MUTATE="$2"; shift 2; fi
FILES=("$@")
[[ ${#FILES[@]} -gt 0 ]] || FILES=(test/unit/bench-store.test.mjs test/unit/bench-platform.test.mjs test/unit/bench-server.test.mjs)
output() { aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
BUCKET="$(output ArtifactBucketName)"
INSTANCE="$(output InstanceId)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
rsync -a --exclude node_modules --exclude e2e --exclude public --exclude .DS_Store "$APP_DIR/" "$STAGE/app/"
COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs -czf "$STAGE/bench-tests.tgz" -C "$STAGE" app
aws s3 cp --region "$REGION" --only-show-errors "$STAGE/bench-tests.tgz" "s3://$BUCKET/releases/bench-tests.tgz"
MUTATION=":"
if [[ -n "$MUTATE" ]]; then MUT_FILE="${MUTATE%%|*}"; MUT_EXPR="${MUTATE#*|}"; MUTATION="sed -i $(printf '%q' "$MUT_EXPR") $(printf '%q' "$MUT_FILE")"; fi
# macOS 自带的 bash 3.2 解析 $(cat <<EOF…) 里的引号有 bug，所以用 read -d '' 读 here-doc。
read -r -d '' REMOTE <<REMOTESCRIPT || true
set -euo pipefail
rm -rf /var/tmp/andon-bench-tests && mkdir -p /var/tmp/andon-bench-tests
aws s3 cp s3://$BUCKET/releases/bench-tests.tgz /var/tmp/andon-bench-tests/t.tgz --region $REGION --only-show-errors
tar -xzf /var/tmp/andon-bench-tests/t.tgz -C /var/tmp/andon-bench-tests
docker exec -i jiuan-mysql sh -c 'MYSQL_PWD="\$(cat /run/bench-secrets/mysql_root_password)" mysql -uroot -e "CREATE DATABASE IF NOT EXISTS jiuan_bench_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"'
cd /var/tmp/andon-bench-tests/app
$MUTATION
export JIUAN_CODE_DIR=/opt/andon-finance/current/jiuan
export MYSQL_TEST_URL="mysql://root:\$(cat /etc/andon-finance/bench/mysql_root_password)@127.0.0.1:3306/jiuan_bench_test"
set +e
/usr/bin/node-24 --test --test-concurrency=1 ${FILES[*]} > /var/tmp/andon-bench-tests/out.txt 2>&1
code=\$?
set -e
grep -E '^(✔|✖|ℹ (tests|pass|fail|skipped))' /var/tmp/andon-bench-tests/out.txt | tail -80
exit \$code
REMOTESCRIPT
B64="$(printf '%s\n' "$REMOTE" | base64 | tr -d '\n')"
COMMANDS="$(printf '{"commands":["echo %s | base64 -d > /var/tmp/andon-bench-test.sh && bash /var/tmp/andon-bench-test.sh"]}' "$B64")"
COMMAND_ID="$(aws ssm send-command --region "$REGION" --instance-ids "$INSTANCE" --document-name AWS-RunShellScript --comment 'andon-finance-poc bench tests' \
  --timeout-seconds 900 --parameters "$COMMANDS" --query Command.CommandId --output text)"
aws ssm wait command-executed --region "$REGION" --command-id "$COMMAND_ID" --instance-id "$INSTANCE" || true
aws ssm get-command-invocation --region "$REGION" --command-id "$COMMAND_ID" --instance-id "$INSTANCE" --query StandardOutputContent --output text
[[ "$(aws ssm get-command-invocation --region "$REGION" --command-id "$COMMAND_ID" --instance-id "$INSTANCE" --query Status --output text)" == "Success" ]]
