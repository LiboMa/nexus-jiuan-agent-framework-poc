#!/usr/bin/env bash
#
# PG 主机经 SSH（PG_HOST_TRANSPORT=ssh）：host_run / host_read_secret / ssh_opts / load_config 的检查。
#
#   bash kb/tests/test_host_transport.sh       # 不连 AWS、不连任何主机；macOS 自带的 /bin/bash（3.2）也要能跑
#
# PATH 最前面放假的 ssh（记下参数和收到的脚本，再把远端命令交给本机的 bash，模拟远端）、sudo（去掉 -n 直接跑）、
# timeout（去掉时长直接跑）、aws（被调到就记下来并失败：SSH 方式不该碰 SSM）。py 换成本机 openssl 做的一次性密钥。
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KB="$(cd "$HERE/.." && pwd)"
# shellcheck source=../lib/common.sh
. "$KB/lib/common.sh"

n=0; fails=0
fail() { fails=$((fails + 1)); printf 'FAIL %s\n' "$*"; }
check() { n=$((n + 1)); if [ "$2" = "$3" ]; then :; else fail "$1：得到 '$2'，期望 '$3'"; fi; }
contains() { n=$((n + 1)); case "$2" in *"$3"*) ;; *) fail "$1：'$2' 里没有 '$3'" ;; esac; }

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/pkg"
cat > "$WORK/bin/ssh" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$FAKE_LOG/ssh.args"
cmd="${@: -1}"
case "$cmd" in *@*) echo "fake ssh: 远端命令缺失" >&2; exit 255 ;; esac
exec bash -c "$cmd"
FAKE
cat > "$WORK/bin/sudo" <<'FAKE'
#!/usr/bin/env bash
[ "$1" = -n ] && shift
echo root > "$FAKE_LOG/sudo.used"
exec "$@"
FAKE
cat > "$WORK/bin/timeout" <<'FAKE'
#!/usr/bin/env bash
shift; exec "$@"
FAKE
cat > "$WORK/bin/aws" <<'FAKE'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG/aws.called"; exit 1
FAKE
chmod +x "$WORK/bin/"*
export PATH="$WORK/bin:$PATH" FAKE_LOG="$WORK"
PKG_DIR="$WORK/pkg"; DEPLOY_NAME=t; AWS_REGION=us-east-1
PG_HOST_TRANSPORT=ssh; PG_SSH_HOST=pg.example.internal; PG_SSH_USER=ec2-user; PG_SSH_PORT=22; PG_SSH_KNOWN_HOSTS=""
PG_SSH_KEY="$WORK/key"; : > "$PG_SSH_KEY"; chmod 600 "$PG_SSH_KEY"
TGT_ID=i-0123456789abcdef0

# ---- 1. 执行：变量原样带过去、输出回来、以 root（经 sudo）跑 ----
cat > "$WORK/s1.sh" <<'S'
echo "user=$(cat "$FAKE_LOG/sudo.used") v=$SPACED"
S
out="$(host_run "$WORK/s1.sh" 30 "SPACED=a b 'c' \$d")"
check "host_run 的输出" "$out" "user=root v=a b 'c' \$d"
contains "ssh 的目标" "$(cat "$WORK/ssh.args")" "ec2-user@pg.example.internal"
contains "远端用 timeout" "$(tail -1 "$WORK/ssh.args")" "sudo -n timeout 30 bash"
[ -f "$WORK/aws.called" ] && fail "SSH 方式调了 aws：$(cat "$WORK/aws.called")"

# ---- 2. 脚本里读 stdin 的命令吃不到后面的行 ----
cat > "$WORK/s2.sh" <<'S'
read -r line || true
echo "read=[$line]"
echo "still-here"
S
out="$(host_run "$WORK/s2.sh" 30)"
check "读 stdin 的脚本" "$out" "$(printf 'read=[]\nstill-here')"

# ---- 3. 远端失败 → 返回 1（set -e：失败那行之后不再跑）----
printf 'false\necho should-not-run\n' > "$WORK/s3.sh"
out="$(host_run "$WORK/s3.sh" 30 2>/dev/null)"; rc=$?
check "远端失败的返回码" "$rc" 1
check "set -e 生效" "$out" ""

# ---- 4. 主机公钥：没给 known_hosts 就首次信任并记进 .state；给了就严格核对 ----
args="$(ssh_opts | tr '\n' ' ')"
contains "首次信任" "$args" "StrictHostKeyChecking=accept-new"
contains "记进 .state" "$args" "UserKnownHostsFile=$PKG_DIR/.state/t.known_hosts"
contains "只用这把私钥" "$args" "-i $PG_SSH_KEY"
PG_SSH_KNOWN_HOSTS="$WORK/pinned"
args="$(ssh_opts | tr '\n' ' ')"
contains "严格核对" "$args" "StrictHostKeyChecking=yes"
contains "用给的 known_hosts" "$args" "UserKnownHostsFile=$WORK/pinned"
PG_SSH_KNOWN_HOSTS=""
contains "没给跳板就不带 ProxyCommand" "$(ssh_opts | grep -c ProxyCommand)" 0
PG_SSH_PROXY_COMMAND="aws ec2-instance-connect open-tunnel --region us-east-1 --instance-id i-0123456789abcdef0"
check "ProxyCommand 是一个参数" "$(ssh_opts | grep '^ProxyCommand=')" "ProxyCommand=$PG_SSH_PROXY_COMMAND"
PG_SSH_PROXY_COMMAND=""

# ---- 5. 读机密：远端只输出 seal 出来的密文，本机解开 ----
py() {
  case "$1 $2" in
    "seal.py keygen") openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$3" 2>/dev/null
                      openssl pkey -in "$3" -pubout 2>/dev/null | base64 | tr -d '\n' ;;
    "seal.py open")   base64 -d | openssl pkeyutl -decrypt -inkey "$3" -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 -pkeyopt rsa_mgf1_md:sha256 ;;
    *) return 1 ;;
  esac
}
printf 'echo some-log-line\nprintf %%s "pw-$WHO" | seal\n' > "$WORK/s5.sh"
outf="$(secret_file db_pw)"
host_read_secret "$WORK/s5.sh" "$outf" "WHO=nexus" >"$WORK/s5.out"; rc=$?
check "host_read_secret 的返回码" "$rc" 0
check "解出来的机密" "$(cat "$outf")" "pw-nexus"
contains "终端上只有密文" "$(tail -1 "$WORK/ssh.args")" "sudo -n timeout 60 bash"

# ---- 6. load_config 的检查（子 shell：die 会 exit）----
# 上面为了测试设的 PG_* 先清掉，只看配置文件里写的
cfg() { printf '%s\n' "$@" > "$WORK/deploy.env"; ( unset PG_HOST_TRANSPORT PG_SSH_HOST PG_SSH_KEY PG_SSH_USER PG_SSH_PORT; load_config "$WORK/deploy.env" ) 2>&1; }
contains "create 模式不能经 SSH" "$(cfg PG_HOST_MODE=create PG_HOST_TRANSPORT=ssh)" "只用于 existing 模式"
contains "要写主机" "$(cfg PG_HOST_TRANSPORT=ssh)" "要写 PG_SSH_HOST"
contains "私钥要绝对路径" "$(cfg PG_HOST_TRANSPORT=ssh PG_SSH_HOST=h PG_SSH_KEY=key)" "绝对路径"
contains "主机名不能带别的字符" "$(cfg PG_HOST_TRANSPORT=ssh "PG_SSH_HOST='h;reboot'" "PG_SSH_KEY=$PG_SSH_KEY")" "只能含字母"
contains "不认识的方式" "$(cfg PG_HOST_TRANSPORT=scp)" "只能是 ssm 或 ssh"
contains "ProxyCommand 只能一行" "$(cfg PG_HOST_TRANSPORT=ssh PG_SSH_HOST=h "PG_SSH_KEY=$PG_SSH_KEY" "PG_SSH_PROXY_COMMAND='a"$'\n'"b'")" "只能是一行"
check "缺省是 SSM" "$( ( unset PG_HOST_TRANSPORT; printf 'X=1\n' > "$WORK/deploy.env"; load_config "$WORK/deploy.env"; echo "$PG_HOST_TRANSPORT" ) 2>/dev/null )" ssm

[ "$fails" = 0 ] && { echo "OK：$n 项"; exit 0; }
echo "$fails / $n 项失败"; exit 1
