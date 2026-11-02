#!/usr/bin/env bash
#
# 用纯 API 把工具包导入 Nexus，同时声明数据库密钥 pg_kb：nexus/IMPORT.md 第 ② 节的全部步骤，一次做完。
# 管理员脚本 admin_run.sh 跑不了时用它。只要 bash、curl 7.55 以上、python3（只用标准库）。
#
# 用法（在交付 zip 解开后的根目录执行）：
#   bash nexus/import-api.sh --nexus https://<env>.<domain> --user <管理员用户名> --password-file <600 文件>
#        [--zip nexus/pg_kb_tools.zip --manifest nexus/MANIFEST.json] [--force-new]
#   bash nexus/import-api.sh --nexus https://<env>.<domain> --user <管理员用户名> --password-stdin
#
#   --nexus           Nexus 地址，不带结尾的 /（要 https；只有 localhost / 127.0.0.1 可以用 http）
#   --user            管理员用户名（导入只对管理员开放）
#   --password-file   管理员密码的 600 文件（只放密码一行）
#   --password-stdin  改从标准输入读密码（终端里输入时不回显）；与 --password-file 二选一
#   --zip、--manifest 要导入的工具包和与它配套的 MANIFEST.json。缺省是 nexus/ 下预打好的那一对；
#                     重打过的（RULES_TABLE 不是 approval_rules）用 repo/knowledgebase-writer-agent-pg/.build/ 下的那一对
#   --force-new       已经导入过也再导一份：本机已有 .state/import.json，或服务端已有 kb_pg_steward_* 目录时，
#                     不加它就停下。加了，服务端会多出一个目录；旧的 import.json 改名留着
#   -h、--help        打印本说明
#
# 做什么（顺序与 nexus/IMPORT.md 第 ② 节相同）：
#   0  本机核对：工具包与 MANIFEST.json 逐文件一致；这台机器没导入过（.state/import.json 不在）
#   1  登录 POST /api/v2/auth/login：令牌只写进临时目录里 600 的请求头文件，不打印、不进命令行
#   2  GET /api/v2/keys/schemas 要有 database_credentials；GET /api/v2/keys/tools-requiring-key（按 3 个工具名逐个搜，被截断就停）里不能已有 kb_pg_steward_* 目录
#   3  上传 POST /api/v2/tools/import/upload（multipart 字段 file）→ review_id
#   4  确认 POST /api/v2/tools/import/confirm：3 个工具的声明取自 repo/knowledgebase-writer-agent-pg/nexus-package.json
#   5  写 repo/knowledgebase-writer-agent-pg/.state/import.json（与 admin_run.sh import 同样的格式，以后 verify / bind / publish 认它）
#   6  核对：3 个工具 key_name=pg_kb key_type=database_credentials；服务端的文件与 MANIFEST.json 逐个一致
#
# 密码只从 600 文件或标准输入读进 python，经管道交给 curl；令牌只在请求头文件里。临时目录 700，退出时删掉（出错、Ctrl-C 也删）。
# 退出码：0 导入并核对通过；1 失败或核对不过（看输出）；2 用法不对；3 已经导入过（没加 --force-new，什么都没写）。
set -euo pipefail
umask 077

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "${HERE}/.." && pwd)"
PKG_DIR="${ROOT}/repo/knowledgebase-writer-agent-pg"
PKG_JSON="${PKG_DIR}/nexus-package.json"
STATE="${PKG_DIR}/.state/import.json"

NEXUS=""; ADMIN_USER=""; PW_FILE=""; PW_STDIN=false; FORCE=false
ZIP="${HERE}/pg_kb_tools.zip"; MANIFEST="${HERE}/MANIFEST.json"

usage() { awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }
bad_usage() { printf '✗ %s（bash nexus/import-api.sh --help）\n' "$*" >&2; exit 2; }
need_arg() { [ -n "${2:-}" ] || bad_usage "$1 后面要跟一个值"; }
step() { printf '\n== %s\n' "$*"; }
ok() { printf '  ✓ %s\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --nexus)          need_arg "$1" "${2:-}"; NEXUS="$2"; shift ;;
    --user)           need_arg "$1" "${2:-}"; ADMIN_USER="$2"; shift ;;
    --password-file)  need_arg "$1" "${2:-}"; PW_FILE="$2"; shift ;;
    --password-stdin) PW_STDIN=true ;;
    --zip)            need_arg "$1" "${2:-}"; ZIP="$2"; shift ;;
    --manifest)       need_arg "$1" "${2:-}"; MANIFEST="$2"; shift ;;
    --force-new)      FORCE=true ;;
    -h|--help)        usage; exit 0 ;;
    *)                bad_usage "不认识的参数 $1" ;;
  esac
  shift
done

# ───────────────────────── 参数与本机工具 ─────────────────────────
[ -n "${NEXUS}" ] && [ -n "${ADMIN_USER}" ] || bad_usage "要给 --nexus 和 --user"
if ${PW_STDIN}; then
  [ -z "${PW_FILE}" ] || bad_usage "--password-file 与 --password-stdin 只能用一个"
else
  [ -n "${PW_FILE}" ] || bad_usage "要给 --password-file <600 文件>（或 --password-stdin）"
fi
while [ "${NEXUS%/}" != "${NEXUS}" ]; do NEXUS="${NEXUS%/}"; done
printf '%s' "${NEXUS}" | grep -Eq '^(https://[A-Za-z0-9.-]+(:[0-9]+)?|http://(localhost|127\.0\.0\.1)(:[0-9]+)?)$' \
  || bad_usage "--nexus 要像 https://<env>.<domain>（只要协议和主机名，不带路径）：${NEXUS}"
case "${ZIP}" in *[\;,\"]*) bad_usage "--zip 的路径里不能有 ; , 或引号：${ZIP}" ;; esac
command -v python3 >/dev/null 2>&1 || die "需要 python3"
command -v curl >/dev/null 2>&1 || die "需要 curl（7.55 以上）"
curl_ver="$(curl --version | head -1 | awk '{print $2}')"
python3 -I -c 'import sys; v=[int(x) for x in (sys.argv[1].split("-")[0].split(".") + ["0", "0"])[:2]]; sys.exit(0 if v >= [7, 55] else 1)' "${curl_ver}" 2>/dev/null \
  || die "curl 是 ${curl_ver}，要 7.55 以上（-H @文件 从文件读请求头，令牌才不进命令行）"
[ -f "${ZIP}" ] || die "没有工具包：${ZIP}"
[ -f "${MANIFEST}" ] || die "没有 MANIFEST.json：${MANIFEST}"
[ -f "${PKG_JSON}" ] || die "没有包描述：${PKG_JSON}（要在交付 zip 解开后的目录里运行）"
if [ -n "${PW_FILE}" ]; then
  [ -f "${PW_FILE}" ] || die "密码文件不存在：${PW_FILE}"
  python3 -I -c 'import os,stat,sys; m=stat.S_IMODE(os.stat(sys.argv[1]).st_mode); sys.exit(1 if m & 0o077 else 0)' "${PW_FILE}" \
    || die "密码文件的权限要是 600（别人不能读）：chmod 600 ${PW_FILE}"
fi

T="$(mktemp -d "${TMPDIR:-/tmp}/pgkb-import.XXXXXX")"
chmod 700 "${T}"
cleanup() { rm -rf "${T}"; }
trap cleanup EXIT
trap 'exit 130' INT TERM

# 把错误回复缩成一句话：只取 detail / message / error，截到 300 字，形似令牌的串换成 ***
errmsg() {
  python3 -I - "$1" <<'PY'
import json, re, sys
try:
    raw = open(sys.argv[1], encoding="utf-8", errors="replace").read()
except OSError:
    raw = ""
try:
    d = json.loads(raw)
    msg = d.get("detail") or d.get("message") or d.get("error") or d if isinstance(d, dict) else d
    msg = json.dumps(msg, ensure_ascii=False) if not isinstance(msg, str) else msg
except ValueError:
    msg = raw.strip() or "（没有回复内容）"
msg = re.sub(r"(eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]+|nx[a-z]_[\w-]{8,}|Bearer\s+\S+)", "***", msg)
print(msg[:300])
PY
}

# api <路径> <回复文件> [curl 参数…]：带令牌调一次 /api/v2 接口（不带 -F / --data-binary 是 GET，带了是 POST）；不是 2xx 就停
api() {
  local path="$1" out="$2" code
  shift 2
  code="$(curl -sS -H @"${T}/auth.hdr" -H 'Accept: application/json' -o "${out}" -w '%{http_code}' "$@" "${NEXUS}/api/v2${path}")" \
    || die "请求没发出去：${path}（网络、地址或 TLS 的问题，看上面 curl 的提示）"
  case "${code}" in
    2??) ;;
    401) die "HTTP 401 ${path}：令牌被拒（登录失效）。重跑本脚本" ;;
    403) die "HTTP 403 ${path}：$(errmsg "${out}")（导入只对管理员开放：--user 要是管理员）" ;;
    *)   die "HTTP ${code} ${path}：$(errmsg "${out}")" ;;
  esac
}

# 要密钥的工具（GET /keys/tools-requiring-key）：平台一次最多回 200 行，截断时 pagination.truncated 为 true。
# 所以按本包的工具名逐个搜（search 匹配工具名），合成一个列表写到 $1；有一次被截断就停下，不拿不全的列表下结论
needs_key() {
  local out="$1" name
  : > "${T}/needs-key.list"
  for name in $(python3 -I -c 'import json,sys; pg=json.load(open(sys.argv[1], encoding="utf-8"))["modules"]["pg"]; print(" ".join(n for n, needs, _ in pg["tools"] if needs))' "${PKG_JSON}"); do
    api "/keys/tools-requiring-key?search=${name}&limit=200" "${T}/needs-key-${name}.json"
    printf '%s\n' "${T}/needs-key-${name}.json" >> "${T}/needs-key.list"
  done
  python3 -I - "${T}/needs-key.list" "${out}" <<'PY' || die "按工具名搜到的要密钥的工具超过 200 个，列表被截断：没法据此核对。先在网页「工具」里清理同名的旧目录"
import json, sys
rows, seen = [], set()
for path in open(sys.argv[1], encoding="utf-8").read().split():
    d = json.load(open(path, encoding="utf-8"))
    if isinstance(d, dict) and (d.get("pagination") or {}).get("truncated"):
        sys.exit(1)
    for r in (d.get("data", d) if isinstance(d, dict) else d) or []:
        k = (r.get("tool_id"), r.get("module_path"), r.get("tool_name"))
        if k not in seen:
            seen.add(k)
            rows.append(r)
json.dump(rows, open(sys.argv[2], "w", encoding="utf-8"), ensure_ascii=False)
PY
}

# ───────────────────────── 0 本机核对 ─────────────────────────
step "0 本机核对"
python3 -I - "${ZIP}" "${MANIFEST}" <<'PY' || die "工具包与 MANIFEST.json 不配套：重新解开交付 zip、核对 SHA256SUMS（重打过的用 .build/ 下成对的两个文件）"
import hashlib, json, sys, zipfile
m = json.load(open(sys.argv[2], encoding="utf-8"))["files"]
with zipfile.ZipFile(sys.argv[1]) as z:
    a = {i.filename: hashlib.sha256(z.read(i)).hexdigest() for i in z.infolist() if not i.is_dir()}
if a != m:
    print("  不一致：%s" % sorted(k for k in set(a) | set(m) if a.get(k) != m.get(k)), file=sys.stderr)
    sys.exit(1)
print("  ✓ 工具包 %d 个文件与 MANIFEST.json 逐文件一致" % len(a))
PY
if [ -e "${STATE}" ]; then
  if ${FORCE}; then
    printf '  ! 这台机器导入过（%s），按 --force-new 再导一份\n' "${STATE#"${ROOT}"/}"
  else
    printf '✗ 这台机器导入过：%s 已在。什么都没做。\n' "${STATE#"${ROOT}"/}" >&2
    printf '  要更新代码用 admin_run.sh publish（repo/knowledgebase-writer-agent-pg/README.md 第 10 节）；确实要在服务端再建一个目录才加 --force-new\n' >&2
    exit 3
  fi
else
  ok "这台机器还没导入过"
fi

# ───────────────────────── 1 登录 ─────────────────────────
step "1 登录 ${NEXUS}（${ADMIN_USER}）"
# 密码从 600 文件或标准输入读进 python，拼成请求体经管道交给 curl；回复（里面有令牌）只落在 700 的临时目录，取出令牌后立刻删掉
python3 -I -c '
import getpass, json, sys
user, path = sys.argv[1], sys.argv[2]
if path:
    pw = open(path, encoding="utf-8").read().strip()
elif sys.stdin.isatty():
    pw = getpass.getpass("管理员密码（不回显）：")
else:
    pw = sys.stdin.readline().strip()
if not pw:
    sys.exit("密码是空的")
sys.stdout.write(json.dumps({"username": user, "password": pw}))
' "${ADMIN_USER}" "${PW_FILE}" \
  | curl -sS -H 'Content-Type: application/json' -H 'Accept: application/json' --data-binary @- \
      -o "${T}/login.json" -w '%{http_code}' "${NEXUS}/api/v2/auth/login" > "${T}/login.code" \
  || die "登录请求没发出去（密码读不到，或网络、地址、TLS 的问题）"
login_code="$(cat "${T}/login.code")"
case "${login_code}" in
  2??) ;;
  *)   die "登录失败（HTTP ${login_code}）：$(errmsg "${T}/login.json")。检查 --user 和密码（文件里只放密码一行）" ;;
esac
python3 -I - "${T}/login.json" "${T}/auth.hdr" <<'PY' || { rm -f "${T}/login.json"; die "登录回复里没有 access_token"; }
import json, os, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
t = d.get("access_token") or (d.get("data") or {}).get("access_token")
os.remove(sys.argv[1])
if not t:
    sys.exit(1)
fd = os.open(sys.argv[2], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
os.write(fd, ("Authorization: Bearer " + t + "\n").encode())
os.close(fd)
PY
ok "已登录（令牌只在临时目录的 600 请求头文件里）"

# ───────────────────────── 2 密钥类型、已有目录 ─────────────────────────
step "2 平台有「数据库凭证」密钥类型，且还没有这个工具目录"
api "/keys/schemas" "${T}/schemas.json"
python3 -I - "${T}/schemas.json" <<'PY' || die "平台没有 database_credentials 密钥类型：这个平台版本不对（要 v0.3.28）"
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
d = d.get("data", d) if isinstance(d, dict) else d
sys.exit(0 if "database_credentials" in (d or {}) else 1)
PY
ok "database_credentials: True"
needs_key "${T}/needs-key.json"
python3 -I - "${T}/needs-key.json" "${T}/existing" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
rows = (d.get("data", d) if isinstance(d, dict) else d) or []
dirs = {}
for r in rows:
    parts = str(r.get("module_path") or "").split("/")
    for p in parts:
        if p.startswith("kb_pg_steward_"):
            dirs[p] = dirs.get(p, 0) + 1
with open(sys.argv[2], "w", encoding="utf-8") as f:
    f.write(" ".join("%s（%d 个工具）" % (k, v) for k, v in sorted(dirs.items())))
PY
existing="$(cat "${T}/existing")"
if [ -n "${existing}" ]; then
  if ${FORCE}; then
    printf '  ! 服务端已有：%s；按 --force-new 再导一份\n' "${existing}"
  else
    printf '✗ 服务端已有 kb_pg_steward 目录：%s。什么都没写。\n' "${existing}" >&2
    printf '  先弄清楚是不是已经部署过（admin_run.sh verify --module pg --dir <DIR_NAME>）；确实要再导一份才加 --force-new\n' >&2
    exit 3
  fi
else
  ok "已有的 kb_pg_steward 目录：没有"
fi

# ───────────────────────── 3 上传 ─────────────────────────
step "3 上传 $(basename "${ZIP}")"
api "/tools/import/upload" "${T}/upload.json" -F "file=@${ZIP};filename=pg_kb_tools.zip;type=application/zip"
python3 -I - "${T}/upload.json" "${T}/review_id" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
d = d.get("data", d) if isinstance(d, dict) else {}
with open(sys.argv[2], "w", encoding="utf-8") as f:
    f.write(str((d or {}).get("review_id") or ""))
PY
review_id="$(cat "${T}/review_id")"
[ -n "${review_id}" ] || die "上传没有返回 review_id：$(errmsg "${T}/upload.json")（文件不是 .zip，或压缩包里有平台拒收的路径）"
ok "review_id: ${review_id}"

# ───────────────────────── 4 确认（声明密钥） ─────────────────────────
step "4 确认，同时声明密钥 pg_kb"
python3 -I - "${review_id}" "${PKG_JSON}" "${T}/confirm.json" <<'PY' || die "读不了包描述 ${PKG_JSON}"
import json, sys
review_id = sys.argv[1]
pg = json.load(open(sys.argv[2], encoding="utf-8"))["modules"]["pg"]
key = pg["key"]
tools = []
for name, needs_key, desc in pg["tools"]:
    t = {"source_function": name, "name": name, "description": desc, "type": "strands_tool", "requires_key": needs_key}
    if needs_key:
        t.update({"key_name": key["name"], "key_type": key["type"], "key_fields_schema": key["fields"]})
    tools.append(t)
with open(sys.argv[3], "w", encoding="utf-8") as f:
    json.dump({"review_id": review_id, "tools": tools, "dir_label": pg["label"]}, f, ensure_ascii=False, indent=2)
print("  声明了 %d 个工具：%s；密钥 %s / %s，字段 %s；目录标签 %s" % (
    len(tools), " ".join(t["name"] for t in tools), key["name"], key["type"],
    "/".join(f["field"] for f in key["fields"]), pg["label"]))
PY
api "/tools/import/confirm" "${T}/confirm-result.json" -H 'Content-Type: application/json' --data-binary @"${T}/confirm.json"

# ───────────────────────── 5 记下结果 ─────────────────────────
step "5 记下结果：${STATE#"${ROOT}"/}"
python3 -I - "${T}/confirm-result.json" "${ZIP}" "${T}/import.json" <<'PY' || die "确认没有返回 dir_name：$(errmsg "${T}/confirm-result.json")"
import hashlib, json, sys, zipfile
r = json.load(open(sys.argv[1], encoding="utf-8"))
r = r.get("data", r) if isinstance(r, dict) else {}
if not (r or {}).get("dir_name"):
    sys.exit(1)
with open(sys.argv[2], "rb") as f:
    content = f.read()
with zipfile.ZipFile(sys.argv[2]) as z:
    files = sorted(i.filename for i in z.infolist() if not i.is_dir())
out = {"dir_name": r["dir_name"], "module_path": "imported_tools/%s/pg_kb_tools" % r["dir_name"],
       "tools": r.get("imported"), "errors": r.get("errors") or [],
       "file_sha": hashlib.sha256(content).hexdigest()[:12], "files": files}
with open(sys.argv[3], "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=2)
PY
mkdir -p "$(dirname "${STATE}")"
if [ -e "${STATE}" ]; then
  prev="${STATE%.json}.$(date -u +%Y%m%dT%H%M%SZ).json"
  mv "${STATE}" "${prev}"
  printf '  ! 旧的 import.json 改名为 %s\n' "${prev#"${ROOT}"/}"
fi
cp "${T}/import.json" "${STATE}"
dir_name="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["dir_name"])' "${STATE}")"
python3 -I -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1], encoding="utf-8")), ensure_ascii=False, indent=2))' "${STATE}" \
  | sed 's/^/  /'
python3 -I -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1], encoding="utf-8"))["errors"] == [] else 1)' "${STATE}" \
  || die "errors 不是 []：有工具没登记上。不要接着绑定，先看上面 errors 的说明"
ok "目录 ${dir_name}（这就是 <DIR_NAME>），errors: []"

# ───────────────────────── 6 核对 ─────────────────────────
step "6 核对：要密钥的工具、服务端的文件"
needs_key "${T}/needs-key-after.json"
python3 -I - "${T}/needs-key-after.json" "${dir_name}" "${PKG_JSON}" "${STATE}" "${T}/tool_id" <<'PY' || die "要密钥的工具核对不过（见上）：不要接着绑定"
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
rows = (d.get("data", d) if isinstance(d, dict) else d) or []
dir_name = sys.argv[2]
pg = json.load(open(sys.argv[3], encoding="utf-8"))["modules"]["pg"]
want = sorted(name for name, needs_key, _ in pg["tools"] if needs_key)
mine = [r for r in rows if "/%s/" % dir_name in "/%s/" % str(r.get("module_path") or "")]
good = True
for r in sorted(mine, key=lambda r: str(r.get("tool_name"))):
    print("  %s: key_name=%s key_type=%s configured=%s" % (r.get("tool_name"), r.get("key_name"), r.get("key_type"), r.get("configured")))
    good = good and r.get("key_name") == pg["key"]["name"] and r.get("key_type") == pg["key"]["type"]
good = good and sorted(str(r.get("tool_name")) for r in mine) == want
tool_id = next((r.get("tool_id") for r in mine if r.get("tool_id")), None)
if not tool_id:
    imported = json.load(open(sys.argv[4], encoding="utf-8")).get("tools") or []
    tool_id = next((t.get("tool_id") for t in imported if isinstance(t, dict) and t.get("tool_id")), None)
if not good:
    print("  要密钥的工具不对：应是 %s，都声明 %s / %s" % (" ".join(want), pg["key"]["name"], pg["key"]["type"]))
    sys.exit(1)
if not tool_id:
    print("  找不到这个目录里任一个工具的 tool_id")
    sys.exit(1)
with open(sys.argv[5], "w", encoding="utf-8") as f:
    f.write(str(tool_id))
PY
tool_id="$(cat "${T}/tool_id")"
ok "3 个工具都要密钥 pg_kb / database_credentials（还没绑定时 configured=False）"
api "/tools/registered/${tool_id}/files" "${T}/files.json"
python3 -I - "${T}/files.json" "${MANIFEST}" <<'PY' || die "服务端的文件与 MANIFEST.json 不一致（见上）：不要接着绑定"
import hashlib, json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
d = d.get("data", d) if isinstance(d, dict) else {}
want = json.load(open(sys.argv[2], encoding="utf-8"))["files"]
got = {f["path"]: f.get("sha256") or hashlib.sha256(f.get("content", "").encode("utf-8")).hexdigest()
       for f in (d or {}).get("files") or []}
for p in sorted(set(want) | set(got)):
    print("  %s: %s" % (p, "一致" if want.get(p) == got.get(p) else "服务端没有" if p not in got else "只在服务端" if p not in want else "不一致"))
print("  current_version %s | 服务端与本地逐个文件一致: %s" % (d.get("current_version"), want == got))
sys.exit(0 if want == got else 1)
PY

step "完成"
printf '  工具目录 %s 已导入（v1），结果在 %s。\n' "${dir_name}" "${STATE#"${ROOT}"/}"
printf '  下一步：以 Agent 与发布的属主身份绑定数据库密钥（nexus/IMPORT.md「导入之后」第 1 条），再核对 3 个都是 configured=True。\n'
