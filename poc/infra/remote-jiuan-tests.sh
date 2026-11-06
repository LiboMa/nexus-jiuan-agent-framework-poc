#!/usr/bin/env bash
# 在测试台实例上跑九安 v0.7.10 自带的测试（换库用；不碰正在跑的服务，不碰库 jiuan）：
#   本机 build-jiuan.sh --with-tests → 打包经 SSH 传到实例上的临时目录（只有登录用户能读）→ 实例上以 root：test-databases.sh create
#   （单独两个用完即删的测试库容器：MySQL 127.0.0.1:3307、PG 127.0.0.1:5434，每次都是空库；跑完 drop），
#   用 /etc/andon-finance/test/ 下的口令拼测试库地址（不经本机），node --test 一个一个文件跑，junit 报告（每条测试带文件名）→ 取回，
#   本机转成 { "tests/x.test.mjs": { "<测试名>": "pass"|"fail"|"skip" } } 写到 --out → 删掉远端目录。
#   退出码 0 只表示跑完了；及格与否用 compare-jiuan-results.mjs 和基线比。
# 用法：DEPLOY_ENV=poc/infra/env/<环境>.env bash poc/infra/remote-jiuan-tests.sh --engine mysql|pg|both [--only '<glob>'] [--patches <目录>] [--junit <报告.xml>] --out <结果.json>
#   --junit：另存一份原始 junit 报告（失败的报错原文在里面，查原因用）。
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
ENGINE="" ONLY='tests/*.test.mjs' PATCHES="" OUT="" JUNIT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --engine) ENGINE="$2"; shift 2 ;;
    --only) ONLY="$2"; shift 2 ;;
    --patches) PATCHES="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --junit) JUNIT="$2"; shift 2 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done
[[ "$ENGINE" == mysql || "$ENGINE" == pg || "$ENGINE" == both ]] || { echo "--engine 只能是 mysql、pg 或 both" >&2; exit 2; }
[[ -n "$OUT" ]] || { echo "要给 --out <结果.json>" >&2; exit 2; }
[[ "$ONLY" =~ ^[A-Za-z0-9_./*{},-]+$ ]] || { echo "--only 只能是 tests/ 下的文件名或通配" >&2; exit 2; }
source "$HERE/lib/deploy-env.sh"
load_deploy_env
source "$HERE/lib/remote.sh"
REGION="${AWS_REGION:-us-east-1}"
STACK="${STACK:-andon-finance-poc}"
output() { aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
[[ "$(remote_mode)" == ssh ]] || { echo "远端测试要经 SSH（环境配置写 SSH_KEY_FILE）" >&2; exit 2; }
ssh_check_key || exit 2
INSTANCE="$(output InstanceId)"
ssh_setup "$(output ElasticIp)" "$INSTANCE" || exit 1

local_work="$(mktemp -d)"; trap 'rm -rf "$local_work"' EXIT
build_args=(--with-tests --out "$local_work/jiuan")
[[ -z "$PATCHES" ]] || build_args+=(--patches "$PATCHES")
bash "$HERE/../bench/build-jiuan.sh" "${build_args[@]}" >/dev/null
cp "$HERE/bench/test-databases.sh" "$local_work/jiuan/test-databases.sh"
# 上传：打包经 SSH 传到实例上新建的临时目录（chmod 0700），回传目录名
remote_dir="$(COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs -C "$local_work/jiuan" -czf - . \
  | ssh "${SSH_OPTS[@]}" "$SSH_TARGET" 'd=$(mktemp -d /var/tmp/jiuan-pgtest.XXXXXX) && chmod 0700 "$d" && tar -C "$d" -xzf - && echo "$d"')"
[[ "$remote_dir" =~ ^/var/tmp/jiuan-pgtest\.[A-Za-z0-9]+$ ]] || { echo "远端临时目录不对：$remote_dir" >&2; exit 1; }

SCRIPT="$(cat <<SH
set -uo pipefail
d='$remote_dir'; trap 'rm -rf "\$d"' EXIT
# 同一时间只跑一组：测试库容器是共用的，另一组在跑就等它跑完（最多两小时）
exec 9>/var/lock/jiuan-remote-tests.lock
flock -w 7200 9 || { echo "另一组远端测试一直没跑完" >&2; exit 1; }
trap 'bash "\$d/test-databases.sh" drop >/dev/null 2>&1; rm -rf "\$d"' EXIT
bash "\$d/test-databases.sh" create >/dev/null || { echo "测试库没建好" >&2; exit 1; }
url_pg="postgres://jiuan_test:\$(cat /etc/andon-finance/test/pg_test_password)@127.0.0.1:5434/jiuan_test"
url_mysql="mysql://jiuan_test:\$(cat /etc/andon-finance/test/mysql_test_password)@127.0.0.1:3307/jiuan_test"
case '$ENGINE' in
  mysql) export MYSQL_TEST_URL="\$url_mysql" ;;
  pg) export PG_TEST_URL="\$url_pg" ;;
  both) export MYSQL_TEST_URL="\$url_mysql" PG_TEST_URL="\$url_pg" ;;
esac
cd "\$d"
shopt -s nullglob
files=( $ONLY )
(( \${#files[@]} > 0 )) || { echo "没有匹配的测试文件：$ONLY" >&2; exit 1; }
# 一个文件的测试跑完就退出（哪怕还有连接没关）；整轮最多 55 分钟（经 EC2 Instance Connect 的 SSH 一小时就断）
timeout 3300 node --test --test-force-exit --test-concurrency=1 --test-timeout=180000 --test-reporter=junit --test-reporter-destination="\$d/junit.xml" "\${files[@]}" >/dev/null 2>"\$d/stderr.txt"
echo "===JUNIT==="
cat "\$d/junit.xml"
SH
)"
raw="$(remote_root "$SCRIPT")" || { echo "远端测试没跑完（见上面的输出）" >&2; exit 1; }
[[ "$raw" == *"===JUNIT==="* ]] || { echo "没取回测试报告" >&2; exit 1; }
printf '%s' "${raw#*===JUNIT===}" > "$local_work/junit.xml"
[[ -z "$JUNIT" ]] || { mkdir -p "$(dirname "$JUNIT")"; cp "$local_work/junit.xml" "$JUNIT"; }
mkdir -p "$(dirname "$OUT")"
node "$HERE/test/compare-jiuan-results.mjs" --from-junit "$local_work/junit.xml" --root "$remote_dir" > "$OUT"
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")), n = { pass: 0, fail: 0, skip: 0 };
for (const tests of Object.values(r)) for (const s of Object.values(tests)) n[s] += 1;
console.log(`JIUAN_TESTS_DONE files=${Object.keys(r).length} pass=${n.pass} fail=${n.fail} skip=${n.skip}`);' "$OUT"
