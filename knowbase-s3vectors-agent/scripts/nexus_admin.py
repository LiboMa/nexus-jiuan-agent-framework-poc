"""用管理员账号导入 / 更新工具包、绑定密钥、发调用密钥。S3 Vectors 版与 PG 版两个交付包共用这一份，按包描述 nexus-package.json 办事。

为什么不用 Operator：导入要 multipart 上传（Operator 的 call 只发 JSON）；本环境「工具代码可能在服务主机上运行时
仅管理员可修改」开着，发布新版本也只对管理员开放。导入时在确认请求里声明密钥：要密钥的工具 requires_key=true，
带上描述里的 key_name / key_type / 字段，平台据此在每次调用前注入绑定的密钥。

包与模块（import / check / publish / verify / bind 都认 --module）：
  --package <包目录>  读它的 nexus-package.json（格式见 nexus_package.py）；缺省是本脚本所在的包 knowbase-s3vectors-agent
  --module <模块名>   描述里的一个模块，缺省是第一个。每个模块各自导入成一个工具目录：
    knowbase-s3vectors-agent       kb（缺省）  .build/s3vectors_kb_tools.py     六个工具，状态 .state/import.json，标签 kb_s3vectors
                                   rules       .build/s3vectors_rules_tools.py  三个规则工具，状态 .state/import-rules.json，标签 kb_s3v_rules
    knowledgebase-writer-agent-pg  pg（缺省）  .build/pg_kb_tools.zip           三个规则工具（要 pg_kb 密钥），状态 .state/import.json，标签 kb_pg_steward
                                   probe       .build/kb_probe.zip              探针 kb_import_probe（不要密钥），状态 .state/import-probe.json，标签 kb_pg_probe
  build 是 .py：单文件导入，上传 <module>.py，发布时只换服务端的这一个文件。
  build 是 .zip：多文件导入，上传 <module>.zip（平台把压缩包里的文件原样放进同一个目录）；发布时整个目录换成本地构建的文件集合，
  核对时逐个文件比。导入、发布前先查压缩包：每个 .py 编译得过、每个工具恰好在一个文件里有顶层的 @tool 定义、与旁边的 MANIFEST.json 一致。

用法（NEXUS_URL / NEXUS_ADMIN_USER / NEXUS_PASSWORD_FILE 由 admin_run.sh 准备；密码不经命令行、不打印）：
  nexus_admin.py [--package …] import  [--module …] [--file <build>] [--label <标签>]
  nexus_admin.py [--package …] check   [--module …] --tool-id <TOOL_ID> --expect-version <N> [--file <build>]
  nexus_admin.py [--package …] publish [--module …] --tool-id <TOOL_ID> --expect-version <N> [--file <build>]
  nexus_admin.py [--package …] verify  [--module …] --dir <DIR_NAME> [--file <build>] [--tool-id <TOOL_ID>（不要密钥的模块）]
  nexus_admin.py [--package …] bind    [--module …] --key-id <key-…> [--module-path imported_tools/<DIR>/<module>] [--key-name <名>]
      以管理员本人的身份把工具模块绑到一把 Nexus 密钥（PUT /keys/tool-bindings）。这是按人绑定：只对调用者本人的 Agent 生效，
      所以只在管理员就是 Agent 和发布的属主时用；否则请属主自己绑（Operator 或网页）。模块路径缺省取导入状态文件里的，
      密钥名缺省是描述里声明的（给了也必须相同）。
  nexus_admin.py key-create --name <Nexus 密钥名> --iam-user <WRITER_IAM_USER>
      只用于 aws_credentials 密钥（S3 Vectors 版）：给写入用 IAM 用户新建访问密钥，直接存成 Nexus「AWS 凭证」密钥：
      密钥值只在本进程内存里，不打印、不落盘；Nexus 侧失败就删掉刚建的 IAM 访问密钥。只输出 key_id 与访问密钥 ID 的末 4 位。
  nexus_admin.py issue-call-key --publish-id <PUBLISH_ID> [--label …] [--out .state/a2a-call-key]
      给 A2A / MCP 发布新建一把调用密钥（nxa_…），明文直接写进 600 文件（缺省在包的 .state/ 下），不打印；只输出 credential_id。
import 成功后把目录名与工具 ID 写进模块的状态文件；已有这个文件时拒绝再次导入（加 --again 才导入第二份）。
"""
import argparse
import ast
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.request
import uuid
import zipfile
from http.cookiejar import CookieJar

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)   # python -I 不把脚本所在目录放进 sys.path；nexus_package.py 与本脚本同目录
import nexus_package  # noqa: E402

OWN_PKG = os.path.dirname(HERE)
TOOL_DIR_RE = r"[a-z0-9_]{1,32}_[0-9a-f]{8}"   # 与 render.py 相同：导入后的目录名 = 标签 + _ + 8 位十六进制
KEY_ID_RE = re.compile(r"key-[0-9a-f]{12}")

# 当前的包与模块：use_package / use_module 设定（parse_args 按 --package / --module 调；导入本模块时是本包的第一个模块）
PKG = DESC = MODULES = None
MODULE_NAME = MODULE = TOOLS = STATE = BUILD = RENDER_CMD = KEY = KEY_NAME = KEY_TYPE = KEY_FIELDS = GUARDS = MANIFEST = None


def use_package(path):
    global PKG, DESC, MODULES
    PKG = os.path.abspath(path)
    DESC = nexus_package.load(PKG)
    MODULES = DESC["modules"]
    use_module(next(iter(MODULES)))


def use_module(name):
    global MODULE_NAME, MODULE, TOOLS, STATE, BUILD, RENDER_CMD, KEY, KEY_NAME, KEY_TYPE, KEY_FIELDS, GUARDS, MANIFEST
    m = MODULES[name]
    MODULE_NAME, MODULE, TOOLS, BUILD, RENDER_CMD = name, m["module"], m["tools"], m["build"], m["render"]
    STATE = nexus_package.path(PKG, m["state"])
    KEY = m.get("key")
    KEY_NAME, KEY_TYPE, KEY_FIELDS = (KEY["name"], KEY["type"], KEY["fields"]) if KEY else (None, None, None)
    GUARDS, MANIFEST = m.get("guards", []), m.get("manifest")


def is_zip():
    return BUILD.endswith(".zip")


use_package(OWN_PKG)


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

    def upload(self, path, field, filename, content, ctype="text/x-python"):
        boundary = "----nexus" + uuid.uuid4().hex
        body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"; filename=\"{filename}\"\r\n"
                f"Content-Type: {ctype}\r\n\r\n").encode("utf-8") + content + f"\r\n--{boundary}--\r\n".encode()
        return self._send("POST", path, body, f"multipart/form-data; boundary={boundary}")

    def login(self):
        with open(os.environ["NEXUS_PASSWORD_FILE"], encoding="utf-8") as f:
            pw = f.read().strip()
        r = self.json("POST", "/auth/login", {"username": os.environ.get("NEXUS_ADMIN_USER", "admin"), "password": pw})
        pw = ""
        self.token = r.get("access_token")
        if not self.token:
            raise SystemExit("登录失败：检查 NEXUS_ADMIN_USER / 管理员密码来源")
        return self


def data(r):
    return r.get("data", r) if isinstance(r, dict) else r


def sha(s):
    return hashlib.sha256(s if isinstance(s, bytes) else s.encode("utf-8")).hexdigest()[:12]


def rel(path):
    return os.path.relpath(path, PKG)


# ─────────────────────── 本地构建的检查 ────────────────────────
def guard(src):
    """描述里的 guards：构建结果里还留着示例值、没渲染的空值等，就不导入 / 发布。"""
    for g in GUARDS:
        if g.get("unless") and g["unless"] in sys.argv:
            continue
        if re.search(g["pattern"], src, re.M):
            raise SystemExit(f"{g['message']}：先运行 {RENDER_CMD} 生成 {BUILD}")


def check_tool_file(path):
    """导入 / 发布前查本地构建。单文件模块返回源码；zip 模块返回 {文件路径: 字节}（见 check_tool_zip）。"""
    if is_zip():
        return check_tool_zip(path)
    with open(path, encoding="utf-8") as f:
        src = f.read()
    compile(src, os.path.basename(path), "exec")
    missing = [n for n, _, _ in TOOLS if not re.search(rf"^@tool\ndef {n}\(", src, re.M)]
    if missing:
        raise SystemExit(f"{path} 里找不到这些 @tool 函数：{missing}")
    guard(src)
    return src


def _is_tool_decorator(node):
    return (isinstance(node, ast.Name) and node.id == "tool") or \
        (isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "tool")


def read_zip(path):
    """压缩包 → {文件路径: 字节}（目录项跳过）。"""
    if not os.path.isfile(path):
        raise SystemExit(f"没有 {path}：先运行 {RENDER_CMD}")
    if not zipfile.is_zipfile(path):
        raise SystemExit(f"读不了 {path}：不是 zip 压缩包（重新运行 {RENDER_CMD}）")
    try:
        with zipfile.ZipFile(path) as z:
            return {i.filename: z.read(i) for i in z.infolist() if not i.is_dir()}
    except (OSError, RuntimeError, NotImplementedError, zipfile.BadZipFile) as e:
        raise SystemExit(f"读不了 {path}：{e}（重新运行 {RENDER_CMD}）") from None


def check_tool_zip(path):
    """多文件模块的压缩包：路径都在包内、没有缓存文件；每个 .py 是 UTF-8、编译得过（并过 guards）；描述里的每个工具恰好在
    一个文件里有顶层定义，且带 @tool（平台按顶层函数名找文件，同名的函数在几个文件里都有会指错）；与旁边的清单一致。"""
    if not path.endswith(".zip"):
        raise SystemExit(f"模块 {MODULE_NAME} 是多文件导入：--file 要给构建出的 .zip（{BUILD}），收到 {path}")
    files = read_zip(path)
    bad = [n for n in files if n.startswith("/") or "\\" in n or any(p in ("", ".", "..") for p in n.split("/"))]
    if bad:
        raise SystemExit(f"{path} 里有不合规的路径（要是目录里的相对路径，不能含 ..）：{bad}")
    junk = [n for n in files if "__pycache__" in n.split("/") or n.endswith((".pyc", ".pyo"))]
    if junk:
        raise SystemExit(f"{path} 里有缓存文件：{junk}（重新运行 {RENDER_CMD}）")
    defs = {}   # 顶层函数名 → [(文件, 带不带 @tool)]
    for name in sorted(files):
        if not name.endswith(".py"):
            continue
        try:
            src = files[name].decode("utf-8")
        except UnicodeDecodeError:
            raise SystemExit(f"{path} 里的 {name} 不是 UTF-8 文本") from None
        try:
            tree = ast.parse(src, filename=name)
            compile(src, name, "exec")
        except SyntaxError as e:
            raise SystemExit(f"{path} 里的 {name} 编译不过：{e}") from None
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                defs.setdefault(node.name, []).append((name, any(_is_tool_decorator(d) for d in node.decorator_list)))
        guard(src)
    missing = [n for n, _, _ in TOOLS if not any(tagged for _, tagged in defs.get(n, []))]
    if missing:
        raise SystemExit(f"{path} 里找不到这些 @tool 函数：{missing}")
    dup = {n: [f for f, _ in defs[n]] for n, _, _ in TOOLS if len(defs[n]) > 1}
    if dup:
        raise SystemExit(f"{path} 里这些工具函数在几个文件里都有顶层定义（平台按函数名找文件，会指错）：{dup}")
    if MANIFEST:
        listed = os.path.join(os.path.dirname(os.path.abspath(path)), MANIFEST)
        if not os.path.isfile(listed):
            raise SystemExit(f"缺少 {listed}：{RENDER_CMD} 把它和压缩包写在一起，重新运行")
        with open(listed, encoding="utf-8") as f:
            expected = (json.load(f) or {}).get("files") or {}
        actual = {n: hashlib.sha256(b).hexdigest() for n, b in files.items()}
        differ = sorted(n for n in set(expected) | set(actual) if expected.get(n) != actual.get(n))
        if differ:
            raise SystemExit(f"{path} 与旁边的 {MANIFEST} 对不上：{differ}（重新运行 {RENDER_CMD}）")
    return files


def tool_declarations():
    """导入确认请求里的 tools：要密钥的工具声明 key_name / key_type / key_fields_schema，平台据此注入绑定的密钥。"""
    tools = []
    for name, needs_key, desc in TOOLS:
        t = {"source_function": name, "name": name, "description": desc, "type": "strands_tool", "requires_key": needs_key}
        if needs_key:
            t.update({"key_name": KEY_NAME, "key_type": KEY_TYPE, "key_fields_schema": KEY_FIELDS})
        tools.append(t)
    return tools


# ─────────────────────── 命令 ────────────────────────
def cmd_import(nx, a):
    if os.path.exists(STATE) and not a.again:
        raise SystemExit(f"已导入过（{rel(STATE)}）。要更新代码请用 publish；确实要再导入一份加 --again")
    checked = check_tool_file(a.file)
    if KEY:
        schemas = data(nx.json("GET", "/keys/schemas"))
        if KEY_TYPE not in (schemas or {}):
            raise SystemExit(f"平台没有 {KEY_TYPE} 密钥类型")
    if is_zip():
        with open(a.file, "rb") as f:
            content = f.read()
        up = data(nx.upload("/tools/import/upload", "file", f"{MODULE}.zip", content, ctype="application/zip"))
    else:
        content = checked.encode("utf-8")
        up = data(nx.upload("/tools/import/upload", "file", f"{MODULE}.py", content))
    review_id = up.get("review_id")
    if not review_id:
        raise SystemExit(f"上传没有返回 review_id：{up}")
    res = data(nx.json("POST", "/tools/import/confirm", {"review_id": review_id, "tools": tool_declarations(),
                                                         "dir_label": a.label}))
    out = {"dir_name": res.get("dir_name"), "module_path": f"imported_tools/{res.get('dir_name')}/{MODULE}",
           "tools": res.get("imported"), "errors": res.get("errors") or [], "file_sha": sha(content)}
    if is_zip():
        out["files"] = sorted(checked)
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    with open(STATE, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(json.dumps(out, ensure_ascii=False, indent=2))


def files_body(nx, a):
    """check / publish 的请求体。单文件模块：只换服务端的 <module>.py；zip 模块：文件集合 = 本地构建的集合（服务端多出的删掉）。
    requirements_txt 沿用服务端当前的。"""
    cur = data(nx.json("GET", f"/tools/registered/{a.tool_id}/files"))
    if a.expect_version is None or cur.get("current_version") != a.expect_version:
        raise SystemExit(f"服务端当前版本是 v{cur.get('current_version')}，不是 --expect-version={a.expect_version}，停止")
    checked = check_tool_file(a.file)
    files = []
    if is_zip():
        server = {f["path"]: f for f in cur.get("files") or []}
        kept_init = [p for p in server if os.path.basename(p) == "__init__.py" and p not in checked]
        if kept_init:
            raise SystemExit(f"服务端有 {kept_init}，本地构建里没有：平台不许删 __init__.py，先把它加进构建再发布")
        for path in sorted(set(server) | set(checked)):
            old = server.get(path)
            if path not in checked:
                print(f"  {path}: {sha(old['content'])} -> (removed)")
                continue
            try:
                content = checked[path].decode("utf-8")
            except UnicodeDecodeError:
                raise SystemExit(f"{path} 不是 UTF-8 文本，不能经 files 接口发布") from None
            mark = "  (new)" if old is None else "  (changed)" if content != old["content"] else ""
            print(f"  {path}: {sha(old['content']) if old else '-'} -> {sha(content)}{mark}")
            files.append({"path": path, "content": content})
    else:
        for f in cur.get("files") or []:
            content = checked if os.path.basename(f["path"]) == f"{MODULE}.py" else f["content"]
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


def saved_state():
    if not os.path.isfile(STATE):
        return {}
    with open(STATE, encoding="utf-8") as f:
        return json.load(f) or {}


def cmd_verify(nx, a):
    """要密钥的模块：列出这个目录里要密钥的工具和绑定情况。再拿一个工具 ID 读服务端的文件，与本地构建比：单文件模块看
    <module>.py 在不在、是否一致；zip 模块逐个文件比（sha256）。"""
    mine = []
    if KEY:
        rows = data(nx.json("GET", "/keys/tools-requiring-key?limit=500")) or []
        mine = [r for r in rows if a.dir in str(r.get("module_path") or "")]
        print("需要密钥的工具：")
        for r in mine:
            print(f"  {r['tool_name']}: key_name={r['key_name']} key_type={r['key_type']} configured={r.get('configured')}")
        tool_id = mine[0]["tool_id"] if mine else None
    else:
        print(f"模块 {MODULE_NAME} 的工具不要密钥（不在「需要密钥的工具」里）")
        state = saved_state()
        tool_id = a.tool_id or (((state.get("tools") or [{}])[0] or {}).get("tool_id") if state.get("dir_name") == a.dir else None)
        if not tool_id:
            print(f"找不到 {a.dir} 的工具 ID：给 --tool-id，或在导入过的机器上运行（{rel(STATE)}）")
    if not (a.file and tool_id):
        return
    cur = data(nx.json("GET", f"/tools/registered/{tool_id}/files"))
    if not is_zip():
        with open(a.file, encoding="utf-8") as f:
            local = f.read()
        same = any(f["content"] == local for f in cur.get("files") or [])
        print("current_version", cur.get("current_version"), "| 服务端与本地文件一致:", same)
        return
    local = {path: hashlib.sha256(content).hexdigest() for path, content in check_tool_file(a.file).items()}
    server = {f["path"]: f.get("sha256") or hashlib.sha256(f.get("content", "").encode("utf-8")).hexdigest()
              for f in cur.get("files") or []}
    print(f"文件（服务端 v{cur.get('current_version')} 与本地构建 {os.path.basename(a.file)}）：")
    same = True
    for path in sorted(set(local) | set(server)):
        status = "服务端没有" if path not in server else "只在服务端" if path not in local else \
            "一致" if server[path] == local[path] else "不一致"
        same = same and status == "一致"
        print(f"  {path}: {status}")
    print("current_version", cur.get("current_version"), "| 服务端与本地逐个文件一致:", same)


def cmd_bind(nx, a):
    """以管理员本人的身份按人绑定（PUT /keys/tool-bindings）：只对调用者本人的 Agent 生效，管理员就是属主时才用。"""
    if not KEY:
        raise SystemExit(f"模块 {MODULE_NAME}（{MODULE}）的工具不要密钥，没有可绑定的")
    key_name = a.key_name or KEY_NAME
    if key_name != KEY_NAME:
        raise SystemExit(f"--key-name 应是工具声明的 {KEY_NAME}（收到 {key_name!r}）：平台按声明的名字找绑定")
    if not KEY_ID_RE.fullmatch(a.key_id or ""):
        raise SystemExit(f"--key-id 应是 Nexus 的密钥 ID（形如 key-0123456789ab），收到 {a.key_id!r}")
    module_path = a.module_path or saved_state().get("module_path")
    if not module_path:
        raise SystemExit(f"没有 {rel(STATE)}（这台机器没导入过）：给 --module-path imported_tools/<目录名>/{MODULE}")
    if not re.fullmatch(rf"imported_tools/{TOOL_DIR_RE}/{re.escape(MODULE)}", module_path):
        raise SystemExit(f"--module-path 应是 imported_tools/<目录名>/{MODULE}，收到 {module_path!r}")
    d = data(nx.json("PUT", "/keys/tool-bindings", {"module_path": module_path, "key_name": key_name, "key_id": a.key_id}))
    print(json.dumps({k: d.get(k) for k in ("binding_id", "module_path", "key_name", "key_id", "updated_at") if k in d},
                     ensure_ascii=False))


def cmd_key_create(nx, a):
    if KEY_TYPE != "aws_credentials":
        raise SystemExit(f"key-create 只建 aws_credentials 密钥（IAM 用户的访问密钥）；模块 {MODULE_NAME} 的密钥是 "
                         f"{KEY_TYPE or '（不要密钥）'}：请在 Nexus「密钥管理」里新建，再用 bind 或 Operator 绑定")
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
    template = KEY.get("description") or f"{DESC['name']}：IAM 用户 {{iam_user}} 的访问密钥"
    try:
        r = data(nx.json("POST", "/keys", {
            "name": a.name, "key_type": KEY_TYPE,
            "secret_values": {"access_key_id": akid, "secret_access_key": created["SecretAccessKey"]},
            "description": a.description or template.replace("{iam_user}", a.iam_user),
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
        raise SystemExit(f"{rel(out_path)} 已存在，没有新建密钥（要换新请先在网页上停用旧的并删掉这个文件）")
    r = data(nx.json("POST", f"/publications/{a.publish_id}/keys", {"label": a.label or f"{DESC['name']} smoke test"}))
    plaintext = str(r.get("plaintext") or "")
    cred = (r.get("credential") or {}).get("credential_id")
    if not plaintext.startswith("nxa_"):
        raise SystemExit(f"响应里没有调用密钥明文，没有写文件（credential_id={cred}）")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    fd = os.open(out_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(plaintext)
    plaintext = ""
    print(json.dumps({"credential_id": cred, "publish_id": a.publish_id, "file": rel(out_path),
                      "mode": "600"}, ensure_ascii=False))


COMMANDS = {"import": cmd_import, "check": cmd_check, "publish": cmd_publish, "verify": cmd_verify, "bind": cmd_bind,
            "key-create": cmd_key_create, "issue-call-key": cmd_issue_call_key}


def parse_args(argv=None):
    pre = argparse.ArgumentParser(add_help=False)
    pre.add_argument("--package")
    known, _ = pre.parse_known_args(argv)
    use_package(known.package or OWN_PKG)
    first = next(iter(MODULES))
    ap = argparse.ArgumentParser(description=f"用管理员账号管理 {DESC['name']} 的工具（读 {rel(os.path.join(PKG, nexus_package.FILE))}）")
    ap.add_argument("cmd", choices=list(COMMANDS))
    ap.add_argument("--package", help="包目录（读它的 nexus-package.json），缺省是本脚本所在的包 knowbase-s3vectors-agent")
    ap.add_argument("--module", choices=list(MODULES), default=first,
                    help="，".join(f"{k} = {m['module']}" + ("（缺省）" if k == first else "") for k, m in MODULES.items()))
    ap.add_argument("--file", help="本地构建，缺省是描述里这个模块的 build（"
                                   + "、".join(f"{k}：{m['build']}" for k, m in MODULES.items()) + "）")
    ap.add_argument("--label", help="导入时的目录标签（issue-call-key：调用密钥的标签），缺省是描述里这个模块的 label（"
                                    + "、".join(f"{k}：{m['label']}" for k, m in MODULES.items()) + "）")
    ap.add_argument("--tool-id")
    ap.add_argument("--dir")
    ap.add_argument("--expect-version", type=int)
    ap.add_argument("--again", action="store_true")
    ap.add_argument("--allow-demo-bucket", action="store_true", help="导入示例桶名的工具文件（跳过描述里 unless 为它的检查）")
    ap.add_argument("--notes", help=f"发布说明，缺省「{DESC['name']} 工具更新」")
    ap.add_argument("--module-path", help="bind：imported_tools/<目录名>/<module>，缺省取导入状态文件里的")
    ap.add_argument("--key-name", help="bind：工具声明的密钥名，缺省就是它")
    ap.add_argument("--key-id", help="bind：Nexus 密钥 ID（key-…）")
    ap.add_argument("--name")
    ap.add_argument("--iam-user")
    ap.add_argument("--description")
    ap.add_argument("--publish-id")
    ap.add_argument("--out")
    a = ap.parse_args(argv)
    use_module(a.module)
    if a.file is None:
        a.file = nexus_package.path(PKG, BUILD)
    if a.label is None:
        a.label = MODULES[a.module]["label"]
    if a.notes is None:
        a.notes = f"{DESC['name']} 工具更新"
    return a


def main():
    a = parse_args()
    if a.cmd in ("check", "publish") and not a.tool_id:
        raise SystemExit(f"{a.cmd} 需要 --tool-id")
    if a.cmd == "verify" and not a.dir:
        raise SystemExit("verify 需要 --dir")
    if a.cmd == "bind" and not a.key_id:
        raise SystemExit("bind 需要 --key-id")
    if a.cmd == "key-create" and not (a.name and a.iam_user):
        raise SystemExit("key-create 需要 --name 与 --iam-user")
    if a.cmd == "issue-call-key" and not a.publish_id:
        raise SystemExit("issue-call-key 需要 --publish-id")
    nx = Nexus().login()
    COMMANDS[a.cmd](nx, a)


if __name__ == "__main__":
    main()
