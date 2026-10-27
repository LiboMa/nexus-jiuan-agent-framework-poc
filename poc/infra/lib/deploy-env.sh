# 一个环境一份配置文件（poc/infra/env/<环境名>.env，从 example.env 复制；只有 example.env 进仓库）。
# 各脚本 source 本文件后调用 load_deploy_env；DEPLOY_ENV 为空时什么都不做（现有环境，行为不变）。
# 规则（audit-agent/deploy_env.py 是同一套）：逐行 KEY=VALUE；# 开头的行和空行跳过；值可以用一对 " 或 ' 包起来；
# 值原样取，不展开 $、反引号（不 source、不 eval）；不认识的键、重复的键、格式不对的行都报错（exit 2，带行号）；
# 空值等于没写。给了 DEPLOY_ENV 时 STACK 和 AWS_REGION 必须写明；文件里写了的键压过 shell 里同名的环境变量。

DEPLOY_ENV_KEYS=(STACK AWS_REGION VPC_ID SUBNET_ID INSTANCE_TYPE DOMAIN_NAME ORIGIN_DOMAIN_NAME JIUAN07_DOMAIN_NAME HOSTED_ZONE_ID
  CERTIFICATE_ARN CLOUDFRONT_PREFIX_LIST_ID NEXUS_ORIGIN NEXUS_PROFILE ADVISORY_PUBLICATION_ID KB_ALLOWED_CIDR KB_SETTINGS CONNECTOR_ID
  AGENT_NAME AGENT_DISPLAY_NAME AGENT_MODEL AGENT_ID PUBLICATION_ID)
# 配置键 → 栈参数（deploy_env_overrides 按这个顺序输出）
DEPLOY_ENV_PARAMS=(VPC_ID:VpcId SUBNET_ID:SubnetId INSTANCE_TYPE:InstanceType DOMAIN_NAME:DomainName ORIGIN_DOMAIN_NAME:OriginDomainName
  JIUAN07_DOMAIN_NAME:Jiuan07DomainName HOSTED_ZONE_ID:HostedZoneId CERTIFICATE_ARN:CertificateArn CLOUDFRONT_PREFIX_LIST_ID:CloudFrontPrefixListId
  NEXUS_ORIGIN:NexusOrigin ADVISORY_PUBLICATION_ID:AdvisoryPublicationId KB_ALLOWED_CIDR:KbAllowedCidr)
DEPLOY_ENV_LOADED=()

deploy_env_fail() { echo "$1" >&2; exit 2; }

load_deploy_env() {
  [[ -n "${DEPLOY_ENV:-}" ]] || return 0
  local file="$DEPLOY_ENV" line key value n=0 seen=" " known k
  local line_re='^([A-Z][A-Z0-9_]*)=(.*)$' double_re='^"(.*)"$' single_re="^'(.*)'\$"
  [[ -f "$file" ]] || deploy_env_fail "DEPLOY_ENV=${file}：找不到这个文件（从 poc/infra/env/example.env 复制一份再改）"
  while IFS= read -r line || [[ -n "$line" ]]; do
    n=$((n + 1))
    line="${line%$'\r'}"
    [[ -z "${line//[[:space:]]/}" || "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ $line_re ]] || deploy_env_fail "${file}:${n}：格式不对，要写成 KEY=VALUE（不写 export）：${line}"
    key="${BASH_REMATCH[1]}"; value="${BASH_REMATCH[2]}"
    known=false
    for k in "${DEPLOY_ENV_KEYS[@]}"; do [[ "$k" == "$key" ]] && known=true; done
    $known || deploy_env_fail "${file}:${n}：不认识的键 ${key}（能写的键见 poc/infra/env/example.env）"
    [[ "$seen" == *" $key "* ]] && deploy_env_fail "${file}:${n}：键 ${key} 写了两次"
    seen+="$key "
    if [[ "$value" =~ $double_re || "$value" =~ $single_re ]]; then value="${BASH_REMATCH[1]}"; fi
    [[ -n "$value" ]] || continue
    printf -v "$key" '%s' "$value"
    export "${key?}"
    DEPLOY_ENV_LOADED+=("$key")
  done < "$file"
  for key in STACK AWS_REGION; do
    [[ " ${DEPLOY_ENV_LOADED[*]:-} " == *" $key "* ]] || deploy_env_fail "${file}：没写 ${key}（用配置文件时栈名和区域都要写明，免得动到别的栈）"
  done
  echo "环境：${file}（栈 ${STACK}，区域 ${AWS_REGION}）" >&2
}

# 配置文件里写了值的栈参数，一行一个 Param=Value（没给 DEPLOY_ENV 时什么都不输出）
deploy_env_overrides() {
  local pair key
  for pair in "${DEPLOY_ENV_PARAMS[@]}"; do
    key="${pair%%:*}"
    [[ " ${DEPLOY_ENV_LOADED[*]:-} " == *" $key "* ]] && printf '%s=%s\n' "${pair#*:}" "${!key}"
  done
  return 0
}
