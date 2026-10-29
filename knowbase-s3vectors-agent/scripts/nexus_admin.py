"""用管理员账号导入 / 更新 S3 Vectors 工具包。

为什么不用 Operator：导入要 multipart 上传（Operator 的 call 只发 JSON）；本环境「工具代码可能在服务主机上运行时
仅管理员可修改」开着，发布新版本也只对管理员开放。导入时在确认请求里声明密钥：四个读写 S3 Vectors 的工具
requires_key=true、key_name=s3vectors_kb、key_type=aws_credentials，平台据此在每次调用前注入绑定的密钥。

两个工具模块，各自导入成一个工具目录，用 --module 选（import / check / publish / verify 都认）：
  --module kb（缺省）  .build/s3vectors_kb_tools.py     六个工具，状态 .state/import.json，目录标签 kb_s3vectors
  --module rules       .build/s3vectors_rules_tools.py  rules_writer / rules_search / rules_manager，三个都要密钥（同上），
                       状态 .state/import-rules.json，目录标签 kb_s3v_rules；先运行 scripts/render.py rules-tools

用法（NEXUS_URL / NEXUS_ADMIN_USER / NEXUS_PASSWORD_FILE 由 admin_run.sh 准备；密码不经命令行、不打印）：
  nexus_admin.py import  --file .build/s3vectors_kb_tools.py [--label kb_s3vectors]
  nexus_admin.py check   --tool-id <TOOL_ID> --file .build/s3vectors_kb_tools.py --expect-version <N>
  nexus_admin.py publish --tool-id <TOOL_ID> --file .build/s3vectors_kb_tools.py --expect-version <N>
  nexus_admin.py verify  --dir <DIR_NAME> [--file .build/s3vectors_kb_tools.py]
  （规则模块：上面四条加 --module rules，--file 缺省就是 .build/s3vectors_rules_tools.py）
  nexus_admin.py key-create --name <Nexus 密钥名> --iam-user <WRITER_IAM_USER>
      给写入用 IAM 用户新建访问密钥，直接存成 Nexus「AWS 凭证」密钥：密钥值只在本进程内存里，
      不打印、不落盘；Nexus 侧失败就删掉刚建的 IAM 访问密钥。只输出 key_id 与访问密钥 ID 的末 4 位。
  nexus_admin.py issue-call-key --publish-id <PUBLISH_ID> [--label …] [--out .state/a2a-call-key]
      给 A2A / MCP 发布新建一把调用密钥（nxa_…），明文直接写进 600 文件，不打印；只输出 credential_id。
import 成功后把目录名与工具 ID 写进 .state/import.json（--module rules：.state/import-rules.json）；
已有这个文件时拒绝再次导入（加 --again 才导入第二份）。
"""
import argparse
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.request
import uuid
from http.cookiejar import CookieJar

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
STATE = os.path.join(PKG, ".state", "import.json")
MODULE = "s3vectors_kb_tools"
KEY_NAME, KEY_TYPE = "s3vectors_kb", "aws_credentials"
KEY_FIELDS = [
    {"field": "access_key_id", "required": True, "description": "专用 IAM 用户的 Access Key ID（只授权本知识库的向量桶）"},
    {"field": "secret_access_key", "required": True, "description": "对应的 Secret Access Key"},
    {"field": "session_token", "required": False, "description": "临时凭证的会话令牌（长期密钥不填）"},
]
TOOLS = [
    ("s3vectors_writer", True, "把文档向量化（Cohere Embed v4，1536 维）并写入 S3 Vectors 知识库；给附件路径即可一步入库，按内容去重"),
    ("s3vectors_search", True, "在 S3 Vectors 知识库中语义检索、按文档查看文本块或找最相关的文档；过滤条件由工具拼"),
    ("s3vectors_manager", True, "S3 Vectors 知识库管理：按文档硬删除 / 软删除、恢复、一致性校验"),
    ("s3vectors_statistics", True, "S3 Vectors 知识库统计：Dashboard、文档清单、文档详情、内容抽样"),
    ("document_parser", False, "解析 Word / Excel / PDF 文档，抽取结构化文本与元数据，计算内容 SHA256"),
    ("text_chunker", False, "把长文本按段落聚合、固定长度加重叠切成文本块"),
]
RULES_TOOLS = [
    ("rules_writer", True, "把审批矩阵格式的制度（.docx）一行一条规则写入 S3 Vectors 规则库（Cohere Embed v4，1536 维）；"
                           "同一 source_id 再上传 = 新版本，按内容去重"),
    ("rules_search", True, "按问题检索 S3 Vectors 规则库；板块、金额的过滤条件由工具代码拼"),
    ("rules_manager", True, "S3 Vectors 规则库管理：制度清单、详情、下线、恢复、删除、一致性校验"),
]
# --module → (模块名, 工具, 状态文件, 缺省目录标签, 生成它的 render.py 子命令)
MODULES = {
    "kb": (MODULE, TOOLS, STATE, "kb_s3vectors", "tools"),
    "rules": ("s3vectors_rules_tools", RULES_TOOLS, os.path.join(PKG, ".state", "import-rules.json"), "kb_s3v_rules",
              "rules-tools"),
}
RENDER_CMD = "tools"


def use_module(name):
    global MODULE, TOOLS, STATE, RENDER_CMD
    MODULE, TOOLS, STATE, _, RENDER_CMD = MODULES[name]


def redact(raw):
    try:
        d = json.loads(raw)
    except ValueError:
        return raw[:300]

    def scrub(o):
        if isinstance(o, dict):
            return {k: ("<redacted>" if re.search(r"password|secret|token|input|content", k, re.I) else scrub(v))
                    for k, v in o.items()}
        if isinstance(o, list):
            return [scrub(x) for x in o]
        return o
    return json.dumps(scrub(d), ensure_ascii=False)[:800]


class Nexus:
    def __init__(self):
        self.base = os.environ["NEXUS_URL"].rstrip("/") + "/api/v2"
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
        self.token = None

    def _send(self, method, path, data=None, ctype=None, timeout=120):
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("Accept", "application/json")
        if ctype:
            req.add_header("Content-Type", ctype)
        if self.token:
            req.add_header("Authorization", f"Bearer {self.token}")
        try:
            with self.opener.open(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            raise SystemExit(f"HTTP {e.code} {method} {path}: {redact(e.read().decode('utf-8', 'replace'))}")
        return json.loads(raw) if raw else {}

    def json(self, method, path, body=None):
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
        return self._send(method, path, data, "application/json" if data is not None else None)

    def upload(self, path, field, filename, content):
        boundary = "----nexus" + uuid.uuid4().hex
        body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"; filename=\"{filename}\"\r\n"
                f"Content-Type: text/x-python\r\n\r\n").encode("utf-8") + content + f"\r\n--{boundary}--\r\n".encode()
        return self._send("POST", path, body, f"multipart/form-data; boundary={boundary}")

    def login(self):
        pw = open(os.environ["NEXUS_PASSWORD_FILE"], encoding="utf-8").read().strip()
        r = self.json("POST", "/auth/login", {"username": os.environ.get("NEXUS_ADMIN_USER", "admin"), "password": pw})
        self.token = r.get("access_token")
        if not self.token:
            raise SystemExit("登录失败：检查 NEXUS_ADMIN_USER / 管理员密码来源")
        return self


def data(r):
    return r.get("data", r) if isinstance(r, dict) else r


def sha(s):
    return hashlib.sha256(s.encode("utf-8")).hexdigest()[:12]


def check_tool_file(path):
    src = open(path, encoding="utf-8").read()
    compile(src, os.path.basename(path), "exec")
    missing = [n for n, _, _ in TOOLS if not re.search(rf"^@tool\ndef {n}\(", src, re.M)]
    if missing:
        raise SystemExit(f"{path} 里找不到这些 @tool 函数：{missing}")
    if MODULE == MODULES["rules"][0] and re.search(r'^_(VECTOR_BUCKET|RULES_INDEX) = ""$', src, re.M):
        raise SystemExit(f"工具文件还没渲染（桶名或规则索引名为空）：先运行 scripts/render.py {RENDER_CMD} 生成 .build/{MODULE}.py")
    if '_VECTOR_BUCKET = "knowbase-s3v-demo"' in src and "--allow-demo-bucket" not in sys.argv:
        raise SystemExit(f"工具文件还是示例桶名：先运行 scripts/render.py {RENDER_CMD} 生成 .build/{MODULE}.py")
    return src


def tool_declarations():
    """导入确认请求里的 tools：要密钥的工具声明 key_name / key_type / key_fields_schema，平台据此注入绑定的密钥。"""
    tools = []
    for name, needs_key, desc in TOOLS:
        t = {"source_function": name, "name": name, "description": desc, "type": "strands_tool", "requires_key": needs_key}
        if needs_key:
            t.update({"key_name": KEY_NAME, "key_type": KEY_TYPE, "key_fields_schema": KEY_FIELDS})
        tools.append(t)
    return tools


def cmd_import(nx, a):
    if os.path.exists(STATE) and not a.again:
        raise SystemExit(f"已导入过（{os.path.relpath(STATE, PKG)}）。要更新代码请用 publish；确实要再导入一份加 --again")
    src = check_tool_file(a.file)
    schemas = data(nx.json("GET", "/keys/schemas"))
    if KEY_TYPE not in (schemas or {}):
        raise SystemExit(f"平台没有 {KEY_TYPE} 密钥类型")
    up = data(nx.upload("/tools/import/upload", "file", f"{MODULE}.py", src.encode("utf-8")))
    review_id = up.get("review_id")
    if not review_id:
        raise SystemExit(f"上传没有返回 review_id：{up}")
    res = data(nx.json("POST", "/tools/import/confirm", {"review_id": review_id, "tools": tool_declarations(),
                                                         "dir_label": a.label}))
    out = {"dir_name": res.get("dir_name"), "module_path": f"imported_tools/{res.get('dir_name')}/{MODULE}",
           "tools": res.get("imported"), "errors": res.get("errors") or [], "file_sha": sha(src)}
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    json.dump(out, open(STATE, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(json.dumps(out, ensure_ascii=False, indent=2))


def files_body(nx, a):
    cur = data(nx.json("GET", f"/tools/registered/{a.tool_id}/files"))
    if a.expect_version is None or cur.get("current_version") != a.expect_version:
        raise SystemExit(f"服务端当前版本是 v{cur.get('current_version')}，不是 --expect-version={a.expect_version}，停止")
    src = check_tool_file(a.file)
    files = []
    for f in cur.get("files") or []:
        content = src if os.path.basename(f["path"]) == f"{MODULE}.py" else f["content"]
        print(f"  {f['path']}: {sha(f['content'])} -> {sha(content)}{'  (changed)' if content != f['content'] else ''}")
        files.append({"path": f["path"], "content": content})
    return {"files": files, "requirements_txt": cur.get("requirements_txt"), "expected_current": cur.get("current_version"),
            "notes": a.notes}


def cmd_check(nx, a):
    d = data(nx.json("POST", f"/tools/registered/{a.tool_id}/publish-check", files_body(nx, a)))
    print("blocking:", d.get("blocking"), "| warnings:", d.get("warnings"))
    for lf in d.get("lint") or []:
        names = [c["name"] for c in lf.get("candidates") or [] if c.get("has_tool_decorator")]
        print(" ", lf.get("file"), "syntax_ok", lf.get("syntax_ok"), "compile_ok", lf.get("compile_ok"), "tools", names)


def cmd_publish(nx, a):
    d = data(nx.json("PUT", f"/tools/registered/{a.tool_id}/files", files_body(nx, a)))
    print(json.dumps({k: d.get(k) for k in ("version_no", "current_version", "state") if k in d}, ensure_ascii=False))


def cmd_verify(nx, a):
    rows = data(nx.json("GET", "/keys/tools-requiring-key?limit=500")) or []
    mine = [r for r in rows if a.dir in str(r.get("module_path") or "")]
    print("需要密钥的工具：")
    for r in mine:
        print(f"  {r['tool_name']}: key_name={r['key_name']} key_type={r['key_type']} configured={r.get('configured')}")
    if a.file and mine:
        cur = data(nx.json("GET", f"/tools/registered/{mine[0]['tool_id']}/files"))
        local = open(a.file, encoding="utf-8").read()
        same = any(f["content"] == local for f in cur.get("files") or [])
        print("current_version", cur.get("current_version"), "| 服务端与本地文件一致:", same)


def cmd_key_create(nx, a):
    import boto3
    rows = data(nx.json("GET", "/keys?limit=1000&search=" + urllib.request.quote(a.name))) or []
    rows = rows.get("items", rows.get("keys", [])) if isinstance(rows, dict) else rows
    if any((k.get("key_name") or k.get("name")) == a.name for k in rows):
        raise SystemExit(f"Nexus 里已有名为 {a.name} 的密钥，没有新建任何东西（要换密钥请先在 IAM 与 Nexus 里轮换）")
    iam = boto3.client("iam")
    existing = iam.list_access_keys(UserName=a.iam_user)["AccessKeyMetadata"]
    if len(existing) >= 2:
        raise SystemExit(f"{a.iam_user} 已有 2 把访问密钥（IAM 上限），先删掉不用的再来")
    created = iam.create_access_key(UserName=a.iam_user)["AccessKey"]
    akid = created["AccessKeyId"]
    try:
        r = data(nx.json("POST", "/keys", {
            "name": a.name, "key_type": KEY_TYPE,
            "secret_values": {"access_key_id": akid, "secret_access_key": created["SecretAccessKey"]},
            "description": a.description or f"knowbase-s3vectors-agent：IAM 用户 {a.iam_user} 的访问密钥，只授权本知识库的向量桶",
        }))
    except BaseException:
        iam.delete_access_key(UserName=a.iam_user, AccessKeyId=akid)
        raise
    finally:
        created.clear()
    print(json.dumps({"key_id": r.get("key_id"), "name": a.name, "key_type": KEY_TYPE,
                      "iam_user": a.iam_user, "access_key_id": "****" + akid[-4:]}, ensure_ascii=False))


def cmd_issue_call_key(nx, a):
    out_path = a.out or os.path.join(PKG, ".state", "a2a-call-key")
    if os.path.exists(out_path):
        raise SystemExit(f"{os.path.relpath(out_path, PKG)} 已存在，没有新建密钥（要换新请先在网页上停用旧的并删掉这个文件）")
    r = data(nx.json("POST", f"/publications/{a.publish_id}/keys", {"label": a.label or "knowbase-s3vectors-agent smoke test"}))
    plaintext = str(r.get("plaintext") or "")
    cred = (r.get("credential") or {}).get("credential_id")
    if not plaintext.startswith("nxa_"):
        raise SystemExit(f"响应里没有调用密钥明文，没有写文件（credential_id={cred}）")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    fd = os.open(out_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(plaintext)
    plaintext = ""
    print(json.dumps({"credential_id": cred, "publish_id": a.publish_id, "file": os.path.relpath(out_path, PKG),
                      "mode": "600"}, ensure_ascii=False))


def parse_args(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["import", "check", "publish", "verify", "key-create", "issue-call-key"])
    ap.add_argument("--module", choices=sorted(MODULES), default="kb",
                    help="kb = s3vectors_kb_tools（缺省），rules = s3vectors_rules_tools")
    ap.add_argument("--file", help="缺省 .build/<模块>.py")
    ap.add_argument("--label", help="导入时的目录标签，缺省 kb_s3vectors（--module rules：kb_s3v_rules）")
    ap.add_argument("--tool-id")
    ap.add_argument("--dir")
    ap.add_argument("--expect-version", type=int)
    ap.add_argument("--again", action="store_true")
    ap.add_argument("--allow-demo-bucket", action="store_true")
    ap.add_argument("--notes", default="knowbase-s3vectors-agent 工具更新")
    ap.add_argument("--name")
    ap.add_argument("--iam-user")
    ap.add_argument("--description")
    ap.add_argument("--publish-id")
    ap.add_argument("--out")
    a = ap.parse_args(argv)
    use_module(a.module)
    if a.file is None:
        a.file = os.path.join(PKG, ".build", f"{MODULE}.py")
    if a.label is None:
        a.label = MODULES[a.module][3]
    return a


def main():
    a = parse_args()
    if a.cmd in ("check", "publish") and not a.tool_id:
        raise SystemExit(f"{a.cmd} 需要 --tool-id")
    if a.cmd == "verify" and not a.dir:
        raise SystemExit("verify 需要 --dir")
    if a.cmd == "key-create" and not (a.name and a.iam_user):
        raise SystemExit("key-create 需要 --name 与 --iam-user")
    if a.cmd == "issue-call-key" and not a.publish_id:
        raise SystemExit("issue-call-key 需要 --publish-id")
    nx = Nexus().login()
    {"import": cmd_import, "check": cmd_check, "publish": cmd_publish, "verify": cmd_verify,
     "key-create": cmd_key_create, "issue-call-key": cmd_issue_call_key}[a.cmd](nx, a)


if __name__ == "__main__":
    main()
