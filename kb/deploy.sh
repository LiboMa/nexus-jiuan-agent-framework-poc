#!/usr/bin/env bash
#
# pgvector-rules-kb：把「制度规则库（PostgreSQL + pgvector）」接入 Nexus，供审核 Agent 查询。幂等，可重复执行。
#
# 用法:
#   ./deploy.sh <阶段>[,<阶段>...] [选项]
#
# 阶段（all = preflight,host,db,network,egress,connector,ingest,agent,verify）:
#   preflight   只读预检：工具、AWS 身份、Nexus 登录、目标主机、Sandbox 节点、Bedrock、规则文档、Agent
#   host        create 模式：CloudFormation 新建专用 PG 主机（只建一次，之后不更新；existing 模式跳过）
#   db          在 PG 主机上起 PostgreSQL + pgvector 容器，确保库 / 用户 / vector 扩展，建库内语义检索（kb_embed / kb_search）。
#               先读库里登记的向量模型：与 EMBED_MODEL_ID 不同就停（防混用），换模型要显式加 --migrate-embeddings
#   network     existing 模式：CloudFormation 给 PG 主机安全组加入站规则（已有等价规则则跳过）
#   egress      Nexus 配置 vm_egress.allow_cidrs 并入 VM_EGRESS_ALLOW_CIDRS（Sandbox VM 才能连私网 PG）
#   connector   Nexus 里建 / 同步数据库凭证密钥与 PostgreSQL 数据连接器，并做连接测试
#   ingest      解析规则 .docx → 写入规则表（没变的行不重写）；向量由库里的 kb_embed_batch 生成（--embed sql）
#   agent       给审核 Agent 提示词打补丁（第 4 条括注 + 第 7、8 条），改前自动备份
#   verify      只读核对各层状态；加 --e2e 再经 API 跑规则问答与 A2A 三段式回归
#   status      打印状态文件与快速检查
#   destroy     按相反顺序只撤销本工具做的改动（交互确认，--yes 跳过；--purge-data 才删数据）
#   rotate-db-password  轮换应用用户密码：主机 .env 换新值 → db（ALTER ROLE）→ connector（同步密钥）（交互确认）
#   api <path>  调试：以管理员身份 GET /api/v2/<path>，输出 JSON（拒绝 /secret 等机密接口）
#   regress     检索回归（单独跑）：--questions-dir <目录> --label <名字> [--out <目录>]。经端口转发以应用用户把题库里的两套题
#               （questions.json、questions_robust.json）逐题调 kb_search（每分钟 ≤ 50 次），结果写到仓库外
#               （缺省 ~/Documents/pgkb-regression/<名字>.json，只有题号、规则编号和计数）
#   regress --compare <a.json> <b.json>   只对比两次结果（不读配置、不连库）：哪一套题的 hit5 变低、已知问题不过 → 退出码 1
#
# 选项:
#   --config <file>   配置文件（默认 ./deploy.env）
#   --dry-run         只读：打印将要做的改动，不写任何东西（--e2e 在 dry-run 下跳过）
#   --e2e             verify 时加跑端到端对话测试（会建测试会话，结束后移到回收站）
#   --yes             destroy 不再交互确认
#   --purge-data      destroy 时同时删除本工具建的数据卷、主机密码目录与 create 模式的主机（不可恢复）
#   --migrate-embeddings  db：库里是 Titan、EMBED_MODEL_ID 是另一个模型时换模型——旧向量备份进 <表>_titan_backup，
#                     用新模型重算规则表和归档表的全部向量，登记 kb_meta（与新的 kb_search.sql 同一个事务）
#   --restore-embeddings  db：换模型后回退（EMBED_MODEL_ID 先改回 Titan）——拷回备份的旧向量，kb_meta 改回 Titan
#   --questions-dir <目录> / --label <名字> / --out <目录>   regress 用（见上）
#   -h, --help
#
# 详细说明：GUIDE.md
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$PKG_DIR/lib/common.sh"

# 用法 = 文件开头的注释块
usage() { awk 'NR == 1 { next } /^#/ { print; next } { exit }' "${BASH_SOURCE[0]}"; }
CONFIG="$PKG_DIR/deploy.env"; DRY_RUN=false; E2E=false; YES=false; PURGE=false; PHASES=""; API_PATH=""
MIGRATE_EMB=false; RESTORE_EMB=false; REG_QDIR=""; REG_LABEL=""; REG_OUT=""; CMP_A=""; CMP_B=""; REG_OPTS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --config)     CONFIG="${2:-}"; shift ;;
    --dry-run)    DRY_RUN=true ;;
    --e2e)        E2E=true ;;
    --yes)        YES=true ;;
    --purge-data) PURGE=true ;;
    --migrate-embeddings) MIGRATE_EMB=true ;;
    --restore-embeddings) RESTORE_EMB=true ;;
    --questions-dir) REG_QDIR="${2:-}"; REG_OPTS="$REG_OPTS $1"; shift ;;
    --label)      REG_LABEL="${2:-}"; REG_OPTS="$REG_OPTS $1"; shift ;;
    --out)        REG_OUT="${2:-}"; REG_OPTS="$REG_OPTS $1"; shift ;;
    --compare)    CMP_A="${2:-}"; CMP_B="${3:-}"; REG_OPTS="$REG_OPTS $1"
                  case "$CMP_A$CMP_B" in -*|"") die "用法：./deploy.sh regress --compare <a.json> <b.json>" ;; esac
                  case "$CMP_B" in -*|"") die "用法：./deploy.sh regress --compare <a.json> <b.json>" ;; esac
                  shift 2 ;;
    -h|--help)    usage; exit 0 ;;
    -*)           die "未知选项 $1（./deploy.sh --help）" ;;
    *)            if [ "$PHASES" = "api" ] && [ -z "$API_PATH" ]; then API_PATH="$1"; else PHASES="$1"; fi ;;
  esac
  shift
done
[ -n "$PHASES" ] || { usage; exit 2; }
[ "$PHASES" = "all" ] && PHASES="preflight,host,db,network,egress,connector,ingest,agent,verify"
# 只配某个阶段的选项：在读配置之前查，用错了不碰任何东西
if $MIGRATE_EMB || $RESTORE_EMB; then
  case ",$PHASES," in *,db,*) ;; *) die "--migrate-embeddings / --restore-embeddings 只用于 db 阶段（./deploy.sh db --migrate-embeddings）" ;; esac
  if $MIGRATE_EMB && $RESTORE_EMB; then die "--migrate-embeddings 和 --restore-embeddings 不能同时给"; fi
fi
if [ -n "$REG_OPTS" ] && [ "$PHASES" != "regress" ]; then die "${REG_OPTS# } 只用于 regress（单独跑：./deploy.sh regress …）"; fi
case ",$PHASES," in *,regress,*) [ "$PHASES" = "regress" ] || die "regress 要单独跑（./deploy.sh regress --questions-dir <目录> --label <名字>）" ;; esac
# regress --compare：只比两个结果文件，不读配置、不连库
if [ -n "$CMP_A" ]; then
  [ -z "$REG_QDIR$REG_LABEL$REG_OUT" ] || die "regress --compare 不和 --questions-dir / --label / --out 一起用"
  py kb_regression.py --compare "$CMP_A" "$CMP_B"; exit $?
fi
export DRY_RUN
trap cleanup EXIT
load_config "$CONFIG"
mkdir -p "$PKG_DIR/.build" "$PKG_DIR/.state"; chmod 700 "$PKG_DIR/.state"
# 临时密钥目录在主 shell 里建好：$(...) 子 shell 里调用 secret_file 也落在这里，退出时由 cleanup 统一删除
SECRETS_DIR="$PKG_DIR/.build/secrets.$$"; mkdir -p "$SECRETS_DIR"; chmod 700 "$SECRETS_DIR"

# ============================================================================
# 公共：目标主机 / Nexus 登录 / 小工具
# ============================================================================
# 目标 PG 主机：existing 取配置，create 取 host 阶段写入的状态。
pg_instance() {
  if [ "$PG_HOST_MODE" = "create" ]; then state_get PG_HOST_INSTANCE_ID; else printf '%s' "$PG_HOST_INSTANCE_ID"; fi
}
# resolve_target [soft]：解析目标主机的私网 IP / VPC / 安全组 / VPC CIDR，导出为 TGT_*。
#   soft：解析不了时返回 1 而不是退出（status / destroy 用）。
resolve_target() {
  local soft="${1:-}" info
  TGT_ID="$(pg_instance)"
  if [ -z "$TGT_ID" ]; then
    [ -n "$soft" ] && return 1
    die "还不知道 PG 主机实例 ID（existing 模式填 PG_HOST_INSTANCE_ID；create 模式先跑 host 阶段）"
  fi
  if ! info="$(aws_cli ec2 describe-instances --instance-ids "$TGT_ID" \
      --query 'Reservations[0].Instances[0].[PrivateIpAddress,VpcId,State.Name,join(`,`,SecurityGroups[].GroupId)]' --output text 2>/dev/null)"; then
    [ -n "$soft" ] && return 1
    die "查不到实例 $TGT_ID"
  fi
  read -r TGT_IP TGT_VPC TGT_STATE TGT_SGS <<< "$info"
  TGT_CIDR="$(aws_cli ec2 describe-vpcs --vpc-ids "$TGT_VPC" --query 'Vpcs[0].CidrBlock' --output text)"
  TGT_BIND_IP="${PG_BIND_IP:-$TGT_IP}"
  ALLOWED_CIDR="${PG_ALLOWED_CIDR:-$TGT_CIDR}"
  EGRESS_CIDRS="${VM_EGRESS_ALLOW_CIDRS:-$TGT_BIND_IP/32}"
  export TGT_ID TGT_IP TGT_VPC TGT_STATE TGT_SGS TGT_CIDR TGT_BIND_IP ALLOWED_CIDR EGRESS_CIDRS
}
# need_target：dry-run 且 create 模式主机还没建时，打印计划并返回 1（调用方据此 return 0）。
need_target() {
  if $DRY_RUN && [ "$PG_HOST_MODE" = "create" ] && [ -z "$(pg_instance)" ]; then
    plan "$1：PG 主机尚未创建（实跑 host 阶段后才能执行本阶段）"
    return 1
  fi
  resolve_target
}

# 准备管理员密码文件，导出 NEXUS_PASSWORD_FILE（主 shell 里调用一次）。
nexus_auth() {
  [ -n "${NEXUS_PASSWORD_FILE:-}" ] && return 0
  require_vars NEXUS_URL
  local f
  if [ -n "${NEXUS_ADMIN_PASSWORD:-}" ]; then
    f="$(secret_file nexus-admin)"; printf '%s' "$NEXUS_ADMIN_PASSWORD" > "$f"
  elif [ -n "$NEXUS_ADMIN_PASSWORD_FILE" ]; then
    [ -s "$NEXUS_ADMIN_PASSWORD_FILE" ] || die "NEXUS_ADMIN_PASSWORD_FILE 不存在或为空：$NEXUS_ADMIN_PASSWORD_FILE"
    f="$NEXUS_ADMIN_PASSWORD_FILE"
  elif [ -n "$NEXUS_ADMIN_PASSWORD_SSM" ]; then
    local inst="${NEXUS_ADMIN_PASSWORD_SSM%%:*}" ypath="${NEXUS_ADMIN_PASSWORD_SSM#*:}"
    f="$(secret_file nexus-admin)"
    # 远端取出 auth_password 后经 seal 加密：SSM 命令历史里只有密文
    ssm_read_secret "$inst" "$PKG_DIR/host/read-admin-password.sh" "$f" "YAML_PATH=$ypath" \
      || die "经 SSM 从 $inst 读取 $ypath 里的 auth_password 失败"
  else
    die "没有管理员密码来源：设置 NEXUS_ADMIN_PASSWORD 环境变量，或 deploy.env 里的 NEXUS_ADMIN_PASSWORD_FILE / NEXUS_ADMIN_PASSWORD_SSM"
  fi
  NEXUS_PASSWORD_FILE="$f"; export NEXUS_PASSWORD_FILE
}
napi() { nexus_auth; py nexus_api.py "$@"; }
# jget <a.b.c>：从 stdin 的 JSON 取字段；布尔输出 true/false，对象 / 数组输出 JSON
jget() { python3 -I -c 'import json,sys
d=json.loads(sys.stdin.read() or "{}")
for k in sys.argv[1].split("."):
    d = d.get(k) if isinstance(d, dict) else None
print("" if d is None else ("true" if d is True else "false" if d is False else (json.dumps(d, ensure_ascii=False) if isinstance(d,(dict,list)) else d)))' "$1"; }
result_of() { sed -n "s/^RESULT $1=//p" | tail -1; }
first_of() { awk -v k="RESULT $1=" 'index($0, k) == 1 && !n++ { print substr($0, length(k) + 1) }'; }
st_of() { printf '%s\n' "$1" | result_of "$2"; }   # st_of <远端输出> <键>
# read_db_password <out-file>：经 SSM 或 SSH（PG_HOST_TRANSPORT）读应用密码（只传密文）
read_db_password() { host_read_secret "$PKG_DIR/host/read-db-password.sh" "$1" "PG_BASE_DIR=$PG_BASE_DIR"; }

# Agent 提示词模板变量
agent_vars() {
  python3 -I -c 'import json,os
print(json.dumps({"CONNECTOR_ID": os.environ["CID"], "RULES_TABLE": os.environ["RULES_TABLE"],
  "RULES_DOC_TITLE": os.environ.get("RULES_DOC_TITLE",""), "RULES_SEGMENTS_HINT": os.environ.get("RULES_SEGMENTS_HINT","")}, ensure_ascii=False))'
}
connector_id() {
  local cid; cid="$(state_get CONNECTOR_ID)"
  [ -n "$cid" ] || cid="$(napi connector-find --name "$CONNECTOR_NAME" | jget connector_id)"
  printf '%s' "$cid"
}
# cidrs_covered <set-elements> <wanted,cidrs>：输出 wanted 里没被 set 覆盖的项（空 = 全覆盖）。nft 会把 /32 显示成裸 IP。
cidrs_covered() { python3 -I -c 'import ipaddress,sys
have=[ipaddress.ip_network(x.strip(), strict=False) for x in sys.argv[1].replace(" ", "").split(",") if x.strip() and x.strip()!="<empty>"]
miss=[w for w in sys.argv[2].split(",") if w.strip() and not any(ipaddress.ip_network(w.strip(), strict=False).subnet_of(h) for h in have if h.version==4)]
print(" ".join(miss))' "$1" "$2"; }
# cfn_prepare <stack>：首次创建失败留下的 ROLLBACK_COMPLETE 栈不能更新，先删掉
cfn_prepare() {
  local st; st="$(aws_cli cloudformation describe-stacks --stack-name "$1" --query 'Stacks[0].StackStatus' --output text 2>/dev/null || true)"
  case "$st" in
    ROLLBACK_COMPLETE|ROLLBACK_FAILED|DELETE_FAILED)
      warn "栈 $1 处于 $st（上次首次创建失败），先删除再重建"
      aws_cli cloudformation delete-stack --stack-name "$1"
      aws_cli cloudformation wait stack-delete-complete --stack-name "$1" ;;
  esac
  printf '%s' "$st"
}

# ============================================================================
# 阶段
# ============================================================================
phase_preflight() {
  log "preflight：只读预检"
  local t miss=""
  local tools="aws uv python3 gzip base64 session-manager-plugin"
  [ "$PG_HOST_TRANSPORT" = ssh ] && tools="aws uv python3 gzip base64 ssh"
  for t in $tools; do command -v "$t" >/dev/null 2>&1 || miss="$miss $t"; done
  [ -z "$miss" ] || die "本机缺少工具:$miss（见 GUIDE.md 2.1）"
  ok "本机工具齐全（${tools// / / }）"
  local ident; ident="$(aws_cli sts get-caller-identity --query Arn --output text)" || die "AWS 凭证不可用"
  ok "AWS 身份 $ident（region $AWS_REGION）"
  local me; me="$(napi whoami)"; [ "$(printf '%s' "$me" | jget role)" = "admin" ] || die "Nexus 登录用户不是管理员：$me"
  ok "Nexus 登录成功（$NEXUS_URL，$(printf '%s' "$me" | jget name)）"

  if [ "$PG_HOST_MODE" = "existing" ]; then
    require_vars PG_HOST_INSTANCE_ID
    resolve_target
    [ "$TGT_STATE" = "running" ] || die "PG 主机 $TGT_ID 状态是 $TGT_STATE"
    local reach; reach="$(host_reachable)" || die "PG 主机 $TGT_ID：$reach"
    ok "PG 主机 $TGT_ID：running、${reach}，私网 $TGT_IP，VPC $TGT_VPC（$TGT_CIDR），SG $TGT_SGS"
  else
    require_vars PG_CREATE_SUBNET_ID
    local sub; sub="$(aws_cli ec2 describe-subnets --subnet-ids "$PG_CREATE_SUBNET_ID" --query 'Subnets[0].[VpcId,CidrBlock,MapPublicIpOnLaunch]' --output text)" || die "查不到子网 $PG_CREATE_SUBNET_ID"
    ok "create 模式：子网 $PG_CREATE_SUBNET_ID（$sub）"
    local nat; nat="$(aws_cli ec2 describe-route-tables --filters "Name=association.subnet-id,Values=$PG_CREATE_SUBNET_ID" --query 'RouteTables[0].Routes[?DestinationCidrBlock==`0.0.0.0/0`].NatGatewayId' --output text)"
    if [ -n "$nat" ] && [ "$nat" != "None" ]; then ok "子网有 NAT 出网（$nat）"; else warn "子网路由表里没找到指向 NAT 的 0.0.0.0/0：主机会拉不到镜像"; fi
    if [ -n "$(pg_instance)" ]; then resolve_target soft && ok "已建的 PG 主机 $TGT_ID（$TGT_STATE，私网 $TGT_IP）"; fi
  fi

  if [ -n "$NEXUS_ENV_ID" ]; then
    local nodes; nodes="$(aws_cli ec2 describe-instances --filters "Name=tag:nexus:component,Values=sandbox" "Name=tag:nexus:environment,Values=$NEXUS_ENV_ID" "Name=instance-state-name,Values=running" --query 'Reservations[].Instances[].[InstanceId,VpcId]' --output text)"
    if [ -z "$nodes" ]; then warn "没找到 nexus:environment=$NEXUS_ENV_ID 的运行中 Sandbox 节点（verify 将跳过 nft 核对）"
    else
      ok "Sandbox 节点：$(printf '%s' "$nodes" | awk '{print $1}' | xargs)"
      if [ -n "${TGT_VPC:-}" ]; then
        printf '%s\n' "$nodes" | awk -v v="$TGT_VPC" '$2!=v{print $1}' | while read -r n; do warn "Sandbox 节点 $n 与 PG 主机不在同一 VPC，需自行确认私网路由"; done
      fi
    fi
  else
    warn "NEXUS_ENV_ID 为空：verify 将跳过 Sandbox 节点 nft 核对"
  fi

  case ",$PHASES," in *,ingest,*)
    require_vars RULES_DOCX
    [ -f "$RULES_DOCX" ] || die "找不到规则文档 RULES_DOCX=$RULES_DOCX"
    ok "规则文档 $(basename "$RULES_DOCX")（$(wc -c < "$RULES_DOCX" | xargs) 字节）"
    # 以本机身份探一次模型（入库的向量由 PG 主机的实例角色在库里算，这里只确认模型 id、区域、模型访问都对）。请求体照模型族发
    local probe body; probe="$(secret_file bedrock-probe.json)"
    case "$EMBED_MODEL_ID" in
      *cohere*) body="{\"texts\":[\"ping\"],\"input_type\":\"search_query\",\"embedding_types\":[\"float\"],\"output_dimension\":$EMBED_DIM,\"truncate\":\"END\"}" ;;
      *titan*)  body="{\"inputText\":\"ping\",\"dimensions\":$EMBED_DIM,\"normalize\":true}" ;;
      *) die "EMBED_MODEL_ID=${EMBED_MODEL_ID}：库里的 kb_embed 只支持 Cohere Embed v4 和 Titan v2" ;;
    esac
    aws_cli bedrock-runtime invoke-model --model-id "$EMBED_MODEL_ID" --content-type application/json --accept application/json \
      --cli-binary-format raw-in-base64-out --body "$body" "$probe" >/dev/null \
      || die "调用 Bedrock $EMBED_MODEL_ID 失败（检查模型访问权限与 bedrock:InvokeModel；us. 开头的推理配置文件还要它路由到的各区域的基础模型）"
    ok "Bedrock 向量模型 $EMBED_MODEL_ID 可用（$EMBED_DIM 维）" ;;
  esac
  if [ "$AGENT_PATCH_PROMPT" = "true" ]; then
    require_vars AGENT_NAME
    local aid; aid="$(napi agent-find --name "$AGENT_NAME" | jget agent_id)"
    [ -n "$aid" ] || die "Nexus 里找不到 Agent $AGENT_NAME"
    ok "审核 Agent $AGENT_NAME → $aid"
  fi
}

phase_host() {
  [ "$PG_HOST_MODE" = "create" ] || { skip "host：existing 模式，跳过"; return 0; }
  log "host：CloudFormation 新建专用 PG 主机"
  require_vars PG_CREATE_SUBNET_ID
  local stack="${DEPLOY_NAME}-pg-host" st vpc cidr ami
  st="$(aws_cli cloudformation describe-stacks --stack-name "$stack" --query 'Stacks[0].StackStatus' --output text 2>/dev/null || true)"
  case "$st" in
    CREATE_COMPLETE|UPDATE_COMPLETE|UPDATE_ROLLBACK_COMPLETE)
      # 只建一次、从不更新：更新可能替换实例，而数据在根卷上
      skip "栈 $stack 已存在（$st），不做更新（避免替换实例丢数据；改主机配置见 GUIDE.md 5.2）"
      [ -n "$(state_get PG_HOST_INSTANCE_ID)" ] || state_set PG_HOST_INSTANCE_ID "$(aws_cli cloudformation describe-stacks --stack-name "$stack" --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" --output text)"
      [ -n "$(state_get HOST_STACK)" ] || state_set HOST_STACK "$stack"
      return 0 ;;
    *_IN_PROGRESS) die "栈 $stack 正在 $st，等它结束后重跑" ;;
  esac
  vpc="$(aws_cli ec2 describe-subnets --subnet-ids "$PG_CREATE_SUBNET_ID" --query 'Subnets[0].VpcId' --output text)"
  cidr="${PG_ALLOWED_CIDR:-$(aws_cli ec2 describe-vpcs --vpc-ids "$vpc" --query 'Vpcs[0].CidrBlock' --output text)}"
  ami="$(state_get HOST_AMI_ID)"
  [ -n "$ami" ] || ami="$(aws_cli ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 --query Parameter.Value --output text)"
  if $DRY_RUN; then plan "cloudformation deploy $stack（AMI $ami，子网 $PG_CREATE_SUBNET_ID，放行 $cidr:$PG_PORT）"; return 0; fi
  cfn_prepare "$stack" >/dev/null
  # 先记状态：首次创建中途失败时，destroy 也知道有这个栈
  state_set HOST_STACK "$stack"; state_set HOST_AMI_ID "$ami"
  aws_cli cloudformation deploy --stack-name "$stack" --template-file "$PKG_DIR/cfn/pgvector-host.yaml" \
    --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset --tags "managed-by=pgvector-rules-kb" "deploy-name=$DEPLOY_NAME" \
    --parameter-overrides "DeployName=$DEPLOY_NAME" "SubnetId=$PG_CREATE_SUBNET_ID" "VpcId=$vpc" "AllowedCidr=$cidr" \
      "Port=$PG_PORT" "InstanceType=$PG_CREATE_INSTANCE_TYPE" "VolumeSizeGb=$PG_CREATE_VOLUME_GB" "ImageId=$ami" "EmbedModelId=$EMBED_MODEL_ID"
  local iid; iid="$(aws_cli cloudformation describe-stacks --stack-name "$stack" --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" --output text)"
  state_set PG_HOST_INSTANCE_ID "$iid"
  log "等待 $iid 的 SSM 上线（最长 10 分钟）"
  ssm_wait_online "$iid" 600 || die "$iid 10 分钟内没有在 SSM 上线（检查子网 NAT / SSM 端点）"
  ok "PG 主机 $iid 已就绪（栈 $stack，AMI $ami）"
}

# db_status：只读，在 PG 主机上（SSM 或 SSH）跑 host/pgvector-status.sh（容器、规则表和归档表、库里登记的向量模型）
db_status() {
  host_run "$PKG_DIR/host/pgvector-status.sh" 60 "PG_CONTAINER_NAME=$PG_CONTAINER_NAME" "PG_DB_NAME=$PG_DB_NAME" "PG_DB_USER=$PG_DB_USER" "RULES_TABLE=$RULES_TABLE" || true
}
# db_up [<apply|migrate|restore> <库里登记的>]：在 PG 主机上（SSM 或 SSH）跑 host/pgvector-up.sh。不给动作 = 只起容器、建库 / 用户 / 扩展，不碰 kb_search.sql。
#   migrate / restore：sql/migrate_embeddings.sql 或 sql/restore_embeddings.sql 拼在 kb_search.sql 后面，一个事务（psql -1）
db_up() {
  local extra=()
  if [ -n "${1:-}" ]; then
    extra=("KB_SEARCH_SQL_B64=$(base64 < "$PKG_DIR/sql/kb_search.sql" | tr -d '\n')" "EMBED_MODEL_ID=$EMBED_MODEL_ID" "EMBED_DIM=$EMBED_DIM"
           "AWS_REGION=$AWS_REGION" "EMBED_ACTION=$1" "EMBED_EXPECT=$2" "EMBED_MODEL_FAMILY=$(model_family "$EMBED_MODEL_ID")")
    case "$1" in
      migrate) extra+=("EMBED_SQL_B64=$(base64 < "$PKG_DIR/sql/migrate_embeddings.sql" | tr -d '\n')") ;;
      restore) extra+=("EMBED_SQL_B64=$(base64 < "$PKG_DIR/sql/restore_embeddings.sql" | tr -d '\n')") ;;
    esac
  fi
  host_run "$PKG_DIR/host/pgvector-up.sh" 900 \
    "PG_IMAGE=$PG_IMAGE" "PG_CONTAINER_NAME=$PG_CONTAINER_NAME" "PG_PORT=$PG_PORT" "PG_BIND_IP=$TGT_BIND_IP" \
    "PG_DATA_VOLUME=$PG_DATA_VOLUME" "PG_MEMORY_LIMIT=$PG_MEMORY_LIMIT" "PG_BASE_DIR=$PG_BASE_DIR" \
    "PG_DB_NAME=$PG_DB_NAME" "PG_DB_USER=$PG_DB_USER" "PG_INSTALL_DOCKER=$PG_INSTALL_DOCKER" "RULES_TABLE=$RULES_TABLE" \
    ${extra[@]+"${extra[@]}"}
}
# db_record <远端输出>：只有本工具新建的东西，destroy 才会删
db_record() {
  [ "$(st_of "$1" container_action)" = "created" ] && state_set DB_CONTAINER_CREATED 1
  [ "$(st_of "$1" volume_action)" = "created" ] && state_set DB_VOLUME_CREATED 1
  [ "$(st_of "$1" env_file)" = "created" ] && state_set DB_BASEDIR_CREATED 1
  return 0
}
# db_embed_plan <status 输出> <embed_guard 的结果>：dry-run 打印登记的 / 配置的模型、两张表各多少行、实跑时做哪一种
db_embed_plan() {
  local st="$1" act="$2" reg cfg t1 t2
  reg="$(st_of "$st" embed_model)"; cfg="$(model_family "$EMBED_MODEL_ID")"
  plan "向量模型：库里登记 ${reg:-（读不到）}$([ "$reg" = titan-inferred ] && printf '（没有 kb_meta、表里已有向量：按 %s 算）' "$TITAN_FAMILY")，配置 ${cfg}（EMBED_MODEL_ID=${EMBED_MODEL_ID}）"
  if [ "$(st_of "$st" rules_table)" = present ]; then t1="$(st_of "$st" rules_rows) 行（有向量 $(st_of "$st" rules_embedded)）"; else t1="还没有"; fi
  if [ "$(st_of "$st" archive_table)" = present ]; then t2="$(st_of "$st" archive_rows) 行（有向量 $(st_of "$st" archive_embedded)）"; else t2="没有"; fi
  plan "规则表 ${RULES_TABLE}：${t1}；归档表 ${RULES_TABLE}_archive：${t2}；备份表 ${RULES_TABLE}_titan_backup：$(st_of "$st" titan_backup)"
  case "$act" in
    apply)   plan "实跑时 apply：照 sql/kb_search.sql（${cfg}）幂等重建函数，不动向量$([ "$reg" = none ] && printf '；新库登记 kb_meta = %s' "$cfg")" ;;
    migrate) plan "实跑时 migrate（一个事务）：新的 kb_search.sql（${cfg}）→ 旧向量备份进 ${RULES_TABLE}_titan_backup → 两张表全部用 $cfg 重算 → kb_meta 登记 $cfg"
             [ "$(st_of "$st" titan_backup)" = absent ] || warn "备份表 ${RULES_TABLE}_titan_backup 已存在（上一次换模型的）：迁移会被拒绝。确认不再回退后先删掉它（GUIDE.md 7.6）" ;;
    restore) plan "实跑时 restore（一个事务）：旧配置的 kb_search.sql（${cfg}）→ 内容没变的行拷回 ${RULES_TABLE}_titan_backup 里的旧向量、其余用 $cfg 重算 → kb_meta 改回 $cfg"
             [ "$(st_of "$st" titan_backup)" = present ] || warn "没有备份表 ${RULES_TABLE}_titan_backup：回退会失败" ;;
    *)       warn "实跑时会停下：${act#refuse:}" ;;
  esac
}

phase_db() {
  log "db：PostgreSQL + pgvector 容器"
  need_target db || return 0
  local st cs reg act outp pre="" first=false
  st="$(db_status)"; cs="$(st_of "$st" container_state)"
  # 读不到登记：容器没在运行（还没建、删了重建、已停止），或库 / 应用用户还没建（接管别人起的容器）。先做不碰 kb_search.sql
  # 的那部分（起容器、建库 / 用户 / 扩展），再读
  { [ "$cs" != running ] || [ "$(st_of "$st" embed_model)" = error ]; } && first=true
  if $DRY_RUN; then
    case "$cs" in
      running) skip "容器 $PG_CONTAINER_NAME 已在运行（$(st_of "$st" port_binding)）；实跑时以主机 .env 的密码执行幂等 SQL（用户 / 库 / 扩展）" ;;
      absent|"") plan "在 $TGT_ID 上启动 $PG_IMAGE，绑定 $TGT_BIND_IP:$PG_PORT，库 $PG_DB_NAME / 用户 $PG_DB_USER" ;;
      *) plan "容器 $PG_CONTAINER_NAME 当前 $cs，实跑时 docker start" ;;
    esac
    if ! $first; then
      case "$(st_of "$st" kb_search)" in
        ready) skip "库内语义检索 kb_search 已可用" ;;
        *) plan "在容器 $PG_CONTAINER_NAME 里装 PL/Python（不重启）并建 kb_embed / kb_search、上传历史、检索日志" ;;
      esac
      db_embed_plan "$st" "$(embed_guard "$(st_of "$st" embed_model)" "$EMBED_MODEL_ID" "$MIGRATE_EMB" "$RESTORE_EMB")"
    else
      plan "读不到库里登记的向量模型（容器 ${cs:-absent}，或库 / 应用用户还没建）：实跑时先起容器、建库 / 用户 / 扩展，再读登记（数据卷里可能已有向量），照它决定重建 kb_search.sql、迁移、回退，或者停下"
    fi
    return 0
  fi
  if $first; then
    pre="$(db_up)" || { printf '%s\n' "$pre"; die "db 阶段在 $TGT_ID 上起容器 / 建库失败（原因见上方远端输出）"; }
    printf '%s\n' "$pre" | grep -E '^\[host\]' || true
    db_record "$pre"
    st="$(db_status)"
  fi
  # 防混用：库里登记的向量模型与配置的不同，就停下，不重新应用 kb_search.sql（换模型 / 回退要显式加参数）
  reg="$(st_of "$st" embed_model)"
  act="$(embed_guard "$reg" "$EMBED_MODEL_ID" "$MIGRATE_EMB" "$RESTORE_EMB")"
  case "$act" in refuse:*) die "db：${act#refuse:}" ;; esac
  ok "向量模型：库里登记 ${reg}，配置 $(model_family "$EMBED_MODEL_ID") → $act"
  outp="$(db_up "$act" "$reg")" || { printf '%s\n' "$outp"; die "db 阶段在 $TGT_ID 上失败（原因见上方远端输出；migrate / restore 失败时整段已回滚）"; }
  printf '%s\n' "$outp" | grep -E '^\[host\]' || true
  db_record "$outp"
  local action; action="$(printf '%s\n%s\n' "$pre" "$outp" | first_of container_action)"
  case "$action" in unchanged) skip "容器 $PG_CONTAINER_NAME 已在运行" ;; *) ok "容器 $PG_CONTAINER_NAME：$action" ;; esac
  ok "PostgreSQL $(st_of "$outp" pg_version) + vector $(st_of "$outp" vector_version)，监听 $(st_of "$outp" listen)，密码文件 $(printf '%s\n%s\n' "$pre" "$outp" | first_of env_file)"
  ok "库内语义检索：PL/Python $(st_of "$outp" plpython)，kb_search $(st_of "$outp" kb_search)"
  case "$act" in
    apply)   ok "向量模型 $(st_of "$outp" embed_model)：kb_search.sql 照配置重建，向量没动" ;;
    migrate) ok "换模型完成：两张表的向量已用 $(st_of "$outp" embed_model) 重算，kb_meta 已登记"
             warn "旧向量备份在 ${RULES_TABLE}_titan_backup：regress 对比、verify --e2e 验收通过后再手工删（删之前随时可以 --restore-embeddings 回退，GUIDE.md 7.6）" ;;
    restore) ok "已回退：向量与 kb_meta 回到 $(st_of "$outp" embed_model)；备份表 ${RULES_TABLE}_titan_backup 留着，确认后手工删" ;;
  esac
  state_set PG_HOST_IP "$TGT_IP"; state_set PG_BIND "$TGT_BIND_IP:$PG_PORT"
}

phase_network() {
  if [ "$PG_HOST_MODE" = "create" ]; then skip "network：create 模式，入站规则由 host 栈管理"; return 0; fi
  resolve_target
  log "network：安全组入站规则 tcp/$PG_PORT ← $ALLOWED_CIDR"
  case "$ALLOWED_CIDR" in 10.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*|192.168.*) ;; *) die "PG_ALLOWED_CIDR=$ALLOWED_CIDR 不是私网段，拒绝放行" ;; esac
  local sg existing stack="${DEPLOY_NAME}-sg-ingress"
  for sg in ${TGT_SGS//,/ }; do
    existing="$(aws_cli ec2 describe-security-group-rules --filters "Name=group-id,Values=$sg" \
      --query "SecurityGroupRules[?IsEgress==\`false\` && IpProtocol=='tcp' && FromPort<=\`$PG_PORT\` && ToPort>=\`$PG_PORT\` && CidrIpv4=='$ALLOWED_CIDR'].SecurityGroupRuleId" --output text)"
    if [ -n "$existing" ] && [ "$existing" != "None" ]; then
      skip "安全组 $sg 已有等价规则 $existing（$ALLOWED_CIDR → $PG_PORT），不再创建"
      [ -n "$(state_get SG_STACK)" ] || state_set SG_RULE_PREEXISTING "$sg/$existing"
      return 0
    fi
  done
  sg="${TGT_SGS%%,*}"
  if $DRY_RUN; then plan "cloudformation deploy $stack：$sg 放行 $ALLOWED_CIDR → tcp/$PG_PORT"; return 0; fi
  cfn_prepare "$stack" >/dev/null
  state_set SG_STACK "$stack"
  aws_cli cloudformation deploy --stack-name "$stack" --template-file "$PKG_DIR/cfn/pgvector-sg-ingress.yaml" \
    --no-fail-on-empty-changeset --tags "managed-by=pgvector-rules-kb" "deploy-name=$DEPLOY_NAME" \
    --parameter-overrides "SecurityGroupId=$sg" "AllowedCidr=$ALLOWED_CIDR" "Port=$PG_PORT"
  ok "安全组 $sg 已放行 $ALLOWED_CIDR → tcp/$PG_PORT（栈 $stack）"
}

phase_egress() {
  need_target egress || return 0
  log "egress：Sandbox VM 出站白名单 vm_egress.allow_cidrs ⊇ $EGRESS_CIDRS"
  local r action dr="" added
  $DRY_RUN && dr="--dry-run"
  # shellcheck disable=SC2086
  r="$(napi egress-ensure --cidrs "$EGRESS_CIDRS" $dr)"; action="$(printf '%s' "$r" | jget action)"
  case "$action" in
    unchanged) skip "已包含：$(printf '%s' "$r" | jget after)" ;;
    would_update) plan "$(printf '%s' "$r" | jget before) → $(printf '%s' "$r" | jget after)" ;;
    updated)
      # 记录本工具实际并入的项（destroy 只去掉这些）
      added="$(printf '%s' "$r" | python3 -I -c 'import json,sys; d=json.load(sys.stdin); print(",".join(x for x in d["after"] if x not in d["before"]))')"
      local prev; prev="$(state_get EGRESS_ADDED)"
      state_set EGRESS_ADDED "$(printf '%s' "${prev:+$prev,}$added" | tr ',' '\n' | awk 'NF && !seen[$0]++' | paste -sd, -)"
      ok "已更新为 $(printf '%s' "$r" | jget after)（本工具并入：$added）；Sandbox 节点约 5 分钟内自动刷新（verify 会核对）" ;;
  esac
}

phase_connector() {
  log "connector：Nexus 数据库凭证密钥 + PostgreSQL 连接器"
  need_target connector || return 0
  local pwf r kid cid action dr=""
  $DRY_RUN && dr="--dry-run"
  pwf="$(secret_file db-app-password)"
  if ! read_db_password "$pwf"; then
    if $DRY_RUN; then plan "主机上还没有 $PG_BASE_DIR/.env（db 阶段会生成），将新建密钥 $KEY_NAME 与连接器 $CONNECTOR_NAME"; return 0; fi
    die "读不到 $TGT_ID:$PG_BASE_DIR/.env 里的应用密码（先跑 db 阶段）"
  fi
  # shellcheck disable=SC2086
  r="$(napi key-ensure --name "$KEY_NAME" --host "$TGT_BIND_IP" --port "$PG_PORT" --db "$PG_DB_NAME" --user "$PG_DB_USER" --password-file "$pwf" $dr)"
  action="$(printf '%s' "$r" | jget action)"; kid="$(printf '%s' "$r" | jget key_id)"
  case "$action" in
    unchanged) skip "密钥 $KEY_NAME（$kid）已是最新" ;;
    would_*)   plan "密钥 $KEY_NAME：$action $(printf '%s' "$r" | jget fields)"
               if [ -z "$kid" ]; then plan "连接器 $CONNECTOR_NAME 将绑定新密钥（若同名连接器已存在则改绑）"; return 0; fi ;;
    *)         ok "密钥 $KEY_NAME：$action（$kid）" ;;
  esac
  if ! $DRY_RUN; then
    [ "$action" = "created" ] && state_set KEY_CREATED "$kid"
    state_set KEY_ID "$kid"
  fi
  # shellcheck disable=SC2086
  r="$(napi connector-ensure --name "$CONNECTOR_NAME" --key-id "$kid" --host "$TGT_BIND_IP" --port "$PG_PORT" --db "$PG_DB_NAME" \
        --permission "$CONNECTOR_PERMISSION" --allow-ddl "$CONNECTOR_ALLOW_DDL" --schemas "$CONNECTOR_ALLOWED_SCHEMAS" \
        --max-rows "$CONNECTOR_MAX_ROWS" --rules-table "$RULES_TABLE" --description "$CONNECTOR_DESCRIPTION" $dr)"
  action="$(printf '%s' "$r" | jget action)"; cid="$(printf '%s' "$r" | jget connector_id)"
  case "$action" in
    unchanged) skip "连接器 $CONNECTOR_NAME（$cid）已是最新" ;;
    would_*)   plan "连接器 $CONNECTOR_NAME：$action $(printf '%s' "$r" | jget fields)"; return 0 ;;
    *)         ok "连接器 $CONNECTOR_NAME：$action（$cid）$(printf '%s' "$r" | jget fields)" ;;
  esac
  [ "$action" = "created" ] && state_set CONNECTOR_CREATED "$cid"
  # 接管来的连接器被改绑到新密钥时，记下原密钥（destroy 时不删仍被它引用的密钥）
  local prevk; prevk="$(printf '%s' "$r" | jget prev_bound_key_id)"
  if [ "$action" = "updated" ] && [ -n "$prevk" ] && [ "$prevk" != "$kid" ] && [ -z "$(state_get CONNECTOR_PREV_KEY_ID)" ]; then
    state_set CONNECTOR_PREV_KEY_ID "$prevk"
  fi
  state_set CONNECTOR_ID "$cid"
  # 「测试连接」会把结果写回连接器状态，dry-run 不做（verify 阶段会测）
  $DRY_RUN && { plan "实跑时做一次连接测试"; return 0; }
  r="$(napi connector-test --id "$cid")"
  [ "$(printf '%s' "$r" | jget success)" = "true" ] \
    || die "连接测试失败：$(printf '%s' "$r" | jget message)（API Server → $TGT_BIND_IP:$PG_PORT，见 GUIDE.md 9.1）"
  ok "连接测试通过（API Server → $TGT_BIND_IP:$PG_PORT）"
}

phase_ingest() {
  log "ingest：规则文档 → $RULES_TABLE"
  require_vars RULES_DOCX
  [ -f "$RULES_DOCX" ] || die "找不到规则文档 $RULES_DOCX"
  # 外部文档放进独立的空目录再解析（不可信输入，解析器以 -I 运行）
  local src="$PKG_DIR/.build/rules-src" json="$PKG_DIR/.build/rules.json" pwf r dr=""
  rm -rf "$src"; mkdir -p "$src"; cp "$RULES_DOCX" "$src/input.docx"
  python3 -I "$PKG_DIR/lib/parse_rules.py" "$src/input.docx" "$json" | sed 's/^/  /'
  need_target ingest || return 0
  $DRY_RUN && dr="--dry-run"
  pwf="$(secret_file db-app-password)"
  if ! read_db_password "$pwf"; then
    if $DRY_RUN; then plan "数据库尚未部署：实跑时将建表 $RULES_TABLE 并写入全部规则"; return 0; fi
    die "读不到应用密码（先跑 db 阶段）"
  fi
  pf_start "$INGEST_LOCAL_PORT" "$TGT_ID" "$TGT_BIND_IP" "$PG_PORT"
  local prune=""; [ "$INGEST_PRUNE" = "true" ] && prune="--prune"
  # shellcheck disable=SC2086
  r="$(py ingest_rules.py --rules "$json" --port "$INGEST_LOCAL_PORT" --db "$PG_DB_NAME" --user "$PG_DB_USER" \
        --password-file "$pwf" --table "$RULES_TABLE" --ddl "$PKG_DIR/sql/approval_rules.sql" \
        --source-tag "$RULES_SOURCE_TAG" --source-doc "$(basename "$RULES_DOCX")" --source-version "$RULES_SOURCE_VERSION" \
        --model "$EMBED_MODEL_ID" --dim "$EMBED_DIM" --region "$AWS_REGION" --embed sql $prune $dr \
        --smoke-question "$E2E_QUESTION" | tail -1)" || { pf_stop; die "入库失败（原因见上方）"; }
  pf_stop
  local ins upd unc prn ret
  ins="$(printf '%s' "$r" | jget inserted)"; upd="$(printf '%s' "$r" | jget updated)"
  unc="$(printf '%s' "$r" | jget unchanged)"; prn="$(printf '%s' "$r" | jget pruned)"; ret="$(printf '%s' "$r" | jget retagged)"
  if $DRY_RUN; then
    plan "新增 $ins / 重算向量 $upd / 仅更新其他列 $ret / 不变 $unc / 删除 $prn"
    [ "$prn" = "0" ] || warn "将删除的 rule_id（新版文档里已没有）：$(printf '%s' "$r" | jget pruned_ids)"
    local cfl; cfl="$(printf '%s' "$r" | jget conflicts)"
    [ "${cfl:-0}" = "0" ] || warn "$cfl 条 rule_id 已属于库里另一份文档：$(printf '%s' "$r" | jget conflict_ids)；实跑会拒绝入库、一条不写（同一份制度的新版本请用它原来的 RULES_SOURCE_TAG）"
    return 0
  fi
  if [ "$ins$upd$ret$prn" = "0000" ]; then skip "规则全部未变（$unc 条）"; else ok "新增 $ins / 重算向量 $upd / 仅更新其他列 $ret / 不变 $unc / 删除 $prn"; fi
  [ "$prn" = "0" ] || ok "已删除：$(printf '%s' "$r" | jget pruned_ids)"
  ok "表内分布 $(printf '%s' "$r" | jget rows_by_type)，无向量的行 $(printf '%s' "$r" | jget rows_without_embedding)"
  [ -z "$(printf '%s' "$r" | jget smoke_top3)" ] || ok "语义检索冒烟（E2E_QUESTION）top3：$(printf '%s' "$r" | jget smoke_top3)"
  [ "$(printf '%s' "$r" | jget untagged_not_in_doc)" = "0" ] || warn "表里有 $(printf '%s' "$r" | jget untagged_not_in_doc) 行没有 source_tag 且不在本文档里（保留未删）"
  state_set RULES_INGESTED "$(date +%Y-%m-%dT%H:%M:%S) $(basename "$RULES_DOCX")"
}

phase_agent() {
  [ "$AGENT_PATCH_PROMPT" = "true" ] || { skip "agent：AGENT_PATCH_PROMPT=false，跳过"; return 0; }
  require_vars AGENT_NAME
  log "agent：审核 Agent $AGENT_NAME 提示词补丁"
  local aid r action dr=""
  aid="$(napi agent-find --name "$AGENT_NAME" | jget agent_id)"; [ -n "$aid" ] || die "找不到 Agent $AGENT_NAME"
  CID="$(connector_id)"; export CID
  if [ -z "$CID" ]; then
    $DRY_RUN && { plan "连接器尚未创建：实跑时补丁里的连接器 ID 取新建的值"; return 0; }
    die "还没有连接器 ID（先跑 connector 阶段）"
  fi
  $DRY_RUN && dr="--dry-run"
  # shellcheck disable=SC2086
  r="$(napi agent-patch --agent-id "$aid" --template "$PKG_DIR/agent/prompt-rules.txt" --vars-json "$(agent_vars)" \
        --backup-dir "$PKG_DIR/.state/backups" $dr)"
  action="$(printf '%s' "$r" | jget action)"
  case "$action" in
    unchanged)    skip "提示词已包含受管规则（第 4 条括注、第 7、8 条）" ;;
    would_update) plan "将修改 $(printf '%s' "$r" | jget changed_lines) 行（新增：$(printf '%s' "$r" | jget inserted)；改写已有行：$(printf '%s' "$r" | jget replaced)）" ;;
    updated)
      [ -n "$(state_get AGENT_PROMPT_BACKUP)" ] || state_set AGENT_PROMPT_BACKUP "$(printf '%s' "$r" | jget backup)"
      state_set AGENT_ID "$aid"
      # 只记「本工具新增的」受管行：destroy 只删这些；改写的已有行不删（需要时从备份人工恢复）
      local ins prev; ins="$(printf '%s' "$r" | python3 -I -c 'import json,sys; print(",".join(json.load(sys.stdin).get("inserted") or []))')"
      prev="$(state_get AGENT_INSERTED_KEYS)"
      [ -z "$ins" ] || state_set AGENT_INSERTED_KEYS "$(printf '%s' "${prev:+$prev,}$ins" | tr ',' '\n' | awk 'NF && !seen[$0]++' | paste -sd, -)"
      [ "$(printf '%s' "$r" | jget readback_ok)" = "true" ] || warn "保存后回读与写入不完全一致，请到界面核对提示词"
      ok "已更新 $(printf '%s' "$r" | jget changed_lines) 行，原提示词备份到 $(printf '%s' "$r" | jget backup)"
      warn "已有会话的动态配置缓存的是旧提示词：要用新规则，请新建会话后重新绑定连接器" ;;
  esac
}

phase_verify() {
  log "verify：逐层核对（只读$($E2E && ! $DRY_RUN && printf '；--e2e 会建测试会话')）"
  local fails=0 st aid r nodes n set miss
  need_target verify || return 0
  st="$(host_run "$PKG_DIR/host/pgvector-status.sh" 60 "PG_CONTAINER_NAME=$PG_CONTAINER_NAME" "PG_DB_NAME=$PG_DB_NAME" "PG_DB_USER=$PG_DB_USER" "RULES_TABLE=$RULES_TABLE" \
    "E2E_QUESTION_B64=$(printf '%s' "$E2E_QUESTION" | base64 | tr -d '\n')" || true)"
  if [ "$(printf '%s\n' "$st" | result_of container_state)" = "running" ]; then
    ok "[db] 容器 running，$(printf '%s\n' "$st" | result_of port_binding)，PG $(printf '%s\n' "$st" | result_of pg_version)，vector $(printf '%s\n' "$st" | result_of vector_version)"
  else warn "[db] 容器状态：$(printf '%s\n' "$st" | result_of container_state)"; fails=$((fails+1)); fi
  if [ "$(printf '%s\n' "$st" | result_of rules_table)" = "present" ]; then
    ok "[ingest] $RULES_TABLE：$(printf '%s\n' "$st" | result_of rules_rows) 行（$(printf '%s\n' "$st" | result_of rules_by_type)），无向量 $(printf '%s\n' "$st" | result_of rules_rows_without_embedding)，来源 $(printf '%s\n' "$st" | result_of rules_sources)"
  else warn "[ingest] 规则表 $RULES_TABLE 不存在"; fails=$((fails+1)); fi
  case "$(printf '%s\n' "$st" | result_of kb_search)" in
    ready) ok "[search] kb_search 可用（库内语义检索，PL/Python 已装）" ;;
    error) warn "[search] kb_search 报错：$(printf '%s\n' "$st" | result_of kb_search_error)（排错见 GUIDE.md 9.10）"; fails=$((fails+1)) ;;
    *) warn "[search] kb_search 不可用（$(printf '%s\n' "$st" | result_of kb_search)）：跑 ./deploy.sh db 装 PL/Python 并建函数"; fails=$((fails+1)) ;;
  esac
  local top3; top3="$(printf '%s\n' "$st" | result_of kb_search_top3)"
  if [ -n "$E2E_EXPECT" ] && [ "$(printf '%s\n' "$st" | result_of kb_search)" = "ready" ]; then
    if printf ',%s,' "$top3" | grep -q ",$E2E_EXPECT,"; then ok "[search] E2E_QUESTION 前 3 名：$top3（含 $E2E_EXPECT）"
    else warn "[search] E2E_QUESTION 前 3 名：${top3:-（空）}，里面没有 $E2E_EXPECT"; fails=$((fails+1)); fi
  fi

  if [ "$PG_HOST_MODE" = "existing" ]; then
    local sg hit=""
    for sg in ${TGT_SGS//,/ }; do
      hit="$hit$(aws_cli ec2 describe-security-group-rules --filters "Name=group-id,Values=$sg" \
        --query "SecurityGroupRules[?IsEgress==\`false\` && IpProtocol=='tcp' && FromPort<=\`$PG_PORT\` && ToPort>=\`$PG_PORT\`].CidrIpv4" --output text 2>/dev/null | tr '\t' ' ' || true) "
    done
    if printf '%s' "$hit" | tr ' ' '\n' | grep -qx -- "$ALLOWED_CIDR"; then ok "[network] 安全组放行 tcp/$PG_PORT 来源：$(printf '%s' "$hit" | xargs)"
    else warn "[network] 安全组没有放行 $ALLOWED_CIDR → $PG_PORT（现有：$(printf '%s' "$hit" | xargs)）"; fails=$((fails+1)); fi
  fi

  r="$(napi egress-get || true)"
  miss="$(cidrs_covered "$(printf '%s' "$r" | python3 -I -c 'import json,sys; print(",".join(json.load(sys.stdin).get("allow_cidrs") or []))' 2>/dev/null || true)" "$EGRESS_CIDRS")"
  if [ -z "$miss" ]; then ok "[egress] vm_egress.allow_cidrs = $(printf '%s' "$r" | jget allow_cidrs)"
  else warn "[egress] vm_egress.allow_cidrs = $(printf '%s' "$r" | jget allow_cidrs)，没覆盖 $miss（跑 ./deploy.sh egress）"; fails=$((fails+1)); fi
  if [ -n "$NEXUS_ENV_ID" ]; then
    nodes="$(aws_cli ec2 describe-instances --filters "Name=tag:nexus:component,Values=sandbox" "Name=tag:nexus:environment,Values=$NEXUS_ENV_ID" "Name=instance-state-name,Values=running" --query 'Reservations[].Instances[].InstanceId' --output text 2>/dev/null || true)"
    printf 'nft list set inet nexus_vm egress_allow 2>/dev/null | tr -d "\\n\\t" | sed -E "s/.*elements = \\{ ?([^}]*)\\}.*/\\1/; t; s/.*/<empty>/"; echo\n' > "$PKG_DIR/.build/nft-egress.sh"
    for n in $nodes; do
      set="$(ssm_run "$n" "$PKG_DIR/.build/nft-egress.sh" 60 2>/dev/null | tail -1 | xargs || true)"
      if [ -z "$set" ]; then warn "[egress] 读不到 Sandbox 节点 $n 的 nft 集合（节点离线或 SSM 不通）"; fails=$((fails+1)); continue; fi
      miss="$(cidrs_covered "$set" "$EGRESS_CIDRS")"
      if [ -z "$miss" ]; then ok "[egress] Sandbox 节点 $n 的 nft egress_allow = { $set }"
      else warn "[egress] Sandbox 节点 $n 的 nft egress_allow = { $set }，还缺 $miss（配置改动约 5 分钟生效，稍后重试）"; fails=$((fails+1)); fi
    done
  fi

  CID="$(connector_id || true)"; export CID
  if [ -n "$CID" ]; then
    r="$(napi connector-test --id "$CID" || true)"
    if [ "$(printf '%s' "$r" | jget success)" = "true" ]; then ok "[connector] $CONNECTOR_NAME（$CID）连接测试通过"
    else warn "[connector] 连接测试失败：$(printf '%s' "$r" | jget message)"; fails=$((fails+1)); fi
    r="$(napi connector-schema --id "$CID" || true)"
    if printf '%s' "$r" | jget tables | grep -q "\"$RULES_TABLE\""; then ok "[connector] Schema 可见表：$(printf '%s' "$r" | jget tables)"
    else warn "[connector] Schema 里看不到 $RULES_TABLE：$(printf '%s' "$r" | jget tables)"; fails=$((fails+1)); fi
  else warn "[connector] 找不到连接器 $CONNECTOR_NAME"; fails=$((fails+1)); fi

  if [ "$AGENT_PATCH_PROMPT" = "true" ] && [ -n "$CID" ]; then
    aid="$(napi agent-find --name "$AGENT_NAME" | jget agent_id)"
    r="$(napi agent-check --agent-id "$aid" --template "$PKG_DIR/agent/prompt-rules.txt" --vars-json "$(agent_vars)" || true)"
    if [ "$(printf '%s' "$r" | jget applied)" = "true" ]; then ok "[agent] $AGENT_NAME 提示词包含受管规则"
    else warn "[agent] $AGENT_NAME 提示词与补丁不一致（跑 ./deploy.sh agent）"; fails=$((fails+1)); fi
    if $E2E && $DRY_RUN; then
      plan "--e2e 在 dry-run 下跳过（它会建测试会话并发消息）"
    elif $E2E; then
      require_vars E2E_QUESTION E2E_EXPECT
      log "verify --e2e：经 API 跑规则问答$( [ "$E2E_A2A_REGRESSION" = "true" ] && printf ' + A2A 三段式回归')（每项 1~3 分钟）"
      local a2a="" cl=""
      [ "$E2E_A2A_REGRESSION" = "true" ] && a2a="--a2a"; [ "$E2E_CLEANUP_SESSIONS" = "true" ] && cl="--cleanup"
      # shellcheck disable=SC2086
      r="$(napi e2e --agent-id "$aid" --connector-id "$CID" --question "$E2E_QUESTION" --expect "$E2E_EXPECT" $a2a $cl || true)"
      printf '%s' "$r" > "$PKG_DIR/.build/e2e-result.json"
      if [ "$(printf '%s' "$r" | jget rule_qa.pass)" = "true" ]; then
        ok "[e2e] 规则问答命中 $E2E_EXPECT（$(printf '%s' "$r" | jget rule_qa.seconds) 秒，工具调用 $(printf '%s' "$r" | jget rule_qa.tool_calls) 次）"
      else warn "[e2e] 规则问答没有命中 $E2E_EXPECT；回答开头：$(printf '%s' "$r" | jget rule_qa.reply_head | head -c 300)"; fails=$((fails+1)); fi
      if [ -n "$a2a" ]; then
        if [ "$(printf '%s' "$r" | jget a2a_regression.pass)" = "true" ]; then
          ok "[e2e] A2A 三段式回归：纯 JSON（verdict=$(printf '%s' "$r" | jget a2a_regression.json_verdict)），未写库（工具：$(printf '%s' "$r" | jget a2a_regression.tools)）"
        else warn "[e2e] A2A 三段式回归失败：verdict=$(printf '%s' "$r" | jget a2a_regression.json_verdict) 写类工具=$(printf '%s' "$r" | jget a2a_regression.write_tools) 回答=$(printf '%s' "$r" | jget a2a_regression.reply_head | head -c 200)"; fails=$((fails+1)); fi
      fi
      ok "[e2e] 完整结果：.build/e2e-result.json"
    fi
  fi
  [ "$fails" -eq 0 ] && ok "verify 全部通过" || die "verify 有 $fails 项未通过（见上方 ! 行与 GUIDE.md 9）"
}

phase_status() {
  log "status：状态文件 $(state_file)"
  if [ -f "$(state_file)" ]; then sed 's/^/  /' "$(state_file)"; else echo "  （还没有状态文件）"; fi
  if resolve_target soft; then ok "PG 主机 $TGT_ID（$TGT_IP，$TGT_STATE）"; else warn "PG 主机未知或查不到"; fi
  CID="$(connector_id || true)"
  if [ -n "$CID" ]; then ok "连接器 $CONNECTOR_NAME → $CID"; else warn "连接器 $CONNECTOR_NAME 不存在"; fi
}

phase_destroy() {
  log "destroy：只撤销本工具的改动（agent → connector → egress → network → db → host）"
  if ! $YES && ! $DRY_RUN; then
    printf '将撤销 %s 的部署（%s）。输入 %s 确认：' "$DEPLOY_NAME" "$($PURGE && echo '含本工具建的数据卷 / 密码目录 / 主机，不可恢复' || echo '数据保留')" "$DEPLOY_NAME"
    local ans; read -r ans; [ "$ans" = "$DEPLOY_NAME" ] || die "已取消"
  fi
  local v r dr=""; $DRY_RUN && dr="--dry-run"

  # agent：只删本工具「新增」的受管行；改写过的已有行不动（整份备份见 AGENT_PROMPT_BACKUP）
  v="$(state_get AGENT_INSERTED_KEYS)"
  if [ -n "$v" ]; then
    CID="$(connector_id || true)"; export CID
    # shellcheck disable=SC2086
    r="$(napi agent-unpatch --agent-id "$(state_get AGENT_ID)" --template "$PKG_DIR/agent/prompt-rules.txt" \
          --vars-json "$(agent_vars)" --only-keys "$v" --backup-dir "$PKG_DIR/.state/backups" $dr)"
    ok "Agent 提示词去掉本工具新增的 [$v]：$(printf '%s' "$r" | jget action)（改动前的整份备份：$(state_get AGENT_PROMPT_BACKUP)）"
    $DRY_RUN || state_del AGENT_INSERTED_KEYS
  else skip "Agent 提示词里没有本工具新增的行，不动"; fi

  # connector / key：只删本工具新建的；仍被接管来的连接器引用的密钥不删
  v="$(state_get CONNECTOR_CREATED)"
  if [ -n "$v" ]; then
    if $DRY_RUN; then plan "删除连接器 $v"; else
      r="$(napi connector-delete --id "$v")"; ok "连接器 $v：$(printf '%s' "$r" | jget action)"; state_del CONNECTOR_CREATED; state_del CONNECTOR_ID; fi
  else skip "连接器不是本工具新建的，不删$( [ -n "$(state_get CONNECTOR_ID)" ] && printf '（%s）' "$(state_get CONNECTOR_ID)")"; fi
  v="$(state_get KEY_CREATED)"
  if [ -n "$v" ]; then
    if [ -z "$(state_get CONNECTOR_CREATED)" ] && [ -n "$(state_get CONNECTOR_ID)" ] && ! $DRY_RUN; then
      warn "密钥 $v 是本工具建的，但被接管来的连接器 $(state_get CONNECTOR_ID) 引用着，不删（原绑定密钥：$(state_get CONNECTOR_PREV_KEY_ID)；需要时在界面上改回后手工删除）"
    elif $DRY_RUN; then plan "删除密钥 $v（若仍被接管来的连接器引用则跳过）"
    else r="$(napi key-delete --id "$v")"; ok "密钥 $v：$(printf '%s' "$r" | jget action)"; state_del KEY_CREATED; state_del KEY_ID; fi
  else skip "密钥不是本工具新建的，不删"; fi

  # egress：只去掉本工具并入的项
  v="$(state_get EGRESS_ADDED)"
  if [ -n "$v" ]; then
    warn "将从 vm_egress.allow_cidrs 去掉本工具并入的 $v；若同一 Nexus 上的其他部署也依赖这些网段，请先确认"
    # shellcheck disable=SC2086
    r="$(napi egress-remove --cidrs "$v" $dr)"; ok "vm_egress.allow_cidrs：$(printf '%s' "$r" | jget action) → $(printf '%s' "$r" | jget after)"
    $DRY_RUN || state_del EGRESS_ADDED
  else skip "vm_egress.allow_cidrs 里没有本工具并入的项，不动"; fi

  # network：只删本工具建的栈
  v="$(state_get SG_STACK)"
  if [ -n "$v" ]; then
    if $DRY_RUN; then plan "删除栈 $v"; else
      aws_cli cloudformation delete-stack --stack-name "$v"; aws_cli cloudformation wait stack-delete-complete --stack-name "$v"
      ok "已删除栈 $v"; state_del SG_STACK; fi
  else skip "安全组规则不是本工具建的，不动$( [ -n "$(state_get SG_RULE_PREEXISTING)" ] && printf '（%s）' "$(state_get SG_RULE_PREEXISTING)")"; fi

  # db：只删本工具建的容器；--purge-data 时再删本工具建的数据卷与密码目录
  if [ "$(state_get DB_CONTAINER_CREATED)" = "1" ]; then
    if ! resolve_target soft; then warn "查不到 PG 主机，跳过容器清理"
    elif $DRY_RUN; then plan "删除 $TGT_ID 上的容器 $PG_CONTAINER_NAME$($PURGE && echo "，以及本工具建的数据卷 / 密码目录")"
    else
      local pv=false pb=false
      $PURGE && [ "$(state_get DB_VOLUME_CREATED)" = "1" ] && pv=true
      $PURGE && [ "$(state_get DB_BASEDIR_CREATED)" = "1" ] && pb=true
      r="$(host_run "$PKG_DIR/host/pgvector-down.sh" 120 "PG_CONTAINER_NAME=$PG_CONTAINER_NAME" "PG_DATA_VOLUME=$PG_DATA_VOLUME" \
            "PG_BASE_DIR=$PG_BASE_DIR" "PG_PURGE_VOLUME=$pv" "PG_PURGE_BASEDIR=$pb")"
      ok "容器 $(printf '%s\n' "$r" | result_of container)，数据卷 $(printf '%s\n' "$r" | result_of volume)，密码目录 $(printf '%s\n' "$r" | result_of base_dir)"
      state_del DB_CONTAINER_CREATED
      [ "$(printf '%s\n' "$r" | result_of volume)" = "removed" ] && state_del DB_VOLUME_CREATED
      [ "$(printf '%s\n' "$r" | result_of base_dir)" = "removed" ] && state_del DB_BASEDIR_CREATED
    fi
  else skip "容器不是本工具创建的，不动"; fi

  # host：数据在根卷上，只有 --purge-data 才删主机栈
  v="$(state_get HOST_STACK)"
  if [ -n "$v" ]; then
    if ! $PURGE; then warn "保留 PG 主机栈 $v（数据在它的根卷上）；要连主机一起删请加 --purge-data"
    elif $DRY_RUN; then plan "删除栈 $v（PG 主机及其根卷）"
    else
      aws_cli cloudformation delete-stack --stack-name "$v"; aws_cli cloudformation wait stack-delete-complete --stack-name "$v"
      ok "已删除栈 $v"; state_del HOST_STACK; state_del PG_HOST_INSTANCE_ID; state_del HOST_AMI_ID; fi
  fi
  ok "destroy 完成"
}

phase_rotate_db_password() {
  log "rotate-db-password：轮换应用用户 $PG_DB_USER 的密码"
  need_target rotate-db-password || return 0
  if $DRY_RUN; then plan "主机 $PG_BASE_DIR/.env 换新密码（旧文件备份）→ db 阶段 ALTER ROLE → connector 阶段同步 Nexus 密钥"; return 0; fi
  # 先确认 db 阶段不会被防混用拦下：不然 .env 换了新密码，库里还是旧的
  local act; act="$(embed_guard "$(st_of "$(db_status)" embed_model)" "$EMBED_MODEL_ID" false false)"
  case "$act" in refuse:*) die "轮换要跑 db 阶段，而它会停下：${act#refuse:}（密码还没换）" ;; esac
  if ! $YES; then
    printf '轮换期间（约 30 秒）连接器会短暂认证失败。输入 %s 确认：' "$DEPLOY_NAME"
    local ans; read -r ans; [ "$ans" = "$DEPLOY_NAME" ] || die "已取消"
  fi
  local r; r="$(host_run "$PKG_DIR/host/rotate-db-password.sh" 60 "PG_BASE_DIR=$PG_BASE_DIR")" || die "主机上换密码失败"
  ok "主机 .env 已换新密码（旧文件：$(printf '%s\n' "$r" | result_of backup)）"
  phase_db
  phase_connector
  ok "密码轮换完成：库与 Nexus 密钥都已是新密码"
}

phase_regress() {
  log "regress：检索回归 ${REG_LABEL}（kb_search，与审核 Agent 同一个函数）"
  [ -n "$REG_QDIR" ] && [ -n "$REG_LABEL" ] \
    || die "用法：./deploy.sh regress --questions-dir <目录> --label <名字> [--out <目录>]；只对比：./deploy.sh regress --compare <a.json> <b.json>"
  local args=(--questions-dir "$REG_QDIR" --label "$REG_LABEL") chk pwf
  [ -z "$REG_OUT" ] || args+=(--out "$REG_OUT")
  # 先只校验、不连库：题库读得出、题库和结果目录都不在仓库里、同名结果不覆盖
  chk="$(py kb_regression.py "${args[@]}" --check)" || die "regress：题库或结果目录不对（原因见上方）"
  need_target regress || return 0
  if $DRY_RUN; then plan "${chk}；经端口转发以应用用户 $PG_DB_USER 逐题调 kb_search（每分钟 ≤ 50 次，检索日志里记 caller=kb-regression）"; return 0; fi
  ok "$chk"
  pwf="$(secret_file db-app-password)"
  read_db_password "$pwf" || die "读不到应用密码（先跑 db 阶段）"
  pf_start "$INGEST_LOCAL_PORT" "$TGT_ID" "$TGT_BIND_IP" "$PG_PORT"
  py kb_regression.py --host 127.0.0.1 --port "$INGEST_LOCAL_PORT" --db "$PG_DB_NAME" --user "$PG_DB_USER" --password-file "$pwf" \
    --table "$RULES_TABLE" "${args[@]}" || { pf_stop; die "回归没跑完（原因见上方），没写结果文件"; }
  pf_stop
}

# ============================================================================
# 需要 Nexus API 的阶段：在主 shell 里准备一次管理员密码文件（napi 常在 $(...) 子 shell 里调用，那里导出的变量传不回来）
case ",$PHASES," in
  *,preflight,*|*,egress,*|*,connector,*|*,agent,*|*,verify,*|*,status,*|*,destroy,*|*,api,*|*,rotate-db-password,*) nexus_auth ;;
esac
if [ "$PHASES" = "api" ]; then
  [ -n "$API_PATH" ] || die "用法：./deploy.sh api <path>"
  py nexus_api.py api-get "$API_PATH"; exit $?
fi
for p in ${PHASES//,/ }; do
  case "$p" in
    preflight|host|db|network|egress|connector|ingest|agent|verify|status|destroy) "phase_$p" ;;
    rotate-db-password) phase_rotate_db_password ;;
    regress) phase_regress ;;
    *) die "未知阶段 $p（./deploy.sh --help）" ;;
  esac
done
$DRY_RUN && log "dry-run 结束：以上 ~ 行是实跑时会做的改动，= 行表示已是目标状态"
exit 0
