#!/usr/bin/env bash
# 部署或更新九安 v0.7.10 测试台（新前端 poc/web + 外壳 poc/app + 九安副本；栈的模板 andon-finance-poc.yaml）。
#   infra/deploy.sh             测试 → 构建 → 建栈或更新栈 → 生成密钥（只补没有的）→ 打包上传 → 实例上装构件、配置测试台、重启 → 健康检查
#   infra/deploy.sh --code-only 跳过建栈，只打包上传、装、重启、健康检查
# 动 AWS 资源之前：跑 poc/infra/test 的测试，构建九安 v0.7.10 副本（poc/bench/build-jiuan.sh：按清单复制 + 补丁 + mysql2），
#   新前端 npm ci、测试、构建（dist/ 放进构件的 web/dist，外壳的前门在 / 给它），再跑外壳的单元测试。
# 实例上（root）：装 secrets.env（root 0600）→ 解开新构件 → bench/bench-configure.sh（MySQL、jiuan 用户和服务；以前的 v0.5.3 PoC 服务还在就停掉删掉）
#   → 换上新构件（/opt/andon-finance/current，上一版留在 previous）→ 重启 andon-jiuan。哪一步失败都不往下走、不做健康检查。
#   KB_ALLOWED_CIDR=<私网段> deploy.sh  建栈时一起放行知识库的 PG 端口（栈已在时用 infra/kb.sh sg）；知识库本身用 infra/kb.sh 部署，见 kb/README.md
#   KB_MODE=pg|s3vectors（一般写在 DEPLOY_ENV 的配置文件里）决定「知识库」页走哪种方式（默认 pg）；两种方式都经 Nexus 上的知识库 Agent，
#   测试台不直连 PG。方式和当前方式的知识库 Agent 发布（pg：KB_PG_PUBLICATION_ID，可以不给；s3vectors：KB_S3V_PUBLICATION_ID，必须给）交给 bench/bench-configure.sh。
#   环境配置写了 SSH_KEY_FILE（和 SSH_KEY_NAME、SSH_ALLOWED_CIDR 或 SSH_VIA=eice）：实例经 SSH 管理，等实例上线、装构件和重启都经 SSH（ec2-user + sudo），不用 SSM；
#   主机公钥第一次从实例的控制台输出里取来钉住（lib/remote.sh）。建栈时按 INSTANCE_TYPE 的架构（arm64 的 m7g，或 x86_64 的 t3）取 AMI。
# 需要本机的 AWS 凭证（能建 CloudFormation 栈、写构件桶，执行 SSM Run Command 或读实例的控制台输出）。口令和测试台密钥只在 infra/secrets.env，不打印；
# Agent 的调用密钥不经过这里，管理员在新前端的「Agent 接入」页启用。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
source "$HERE/lib/deploy-env.sh"
load_deploy_env
source "$HERE/lib/remote.sh"
REGION="${AWS_REGION:-us-east-1}"
STACK="${STACK:-andon-finance-poc}"
SECRETS="$HERE/secrets.env"
POC_DIR="$(cd "$HERE/.." && pwd)"
OPERATOR_SCRIPT="${NEXUS_OPERATOR_SCRIPT:-$POC_DIR/../skills/nexus-ai-operator/scripts/nexus.py}"
CODE_ONLY=false
[[ "${1:-}" == "--code-only" ]] && CODE_ONLY=true
# 这两项原样拼进实例上以 root 跑的命令：先核对格式，不合格就在动任何 AWS 资源之前停下
[[ "${KB_MODE:-pg}" == "pg" || "${KB_MODE:-pg}" == "s3vectors" ]] || { echo "KB_MODE 只能是 pg 或 s3vectors" >&2; exit 2; }
[[ -z "${KB_S3V_PUBLICATION_ID:-}" || "$KB_S3V_PUBLICATION_ID" =~ ^pub_[0-9a-f]{16}$ ]] || { echo "KB_S3V_PUBLICATION_ID 应是文档管家的发布编号（pub_ 加 16 位十六进制）" >&2; exit 2; }
[[ "${KB_MODE:-pg}" == "pg" || -n "${KB_S3V_PUBLICATION_ID:-}" ]] || { echo "KB_MODE=s3vectors 时要给 KB_S3V_PUBLICATION_ID（知识库文档管家的发布）" >&2; exit 2; }
[[ -z "${KB_PG_PUBLICATION_ID:-}" || "$KB_PG_PUBLICATION_ID" =~ ^pub_[0-9a-f]{16}$ ]] || { echo "KB_PG_PUBLICATION_ID 应是 PG 知识库 Agent 的发布编号（pub_ 加 16 位十六进制）" >&2; exit 2; }
# 「知识库」页经哪个知识库 Agent：pg 方式取 KB_PG_PUBLICATION_ID（没给时页面说「知识库 Agent 还没配置」），s3vectors 方式取 KB_S3V_PUBLICATION_ID
KB_PUBLICATION="${KB_PG_PUBLICATION_ID:-}"
[[ "${KB_MODE:-pg}" == "pg" ]] || KB_PUBLICATION="$KB_S3V_PUBLICATION_ID"
REMOTE="$(remote_mode)"
# 经 SSH 管理：私钥和密钥对名字在动 AWS 之前核对
[[ "$REMOTE" == ssm ]] || ssh_check_key || exit 2

say() { printf '\n== %s\n' "$*"; }
output() {
  aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
# 测试不看部署的环境：DEPLOY_ENV 和环境配置能写的键（load_deploy_env 把读到的 export 了，shell 里也可能有同名的）都不传给 node --test
node_tests() { (unset -v DEPLOY_ENV "${DEPLOY_ENV_KEYS[@]}"; cd "$1" && node --test "$2"); }
# 新前端：按锁文件装依赖、跑它的测试、构建出 dist/；和单元测试一样不看部署的环境，哪一步失败部署就停
web_build() { (unset -v DEPLOY_ENV "${DEPLOY_ENV_KEYS[@]}"; cd "$1" && npm ci && npm test && npm run build); }

say "检查工具与账号"
for tool in node npm aws rsync tar curl openssl; do command -v "$tool" >/dev/null || { echo "缺少 $tool" >&2; exit 1; }; done
aws sts get-caller-identity --query Account --output text
[[ -f "$OPERATOR_SCRIPT" ]] || { echo "找不到 nexus-ai-operator：$OPERATOR_SCRIPT" >&2; exit 1; }

say "基础设施和部署脚本的测试（poc/infra/test）"
node_tests "$HERE" "test/**/*.test.mjs"

say "构建九安 v0.7.10 副本（按清单复制 + 补丁 + mysql2）"
"$POC_DIR/bench/build-jiuan.sh"

say "构建新前端（poc/web：npm ci、测试、构建）"
web_build "$POC_DIR/web"

# 前门对真实构建产物（poc/web/dist）的那条测试要测这次构建、要发出去的那份：所以在 web_build 之后跑
say "跑测试台外壳的单元测试"
node_tests "$POC_DIR/app" "test/unit/**/*.test.mjs"

if ! $CODE_ONLY; then
  say "建栈或更新栈 ${STACK}（第一次建 CloudFront 约需 5–15 分钟）"
  aws cloudformation validate-template --region "$REGION" --template-body "file://$HERE/andon-finance-poc.yaml" >/dev/null
  args=(--region "$REGION" --stack-name "$STACK" --template-file "$HERE/andon-finance-poc.yaml" --capabilities CAPABILITY_IAM
    --no-fail-on-empty-changeset --tags project=andon-finance-poc)
  overrides=()
  # 实例类型的架构：arm64（m7g）或 x86_64（t3）；AMI 要和它一致
  type_arch() { aws ec2 describe-instance-types --region "$REGION" --instance-types "$1" --query 'InstanceTypes[0].ProcessorInfo.SupportedArchitectures' --output text | grep -qw arm64 && echo arm64 || echo x86_64; }
  if ! aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" >/dev/null 2>&1; then
    ARCH="$(type_arch "${INSTANCE_TYPE:-m7g.xlarge}")"
    AMI="$(aws ssm get-parameter --region "$REGION" --name "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-$ARCH" --query Parameter.Value --output text)"
    overrides+=("ImageId=$AMI")
  elif [[ -n "${INSTANCE_TYPE:-}" ]]; then
    # 栈已在：AMI 不换，所以不能换到另一种架构的类型（更新会起不来），要换就另建一个栈
    image="$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" --query "Stacks[0].Parameters[?ParameterKey=='ImageId'].ParameterValue" --output text)"
    image_arch="$(aws ec2 describe-images --region "$REGION" --image-ids "$image" --query 'Images[0].Architecture' --output text)"
    [[ "$image_arch" == "$(type_arch "$INSTANCE_TYPE")" ]] \
      || { echo "栈 $STACK 的 AMI 是 ${image_arch}，${INSTANCE_TYPE} 是另一种架构：不能就地换，另建一个栈" >&2; exit 2; }
  fi
  # 知识库的 PG 端口入站规则（模板里的 KbIngress）：第一次建栈时可以一起开；栈已在时用 infra/kb.sh sg（它会接管手工加的同样规则）。
  # 没给就沿用栈上的值（aws cloudformation deploy 对没写的参数用现值）。
  # 给了环境配置（DEPLOY_ENV）：里面写了值的栈参数都传上去（KbAllowedCidr 也以文件为准）；没给就只认环境变量 KB_ALLOWED_CIDR
  while IFS= read -r override; do overrides+=("$override"); done < <(deploy_env_overrides)
  [[ -z "${DEPLOY_ENV:-}" && -n "${KB_ALLOWED_CIDR:-}" ]] && overrides+=("KbAllowedCidr=$KB_ALLOWED_CIDR")
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
# 九安 v0.7.10 测试台的启动配置（两个账号的口令、MySQL 和九安存储的密钥）。只放在本机和实例上，不进构件、不进文档、不贴进对话。
# 改完运行 infra/deploy.sh --code-only。Agent 的调用密钥不放这里，在新前端的「Agent 接入」页启用。
REVIEWER_PASSWORD=$(openssl rand -base64 18)
CHECKER_PASSWORD=$(openssl rand -base64 18)
SECRETSFILE
  echo "已生成 ${SECRETS}：两个账号的随机口令（测试台的三项密钥接着补上）"
fi
# >>> bench-secrets
# 测试台（MySQL 与九安存储）的三项密钥：缺了才补，已有的永远不改。换了 JIUAN_DATA_KEY，九安的库就打不开了。
# 2026-11-02 之前的文件里后两项叫 JIUAN07_…：先原地改名（值不变），免得当成缺了另生成。
for name in JIUAN_MYSQL_APP_PASSWORD JIUAN_DATA_KEY; do
  legacy="JIUAN07_${name#JIUAN_}"
  if grep -q "^${legacy}=" "$SECRETS" && ! grep -q "^${name}=" "$SECRETS"; then
    ( umask 077; sed "s/^${legacy}=/${name}=/" "$SECRETS" > "$SECRETS.new" ) && mv "$SECRETS.new" "$SECRETS"
    echo "已把 ${SECRETS} 里的 ${legacy} 改名为 ${name}（值不变）"
  fi
done
for name in BENCH_MYSQL_ROOT_PASSWORD JIUAN_MYSQL_APP_PASSWORD JIUAN_DATA_KEY; do
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
mkdir -p "$STAGE/release/operator/scripts" "$STAGE/release/bench" "$STAGE/release/app" "$STAGE/release/web/dist" "$STAGE/release/jiuan"
rsync -a --exclude .DS_Store "$HERE/bench/" "$STAGE/release/bench/"
# 测试台外壳（不带测试和冒烟脚本）和按清单复制的九安副本（不含 seeds、database、tests、deploy、scripts，带锁定版本的 node_modules）
rsync -a --exclude test --exclude scripts --exclude node_modules --exclude .DS_Store "$POC_DIR/app/" "$STAGE/release/app/"
rsync -a --exclude .DS_Store "$POC_DIR/../.build/jiuan/" "$STAGE/release/jiuan/"
# 新前端只带构建产物（外壳的 front.mjs 默认找 app/../web/dist）
rsync -a --exclude .DS_Store "$POC_DIR/web/dist/" "$STAGE/release/web/dist/"
cp "$OPERATOR_SCRIPT" "$STAGE/release/operator/scripts/nexus.py"
# macOS 的 tar 默认会带上 AppleDouble（._*）和扩展属性，实例上解包会多出垃圾文件和告警。
COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs -czf "$STAGE/current.tgz" -C "$STAGE/release" .
aws s3 cp --region "$REGION" --only-show-errors "$STAGE/current.tgz" "s3://$BUCKET/releases/current.tgz"
aws s3 cp --region "$REGION" --only-show-errors "$STAGE/current.tgz" "s3://$BUCKET/releases/archive/$(date -u +%Y%m%dT%H%M%SZ).tgz"
aws s3 cp --region "$REGION" --only-show-errors --sse AES256 "$SECRETS" "s3://$BUCKET/secrets/secrets.env"

if [[ "$REMOTE" == ssh ]]; then
  say "等实例经 SSH 能登录（$(output ElasticIp)）"
  ssh_setup "$(output ElasticIp)" "$INSTANCE" && ssh_wait 60 || exit 1
else
  say "等 EC2 的 SSM Agent 上线"
  ssm_wait_online "$INSTANCE" || exit 1
fi

say "实例上装构件、配置测试台、重启"
# 站点名：栈还没更新到有这个参数时用模板的默认值
SITE_DOMAIN="$(param DomainName)"
[[ -n "$SITE_DOMAIN" && "$SITE_DOMAIN" != None ]] || SITE_DOMAIN=jiuan-v0710.tinyboat.blog
# >>> install
INSTALL="$(cat <<SH
set -euo pipefail
work="\$(mktemp -d /var/tmp/andon-release.XXXXXX)"; trap 'rm -rf "\$work"' EXIT
# 先装密钥配置文件（只有 root 能读；bench-configure.sh 从它取出各项写给 jiuan）
aws s3 cp s3://$BUCKET/secrets/secrets.env /etc/andon-finance/secrets.env.new --region $REGION --only-show-errors
chown root:root /etc/andon-finance/secrets.env.new; chmod 0600 /etc/andon-finance/secrets.env.new
mv /etc/andon-finance/secrets.env.new /etc/andon-finance/secrets.env
aws s3 cp s3://$BUCKET/releases/current.tgz "\$work/release.tgz" --region $REGION --only-show-errors
mkdir "\$work/release"
tar -xzf "\$work/release.tgz" -C "\$work/release" --no-same-owner
chmod -R a+rX,go-w "\$work/release"
bash "\$work/release/bench/bench-configure.sh" $SITE_DOMAIN $(param NexusOrigin) '${KB_MODE:-pg}' '$KB_PUBLICATION'
rm -rf /opt/andon-finance/previous
if [ -d /opt/andon-finance/current ]; then mv /opt/andon-finance/current /opt/andon-finance/previous; fi
mv "\$work/release" /opt/andon-finance/current
systemctl restart andon-jiuan.service
sleep 5
systemctl is-active andon-jiuan.service
SH
)"
# <<< install
run_root "$INSTANCE" "$INSTALL" 900 || { echo "实例上的安装或重启没有成功（见上面的输出），不做健康检查" >&2; exit 1; }

if [[ "$REMOTE" == ssh ]]; then LOGS="ssh -i $SSH_KEY_FILE $SSH_TARGET"; else LOGS="aws ssm start-session --region $REGION --target ${INSTANCE}"; fi
say "健康检查 $SITE/poc/healthz"
healthy() { for attempt in $(seq 1 36); do curl -fsS "$1" >/dev/null 2>&1 && return 0; sleep 10; done; return 1; }
# 第一次建 CloudFront 分发后，DNS 生效要几分钟
healthy "$SITE/poc/healthz" || { echo "健康检查没有通过。查看日志：${LOGS}，然后 sudo journalctl -u andon-jiuan -n 200" >&2; exit 1; }
echo "健康检查通过：$SITE"
echo "两个账号的口令在 ${SECRETS}（REVIEWER_PASSWORD / CHECKER_PASSWORD）"
