# 一个环境一份配置文件（poc/infra/env/<环境名>.env，从 example.env 复制；只有 example.env 进仓库）。
# 各脚本 source 本文件后调用 load_deploy_env；DEPLOY_ENV 为空时什么都不做（现有环境，行为不变）。
# 规则（audit-agent/deploy_env.py 是同一套）：逐行 KEY=VALUE；# 开头的行和空行跳过；值可以用一对 " 或 ' 包起来；
# 值原样取，不展开 $、反引号（不 source、不 eval）；不认识的键、重复的键、格式不对的行都报错（exit 2，带行号）；
# 空值等于没写。给了 DEPLOY_ENV 时 STACK 和 AWS_REGION 必须写明；文件里写了的键压过 shell 里同名的环境变量。
# KB_MODE（知识库的部署方式）只能是 pg 或 s3vectors，不写就是 pg；KB_MODE=s3vectors 时 DEPLOY_ENV_S3V_KEYS 这五项都要写，
# 缺了就报错并一次列出缺哪几项（只看文件里写的，和 STACK / AWS_REGION 一样）。
# KB_PG_PUBLICATION_ID（pg 方式「制度知识库」页经的 PG 知识库 Agent 的发布）写了就要是 pub_ 加 16 位小写十六进制（报错带行号），不写也行。
# SSH_KEY_FILE（本机私钥的路径，只给本机的脚本用，不传给栈）写了就是经 SSH 管理这台实例（deploy.sh、kb.sh、run.sh 都不再用 SSM）；
# 路径原样取，不展开 ~，写绝对路径。

DEPLOY_ENV_KEYS=(STACK AWS_REGION VPC_ID SUBNET_ID INSTANCE_TYPE ROOT_VOLUME_SIZE SSH_KEY_NAME SSH_KEY_FILE SSH_ALLOWED_CIDR SSH_VIA SSM_MANAGED ORIGIN_DOMAIN_NAME DOMAIN_NAME HOSTED_ZONE_ID
  CERTIFICATE_ARN CLOUDFRONT_PREFIX_LIST_ID NEXUS_ORIGIN NEXUS_PROFILE KB_MODE KB_ALLOWED_CIDR KB_SETTINGS CONNECTOR_ID
  KB_PG_PUBLICATION_ID KB_S3V_BUCKET KB_S3V_RULES_INDEX RULES_TOOL_DIR KB_S3V_KEY_ID KB_S3V_PUBLICATION_ID
  AGENT_NAME AGENT_DISPLAY_NAME AGENT_MODEL AGENT_ID PUBLICATION_ID)
# KB_MODE=s3vectors 时必须写的几项（S3 Vectors 方式：向量桶、规则索引、规则工具目录、文档管家的写入密钥编号和发布）
DEPLOY_ENV_S3V_KEYS=(KB_S3V_BUCKET KB_S3V_RULES_INDEX RULES_TOOL_DIR KB_S3V_KEY_ID KB_S3V_PUBLICATION_ID)
# 配置键 → 栈参数（deploy_env_overrides 按这个顺序输出）
DEPLOY_ENV_PARAMS=(VPC_ID:VpcId SUBNET_ID:SubnetId INSTANCE_TYPE:InstanceType ROOT_VOLUME_SIZE:RootVolumeSize SSH_KEY_NAME:KeyName
  SSH_ALLOWED_CIDR:SshAllowedCidr SSH_VIA:SshVia SSM_MANAGED:SsmManaged ORIGIN_DOMAIN_NAME:OriginDomainName
  DOMAIN_NAME:DomainName HOSTED_ZONE_ID:HostedZoneId CERTIFICATE_ARN:CertificateArn CLOUDFRONT_PREFIX_LIST_ID:CloudFrontPrefixListId
  NEXUS_ORIGIN:NexusOrigin KB_ALLOWED_CIDR:KbAllowedCidr)
DEPLOY_ENV_LOADED=()

deploy_env_fail() { echo "$1" >&2; exit 2; }

load_deploy_env() {
  [[ -n "${DEPLOY_ENV:-}" ]] || return 0
  local file="$DEPLOY_ENV" line key value n=0 seen=" " known k missing=""
  local line_re='^([A-Z][A-Z0-9_]*)=(.*)$' double_re='^"(.*)"$' single_re="^'(.*)'\$" publication_re='^pub_[0-9a-f]{16}$'
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
    [[ "$key" != KB_MODE || -z "$value" || "$value" == pg || "$value" == s3vectors ]] || deploy_env_fail "${file}:${n}：KB_MODE 只能是 pg 或 s3vectors：${value}"
    [[ "$key" != KB_PG_PUBLICATION_ID || -z "$value" || "$value" =~ $publication_re ]] \
      || deploy_env_fail "${file}:${n}：KB_PG_PUBLICATION_ID 应是 PG 知识库 Agent 的发布编号（pub_ 加 16 位十六进制）：${value}"
    [[ -n "$value" ]] || continue
    printf -v "$key" '%s' "$value"
    export "${key?}"
    DEPLOY_ENV_LOADED+=("$key")
  done < "$file"
  for key in STACK AWS_REGION; do
    [[ " ${DEPLOY_ENV_LOADED[*]:-} " == *" $key "* ]] || deploy_env_fail "${file}：没写 ${key}（用配置文件时栈名和区域都要写明，免得动到别的栈）"
  done
  if [[ " ${DEPLOY_ENV_LOADED[*]:-} " == *" KB_MODE "* && "$KB_MODE" == s3vectors ]]; then
    for key in "${DEPLOY_ENV_S3V_KEYS[@]}"; do
      [[ " ${DEPLOY_ENV_LOADED[*]:-} " == *" $key "* ]] || missing+="${missing:+、}${key}"
    done
    [[ -z "$missing" ]] || deploy_env_fail "${file}：KB_MODE=s3vectors 时还要写：${missing}（S3 Vectors 方式的几项见 poc/infra/env/example.env）"
  fi
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
