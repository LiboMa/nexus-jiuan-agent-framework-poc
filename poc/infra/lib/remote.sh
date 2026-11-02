# 经 SSH 管理测试台实例：deploy.sh、kb.sh、migrate-data.sh 和端到端测试的 run.sh 共用（source 本文件）。
# 环境配置（DEPLOY_ENV）写了 SSH_KEY_FILE 就经 SSH（REMOTE=ssh），否则照原来经 SSM（REMOTE=ssm），本文件的函数都用不到。
#   remote_mode                     输出 ssh 或 ssm
#   ssh_check_key                   动 AWS 之前核对：SSH_KEY_NAME 也写了、私钥文件在、权限只有自己能读、本机有 ssh
#   ssh_setup <主机> <实例> [等几分钟，缺省 SSH_HOSTKEY_WAIT_MINUTES 或 8]  准备 SSH_OPTS、SSH_TARGET：主机公钥第一次从实例的控制台输出里取（cloud-init 启动时打印的），
#                                   钉进 poc/infra/.state/<栈>-<实例>.known_hosts，之后严格核对（StrictHostKeyChecking=yes）。
#                                   控制台输出里一直没有（等到时限）就停；确认要首次信任再连时，运行时给 SSH_TRUST_FIRST_USE=1
#   ssh_wait [次数]                 等到能登录（每 10 秒一次，缺省 60 次）
#   remote_root <脚本>              以 root 跑一段脚本：先写进远端的 mktemp 文件再 sudo bash 它（stdin 不留给脚本，免得脚本里的命令吃掉后面的行），
#                                   远端的标准输出、标准错误原样回来，返回远端的退出码
#   ssm_root <实例> <脚本> [超时秒] [区域]  经 SSM（AWS-RunShellScript）以 root 跑一段脚本：同样先写进远端的临时文件；回标准输出，
#                                   没成功就把标准错误的最后几行打到本机的标准错误、返回 1
#   ssm_wait_online <实例>          等实例的 SSM Agent 上线（最多 10 分钟）
#   run_root <实例> <脚本> [超时秒]  按 remote_mode 选：经 SSH（remote_root，先要 ssh_setup）或经 SSM（ssm_root）
# SSH_VIA=eice：不直连弹性 IP，经栈里的 EC2 Instance Connect 端点（ProxyCommand 是 aws ec2-instance-connect open-tunnel，走 AWS API 的 HTTPS），
#   本机网络连不到实例的地址段时用；SSH_PROXY_COMMAND 是给 kb（PG_SSH_PROXY_COMMAND）和别的脚本用的同一条命令。
# 登录用户是 ec2-user（Amazon Linux 2023）。不打印私钥，不把它拷到别处。
REMOTE_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REMOTE_STATE_DIR="${REMOTE_STATE_DIR:-$(cd "$REMOTE_LIB_DIR/.." && pwd)/.state}"
SSH_USER="${SSH_USER:-ec2-user}"
SSH_OPTS=()
SSH_TARGET=""
SSH_KNOWN_HOSTS=""
SSH_PROXY_COMMAND=""

remote_mode() { [[ -n "${SSH_KEY_FILE:-}" ]] && echo ssh || echo ssm; }

ssh_check_key() {
  command -v ssh >/dev/null || { echo "缺少 ssh" >&2; return 1; }
  [[ -n "${SSH_KEY_NAME:-}" ]] || { echo "写了 SSH_KEY_FILE 就要写 SSH_KEY_NAME（实例上的 EC2 密钥对）" >&2; return 1; }
  [[ "$SSH_KEY_FILE" == /* ]] || { echo "SSH_KEY_FILE 要写绝对路径（不展开 ~）：$SSH_KEY_FILE" >&2; return 1; }
  [[ -f "$SSH_KEY_FILE" ]] || { echo "找不到私钥 $SSH_KEY_FILE" >&2; return 1; }
  local mode
  mode="$(stat -f '%Lp' "$SSH_KEY_FILE" 2>/dev/null || stat -c '%a' "$SSH_KEY_FILE")"
  [[ "$mode" == 600 || "$mode" == 400 ]] || { echo "私钥 $SSH_KEY_FILE 的权限是 ${mode}，ssh 不会用它：chmod 600 $SSH_KEY_FILE" >&2; return 1; }
  case "${SSH_VIA:-direct}" in direct|eice) ;; *) echo "SSH_VIA 只能是 direct 或 eice：$SSH_VIA" >&2; return 1 ;; esac
}

# 控制台输出里 cloud-init 打印的主机公钥（-----BEGIN SSH HOST KEY KEYS----- 到 END 之间，一行一个「类型 公钥」）
console_host_keys() {
  local text
  text="$(aws ec2 get-console-output --region "${REGION:-${AWS_REGION:-us-east-1}}" --instance-id "$1" --latest --query Output --output text 2>/dev/null || true)"
  [[ "$text" == *"BEGIN SSH HOST KEY KEYS"* ]] || text="$(printf '%s' "$text" | base64 -d 2>/dev/null || true)"
  printf '%s\n' "$text" | tr -d '\r' | sed -n '/-----BEGIN SSH HOST KEY KEYS-----/,/-----END SSH HOST KEY KEYS-----/p' \
    | grep -E '^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) [A-Za-z0-9+/=]+' | awk '{print $1, $2}'
}

ssh_setup() {
  local host="$1" instance="$2" minutes="${3:-${SSH_HOSTKEY_WAIT_MINUTES:-8}}" keys="" i
  [[ -n "$host" && "$host" != None ]] || { echo "没有实例的公网地址（栈输出 ElasticIp）" >&2; return 1; }
  mkdir -p "$REMOTE_STATE_DIR"; chmod 700 "$REMOTE_STATE_DIR"
  SSH_KNOWN_HOSTS="$REMOTE_STATE_DIR/${STACK:-stack}-${instance}.known_hosts"
  local checking=yes
  if [[ ! -s "$SSH_KNOWN_HOSTS" ]]; then
    i=0
    while :; do
      keys="$(console_host_keys "$instance")"
      [[ -n "$keys" ]] && break
      (( i >= minutes * 6 )) && break
      (( i == 0 )) && echo "等实例 $instance 的控制台输出里出现主机公钥（最多 ${minutes} 分钟）" >&2
      sleep 10; i=$((i + 1))
    done
    if [[ -n "$keys" ]]; then
      (umask 077; printf '%s\n' "$keys" | awk -v h="$host" '{print h, $1, $2}' > "$SSH_KNOWN_HOSTS")
      echo "已从控制台输出钉住 $host 的主机公钥（$(wc -l < "$SSH_KNOWN_HOSTS" | tr -d ' ') 个）：$SSH_KNOWN_HOSTS" >&2
    elif [[ "${SSH_TRUST_FIRST_USE:-}" == 1 ]]; then
      echo "控制台输出里没有主机公钥；按 SSH_TRUST_FIRST_USE=1 首次信任 $host" >&2
      checking=accept-new
    else
      echo "实例 $instance 的控制台输出里 ${minutes} 分钟内没有主机公钥，没法核对 $host 是不是这台实例。" >&2
      echo "确认要首次信任再连：运行时加 SSH_TRUST_FIRST_USE=1" >&2
      return 1
    fi
  fi
  SSH_OPTS=(-i "$SSH_KEY_FILE" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=8
    -o StrictHostKeyChecking="$checking" -o UserKnownHostsFile="$SSH_KNOWN_HOSTS" -o GlobalKnownHostsFile=/dev/null -o LogLevel=ERROR)
  SSH_PROXY_COMMAND=""
  if [[ "${SSH_VIA:-direct}" == eice ]]; then
    # 主机公钥照样按弹性 IP 这个名字核对（钉住的就是它）；连接本身经端点到实例的私网地址
    SSH_PROXY_COMMAND="aws ec2-instance-connect open-tunnel --region ${REGION:-${AWS_REGION:-us-east-1}} --instance-id $instance"
    SSH_OPTS+=(-o "ProxyCommand=$SSH_PROXY_COMMAND")
  fi
  SSH_TARGET="$SSH_USER@$host"
}

ssh_wait() {
  local tries="${1:-60}" i
  for ((i = 0; i < tries; i++)); do
    ssh "${SSH_OPTS[@]}" "$SSH_TARGET" true </dev/null 2>/dev/null && return 0
    sleep 10
  done
  echo "经 SSH 登录不了 ${SSH_TARGET}（安全组是否放行了本机地址 SSH_ALLOWED_CIDR、密钥对是否对得上）" >&2
  return 1
}

remote_root() {
  ssh "${SSH_OPTS[@]}" "$SSH_TARGET" 'f=$(mktemp /tmp/andon-op.XXXXXX) && cat > "$f" && sudo -n bash "$f" </dev/null; rc=$?; rm -f "$f"; exit $rc' <<< "$1"
}

ssm_root() {
  local instance="$1" script="$2" timeout="${3:-600}" region="${4:-${REGION:-${AWS_REGION:-us-east-1}}}" payload id status=""
  payload="$(printf '%s' "$script" | gzip -9 | base64 | tr -d '\n')"
  id="$(aws ssm send-command --region "$region" --instance-ids "$instance" --document-name AWS-RunShellScript --timeout-seconds 120 \
    --comment "${STACK:-andon-finance}: root script" \
    --parameters "$(python3 -I -c 'import json,sys; print(json.dumps({"commands": ["f=$(mktemp /tmp/andon-op.XXXXXX); echo %s | base64 -d | gunzip > \"$f\" && bash \"$f\"; rc=$?; rm -f \"$f\"; exit $rc" % sys.argv[1]], "executionTimeout": [sys.argv[2]]}))' "$payload" "$timeout")" \
    --query Command.CommandId --output text)" || return 1
  for _ in $(seq 1 $(( timeout / 5 + 12 ))); do
    sleep 5
    status="$(aws ssm get-command-invocation --region "$region" --command-id "$id" --instance-id "$instance" --query Status --output text 2>/dev/null || true)"
    case "$status" in Pending|InProgress|Delayed|"") continue ;; *) break ;; esac
  done
  aws ssm get-command-invocation --region "$region" --command-id "$id" --instance-id "$instance" --query StandardOutputContent --output text 2>/dev/null || true
  if [[ "$status" != Success ]]; then
    aws ssm get-command-invocation --region "$region" --command-id "$id" --instance-id "$instance" --query StandardErrorContent --output text 2>/dev/null | tail -20 >&2 || true
    echo "实例 $instance 上经 SSM 的命令没有成功（${status:-没有结果}）" >&2
    return 1
  fi
}

ssm_wait_online() {
  local status="" region="${REGION:-${AWS_REGION:-us-east-1}}"
  for _ in $(seq 1 60); do
    status="$(aws ssm describe-instance-information --region "$region" --filters "Key=InstanceIds,Values=$1" \
      --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null || true)"
    [[ "$status" == Online ]] && return 0
    sleep 10
  done
  echo "实例 $1 的 SSM Agent 没有上线" >&2
  return 1
}

run_root() {
  if [[ "$(remote_mode)" == ssh ]]; then remote_root "$2"; else ssm_root "$1" "$2" "${3:-600}"; fi
}

