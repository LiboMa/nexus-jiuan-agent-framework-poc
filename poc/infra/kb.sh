#!/usr/bin/env bash
# 知识库（kb/：PostgreSQL + pgvector → Nexus 数据连接器 → 审核 Agent）和测试台共用一套 IaC：
#   PG 跑在测试台这台实例上（kb 的 existing 模式，容器 nexus-pgvector 只绑实例的私网 IP）；
#   PG 端口的入站规则归测试台的栈管（栈参数 KbAllowedCidr、KbPort，模板里的 KbIngress），不另建栈。
# 用法（在 poc/ 下）：
#   infra/kb.sh sg --cidr <私网段> [--yes]   把入站规则交给栈：更新栈参数 KbAllowedCidr。现场有手工加的同样规则时先列出它；
#                                           加 --yes 才先撤掉它、再由栈建同样的规则（中间约一分钟连不上 PG），栈没建成就把它加回去
#   infra/kb.sh config                      由栈（实例、放行网段、端口、Nexus 地址）和 infra/kb.env 生成 kb 的配置 kb/.state/infra.env（0600）
#   infra/kb.sh <阶段或命令> [参数…]         先生成配置，再原样交给 kb/deploy.sh --config：preflight、all --dry-run、all、verify --e2e、status……
# infra/kb.env 是部署人自己的设置（从 kb.env.example 复制，不进仓库）：管理员密码的来源、制度原文的路径、Sandbox 节点标签等。
# 不写任何密码：管理员密码用运行时的 NEXUS_ADMIN_PASSWORD 环境变量，或 kb.env 里的 NEXUS_ADMIN_PASSWORD_FILE / NEXUS_ADMIN_PASSWORD_SSM（kb/GUIDE.md 3.2）。
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
source "$HERE/lib/deploy-env.sh"
load_deploy_env
REGION="${AWS_REGION:-us-east-1}"
STACK="${STACK:-andon-finance-poc}"
KB_DIR="${KB_DIR:-$ROOT/kb}"
# kb 的个人设置文件：环境配置里的 KB_SETTINGS（相对仓库根目录），或环境变量 KB_SETTINGS，默认 poc/infra/kb.env
SETTINGS="${KB_SETTINGS:-$HERE/kb.env}"
[[ "$SETTINGS" == /* ]] || SETTINGS="$ROOT/$SETTINGS"
CONFIG="${KB_CONFIG:-$KB_DIR/.state/infra.env}"
TEMPLATE="$HERE/andon-finance-poc.yaml"
PRIVATE='^(10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3})/([0-9]|[12][0-9]|3[0-2])$'
RULE_DESCRIPTION='nexus-pgvector: Nexus server + sandbox VMs (private only)'
DERIVED="AWS_REGION PG_HOST_MODE PG_HOST_INSTANCE_ID PG_ALLOWED_CIDR PG_PORT NEXUS_URL"

die() { echo "$1" >&2; exit "${2:-1}"; }
clean() { [[ "$1" == None ]] && echo "" || echo "$1"; }
output() { clean "$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text)"; }
param() { clean "$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" --query "Stacks[0].Parameters[?ParameterKey=='$1'].ParameterValue" --output text)"; }

usage() { sed -n '2,13p' "${BASH_SOURCE[0]:-$0}" | sed 's/^# \{0,1\}//'; }

write_config() {
  [[ -f "$SETTINGS" ]] || die "找不到 ${SETTINGS}：先 cp $HERE/kb.env.example $SETTINGS && chmod 600 $SETTINGS，再按注释改（不进仓库）"
  grep -Eq '^[[:space:]]*(export[[:space:]]+)?NEXUS_ADMIN_PASSWORD=' "$SETTINGS" \
    && die "$SETTINGS 里不能写 NEXUS_ADMIN_PASSWORD（明文密码）：改用 NEXUS_ADMIN_PASSWORD_FILE / NEXUS_ADMIN_PASSWORD_SSM，或运行时的环境变量"
  local instance cidr port nexus
  instance="$(output InstanceId)"; cidr="$(param KbAllowedCidr)"; port="$(param KbPort)"; nexus="$(param NexusOrigin)"
  [[ -n "$instance" ]] || die "读不到栈 $STACK 的 InstanceId：先运行 infra/deploy.sh 建栈"
  [[ -n "$cidr" ]] || die "栈 $STACK 还没开 PG 端口（参数 KbAllowedCidr 为空）：先运行 infra/kb.sh sg --cidr <私网段>"
  [[ -n "$nexus" ]] || die "读不到栈 $STACK 的参数 NexusOrigin"
  local AWS_REGION_V="$REGION" PG_HOST_MODE_V=existing PG_HOST_INSTANCE_ID_V="$instance" PG_ALLOWED_CIDR_V="$cidr" PG_PORT_V="${port:-5432}" NEXUS_URL_V="${nexus%/}"
  local key mine wanted
  for key in $DERIVED; do
    mine="$( set +u; set -a; source "$SETTINGS" >/dev/null 2>&1; printf '%s' "${!key-}" )"
    wanted="$(eval "printf '%s' \"\$${key}_V\"")"
    if grep -Eq "^[[:space:]]*(export[[:space:]]+)?${key}=" "$SETTINGS" && [[ "$mine" != "$wanted" ]]; then
      echo "kb.env 里的 ${key}（${mine}）和栈不同，以栈为准（${wanted}）" >&2
    fi
  done
  # 环境配置里写了 AGENT_NAME（审核 Agent 的 agent_name）就以它为准，和 audit-agent/setup.py 用的是同一个
  local from_env=false
  if [[ " ${DEPLOY_ENV_LOADED[*]:-} " == *" AGENT_NAME "* ]]; then
    from_env=true
    mine="$( set +u; set -a; source "$SETTINGS" >/dev/null 2>&1; printf '%s' "${AGENT_NAME-}" )"
    if grep -Eq '^[[:space:]]*(export[[:space:]]+)?AGENT_NAME=' "$SETTINGS" && [[ "$mine" != "$AGENT_NAME" ]]; then
      echo "kb.env 里的 AGENT_NAME（${mine}）和环境配置不同，以环境配置为准（${AGENT_NAME}）" >&2
    fi
  fi
  mkdir -p "$(dirname "$CONFIG")"
  local tmp; tmp="$(mktemp "$(dirname "$CONFIG")/.infra.env.XXXXXX")"
  chmod 600 "$tmp"
  {
    # 没写的项由 kb 自己补默认值（kb/lib/common.sh 的 load_config），所以这里只有部署人的设置和栈给的值
    echo "# 由 poc/infra/kb.sh 生成（$(date -u +%Y-%m-%dT%H:%M:%SZ)）。不要手改：改 poc/infra/kb.env 或栈参数，再运行 infra/kb.sh config。"
    echo "# ---- 部署人的设置：$SETTINGS ----"
    cat "$SETTINGS"
    echo
    echo "# ---- 来自栈 ${STACK}（以这里为准）----"
    for key in $DERIVED; do printf '%s=%q\n' "$key" "$(eval "printf '%s' \"\$${key}_V\"")"; done
    if $from_env; then
      echo
      echo "# ---- 来自环境配置 ${DEPLOY_ENV}（以这里为准）----"
      printf 'AGENT_NAME=%q\n' "$AGENT_NAME"
    fi
  } > "$tmp"
  mv "$tmp" "$CONFIG"
  echo "已生成 ${CONFIG}：PG 在实例 ${instance}（existing 模式），端口 ${PG_PORT_V} ← ${cidr}，Nexus ${NEXUS_URL_V}"
}

sg_command() {
  local cidr="" yes=false
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --cidr) cidr="${2:-}"; shift 2 ;;
      --yes) yes=true; shift ;;
      *) die "kb.sh sg：不认识的参数 $1" 2 ;;
    esac
  done
  [[ -n "$cidr" ]] || cidr="$(param KbAllowedCidr)"
  [[ "$cidr" =~ $PRIVATE ]] || die "只能放行私网段（10.0.0.0/8、172.16.0.0/12、192.168.0.0/16 里的 CIDR）：${cidr:-（没给 --cidr）}" 2
  local port group rules="" revoked=false
  port="$(param KbPort)"; port="${port:-5432}"
  group="$(clean "$(aws cloudformation describe-stack-resource --region "$REGION" --stack-name "$STACK" --logical-resource-id AppSecurityGroup --query StackResourceDetail.PhysicalResourceId --output text)")"
  [[ -n "$group" ]] || die "读不到栈 $STACK 的应用安全组"
  if ! aws cloudformation describe-stack-resource --region "$REGION" --stack-name "$STACK" --logical-resource-id KbIngress >/dev/null 2>&1; then
    rules="$(clean "$(aws ec2 describe-security-group-rules --region "$REGION" --filters "Name=group-id,Values=$group" \
      --query "SecurityGroupRules[?IsEgress==\`false\` && IpProtocol=='tcp' && FromPort==\`$port\` && ToPort==\`$port\` && CidrIpv4=='$cidr'].SecurityGroupRuleId" --output text)")"
  fi
  if [[ -n "$rules" ]]; then
    echo "安全组 $group 上已有手工加的同样规则 ${rules}（tcp $port ← ${cidr}），不归栈管。" >&2
    if ! $yes; then
      echo "确认后加 --yes：先撤掉它，再由栈 $STACK 建同样的规则（中间约一分钟连不上 PG；栈没建成就把它加回去）。" >&2
      exit 3
    fi
    # shellcheck disable=SC2086
    aws ec2 revoke-security-group-ingress --region "$REGION" --group-id "$group" --security-group-rule-ids $rules >/dev/null
    revoked=true
    echo "已撤掉手工规则 ${rules}，接着由栈建"
  fi
  if ! aws cloudformation deploy --region "$REGION" --stack-name "$STACK" --template-file "$TEMPLATE" --capabilities CAPABILITY_IAM \
      --no-fail-on-empty-changeset --tags project=andon-finance-poc --parameter-overrides "KbAllowedCidr=$cidr"; then
    if $revoked; then
      local permissions
      permissions="$(printf '[{"IpProtocol":"tcp","FromPort":%s,"ToPort":%s,"IpRanges":[{"CidrIp":"%s","Description":"%s"}]}]' "$port" "$port" "$cidr" "$RULE_DESCRIPTION")"
      if aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$group" --ip-permissions "$permissions" >/dev/null; then
        echo "栈没更新成功：已把手工规则加回去（tcp $port ← ${cidr}）" >&2
      else
        echo "!! 栈没更新成功，手工规则也没加回去：在安全组 $group 上手工放行 tcp $port ← $cidr" >&2
      fi
    fi
    exit 1
  fi
  echo "PG 端口 $port ← $cidr 的入站规则归栈 $STACK 管（KbIngress）"
}

case "${1:-}" in
  sg) shift; sg_command "$@" ;;
  config) write_config ;;
  ""|-h|--help|help) usage ;;
  *) write_config; exec bash "$KB_DIR/deploy.sh" --config "$CONFIG" "$@" ;;
esac
