#!/usr/bin/env bash
# 部署或更新 andon-finance PoC（us-east-1，栈 andon-finance-poc）。
#   infra/deploy.sh             单元测试 → 生成前端副本 → 建栈或更新栈 → 生成口令（只在没有时）→ 打包上传 → 让 EC2 拉取并重启 → 健康检查
#   infra/deploy.sh --code-only 跳过建栈，只打包上传、重启、健康检查
# 测试台：构件里的九安是构建出来的副本（poc/bench/build-jiuan.sh：开发包 + 补丁 + mysql2）；重启前在实例上配置测试台（bench/bench-configure.sh）。
#   KB_ALLOWED_CIDR=<私网段> deploy.sh  建栈时一起放行知识库的 PG 端口（栈已在时用 infra/kb.sh sg）；知识库本身用 infra/kb.sh 部署，见 kb/README.md
#   POC_STORE=memory|mysql 决定服务用内存存储还是本机 MySQL（默认 mysql；回到内存存储：POC_STORE=memory deploy.sh --code-only）。
# 需要本机的 AWS 凭证（能建 CloudFormation 栈、写构件桶、执行 SSM Run Command）。应用的启动配置（口令、REGISTRY_KEY、测试台密钥）只在 infra/secrets.env，不打印；Agent 的调用密钥不经过这里，用户在前端启用。
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
STACK="andon-finance-poc"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
SECRETS="$HERE/secrets.env"
POC_DIR="$(cd "$HERE/.." && pwd)"
APP_DIR="$POC_DIR/app"
JIUAN_CODE_DIR="${JIUAN_CODE_DIR:-$POC_DIR/../source/审核平台-测试环境开发包-v0.5.3/code}"
OPERATOR_SCRIPT="${NEXUS_OPERATOR_SCRIPT:-$POC_DIR/../skills/nexus-ai-operator/scripts/nexus.py}"
CODE_ONLY=false
[[ "${1:-}" == "--code-only" ]] && CODE_ONLY=true
POC_STORE="${POC_STORE:-mysql}"
[[ "$POC_STORE" == "memory" || "$POC_STORE" == "mysql" ]] || { echo "POC_STORE 只能是 memory 或 mysql" >&2; exit 2; }

say() { printf '\n== %s\n' "$*"; }
output() {
  aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

say "检查工具与账号"
for tool in node aws rsync tar curl openssl; do command -v "$tool" >/dev/null || { echo "缺少 $tool" >&2; exit 1; }; done
aws sts get-caller-identity --query Account --output text
[[ -f "$JIUAN_CODE_DIR/analysis-server.mjs" ]] || { echo "找不到九安开发包：$JIUAN_CODE_DIR" >&2; exit 1; }
[[ -f "$OPERATOR_SCRIPT" ]] || { echo "找不到 nexus-ai-operator：$OPERATOR_SCRIPT" >&2; exit 1; }

say "单元测试"
(cd "$APP_DIR" && node --test "test/unit/**/*.test.mjs")

say "生成前端副本"
(cd "$APP_DIR" && node scripts/build-public.mjs)

say "构建九安副本（开发包 + 补丁 + mysql2）"
"$POC_DIR/bench/build-jiuan.sh"

say "构建九安 v0.7.10 副本（按清单复制 + mysql2），跑测试台外壳的单元测试"
"$POC_DIR/bench/build-jiuan07.sh"
(cd "$POC_DIR/app07" && node --test "test/unit/**/*.test.mjs")

if ! $CODE_ONLY; then
  say "建栈或更新栈 ${STACK}（第一次建 CloudFront 约需 5–15 分钟）"
  aws cloudformation validate-template --region "$REGION" --template-body "file://$HERE/andon-finance-poc.yaml" >/dev/null
  args=(--region "$REGION" --stack-name "$STACK" --template-file "$HERE/andon-finance-poc.yaml" --capabilities CAPABILITY_IAM
    --no-fail-on-empty-changeset --tags project=andon-finance-poc)
  overrides=()
  if ! aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" >/dev/null 2>&1; then
    AMI="$(aws ssm get-parameter --region "$REGION" --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 --query Parameter.Value --output text)"
    overrides+=("ImageId=$AMI")
  fi
  # 知识库的 PG 端口入站规则（模板里的 KbIngress）：第一次建栈时可以一起开；栈已在时用 infra/kb.sh sg（它会接管手工加的同样规则）。
  # 没给就沿用栈上的值（aws cloudformation deploy 对没写的参数用现值）。
  [[ -n "${KB_ALLOWED_CIDR:-}" ]] && overrides+=("KbAllowedCidr=$KB_ALLOWED_CIDR")
  [[ ${#overrides[@]} -gt 0 ]] && args+=(--parameter-overrides "${overrides[@]}")
  aws cloudformation deploy "${args[@]}"
fi

BUCKET="$(output ArtifactBucketName)"
INSTANCE="$(output InstanceId)"
SITE="$(output SiteUrl)"

param() { aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" --query "Stacks[0].Parameters[?ParameterKey=='$1'].ParameterValue" --output text; }

say "密钥配置文件 $SECRETS"
if [[ ! -f "$SECRETS" ]]; then
  install -m 600 /dev/null "$SECRETS"   # 先建成 0600，再写入
  cat >> "$SECRETS" <<SECRETSFILE
# andon-finance PoC 的启动配置（口令、REGISTRY_KEY、测试台密钥）。只放在本机和实例上，不进构件、不进文档、不贴进对话。改完运行 infra/deploy.sh --code-only。Agent 的调用密钥不放这里，在前端「Nexus Agent」页启用。
REVIEWER_PASSWORD=$(openssl rand -base64 18)
CHECKER_PASSWORD=$(openssl rand -base64 18)
# 加密各用户调用密钥的密钥（32 字节 base64）。换掉它，所有用户都要重新启用 Agent。
REGISTRY_KEY=$(openssl rand -base64 32)
SECRETSFILE
  echo "已生成 ${SECRETS}：两条随机口令和 REGISTRY_KEY（测试台的三项密钥接着补上）。Agent 的调用密钥不放这里，在前端「Nexus Agent」页启用"
fi
if ! grep -q '^REGISTRY_KEY=' "$SECRETS"; then
  printf '%s\n' '# 加密各用户调用密钥的密钥（32 字节 base64）。换掉它，所有用户都要重新启用 Agent。' "REGISTRY_KEY=$(openssl rand -base64 32)" >> "$SECRETS"
  echo "已在 ${SECRETS} 里补上 REGISTRY_KEY"
fi
# >>> bench-secrets
# 测试台（MySQL 与九安存储）的三项密钥：缺了才补，已有的永远不改。换了 BENCH_DATA_KEY，九安的库就打不开了。
for name in BENCH_MYSQL_ROOT_PASSWORD BENCH_MYSQL_APP_PASSWORD BENCH_DATA_KEY JIUAN07_MYSQL_APP_PASSWORD JIUAN07_DATA_KEY; do
  grep -q "^${name}=" "$SECRETS" && continue
  if [[ "$name" == *_DATA_KEY ]]; then value="$(openssl rand -base64 32)"; else value="$(openssl rand -hex 16)"; fi
  printf '%s\n' "# 测试台：只补不换（${name}）" "${name}=${value}" >> "$SECRETS"
  echo "已在 ${SECRETS} 里补上 ${name}"
done
# <<< bench-secrets
chmod 600 "$SECRETS"

say "打包并上传构件"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/release/app" "$STAGE/release/jiuan" "$STAGE/release/operator/scripts" "$STAGE/release/bench" "$STAGE/release/app07" "$STAGE/release/jiuan07"
rsync -a --exclude test --exclude node_modules --exclude .DS_Store "$APP_DIR/" "$STAGE/release/app/"
# 九安取构建出来的副本：已经不含 tests、deploy，带着锁定版本的 node_modules（mysql2）。
rsync -a --exclude .DS_Store "$POC_DIR/../.build/jiuan/" "$STAGE/release/jiuan/"
rsync -a --exclude .DS_Store "$HERE/bench/" "$STAGE/release/bench/"
# 九安 v0.7.10：测试台外壳（不带测试和冒烟脚本）和按清单复制的副本（不含 seeds、database、tests、deploy、scripts）
rsync -a --exclude test --exclude scripts --exclude node_modules --exclude .DS_Store "$POC_DIR/app07/" "$STAGE/release/app07/"
rsync -a --exclude .DS_Store "$POC_DIR/../.build/jiuan07/" "$STAGE/release/jiuan07/"
cp "$OPERATOR_SCRIPT" "$STAGE/release/operator/scripts/nexus.py"
# macOS 的 tar 默认会带上 AppleDouble（._*）和扩展属性，实例上解包会多出垃圾文件和告警。
COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs -czf "$STAGE/current.tgz" -C "$STAGE/release" .
aws s3 cp --region "$REGION" --only-show-errors "$STAGE/current.tgz" "s3://$BUCKET/releases/current.tgz"
aws s3 cp --region "$REGION" --only-show-errors "$STAGE/current.tgz" "s3://$BUCKET/releases/archive/$(date -u +%Y%m%dT%H%M%SZ).tgz"
aws s3 cp --region "$REGION" --only-show-errors --sse AES256 "$SECRETS" "s3://$BUCKET/secrets/secrets.env"

say "等 EC2 的 SSM Agent 上线"
status=""
for attempt in $(seq 1 60); do
  status="$(aws ssm describe-instance-information --region "$REGION" --filters "Key=InstanceIds,Values=$INSTANCE" \
    --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null || true)"
  [[ "$status" == "Online" ]] && break
  sleep 10
done
[[ "$status" == "Online" ]] || { echo "SSM Agent 没有上线，请检查实例 $INSTANCE" >&2; exit 1; }

say "按栈参数重写实例配置，让 EC2 拉取新构件并重启服务"
# 用户数据只在首次启动时写 /etc/andon-finance/env；改了栈参数（如 AdvisoryPublicationId、NexusOrigin、AppPort）之后，靠这里同步到实例。
# 变量清单必须与模板用户数据里的一致（infra.test.mjs 会核对）。
ENV_FILE="$(cat <<ENVFILE
POC_ORIGIN=https://$(param DomainName)
POC_PORT=$(param AppPort)
POC_BIND=0.0.0.0
POC_BUCKET=$BUCKET
AWS_REGION=$REGION
POC_SECRETS_FILE=/etc/andon-finance/secrets.env
NEXUS_ORIGIN=$(param NexusOrigin)
NEXUS_ADVISORY_PUBLICATION=$(param AdvisoryPublicationId)
NEXUS_HOME=/var/lib/andon-finance/nexus
NEXUS_OPERATOR=/opt/andon-finance/current/operator/scripts/nexus.py
JIUAN_CODE_DIR=/opt/andon-finance/current/jiuan
POC_PUBLIC_DIR=/opt/andon-finance/current/app/public
ENVFILE
)"
ENV_B64="$(printf '%s\n' "$ENV_FILE" | base64 | tr -d '\n')"
# 九安 v0.7.10 的站点：栈还没更新到有这个参数时（先跑了 --code-only）用模板的默认值
J07_DOMAIN="$(param Jiuan07DomainName)"
[[ -n "$J07_DOMAIN" && "$J07_DOMAIN" != None ]] || J07_DOMAIN=jiuan-v0710.tinyboat.blog
# 先装密钥配置文件（root:andon 0640），再写 env，最后重启；任何一步失败都不重启。
INSTALL="aws s3 cp s3://$BUCKET/secrets/secrets.env /etc/andon-finance/secrets.env.new --region $REGION --only-show-errors && chown root:andon /etc/andon-finance/secrets.env.new && chmod 0640 /etc/andon-finance/secrets.env.new && mv /etc/andon-finance/secrets.env.new /etc/andon-finance/secrets.env && echo $ENV_B64 | base64 -d > /etc/andon-finance/env && chmod 0644 /etc/andon-finance/env && rm -rf /var/tmp/andon-bench-config && mkdir -p /var/tmp/andon-bench-config && aws s3 cp s3://$BUCKET/releases/current.tgz /var/tmp/andon-bench-config/release.tgz --region $REGION --only-show-errors && tar -xzf /var/tmp/andon-bench-config/release.tgz -C /var/tmp/andon-bench-config ./bench && bash /var/tmp/andon-bench-config/bench/bench-configure.sh $POC_STORE && bash /var/tmp/andon-bench-config/bench/bench07-configure.sh $J07_DOMAIN $(param NexusOrigin) && systemctl restart andon-finance-poc.service && systemctl restart andon-jiuan07.service"
COMMANDS="$(printf '{"commands":["%s","sleep 5","systemctl is-active andon-finance-poc.service","systemctl is-active andon-jiuan07.service"]}' "$INSTALL")"
COMMAND_ID="$(aws ssm send-command --region "$REGION" --instance-ids "$INSTANCE" --document-name AWS-RunShellScript --comment 'andon-finance-poc deploy' \
  --parameters "$COMMANDS" --query Command.CommandId --output text)"
aws ssm wait command-executed --region "$REGION" --command-id "$COMMAND_ID" --instance-id "$INSTANCE" || true
aws ssm get-command-invocation --region "$REGION" --command-id "$COMMAND_ID" --instance-id "$INSTANCE" --query '[Status,StandardOutputContent,StandardErrorContent]' --output text
# SSM 没成功就停在这里，不再报「健康检查通过」（评审 I1）。
[[ "$(aws ssm get-command-invocation --region "$REGION" --command-id "$COMMAND_ID" --instance-id "$INSTANCE" --query Status --output text)" == "Success" ]] \
  || { echo "实例上的安装或重启没有成功（见上面的输出），不做健康检查" >&2; exit 1; }

say "健康检查 $SITE/api/health 和 https://$J07_DOMAIN/poc/healthz"
healthy() { for attempt in $(seq 1 36); do curl -fsS "$1" >/dev/null 2>&1 && return 0; sleep 10; done; return 1; }
healthy "$SITE/api/health" || { echo "PoC 健康检查没有通过。查看日志：aws ssm start-session --region $REGION --target ${INSTANCE}，然后 sudo journalctl -u andon-finance-poc -n 200" >&2; exit 1; }
echo "健康检查通过：$SITE"
# v0.7.10 经 PoC 进程按 Host 转发；第一次建它的 CloudFront 分发后，DNS 生效要几分钟
healthy "https://$J07_DOMAIN/poc/healthz" || { echo "九安 v0.7.10 健康检查没有通过。查看日志：sudo journalctl -u andon-jiuan07 -n 200（实例 ${INSTANCE}）" >&2; exit 1; }
echo "健康检查通过：https://${J07_DOMAIN}（九安 v0.7.10）"
echo "两个账号的口令在 ${SECRETS}（REVIEWER_PASSWORD / CHECKER_PASSWORD），两个站点相同"
