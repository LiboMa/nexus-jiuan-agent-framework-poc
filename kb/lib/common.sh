# shellcheck shell=bash
#
# pgvector-rules-kb 公共函数（由 deploy.sh source，不单独执行）
#
#   日志        log / ok / skip / plan / warn / die
#   配置        load_config / require_vars / aws_cli
#   状态文件    state_get / state_set / state_del      → .state/<DEPLOY_NAME>.env
#   密钥文件    secret_file                             → .build/secrets/（700），退出时自动删除
#   SSM         ssm_run / ssm_read_secret / ssm_wait_online
#   PG 主机     host_run / host_read_secret / host_reachable  → 按 PG_HOST_TRANSPORT 经 SSM（缺省）或 SSH（ssh_run）
#   端口转发    pf_start / pf_stop（SSM 或 SSH）
#   Python      py <script> [args]                      → uv 临时环境，-I 隔离模式
#   向量模型    model_family / embed_guard               → db 阶段防混用
#
# 兼容 bash 3.2（macOS 自带）：不用关联数组、mapfile、${var,,}。

# ---------- 日志 ----------
log()  { printf '\033[0;36m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }
ok()   { printf '\033[0;32m  ✓\033[0m %s\n' "$*"; }
skip() { printf '\033[0;33m  =\033[0m %s\n' "$*"; }                 # 已是目标状态，未做改动
plan() { printf '\033[0;35m  ~\033[0m [dry-run] %s\n' "$*"; }       # dry-run 下本应执行的改动
warn() { printf '\033[0;33m  !\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[0;31m  ✗\033[0m %s\n' "$*" >&2; exit 1; }

# ---------- 配置 ----------
# 样例里的 <…> 是要换成真实值的占位符，还留着就停下并说出是哪一项：
#   没加引号的（KEY=https://<env>.<domain>）bash 会当成重定向，source 时只报一句看不懂的语法错误，所以 source 之前先看原文；
#   加了引号的（样例里的写法）source 得过，source 之后再看值。
# 正文类的项（连接器描述、文档名、版本说明、板块提示、问句）可以合法地含 < 和 >，不当占位符。
CONFIG_FREE_TEXT=" CONNECTOR_DESCRIPTION RULES_DOC_TITLE RULES_SOURCE_VERSION RULES_SEGMENTS_HINT E2E_QUESTION "
config_keys() { LC_ALL=C sed -n 's/^[[:space:]]*\(export[[:space:]][[:space:]]*\)\{0,1\}\([A-Za-z_][A-Za-z0-9_]*\)=.*/\2/p' "$1"; }
unquoted_placeholder_keys() {
  LC_ALL=C sed -n "s/^[[:space:]]*\(export[[:space:]][[:space:]]*\)\{0,1\}\([A-Za-z_][A-Za-z0-9_]*\)=[^'\"[:space:]]*<[^[:space:]]*>.*/\2/p" "$1"
}

# load_config <file>：source 配置并补默认值。所有变量导出，供 Python 子进程读取。
load_config() {
  local f="$1" pre_profile="${AWS_PROFILE:-}" k
  [ -f "$f" ] || die "找不到配置文件 $f（先 cp deploy.env.example deploy.env 再修改）"
  for k in $(unquoted_placeholder_keys "$f"); do die "deploy.env 里 $k 还是占位符，先填上"; done
  set -a
  # shellcheck disable=SC1090
  . "$f"
  set +a
  for k in $(config_keys "$f"); do
    case "$CONFIG_FREE_TEXT" in *" $k "*) continue ;; esac
    case "${!k-}" in *'<'*'>'*) die "deploy.env 里 $k 还是占位符，先填上" ;; esac
  done
  : "${DEPLOY_NAME:=pgvector-rules-kb}"
  : "${AWS_REGION:=us-east-1}"
  : "${NEXUS_ADMIN_USER:=admin}"
  : "${PG_HOST_MODE:=existing}"
  : "${PG_HOST_TRANSPORT:=ssm}"
  : "${PG_SSH_USER:=ec2-user}"
  : "${PG_SSH_PORT:=22}"
  : "${PG_CREATE_INSTANCE_TYPE:=t3.medium}"
  : "${PG_CREATE_VOLUME_GB:=30}"
  : "${PG_IMAGE:=pgvector/pgvector:pg17}"
  : "${PG_CONTAINER_NAME:=nexus-pgvector}"
  : "${PG_PORT:=5432}"
  : "${PG_DATA_VOLUME:=nexus-pgvector-data}"
  : "${PG_MEMORY_LIMIT:=2g}"
  : "${PG_BASE_DIR:=/opt/nexus-pgvector}"
  : "${PG_DB_NAME:=nexus}"
  : "${PG_DB_USER:=nexus}"
  : "${PG_INSTALL_DOCKER:=true}"
  : "${CONNECTOR_NAME:=pgvector-rules-kb}"
  : "${KEY_NAME:=pgvector-rules-kb-cred}"
  : "${CONNECTOR_PERMISSION:=read_write}"
  : "${CONNECTOR_ALLOW_DDL:=true}"
  : "${CONNECTOR_ALLOWED_SCHEMAS:=public}"
  : "${CONNECTOR_MAX_ROWS:=1000}"
  : "${RULES_TABLE:=approval_rules}"
  : "${RULES_SOURCE_TAG:=finance-approval-v4}"
  : "${EMBED_MODEL_ID:=us.cohere.embed-v4:0}"
  : "${EMBED_DIM:=1024}"
  : "${INGEST_LOCAL_PORT:=15432}"
  : "${INGEST_PRUNE:=true}"
  : "${AGENT_PATCH_PROMPT:=true}"
  : "${E2E_A2A_REGRESSION:=true}"
  : "${E2E_CLEANUP_SESSIONS:=true}"
  # 可选项：留空即可（各阶段按注释里的规则自动发现或跳过）
  : "${NEXUS_URL:=}" "${NEXUS_ENV_ID:=}" "${NEXUS_ADMIN_PASSWORD_FILE:=}" "${NEXUS_ADMIN_PASSWORD_SSM:=}"
  : "${PG_HOST_INSTANCE_ID:=}" "${PG_CREATE_SUBNET_ID:=}" "${PG_BIND_IP:=}" "${PG_ALLOWED_CIDR:=}"
  : "${PG_SSH_HOST:=}" "${PG_SSH_KEY:=}" "${PG_SSH_KNOWN_HOSTS:=}" "${PG_SSH_PROXY_COMMAND:=}"
  : "${VM_EGRESS_ALLOW_CIDRS:=}" "${CONNECTOR_DESCRIPTION:=}" "${RULES_DOCX:=}" "${RULES_DOC_TITLE:=}"
  : "${RULES_SOURCE_VERSION:=}" "${RULES_SEGMENTS_HINT:=}" "${AGENT_NAME:=}" "${E2E_QUESTION:=}" "${E2E_EXPECT:=}"
  export DEPLOY_NAME AWS_REGION NEXUS_ADMIN_USER PG_HOST_MODE PG_CREATE_INSTANCE_TYPE PG_CREATE_VOLUME_GB \
    PG_HOST_TRANSPORT PG_SSH_USER PG_SSH_PORT PG_SSH_HOST PG_SSH_KEY PG_SSH_KNOWN_HOSTS PG_SSH_PROXY_COMMAND \
    PG_IMAGE PG_CONTAINER_NAME PG_PORT PG_DATA_VOLUME PG_MEMORY_LIMIT PG_BASE_DIR PG_DB_NAME PG_DB_USER \
    PG_INSTALL_DOCKER CONNECTOR_NAME KEY_NAME CONNECTOR_PERMISSION CONNECTOR_ALLOW_DDL CONNECTOR_ALLOWED_SCHEMAS \
    CONNECTOR_MAX_ROWS RULES_TABLE RULES_SOURCE_TAG EMBED_MODEL_ID EMBED_DIM INGEST_LOCAL_PORT INGEST_PRUNE \
    AGENT_PATCH_PROMPT E2E_A2A_REGRESSION E2E_CLEANUP_SESSIONS
  # 配置里 AWS_PROFILE 留空时，沿用调用前已导出的值（AWS_PROFILE=x ./deploy.sh …）；两者都空才用默认凭证链
  [ -z "${AWS_PROFILE:-}" ] && [ -n "$pre_profile" ] && AWS_PROFILE="$pre_profile"
  if [ -n "${AWS_PROFILE:-}" ]; then export AWS_PROFILE; else unset AWS_PROFILE; fi
  NEXUS_URL="${NEXUS_URL%/}"; export NEXUS_URL
  case "$DEPLOY_NAME" in
    *[!a-zA-Z0-9-]*|"") die "DEPLOY_NAME 只能含字母、数字和连字符（用作 CloudFormation 栈名）：$DEPLOY_NAME" ;;
  esac
  case "$PG_HOST_MODE" in existing|create) ;; *) die "PG_HOST_MODE 只能是 existing 或 create：$PG_HOST_MODE" ;; esac
  case "$PG_HOST_TRANSPORT" in
    ssm) ;;
    ssh)
      [ "$PG_HOST_MODE" = existing ] || die "PG_HOST_TRANSPORT=ssh 只用于 existing 模式（create 模式建的专用主机没有公网地址，只能经 SSM）"
      [ -n "$PG_SSH_HOST" ] || die "PG_HOST_TRANSPORT=ssh 要写 PG_SSH_HOST（PG 主机的地址，本机要能 SSH 到）"
      case "$PG_SSH_KEY" in /*) ;; *) die "PG_HOST_TRANSPORT=ssh 要写 PG_SSH_KEY（本机私钥的绝对路径）：${PG_SSH_KEY:-空}" ;; esac
      [ -f "$PG_SSH_KEY" ] || die "找不到私钥 $PG_SSH_KEY"
      case "$PG_SSH_USER$PG_SSH_PORT$PG_SSH_HOST" in *[!A-Za-z0-9._-]*) die "PG_SSH_USER / PG_SSH_PORT / PG_SSH_HOST 只能含字母、数字和 . _ -" ;; esac
      case "$PG_SSH_PROXY_COMMAND" in *$'\n'*|*$'\r'*) die "PG_SSH_PROXY_COMMAND 只能是一行" ;; esac
      ;;
    *) die "PG_HOST_TRANSPORT 只能是 ssm 或 ssh：$PG_HOST_TRANSPORT" ;;
  esac
  case "$CONNECTOR_PERMISSION" in read_only|read_write) ;; *) die "CONNECTOR_PERMISSION 只能是 read_only 或 read_write" ;; esac
  case "$RULES_TABLE" in *[!a-z0-9_]*|[0-9]*|"") die "RULES_TABLE 只能含小写字母、数字、下划线且不以数字开头：$RULES_TABLE" ;; esac
}

# require_vars VAR...：缺任何一个就退出，并说明是哪个。
require_vars() {
  local v missing=""
  for v in "$@"; do
    eval "[ -n \"\${$v:-}\" ]" || missing="$missing $v"
  done
  [ -z "$missing" ] || die "deploy.env 缺少必填项:$missing"
}

aws_cli() { aws --region "$AWS_REGION" "$@"; }

# ---------- 状态文件 ----------
# .state/<DEPLOY_NAME>.env：KEY=VALUE（printf %q 转义），记录本工具创建/发现的资源 ID 与改动前的原值，
# 供幂等判断、status 与 destroy 使用。
state_file() { printf '%s/.state/%s.env' "$PKG_DIR" "$DEPLOY_NAME"; }
state_get() {
  local f; f="$(state_file)"
  [ -f "$f" ] || return 0
  ( set +u
    # shellcheck disable=SC1090
    . "$f"
    eval "printf '%s' \"\${$1:-}\"" )
}
state_set() {
  $DRY_RUN && { plan "记录状态 $1"; return 0; }
  local f tmp; f="$(state_file)"; mkdir -p "$(dirname "$f")"; chmod 700 "$(dirname "$f")"
  tmp="$(mktemp "${f}.XXXX")"
  [ -f "$f" ] && grep -v "^$1=" "$f" > "$tmp" || true
  printf '%s=%q\n' "$1" "$2" >> "$tmp"
  mv "$tmp" "$f"; chmod 600 "$f"
}
state_del() {
  $DRY_RUN && { plan "清除状态 $1"; return 0; }
  local f tmp; f="$(state_file)"; [ -f "$f" ] || return 0
  tmp="$(mktemp "${f}.XXXX")"; grep -v "^$1=" "$f" > "$tmp" || true; mv "$tmp" "$f"; chmod 600 "$f"
}

# ---------- 临时密钥文件 ----------
# secret_file <name>：返回一个 600 权限的空文件路径（.build/secrets/ 下）。进程退出时整个目录删除。
# 密码只经文件在本工具的进程之间传递，绝不出现在命令行参数、日志或终端输出里。
SECRETS_DIR=""
secret_file() {
  if [ -z "$SECRETS_DIR" ]; then
    SECRETS_DIR="$PKG_DIR/.build/secrets.$$"
    mkdir -p "$SECRETS_DIR"; chmod 700 "$SECRETS_DIR"
  fi
  local f="$SECRETS_DIR/$1"; : > "$f"; chmod 600 "$f"; printf '%s' "$f"
}

# ---------- SSM 远程执行 ----------
# ssm_run <instance-id> <script-file> [timeout-sec] [VAR=value ...]
#   在目标实例上以 root 执行本地脚本。VAR=value 以 export 的形式加在脚本前面。
#   脚本经 gzip + base64 传输（绕开命令参数里的引号转义问题），在远端写进 mktemp 文件执行后删除。
#   远端 stdout 原样写到本地 stdout；状态与 stderr 写到本地 stderr；远端失败时返回 1。
#   投递超时 120 秒（实例离线时命令不会排队到之后才执行）；本地等待超时则取消命令。
#   注意：SSM 会保存命令输出约 30 天。要读机密请用 ssm_read_secret（输出只含密文）。
# remote_script <script-file> [VAR=value ...]：远端要跑的整段脚本（set -e、export 的变量、seal 函数、脚本本身），ssm_run 和 ssh_run 共用
remote_script() {
  local file="$1"; shift
  printf 'set -e\n'
  for kv in "$@"; do printf 'export %s=%q\n' "${kv%%=*}" "${kv#*=}"; done
  # seal：把 stdin 的机密用本次运行的一次性公钥加密成一行 base64（host_read_secret / ssm_read_secret 使用）
  printf '%s\n' 'seal() { local k; k="$(mktemp)"; printf "%s" "$SEAL_PUB_B64" | base64 -d > "$k"; openssl pkeyutl -encrypt -pubin -inkey "$k" -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 -pkeyopt rsa_mgf1_md:sha256 | base64 | tr -d "\n"; rm -f "$k"; echo; }'
  cat "$file"
}
ssm_run() {
  local inst="$1" file="$2" to="${3:-300}"; shift 3 || shift $#
  local payload id st out err
  payload="$(remote_script "$file" "$@" | gzip -9 | base64 | tr -d '\n')"
  id="$(aws_cli ssm send-command --instance-ids "$inst" --document-name AWS-RunShellScript --timeout-seconds 120 \
        --comment "${DEPLOY_NAME}: $(basename "$file")" \
        --parameters "$(python3 -I -c 'import json,sys;print(json.dumps({"commands":["f=$(mktemp /tmp/prk-op.XXXXXX); echo %s | base64 -d | gunzip > \"$f\" && bash \"$f\"; rc=$?; rm -f \"$f\"; exit $rc" % sys.argv[1]],"executionTimeout":[sys.argv[2]]}))' "$payload" "$to")" \
        --query Command.CommandId --output text)" || return 1
  st=""
  for _ in $(seq 1 $(( to / 3 + 10 ))); do
    sleep 3
    st="$(aws_cli ssm get-command-invocation --command-id "$id" --instance-id "$inst" --query Status --output text 2>/dev/null || true)"
    case "$st" in Pending|InProgress|Delayed|"") continue ;; *) break ;; esac
  done
  case "$st" in
    Pending|InProgress|Delayed|"")
      aws_cli ssm cancel-command --command-id "$id" --instance-ids "$inst" >/dev/null 2>&1 || true
      warn "SSM 命令 $id 在 $inst 上本地等待超时，已取消（$(basename "$file")）"
      return 1 ;;
  esac
  out="$(aws_cli ssm get-command-invocation --command-id "$id" --instance-id "$inst" --query StandardOutputContent --output text 2>/dev/null || true)"
  err="$(aws_cli ssm get-command-invocation --command-id "$id" --instance-id "$inst" --query StandardErrorContent --output text 2>/dev/null || true)"
  [ -n "$out" ] && [ "$out" != "None" ] && printf '%s\n' "$out"
  if [ "$st" != "Success" ]; then
    [ -n "$err" ] && [ "$err" != "None" ] && printf '%s\n' "$err" | tail -20 >&2
    warn "SSM 命令 $id 在 $inst 上状态为 $st（$(basename "$file")）"
    return 1
  fi
  return 0
}

# ssm_read_secret <instance-id> <script-file> <out-file> [VAR=value ...]
#   远端脚本必须把机密经 `| seal` 输出（一行密文）。本地用一次性私钥解密后写进 <out-file>（调用方用 secret_file 建）。
#   SSM 命令历史里只有密文；私钥在 SECRETS_DIR 里，进程退出即删。
SEAL_PUB_B64=""
seal_keygen() {
  [ -n "$SEAL_PUB_B64" ] && return 0
  [ -n "$SECRETS_DIR" ] || secret_file .seal-dir >/dev/null
  SEAL_PUB_B64="$(py seal.py keygen "$SECRETS_DIR/seal.key")" || die "生成一次性密钥失败"
}
# seal_open <out-file>：stdin 是远端 seal 出来的那一行密文
seal_open() {
  local ct; ct="$(tail -1)"
  [ -n "$ct" ] || return 1
  printf '%s' "$ct" | py seal.py open "$SECRETS_DIR/seal.key" > "$1" || return 1
  [ -s "$1" ]
}
ssm_read_secret() {
  local inst="$1" script="$2" outf="$3" out; shift 3
  seal_keygen
  out="$(ssm_run "$inst" "$script" 60 "SEAL_PUB_B64=$SEAL_PUB_B64" "$@")" || return 1
  printf '%s\n' "$out" | seal_open "$outf"
}

# ssm_wait_online <instance-id> [timeout-sec]
ssm_wait_online() {
  local inst="$1" to="${2:-600}" st
  for _ in $(seq 1 $(( to / 10 ))); do
    st="$(aws_cli ssm describe-instance-information --filters "Key=InstanceIds,Values=$inst" \
          --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null || true)"
    [ "$st" = "Online" ] && return 0
    sleep 10
  done
  return 1
}

# ---------- PG 主机：经 SSM（缺省）或 SSH ----------
# PG_HOST_TRANSPORT=ssm：PG 主机经 SSM Run Command 和 SSM 端口转发（实例要 SSM 在线）。
# PG_HOST_TRANSPORT=ssh：经 SSH（existing 模式）：PG_SSH_HOST、PG_SSH_KEY（本机私钥）、PG_SSH_USER（缺省 ec2-user，要能免密 sudo）、PG_SSH_PORT。
#   本机连不到主机地址时给 PG_SSH_PROXY_COMMAND（ssh 的 ProxyCommand，比如跳板机，或 aws ec2-instance-connect open-tunnel --instance-id …）。
#   主机公钥：给了 PG_SSH_KNOWN_HOSTS（核对过的 known_hosts 文件）就严格核对；没给就首次信任，记进 .state/<DEPLOY_NAME>.known_hosts，之后照它核对。
# 远端脚本先写进远端的 mktemp 文件再 sudo bash 它（stdin 不留给脚本），超时由远端的 timeout 管；输出约定和 ssm_run 一样。
ssh_opts() {
  local known="$PG_SSH_KNOWN_HOSTS" checking=yes
  if [ -z "$known" ]; then
    known="$PKG_DIR/.state/${DEPLOY_NAME}.known_hosts"; checking=accept-new
    mkdir -p "$PKG_DIR/.state"; chmod 700 "$PKG_DIR/.state"
  fi
  printf '%s\n' -i "$PG_SSH_KEY" -p "$PG_SSH_PORT" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=20 \
    -o ServerAliveInterval=15 -o ServerAliveCountMax=8 -o "StrictHostKeyChecking=$checking" -o "UserKnownHostsFile=$known" \
    -o GlobalKnownHostsFile=/dev/null -o LogLevel=ERROR
  [ -z "${PG_SSH_PROXY_COMMAND:-}" ] || printf '%s\n' -o "ProxyCommand=$PG_SSH_PROXY_COMMAND"
}
# ssh_run <script-file> [timeout-sec] [VAR=value ...]：在 PG 主机上以 root 执行本地脚本（同 ssm_run，只是不用实例 ID）
ssh_run() {
  local file="$1" to="${2:-300}" rc=0 opts=(); shift 2 || shift $#
  while IFS= read -r o; do opts+=("$o"); done < <(ssh_opts)
  remote_script "$file" "$@" | ssh "${opts[@]}" "$PG_SSH_USER@$PG_SSH_HOST" \
    "f=\$(mktemp /tmp/prk-op.XXXXXX) && cat > \"\$f\" && sudo -n timeout $to bash \"\$f\" </dev/null; rc=\$?; rm -f \"\$f\"; exit \$rc" || rc=$?
  case "$rc" in
    0) return 0 ;;
    124) warn "SSH 命令在 $PG_SSH_HOST 上超时（${to} 秒，$(basename "$file")）" ;;
    255) warn "SSH 连不上 $PG_SSH_USER@$PG_SSH_HOST:${PG_SSH_PORT}（$(basename "$file")）：地址、安全组、私钥、主机公钥" ;;
    *) warn "SSH 命令在 $PG_SSH_HOST 上退出码 ${rc}（$(basename "$file")）" ;;
  esac
  return 1
}
# host_run <script-file> [timeout-sec] [VAR=value ...]：在 PG 主机（TGT_ID）上以 root 执行，按 PG_HOST_TRANSPORT 走 SSM 或 SSH
host_run() {
  local file="$1" to="${2:-300}"; shift 2 || shift $#
  if [ "$PG_HOST_TRANSPORT" = ssh ]; then ssh_run "$file" "$to" "$@"; else ssm_run "$TGT_ID" "$file" "$to" "$@"; fi
}
# host_read_secret <script-file> <out-file> [VAR=value ...]：同 ssm_read_secret，对 PG 主机；远端只输出密文
host_read_secret() {
  local script="$1" outf="$2" out; shift 2
  seal_keygen
  out="$(host_run "$script" 60 "SEAL_PUB_B64=$SEAL_PUB_B64" "$@")" || return 1
  printf '%s\n' "$out" | seal_open "$outf"
}
# host_reachable：preflight 用，PG 主机能不能执行命令（SSM：Online + Linux；SSH：能登录、能免密 sudo）。输出一行说明，失败返回 1
host_reachable() {
  if [ "$PG_HOST_TRANSPORT" = ssh ]; then
    local f="$PKG_DIR/.build/host-ping.sh" out
    mkdir -p "$PKG_DIR/.build"; printf 'echo "ssh-ok $(uname -m)"\n' > "$f"
    out="$(ssh_run "$f" 30 | tail -1)" || { echo "SSH 不通（$PG_SSH_USER@$PG_SSH_HOST:${PG_SSH_PORT}）"; return 1; }
    case "$out" in ssh-ok*) echo "SSH 可登录、可 sudo（${out#ssh-ok }）"; return 0 ;; *) echo "SSH 输出不对：$out"; return 1 ;; esac
  fi
  local ping; ping="$(aws_cli ssm describe-instance-information --filters "Key=InstanceIds,Values=$TGT_ID" --query 'InstanceInformationList[0].[PingStatus,PlatformType]' --output text)"
  case "$ping" in Online*Linux*) echo "SSM Online"; return 0 ;; *) echo "SSM 状态不对：$ping（需要 Online + Linux）"; return 1 ;; esac
}

# ---------- 端口转发（SSM 或 SSH）----------
# pf_start <local-port> <instance-id> <remote-host> <remote-port>：后台建立转发。SSM：等到 "Waiting for connections"；
#   SSH（PG_HOST_TRANSPORT=ssh，不用实例 ID）：ssh -N -L，等到本机端口能连上。
PF_PID=""
pf_start() {
  local lport="$1" inst="$2" rhost="$3" rport="$4" logf
  if (exec 3<>"/dev/tcp/127.0.0.1/$lport") 2>/dev/null; then
    die "本机端口 $lport 已被占用（可能是上次残留的端口转发）；换一个 INGEST_LOCAL_PORT 或结束占用进程"
  fi
  logf="$PKG_DIR/.build/port-forward.log"; mkdir -p "$PKG_DIR/.build"
  if [ "$PG_HOST_TRANSPORT" = ssh ]; then
    local opts=(); while IFS= read -r o; do opts+=("$o"); done < <(ssh_opts)
    ssh "${opts[@]}" -N -o ExitOnForwardFailure=yes -L "127.0.0.1:$lport:$rhost:$rport" "$PG_SSH_USER@$PG_SSH_HOST" > "$logf" 2>&1 &
    PF_PID=$!
    for _ in $(seq 1 30); do
      (exec 3<>"/dev/tcp/127.0.0.1/$lport") 2>/dev/null && return 0
      kill -0 "$PF_PID" 2>/dev/null || break
      sleep 1
    done
    cat "$logf" >&2
    pf_stop
    die "SSH 端口转发没有建立（127.0.0.1:$lport → $rhost:$rport 经 ${PG_SSH_HOST}）"
  fi
  # 直接后台运行 aws（不能用 aws_cli 函数：那样 $! 是子 shell 的 PID，结束它会让 aws 与 session-manager-plugin 成为孤儿进程）
  aws --region "$AWS_REGION" ssm start-session --target "$inst" --document-name AWS-StartPortForwardingSessionToRemoteHost \
    --parameters "{\"host\":[\"$rhost\"],\"portNumber\":[\"$rport\"],\"localPortNumber\":[\"$lport\"]}" > "$logf" 2>&1 &
  PF_PID=$!
  for _ in $(seq 1 30); do
    grep -q "Waiting for connections" "$logf" 2>/dev/null && return 0
    kill -0 "$PF_PID" 2>/dev/null || break
    sleep 1
  done
  cat "$logf" >&2
  pf_stop
  die "SSM 端口转发没有建立（检查 session-manager-plugin 是否安装、实例 SSM 是否在线）"
}
pf_stop() {
  if [ -n "$PF_PID" ]; then
    # session-manager-plugin 是 aws 的子进程：先结束子进程，再结束 aws
    pkill -P "$PF_PID" 2>/dev/null || true
    kill "$PF_PID" 2>/dev/null || true
    wait "$PF_PID" 2>/dev/null || true
    PF_PID=""
  fi
}

# ---------- Python ----------
# py <script.py> [args...]：在 uv 的临时环境里以 -I（隔离模式）运行 lib/ 下的脚本。
py() {
  local script="$1"; shift
  uv run --quiet --no-project --python 3.12 \
    --with 'boto3>=1.34' --with 'psycopg[binary]>=3.1' --with 'pyyaml>=6' --with 'cryptography>=42' \
    python -I "$PKG_DIR/lib/$script" "$@"
}

# ---------- 向量模型（防混用）----------
# 库里的向量只能出自一个模型：kb_embed / kb_search 换成另一个模型，而表里还是旧模型的向量，检索就是拿两种向量比距离。
# db 阶段先读库里登记的模型（host/pgvector-status.sh 的 embed_model），再由 embed_guard 决定做什么。
TITAN_FAMILY="amazon.titan-embed-text-v2:0"

# model_family <模型 id>：kb_meta.embed_model 记的模型族——去掉推理配置文件的区域前缀（us. / global. / eu. / apac.）
model_family() {
  case "$1" in us.*|global.*|eu.*|apac.*) printf '%s' "${1#*.}" ;; *) printf '%s' "$1" ;; esac
}

# embed_guard <登记的> <配置的模型族> <migrate:true|false> <restore:true|false>：只判断，不改任何东西。输出一行：
#   apply           照配置（重新）应用 sql/kb_search.sql：库里还没有向量，或登记的就是配置的模型
#   migrate         --migrate-embeddings：库里是 Titan，备份旧向量后用配置的模型整库重算（sql/migrate_embeddings.sql）
#   restore         --restore-embeddings：换模型后回退到 Titan，拷回备份的旧向量（sql/restore_embeddings.sql）
#   refuse:<原因>   其余情况：停下，不重新应用 kb_search.sql
# 登记的：模型族；titan-inferred（没有 kb_meta、表里已有向量：Titan 时代建的库）；none（还没有向量）。读不到（error、空）就停。
# 备份表叫 <表>_titan_backup：迁移只从 Titan 迁出，回退只回到 Titan。
embed_guard() {
  local reg="$1" cfg m="$3" r="$4" shown
  cfg="$(model_family "$2")"
  case "$m$r" in
    truetrue) echo "refuse:--migrate-embeddings 和 --restore-embeddings 不能同时给"; return 0 ;;
    truefalse|falsetrue|falsefalse) ;;
    *) echo "refuse:embed_guard 的 migrate / restore 只能是 true 或 false（给的是 $m / ${r}）"; return 0 ;;
  esac
  shown="$reg"
  case "$reg" in
    none) ;;
    titan-inferred) reg="$TITAN_FAMILY"; shown="${TITAN_FAMILY}（没有 kb_meta、表里已有向量，按 Titan 算）" ;;
    ""|error|*[!A-Za-z0-9._:-]*)
      echo "refuse:读不到库里登记的向量模型（${reg:-空}），不动 kb_search：先看 verify 的 [db] 行，容器和库都正常后重跑"; return 0 ;;
    *) reg="$(model_family "$reg")"; shown="$reg" ;;
  esac
  if [ "$reg" = none ]; then
    if [ "$m" = true ]; then echo "refuse:库里还没有向量，不用迁移：去掉 --migrate-embeddings 再跑 db"
    elif [ "$r" = true ]; then echo "refuse:库里还没有向量，没有可回退的：去掉 --restore-embeddings 再跑 db"
    else echo apply; fi
    return 0
  fi
  if [ "$reg" = "$cfg" ]; then
    if [ "$m" = true ]; then echo "refuse:库里已经是 ${cfg}，不用迁移：去掉 --migrate-embeddings"
    elif [ "$r" = true ]; then echo "refuse:库里已经是 ${cfg}，没有可回退的：去掉 --restore-embeddings"
    else echo apply; fi
    return 0
  fi
  if [ "$m" = true ]; then
    if [ "$reg" = "$TITAN_FAMILY" ]; then echo migrate
    else echo "refuse:迁移只从 Titan 迁出（备份表 <表>_titan_backup），库里是 ${shown}；要回到 Titan 用 --restore-embeddings"; fi
  elif [ "$r" = true ]; then
    if [ "$cfg" = "$TITAN_FAMILY" ]; then echo restore
    else echo "refuse:回退只回到 Titan（备份表里是 Titan 的向量），配置的是 ${cfg}：先把 EMBED_MODEL_ID 改回 $TITAN_FAMILY"; fi
  else
    echo "refuse:库里登记的向量模型是 ${shown}，配置的是 ${cfg}：不重新应用 kb_search.sql，免得新旧向量混用。换模型加 --migrate-embeddings，回退加 --restore-embeddings（GUIDE.md 7.6）"
  fi
  return 0
}

# ---------- 退出清理 ----------
cleanup() {
  pf_stop
  [ -n "$SECRETS_DIR" ] && rm -rf "$SECRETS_DIR"
  return 0
}
