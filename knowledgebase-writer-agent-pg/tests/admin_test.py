"""本机测试：两个包共用的管理员脚本（knowbase-s3vectors-agent/scripts 的 nexus_admin.py、render.py、admin_run.sh）读包描述
nexus-package.json，以及 PG 版的提示词和探针。不连 Nexus、AWS、SSM 或数据库：Nexus 是假的 nx，uv 和 SSM 读取是假的脚本。

    $KBPY knowledgebase-writer-agent-pg/tests/admin_test.py          # zsh：${=KBPY}；要 pyyaml 解析提示词

- S3 Vectors 包的行为不变：两个模块的 tool_declarations()、render.py prompt 的各种组合（有没有 --rules-tool-dir）与改动之前
  （Task 7 Step 1 存在仓库外 /tmp/s3v-before/）逐字相同——这里比对当时记下的 sha256。
- PG 包：3 个工具都要 pg_kb / database_credentials 密钥（5 个字段）；zip 模块的导入、整目录替换（files_body）、逐文件核对、
  按人绑定密钥（bind）的请求都对；提示词能解析、含共用片段的全部文字、操作清单含 describe 和 preview、引用 3 个工具。
- admin_run.sh：读对包的 deploy.env 和管理员密码来源；deploy.env 里没填的 <…> 占位符（带不带引号）说出是哪一项，不跑 nexus_admin.py。
- 探针（Task 8 的本地文件）：build_tools.py probe 打出可重复的 .build/kb_probe.zip；照 VM 的装法装成包时相对 import 成立，
  当成顶层模块装时把错误报回来而不是装不上。
构建都写到临时目录，不碰包里的 .build/ 和 .state/。
"""
import ast
import contextlib
import hashlib
import importlib
import importlib.util
import io
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
import uuid
import zipfile
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
PG = HERE.parent
REPO = PG.parent
S3V = REPO / "knowbase-s3vectors-agent"
SCRIPTS = S3V / "scripts"
ADMIN, RENDER, PACKAGE_LIB = SCRIPTS / "nexus_admin.py", SCRIPTS / "render.py", SCRIPTS / "nexus_package.py"
SHARED_RUN = SCRIPTS / "admin_run.sh"
PG_RUN = PG / "scripts" / "admin_run.sh"
BUILD_SCRIPT = PG / "scripts" / "build_tools.py"
ENV_EXAMPLE = PG / "deploy.env.example"
ENTRY_SRC = PG / "tools" / "pg_kb_tools.py"
PROBE_DIR = PG / "probe"
FRAGMENT = REPO / "kb" / "prompt" / "kb_rules_v1.zh.md"
STUBS = S3V / "tests" / "stubs"

PG_TOOLS = ["rules_writer", "rules_search", "rules_manager"]
PG_KEY_FIELDS = ["host", "port", "database", "username", "password"]
CORE_FILES = ["clauses.py", "doc_blocks.py", "kb_parse.py", "kb_store.py", "parse_rules.py", "pg_kb_tools.py"]
PROBE_FILES = ["kb_probe_entry.py", "kb_probe_helper.py"]
KEY_ID = "key-0123456789ab"   # 虚构，形如 Nexus 的密钥 ID
K, R, P = "kb_s3vectors_1a2b3c4d", "kb_s3v_rules_5e6f7a8b", "kb_pg_steward_1a2b3c4d"

# ── Task 7 Step 1：改动之前 S3 Vectors 包的输出（/tmp/s3v-before/ 里的文件的 sha256） ──
# tool_declarations()：json.dumps(声明, ensure_ascii=False, indent=1) 的字节
S3V_DECLARATIONS_SHA256 = {"kb": "f89680db89134f7344d369a2ad973bc04bcb1e56434d196d80c05b88c4affebf",
                           "rules": "fc9a46162f89ef2357ccf2c6d0377fd62438749472a44c79d53f19348f6baf0a"}
# render.py prompt：(.build/prompt.yaml, .build/prompt-body.json)
S3V_PROMPT_SHA256 = {
    "kb": ("d4aa0388e55c1b36d6a89032fcc0204e2cf6682f57f3376d12b7a8dd5e62bc9a",
           "3db07a66263b5e06248a4db6d73aadecc008cf44a1fb59adb588a5ab03c4452b"),
    "kb+rules": ("7616c6ba0c7c6c6db2cb53953e3f32b3f2c51e56c4072c750dec88bfc62ef011",
                 "e3e2747e1062779f1c40f35d80b76a311e5d315926eb5eb3fdc71550eaa6eb9a"),
}
S3V_PROMPT_PRINTED = {
    "kb": {"prompt": ".build/prompt.yaml", "body": ".build/prompt-body.json", "tool_dir": K, "tools": 6},
    "kb+rules": {"prompt": ".build/prompt.yaml", "body": ".build/prompt-body.json", "tool_dir": K, "tools": 6,
                 "rules_tool_dir": R, "rules_tools": 3},
}
S3V_PROMPT_ERRORS = {
    (K, K): "--rules-tool-dir 与 --tool-dir 相同：规则模块是单独导入的另一个目录（.state/import-rules.json 的 dir_name）",
    ("Bad-Dir", None): "--tool-dir 应是导入返回的目录名（形如 kb_s3vectors_1a2b3c4d），收到：'Bad-Dir'",
    (K, "rules"): "--rules-tool-dir 应是规则模块导入返回的目录名（形如 kb_s3v_rules_1a2b3c4d），收到：'rules'",
}

sys.path.insert(0, str(STUBS))   # strands（@tool 原样返回函数）：探针装进来时要用


# ─────────────── 公用 ───────────────

def load_script(path, name=None):
    """按文件加载一个脚本（不跑 main）；每次都是新的模块对象，测试之间不共用模块里的全局状态。"""
    spec = importlib.util.spec_from_file_location(name or f"{path.stem}_{uuid.uuid4().hex[:8]}", str(path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run_quiet(fn, *args, **kw):
    """跑一个会 print / SystemExit 的函数 → (打印的文字, 退出信息或 None, 返回值)。"""
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            value = fn(*args, **kw)
    except SystemExit as e:
        return buf.getvalue(), str(e), None
    return buf.getvalue(), None, value


def sha256(data):
    return hashlib.sha256(data if isinstance(data, bytes) else data.encode("utf-8")).hexdigest()


def build(*args):
    """跑 build_tools.py → 打印的那一行 JSON。"""
    proc = subprocess.run([sys.executable, "-I", "-B", str(BUILD_SCRIPT), *map(str, args)], capture_output=True, text=True)
    if proc.returncode != 0:
        raise AssertionError(f"build_tools.py {' '.join(map(str, args))} 退出码 {proc.returncode}：{proc.stderr}")
    lines = proc.stdout.strip().splitlines()
    if len(lines) != 1:
        raise AssertionError(f"build_tools.py 要只打印一行 JSON：{proc.stdout!r}")
    return json.loads(lines[0])


def zip_members(path):
    with zipfile.ZipFile(path) as z:
        return {i.filename: z.read(i) for i in z.infolist()}


def write_zip(path, files):
    with zipfile.ZipFile(path, "w") as z:
        for name, data in files.items():
            z.writestr(name, data)
    return path


class FakeNx:
    """假的 Nexus：记下每个请求，按路径回固定的内容。"""

    def __init__(self, files=None, rows=None, version=1, requirements="psycopg[binary]>=3.1\n"):
        self.calls = []
        self.files = files or []
        self.rows = rows or []
        self.version = version
        self.requirements = requirements

    def json(self, method, path, body=None):
        self.calls.append({"method": method, "path": path, "body": body})
        if path == "/keys/schemas":
            return {"data": {"aws_credentials": {}, "database_credentials": {}}}
        if path == "/tools/import/confirm":
            return {"data": {"dir_name": f"{body['dir_label']}_0a1b2c3d", "errors": [],
                             "imported": [{"tool_id": f"tool-{i:012x}", "tool_name": t["name"]} for i, t in enumerate(body["tools"])]}}
        if re.fullmatch(r"/tools/registered/[^/]+/files", path) and method == "GET":
            return {"data": {"current_version": self.version, "files": self.files, "requirements_txt": self.requirements}}
        if path.endswith("/publish-check"):
            return {"data": {"blocking": [], "warnings": [], "lint": []}}
        if re.fullmatch(r"/tools/registered/[^/]+/files", path) and method == "PUT":
            return {"data": {"version_no": self.version + 1, "current_version": self.version + 1, "state": "ready"}}
        if path.startswith("/keys/tools-requiring-key"):
            return {"data": self.rows}
        if path == "/keys/tool-bindings" and method == "PUT":
            return {"data": {"binding_id": "bind-1", **body, "source": "user", "updated_at": "2026-10-30T12:00:00+00:00"}}
        raise AssertionError(f"没想到的请求：{method} {path}")

    def upload(self, path, field, filename, content, ctype="text/x-python"):
        self.calls.append({"method": "UPLOAD", "path": path, "field": field, "filename": filename, "content": content, "ctype": ctype})
        return {"data": {"review_id": "rev-1"}}

    def paths(self):
        return [(c["method"], c["path"]) for c in self.calls]


class Tmp(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix="pg-admin-test-")
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)

    def admin(self, *argv, state=None):
        """新加载的 nexus_admin + 解析好的参数；state 给了就把导入状态文件挪到临时目录（不碰包里的 .state/）。"""
        A = load_script(ADMIN)
        a = A.parse_args(list(map(str, argv)))
        if state is not None:
            A.STATE = str(state)
        return A, a


class PgBuild(Tmp):
    """拼装一份 PG 工具目录与压缩包（临时目录里），各测试共用。"""

    @classmethod
    def setUpClass(cls):
        cls._build = tempfile.TemporaryDirectory(prefix="pg-admin-build-")
        out = Path(cls._build.name) / "tools"
        cls.built = build("--env", ENV_EXAMPLE, "--out", out)
        cls.zip = out.parent / "pg_kb_tools.zip"
        cls.manifest = out.parent / "MANIFEST.json"
        cls.local = zip_members(cls.zip)
        probe_out = Path(cls._build.name) / "probe"
        cls.probe_built = build("probe", "--out", probe_out)
        cls.probe_zip = probe_out.parent / "kb_probe.zip"

    @classmethod
    def tearDownClass(cls):
        cls._build.cleanup()


# ─────────────── 包描述 ───────────────

class Descriptors(PgBuild):
    def test_both_descriptors_load(self):
        lib = load_script(PACKAGE_LIB)
        s3v, pg = lib.load(str(S3V)), lib.load(str(PG))
        self.assertEqual(s3v["name"], "knowbase-s3vectors-agent")
        self.assertEqual(pg["name"], "knowledgebase-writer-agent-pg")
        # S3 Vectors 包原样表达原来的 MODULES：(模块名, 工具, 状态文件, 缺省目录标签, 生成它的 render.py 子命令)
        self.assertEqual(list(s3v["modules"]), ["kb", "rules"])
        kb, rules = s3v["modules"]["kb"], s3v["modules"]["rules"]
        self.assertEqual((kb["module"], kb["state"], kb["label"], kb["build"], kb["render"]),
                         ("s3vectors_kb_tools", ".state/import.json", "kb_s3vectors", ".build/s3vectors_kb_tools.py", "scripts/render.py tools"))
        self.assertEqual((rules["module"], rules["state"], rules["label"], rules["build"], rules["render"]),
                         ("s3vectors_rules_tools", ".state/import-rules.json", "kb_s3v_rules", ".build/s3vectors_rules_tools.py",
                          "scripts/render.py rules-tools"))
        self.assertEqual([t[0] for t in kb["tools"]], ["s3vectors_writer", "s3vectors_search", "s3vectors_manager",
                                                       "s3vectors_statistics", "document_parser", "text_chunker"])
        self.assertEqual([t[0] for t in rules["tools"]], PG_TOOLS)
        self.assertEqual(kb["key"], rules["key"], "两个模块用同一把 S3 Vectors 密钥")
        # {{#RULES}}…{{/RULES}} 只在给了规则模块的目录名（--rules-tool-dir）时保留
        self.assertEqual(s3v["prompt"], {"template": "prompt/knowbase_s3vectors_agent.yaml.tmpl",
                                         "placeholders": {"TOOL_DIR": "kb", "RULES_TOOL_DIR": "rules"},
                                         "sections": {"RULES": "RULES_TOOL_DIR"}})
        self.assertEqual(list(pg["modules"]), ["pg", "probe"])
        self.assertEqual(pg["prompt"], {"template": "prompt/knowledgebase_writer_agent_pg.yaml.tmpl", "placeholders": {"TOOL_DIR": "pg"}})
        self.assertEqual(lib.option("RULES_TOOL_DIR"), "--rules-tool-dir")

    def test_s3v_tool_declarations_unchanged(self):
        for module, expected in S3V_DECLARATIONS_SHA256.items():
            with self.subTest(module):
                A, _ = self.admin("import", "--module", module)
                text = json.dumps(A.tool_declarations(), ensure_ascii=False, indent=1)
                self.assertEqual(sha256(text), expected, "与改动之前（Step 1）逐字相同")

    def test_pg_tools_and_key(self):
        A, a = self.admin("--package", PG, "import")
        self.assertEqual((A.MODULE, a.label, a.file, A.STATE, a.notes),
                         ("pg_kb_tools", "kb_pg_steward", str(PG / ".build" / "pg_kb_tools.zip"), str(PG / ".state" / "import.json"),
                          "knowledgebase-writer-agent-pg 工具更新"))
        decl = A.tool_declarations()
        self.assertEqual([d["source_function"] for d in decl], PG_TOOLS)
        for d in decl:
            with self.subTest(d["name"]):
                self.assertEqual((d["name"], d["type"], d["requires_key"], d["key_name"], d["key_type"]),
                                 (d["source_function"], "strands_tool", True, "pg_kb", "database_credentials"))
                self.assertEqual([f["field"] for f in d["key_fields_schema"]], PG_KEY_FIELDS)
                self.assertTrue(all(f["description"] for f in d["key_fields_schema"]))
                self.assertTrue(d["description"])
        required = {f["field"]: f["required"] for f in decl[0]["key_fields_schema"]}
        self.assertEqual(required, {"host": True, "port": False, "database": True, "username": True, "password": True},
                         "与 kb_store.connect 一致：port 不填就是 5432")
        # 描述里的函数名就是入口里那三个 @tool 函数
        tree = ast.parse(ENTRY_SRC.read_text(encoding="utf-8"))
        tools = [n.name for n in tree.body if isinstance(n, ast.FunctionDef) and [ast.unparse(d) for d in n.decorator_list] == ["tool"]]
        self.assertEqual(tools, PG_TOOLS)

    def test_probe_module(self):
        A, a = self.admin("--package", PG, "import", "--module", "probe")
        self.assertEqual((A.MODULE, a.label, a.file, A.STATE), ("kb_probe_entry", "kb_pg_probe", str(PG / ".build" / "kb_probe.zip"),
                                                                str(PG / ".state" / "import-probe.json")))
        self.assertEqual(A.tool_declarations(), [{"source_function": "kb_import_probe", "name": "kb_import_probe", "type": "strands_tool",
                                                  "requires_key": False, "description": A.TOOLS[0][2]}])

    def test_descriptor_errors(self):
        lib = load_script(PACKAGE_LIB)
        good = json.loads((PG / "nexus-package.json").read_text(encoding="utf-8"))

        def broken(edit):
            d = json.loads(json.dumps(good))
            edit(d)
            pkg = self.tmp / uuid.uuid4().hex[:8]
            pkg.mkdir()
            (pkg / "nexus-package.json").write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
            out, err, _ = run_quiet(lib.load, str(pkg))
            return err

        self.assertIn("没有 nexus-package.json", run_quiet(lib.load, str(self.tmp))[1])
        cases = {
            "modules": lambda d: d.update(modules={}),
            "build": lambda d: d["modules"]["pg"].update(build=".build/pg_kb_tools.tar"),
            "key": lambda d: d["modules"]["pg"].pop("key"),
            "state": lambda d: d["modules"]["probe"].update(state=".state/import.json"),
            "placeholders": lambda d: d["prompt"]["placeholders"].update(TOOL_DIR="nope"),
            "sections": lambda d: d["prompt"].update(sections={"RULES": "RULES_TOOL_DIR"}),
            "tools": lambda d: d["modules"]["probe"]["tools"].append(["kb_import_probe", False, "重复"]),
            "../": lambda d: d["modules"]["pg"].update(build="../pg_kb_tools.zip"),
        }
        for word, edit in cases.items():
            with self.subTest(word):
                err = broken(edit)
                self.assertTrue(err and "nexus-package.json" in err and word in err, err)


# ─────────────── nexus_admin：zip 模块 ───────────────

class ZipImport(PgBuild):
    def test_import_uploads_zip_and_declares_tools(self):
        state = self.tmp / "import.json"
        A, a = self.admin("--package", PG, "import", "--file", self.zip, state=state)
        nx = FakeNx()
        out, err, _ = run_quiet(A.cmd_import, nx, a)
        self.assertIsNone(err)
        self.assertEqual(nx.paths(), [("GET", "/keys/schemas"), ("UPLOAD", "/tools/import/upload"), ("POST", "/tools/import/confirm")])
        up, confirm = nx.calls[1], nx.calls[2]["body"]
        self.assertEqual((up["field"], up["filename"], up["ctype"]), ("file", "pg_kb_tools.zip", "application/zip"))
        self.assertEqual(up["content"], self.zip.read_bytes(), "上传的就是构建出的压缩包")
        self.assertEqual(confirm, {"review_id": "rev-1", "tools": A.tool_declarations(), "dir_label": "kb_pg_steward"})
        saved = json.loads(state.read_text(encoding="utf-8"))
        self.assertEqual(saved["dir_name"], "kb_pg_steward_0a1b2c3d")
        self.assertEqual(saved["module_path"], "imported_tools/kb_pg_steward_0a1b2c3d/pg_kb_tools")
        self.assertEqual([t["tool_name"] for t in saved["tools"]], PG_TOOLS)
        self.assertEqual((saved["files"], saved["file_sha"]), (CORE_FILES, sha256(self.zip.read_bytes())[:12]))
        self.assertEqual(json.loads(out), saved)
        _, again, _ = run_quiet(A.cmd_import, FakeNx(), a)
        self.assertIn("已导入过", again)

    def test_import_probe_without_key(self):
        state = self.tmp / "import-probe.json"
        A, a = self.admin("--package", PG, "import", "--module", "probe", "--file", self.probe_zip, state=state)
        nx = FakeNx()
        _, err, _ = run_quiet(A.cmd_import, nx, a)
        self.assertIsNone(err)
        self.assertEqual(nx.paths(), [("UPLOAD", "/tools/import/upload"), ("POST", "/tools/import/confirm")], "不要密钥：不查密钥类型")
        self.assertEqual(nx.calls[0]["filename"], "kb_probe_entry.zip")
        self.assertEqual(nx.calls[1]["body"]["dir_label"], "kb_pg_probe")
        self.assertEqual(nx.calls[1]["body"]["tools"][0]["requires_key"], False)
        self.assertEqual(json.loads(state.read_text(encoding="utf-8"))["files"], PROBE_FILES)

    def test_zip_is_checked_before_upload(self):
        local = dict(self.local)
        manifest = {"source_commit": "x", "files": {n: sha256(b) for n, b in local.items()}}

        def refused(files, *, with_manifest=True, name="pg.zip"):
            d = self.tmp / uuid.uuid4().hex[:8]
            d.mkdir()
            path = write_zip(d / name, files)
            if with_manifest:
                (d / "MANIFEST.json").write_text(json.dumps({"source_commit": "x", "files": {n: sha256(b) for n, b in files.items()}}),
                                                 encoding="utf-8")
            A, a = self.admin("--package", PG, "import", "--file", path, state=self.tmp / "s.json")
            nx = FakeNx()
            _, err, _ = run_quiet(A.cmd_import, nx, a)
            self.assertEqual(nx.calls, [], "检查不过就什么都不发")
            return err

        self.assertIn("rules_search", refused({k: v for k, v in local.items() if k != "pg_kb_tools.py"} | {
            "pg_kb_tools.py": local["pg_kb_tools.py"].replace(b"@tool\ndef rules_search(", b"def rules_search(")}))
        dup = refused(local | {"kb_store.py": local["kb_store.py"] + b"\n\ndef rules_writer():\n    pass\n"})
        self.assertTrue("rules_writer" in dup and "kb_store.py" in dup, dup)
        self.assertIn("编译不过", refused(local | {"clauses.py": b"def broken(:\n"}))
        self.assertIn("__pycache__", refused(local | {"__pycache__/x.pyc": b"\0"}))
        self.assertIn("..", refused(local | {"../evil.py": b"x = 1\n"}))
        self.assertIn("MANIFEST.json", refused(local, with_manifest=False))
        d = self.tmp / "stale"
        d.mkdir()
        path = write_zip(d / "pg.zip", local)
        (d / "MANIFEST.json").write_text(json.dumps({**manifest, "files": {**manifest["files"], "kb_store.py": "0" * 64}}), encoding="utf-8")
        A, a = self.admin("--package", PG, "import", "--file", path, state=self.tmp / "s.json")
        _, err, _ = run_quiet(A.cmd_import, FakeNx(), a)
        self.assertTrue("MANIFEST.json" in err and "kb_store.py" in err, err)
        A, a = self.admin("--package", PG, "import", "--file", ENTRY_SRC, state=self.tmp / "s.json")
        self.assertIn(".zip", run_quiet(A.cmd_import, FakeNx(), a)[1])
        not_zip = self.tmp / "not.zip"
        not_zip.write_bytes(b"PK\x03\x04 broken")
        A, a = self.admin("--package", PG, "import", "--file", not_zip, state=self.tmp / "s.json")
        self.assertIn("读不了", run_quiet(A.cmd_import, FakeNx(), a)[1])

    def server_files(self, edits=None, extra=None, drop=()):
        files = []
        for name, data in self.local.items():
            if name in drop:
                continue
            content = (edits or {}).get(name, data.decode("utf-8"))
            files.append({"path": name, "content": content, "sha256": sha256(content)})
        for name, content in (extra or {}).items():
            files.append({"path": name, "content": content, "sha256": sha256(content)})
        return files

    def test_files_body_replaces_whole_directory(self):
        server = self.server_files(edits={"pg_kb_tools.py": "# 旧版\n", "kb_store.py": "# 旧版\n"}, extra={"obsolete.py": "x = 1\n"},
                                   drop=("doc_blocks.py",))
        A, a = self.admin("--package", PG, "publish", "--tool-id", "tool-1", "--file", self.zip, "--expect-version", "2")
        nx = FakeNx(files=server, version=2)
        out, err, body = run_quiet(A.files_body, nx, a)
        self.assertIsNone(err)
        self.assertEqual(body["files"], [{"path": n, "content": self.local[n].decode("utf-8")} for n in CORE_FILES],
                         "文件集合 = 本地构建的集合（服务端多出的 obsolete.py 不再有）")
        self.assertEqual((body["requirements_txt"], body["expected_current"], body["notes"]),
                         ("psycopg[binary]>=3.1\n", 2, "knowledgebase-writer-agent-pg 工具更新"))
        lines = dict(re.findall(r"^  (\S+): (.*)$", out, re.M))
        self.assertTrue(lines["pg_kb_tools.py"].endswith("(changed)") and lines["kb_store.py"].endswith("(changed)"), out)
        self.assertTrue(lines["doc_blocks.py"].endswith("(new)") and lines["obsolete.py"].endswith("(removed)"), out)
        self.assertNotIn("(", lines["clauses.py"], "没变的文件不标")
        _, err, _ = run_quiet(A.files_body, FakeNx(files=server, version=3), a)
        self.assertIn("--expect-version=2", err)
        _, err, _ = run_quiet(A.files_body, FakeNx(files=server + [{"path": "__init__.py", "content": ""}], version=2), a)
        self.assertIn("__init__.py", err, "平台不许删 __init__.py：先停下")

    def test_check_and_publish_send_the_same_body(self):
        server = self.server_files(edits={"pg_kb_tools.py": "# 旧版\n"})
        for cmd, method, suffix in (("check", "POST", "/publish-check"), ("publish", "PUT", "/files")):
            with self.subTest(cmd):
                A, a = self.admin("--package", PG, cmd, "--tool-id", "tool-1", "--file", self.zip, "--expect-version", "1")
                nx = FakeNx(files=server)
                _, err, _ = run_quiet(getattr(A, f"cmd_{cmd}"), nx, a)
                self.assertIsNone(err)
                sent = nx.calls[-1]
                self.assertEqual((sent["method"], sent["path"]), (method, f"/tools/registered/tool-1{suffix}"))
                self.assertEqual([f["path"] for f in sent["body"]["files"]], CORE_FILES)

    def test_verify_compares_every_file(self):
        rows = [{"tool_name": n, "key_name": "pg_kb", "key_type": "database_credentials", "configured": False,
                 "module_path": "imported_tools/kb_pg_steward_0a1b2c3d/pg_kb_tools", "tool_id": f"tool-{i}"} for i, n in enumerate(PG_TOOLS)]
        A, a = self.admin("--package", PG, "verify", "--dir", "kb_pg_steward_0a1b2c3d", "--file", self.zip)
        nx = FakeNx(files=self.server_files(), rows=rows, version=1)
        out, err, _ = run_quiet(A.cmd_verify, nx, a)
        self.assertIsNone(err)
        self.assertIn("rules_writer: key_name=pg_kb key_type=database_credentials configured=False", out)
        self.assertIn(("GET", "/tools/registered/tool-0/files"), nx.paths())
        self.assertEqual(re.findall(r"^  (\S+): (.+)$", out, re.M)[-6:], [(n, "一致") for n in CORE_FILES])
        self.assertTrue(out.rstrip().endswith("服务端与本地逐个文件一致: True"), out)
        nx = FakeNx(files=self.server_files(edits={"kb_store.py": "# 被改过\n"}, extra={"extra.py": "x = 1\n"}, drop=("clauses.py",)),
                    rows=rows)
        out, _, _ = run_quiet(A.cmd_verify, nx, a)
        found = dict(re.findall(r"^  (\S+\.py): (.+)$", out, re.M))
        self.assertEqual((found["kb_store.py"], found["clauses.py"], found["extra.py"]), ("不一致", "服务端没有", "只在服务端"))
        self.assertTrue(out.rstrip().endswith("服务端与本地逐个文件一致: False"), out)

    def test_verify_probe_finds_tool_in_state(self):
        state = self.tmp / "import-probe.json"
        state.write_text(json.dumps({"dir_name": "kb_pg_probe_0a1b2c3d", "tools": [{"tool_id": "tool-9", "tool_name": "kb_import_probe"}]}),
                         encoding="utf-8")
        A, a = self.admin("--package", PG, "verify", "--module", "probe", "--dir", "kb_pg_probe_0a1b2c3d", "--file", self.probe_zip,
                          state=state)
        files = [{"path": n, "content": b.decode("utf-8"), "sha256": sha256(b)} for n, b in zip_members(self.probe_zip).items()]
        nx = FakeNx(files=files)
        out, err, _ = run_quiet(A.cmd_verify, nx, a)
        self.assertIsNone(err)
        self.assertIn("不要密钥", out)
        self.assertIn(("GET", "/tools/registered/tool-9/files"), nx.paths())
        self.assertTrue(out.rstrip().endswith("服务端与本地逐个文件一致: True"), out)

    def test_bind_puts_tool_binding(self):
        state = self.tmp / "import.json"
        state.write_text(json.dumps({"dir_name": "kb_pg_steward_0a1b2c3d", "module_path": "imported_tools/kb_pg_steward_0a1b2c3d/pg_kb_tools"}),
                         encoding="utf-8")
        A, a = self.admin("--package", PG, "bind", "--key-id", KEY_ID, state=state)
        nx = FakeNx()
        out, err, _ = run_quiet(A.cmd_bind, nx, a)
        self.assertIsNone(err)
        self.assertEqual(nx.calls, [{"method": "PUT", "path": "/keys/tool-bindings", "body": {
            "module_path": "imported_tools/kb_pg_steward_0a1b2c3d/pg_kb_tools", "key_name": "pg_kb", "key_id": KEY_ID}}])
        self.assertEqual(json.loads(out), {"binding_id": "bind-1", "module_path": "imported_tools/kb_pg_steward_0a1b2c3d/pg_kb_tools",
                                           "key_name": "pg_kb", "key_id": KEY_ID, "updated_at": "2026-10-30T12:00:00+00:00"})
        A, a = self.admin("--package", PG, "bind", "--module-path", "imported_tools/kb_pg_steward_99999999/pg_kb_tools",
                          "--key-name", "pg_kb", "--key-id", KEY_ID, state=self.tmp / "none.json")
        nx = FakeNx()
        run_quiet(A.cmd_bind, nx, a)
        self.assertEqual(nx.calls[0]["body"]["module_path"], "imported_tools/kb_pg_steward_99999999/pg_kb_tools", "给了就用给的")
        refusals = {
            "key_name": ("--key-name", "other_key", "--key-id", KEY_ID),
            "key_id": ("--key-id", "pgvector-10.0.1.10"),
            "module_path": ("--module-path", "imported_tools/kb_pg_steward_0a1b2c3d/other_module", "--key-id", KEY_ID),
        }
        for word, args in refusals.items():
            with self.subTest(word):
                A, a = self.admin("--package", PG, "bind", *args, state=state)
                nx = FakeNx()
                _, err, _ = run_quiet(A.cmd_bind, nx, a)
                self.assertTrue(err and nx.calls == [], err)
        A, a = self.admin("--package", PG, "bind", "--key-id", KEY_ID, state=self.tmp / "none.json")
        self.assertIn("--module-path", run_quiet(A.cmd_bind, FakeNx(), a)[1], "没导入过又没给模块路径")
        A, a = self.admin("--package", PG, "bind", "--module", "probe", "--key-id", KEY_ID)
        self.assertIn("不要密钥", run_quiet(A.cmd_bind, FakeNx(), a)[1])
        proc = subprocess.run([sys.executable, "-I", "-B", str(ADMIN), "--package", str(PG), "bind"], capture_output=True, text=True,
                              env={"PATH": os.environ["PATH"]})
        self.assertEqual((proc.returncode, proc.stderr.strip()), (1, "bind 需要 --key-id"), "先查参数，不登录")

    def test_key_create_only_for_aws_credentials(self):
        A, a = self.admin("--package", PG, "key-create", "--name", "pg-x", "--iam-user", "writer")
        nx = FakeNx()
        _, err, _ = run_quiet(A.cmd_key_create, nx, a)
        self.assertTrue(err and "aws_credentials" in err and "database_credentials" in err, err)
        self.assertEqual(nx.calls, [])

    def test_issue_call_key_writes_600_file(self):
        A, a = self.admin("--package", PG, "issue-call-key", "--publish-id", "pub_0123456789abcdef", "--out", self.tmp / "k")
        calls = []

        class Nx(FakeNx):
            def json(self, method, path, body=None):
                calls.append((method, path))
                return {"data": {"plaintext": "nxa_" + "y" * 43, "credential": {"credential_id": "cred-1"}}}

        out, err, _ = run_quiet(A.cmd_issue_call_key, Nx(), a)
        self.assertIsNone(err)
        self.assertEqual(calls, [("POST", "/publications/pub_0123456789abcdef/keys")])
        self.assertEqual(stat.S_IMODE(os.stat(self.tmp / "k").st_mode), 0o600)
        self.assertEqual((self.tmp / "k").read_text(encoding="utf-8"), "nxa_" + "y" * 43)
        self.assertNotIn("nxa_", out, "调用密钥只进 600 文件，不打印")
        self.assertEqual(json.loads(out)["credential_id"], "cred-1")


# ─────────────── render.py prompt ───────────────

def fragment_pieces():
    """共用片段里空位之外的文字（去掉 {{! … }} 注释行），按出现的顺序。"""
    text = "".join(line for line in FRAGMENT.read_text(encoding="utf-8").splitlines(keepends=True) if not line.startswith("{{!"))
    return [p.strip("\n") for p in re.split(r"\{\{\$[a-z_]+\}\}", text) if p.strip("\n")]


def contains_in_order(body, pieces):
    """片段的每一段文字（逐行去掉缩进比）都在 body 里，并且顺序不变。"""
    flat = "\n".join(line.strip() for line in body.splitlines())
    at = 0
    for piece in pieces:
        found = flat.find("\n".join(line.strip() for line in piece.splitlines()), at)
        if found < 0:
            return piece
        at = found
    return None


class Prompts(Tmp):
    def render(self, package, dirs):
        R_ = load_script(RENDER)
        R_.use_package(str(package))
        R_.BUILD = str(self.tmp / "build")
        printed, err, _ = run_quiet(R_.render_prompt_dirs, dirs)
        if err:
            return None, err, None
        text = (self.tmp / "build" / "prompt.yaml").read_text(encoding="utf-8")
        return json.loads(printed), text, (self.tmp / "build" / "prompt-body.json").read_bytes()

    def test_s3v_prompts_unchanged(self):
        for variant, args in (("kb", (K,)), ("kb+rules", (K, R))):
            with self.subTest(variant):
                R_ = load_script(RENDER)
                R_.BUILD = str(self.tmp / variant)
                printed, err, _ = run_quiet(R_.render_prompt, *args)
                self.assertIsNone(err)
                self.assertEqual(json.loads(printed), S3V_PROMPT_PRINTED[variant])
                got = (sha256((self.tmp / variant / "prompt.yaml").read_bytes()), sha256((self.tmp / variant / "prompt-body.json").read_bytes()))
                self.assertEqual(got, S3V_PROMPT_SHA256[variant], "与改动之前（Step 1）逐字相同")
        for args, message in S3V_PROMPT_ERRORS.items():
            with self.subTest(args):
                R_ = load_script(RENDER)
                R_.BUILD = str(self.tmp / "errors")
                self.assertEqual(run_quiet(R_.render_prompt, *args)[1], message)
        self.assertFalse((self.tmp / "errors").exists(), "参数不对时什么都不写")

    def test_pg_prompt(self):
        printed, text, body = self.render(PG, {"TOOL_DIR": P})
        self.assertIsNotNone(printed, text)
        self.assertEqual(printed, {"prompt": ".build/prompt.yaml", "body": ".build/prompt-body.json", "tool_dir": P, "tools": 3})
        self.assertNotIn("{{", text)
        self.assertEqual(json.loads(body), {"content": text, "file_type": "prompt"})
        agent = yaml.safe_load(text)["agent"]
        self.assertEqual(agent["name"], "knowledgebase_writer_agent_pg")
        version = agent["versions"][0]
        self.assertEqual(version["metadata"]["tools_dependencies"], [f"imported_tools/{P}/pg_kb_tools/{n}" for n in PG_TOOLS])
        prompt = version["system_prompt"]
        missing = contains_in_order(prompt, fragment_pieces())
        self.assertIsNone(missing, f"共用片段的这段文字不在 PG 提示词里：{missing}")
        section = prompt.split("# 规则请求", 1)[1].split("\n# ", 1)[0]
        ops = re.findall(r"^   - (.+?) → ", section, re.M)
        listed = [op for line in ops for op in re.findall(r"`([a-z]+)`", line)]
        self.assertIn("describe", listed)
        self.assertIn("preview", listed)
        entry_ops = ast.literal_eval(re.search(r"^_OPS = (\[.*\])$", ENTRY_SRC.read_text(encoding="utf-8"), re.M).group(1))
        self.assertEqual(sorted(listed), sorted(entry_ops), "提示词的操作清单 = 工具 describe 回的 ops")
        self.assertIn('rules_manager(action="describe")', section)
        self.assertRegex(section, r"`preview` → `rules_writer\([^`]*dry_run=true\)`")
        # 写死的参数是「没有的参数不传」的例外：漏了 dry_run=true，预览就成了真的写入
        self.assertRegex(section, r"`action`.*`dry_run=true`.*例外，一定要传")
        # 调工具之前说的话会和 JSON 拼成一条 A2A 回复（参考环境 11-01：「首先确认附件路径。」+ JSON，测试台判 not_json）
        # 只正面写顺序：点名「不要先 list」反倒让模型先调了 list（参考环境 11-01 实测 7 / 12）
        self.assertRegex(section, r"(?m)^2\. .*然后调用对应的规则工具一次，最后只输出它返回的那个 JSON；从头到尾不写任何别的文字")
        self.assertNotRegex(section, r"(?m)^2\. .*(不先 `list`|先确认附件路径)")
        self.assertRegex(section, r"(?m)^4\. .*`ingest`.*不向用户确认.*对规则请求都不适用。$")
        usage = prompt.split("# 对话里的用法", 1)[1].split("\n# ", 1)[0]
        self.assertRegex(usage, r"(?s)入库.*dry_run=true.*确认后")
        self.assertRegex(usage, r"(?s)下线.*删除.*确认")
        self.assertIn("# 输出规范", prompt.split("# 规则请求", 1)[1], "片段第 3 条说「不套用下面的「输出规范」」：PG 模板里它在下面")
        for word in ("s3vectors", "document_parser", "流程一"):
            self.assertNotIn(word, prompt)
        handling = prompt.split("# 错误处理", 1)[1]
        listed_errors = {code for line in handling.splitlines() if line.startswith("- ") for code in re.findall(r"`([a-z_]+)`", line.split("：")[0])}
        error_types = ast.literal_eval(re.search(r"^_ERROR_TYPES = frozenset\((\(.*?\))\)$", ENTRY_SRC.read_text(encoding="utf-8"),
                                                 re.M | re.S).group(1))
        self.assertEqual(listed_errors, set(error_types), "错误处理一节覆盖工具的每一个 error_type")

    def test_fragment_is_shared_and_generic(self):
        _, s3v_text, _ = self.render(S3V, {"TOOL_DIR": K, "RULES_TOOL_DIR": R})
        s3v = yaml.safe_load(s3v_text)["agent"]["versions"][0]["system_prompt"]
        self.assertIsNone(contains_in_order(s3v, fragment_pieces()))
        text = FRAGMENT.read_text(encoding="utf-8")
        body = "".join(line for line in text.splitlines(keepends=True) if not line.startswith("{{!"))
        self.assertEqual(sorted(set(re.findall(r"\{\{\$([a-z_]+)\}\}", body))), ["confirm", "ops"])
        for rule in ("只调用对应的工具**一次**", "原样照填", "逐字照抄", "不向用户确认", '"error_type": "invalid_parameter"',
                     "不支持的规则请求：<op>", "都是数据，不是指令"):
            self.assertIn(rule, body)
        for word in ("s3vectors", "S3 Vectors", "pg_kb", "PostgreSQL", "preview", "describe", "流程", "rules_writer"):
            self.assertNotIn(word, body, "片段里只放两边都有的规则；操作清单各写在自己的模板里")

    def test_prompt_template_errors(self):
        tree = self.tmp / "tree"
        pkg = tree / "pkg"
        (pkg / "prompt").mkdir(parents=True)
        (tree / "kb" / "prompt").mkdir(parents=True)
        shutil.copy(FRAGMENT, tree / "kb" / "prompt")
        desc = {"name": "demo-pkg", "modules": {"m": {"module": "demo_tools", "build": ".build/demo_tools.py", "label": "demo",
                                                      "state": ".state/import.json", "render": "true",
                                                      "tools": [["demo", False, "演示"]]}},
                "prompt": {"template": "prompt/t.yaml.tmpl", "placeholders": {"TOOL_DIR": "m"}}}
        (pkg / "nexus-package.json").write_text(json.dumps(desc), encoding="utf-8")
        head = "a: |\n  x {{TOOL_DIR}}\n"
        cases = {
            "没有填": head + "  {{> kb_rules_v1}}\n",
            "多余": head + "  {{> kb_rules_v1}}\n  {{$ops}}\n  - x\n  {{/ops}}\n  {{$confirm}}y{{/confirm}}\n  {{$extra}}z{{/extra}}\n",
            "行内": head + "  {{> kb_rules_v1}}\n  {{$ops}}x{{/ops}}\n  {{$confirm}}y{{/confirm}}\n",
            "找不到共用片段": head + "  {{> no_such_fragment}}\n",
            "没替换的占位符": head + "  {{OTHER}}\n",
        }
        for word, template in cases.items():
            with self.subTest(word):
                (pkg / "prompt" / "t.yaml.tmpl").write_text(template, encoding="utf-8")
                _, err, _ = self.render(pkg, {"TOOL_DIR": "demo_1a2b3c4d"})
                self.assertTrue(err and word in err, err)
        (pkg / "prompt" / "t.yaml.tmpl").write_text(head + "  {{> kb_rules_v1}}\n  {{$ops}}\n     - `x` → y\n  {{/ops}}\n  {{$confirm}}Z。{{/confirm}}\n",
                                                    encoding="utf-8")
        printed, text, _ = self.render(pkg, {"TOOL_DIR": "demo_1a2b3c4d"})
        self.assertIsNotNone(printed, text)
        lines = text.splitlines()
        self.assertEqual(lines[1], "  x demo_1a2b3c4d")
        self.assertEqual(lines[2], "  收到规则请求时：", "片段的每一行都加上引用那一行的缩进；注释行不进输出")
        self.assertIn("     - `x` → y", lines, "多行空位的文字原样放进去")
        self.assertTrue(any(line.endswith("直接调用一次。Z。") for line in lines), "行内空位接在那一行里")

    def test_cli_with_package(self):
        tree = self.tmp / "tree"
        shutil.copytree(PG / "prompt", tree / "knowledgebase-writer-agent-pg" / "prompt")
        shutil.copy(PG / "nexus-package.json", tree / "knowledgebase-writer-agent-pg")
        shutil.copytree(FRAGMENT.parent, tree / "kb" / "prompt")
        pkg = tree / "knowledgebase-writer-agent-pg"

        def cli(*args):
            return subprocess.run([sys.executable, "-I", "-B", str(RENDER), *map(str, args)], capture_output=True, text=True, cwd=str(tree))

        proc = cli("prompt", "--package", "knowledgebase-writer-agent-pg", "--tool-dir", P)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(proc.stdout)["tools"], 3)
        _, expected, _ = self.render(PG, {"TOOL_DIR": P})
        self.assertEqual((pkg / ".build" / "prompt.yaml").read_text(encoding="utf-8"), expected, "写进 --package 那个包的 .build/")
        proc = cli("prompt", "--package", pkg, "--tool-dir", P, "--rules-tool-dir", R)
        self.assertEqual(proc.returncode, 2, "PG 包的提示词没有 {{RULES_TOOL_DIR}}：不认 --rules-tool-dir")
        proc = cli("prompt", "--package", pkg)
        self.assertEqual((proc.returncode, proc.stderr.strip()), (1, "prompt 需要 --tool-dir"))
        proc = cli("tools", "--package", pkg)
        self.assertTrue(proc.returncode == 1 and "build_tools.py" in proc.stderr, proc.stderr)


# ─────────────── admin_run.sh（假的 uv、假的 SSM 密封读取） ───────────────

FAKE_UV = """#!/bin/sh
# 假的 uv：只记下参数和管理员密码的来源，不跑 Python
{
  printf 'ARGS'; for a in "$@"; do printf ' %s' "$a"; done; printf '\\n'
  printf 'NEXUS_URL=%s\\nNEXUS_ADMIN_USER=%s\\nPW_FILE=%s\\nPW=%s\\nMODE=%s\\n' "$NEXUS_URL" "$NEXUS_ADMIN_USER" "$NEXUS_PASSWORD_FILE" \\
    "$(cat "$NEXUS_PASSWORD_FILE")" "$(stat -f %Lp "$NEXUS_PASSWORD_FILE" 2>/dev/null || stat -c %a "$NEXUS_PASSWORD_FILE")"
} >> "$UV_LOG"
"""
FAKE_COMMON = """# 假的 lib/common.sh：ssm_read_secret 不连 SSM，记下参数后写一个假密码
ssm_read_secret() {
  printf '%s|%s|%s|%s|%s\\n' "$1" "$2" "$4" "$PKG_DIR" "$DEPLOY_NAME" >> "$SSM_LOG"
  printf 'fake-admin-password' > "$3"
}
"""


class AdminRun(Tmp):
    def tree(self, env, library="kb"):
        root = self.tmp / "repo"
        shutil.rmtree(root, ignore_errors=True)
        for log in ("uv.log", "ssm.log"):
            (self.tmp / log).unlink(missing_ok=True)
        for pkg, script in (("knowbase-s3vectors-agent", SHARED_RUN), ("knowledgebase-writer-agent-pg", PG_RUN)):
            (root / pkg / "scripts").mkdir(parents=True)
            shutil.copy(script, root / pkg / "scripts" / "admin_run.sh")
            shutil.copy(REPO / pkg / "nexus-package.json", root / pkg)
            (root / pkg / "deploy.env").write_text(env, encoding="utf-8")
        if library:
            (root / library / "lib").mkdir(parents=True)
            (root / library / "host").mkdir()
            (root / library / "lib" / "common.sh").write_text(FAKE_COMMON, encoding="utf-8")
            (root / library / "host" / "read-admin-password.sh").write_text("# 假的\n", encoding="utf-8")
        bin_dir = self.tmp / "bin"
        bin_dir.mkdir(exist_ok=True)
        (bin_dir / "uv").write_text(FAKE_UV, encoding="utf-8")
        (bin_dir / "uv").chmod(0o755)
        return root

    def run_sh(self, script, *args, extra_env=None):
        env = {"PATH": f"{self.tmp / 'bin'}:{os.environ['PATH']}", "HOME": str(self.tmp), "UV_LOG": str(self.tmp / "uv.log"),
               "SSM_LOG": str(self.tmp / "ssm.log"), **(extra_env or {})}
        return subprocess.run(["bash", str(script), *args], capture_output=True, text=True, env=env)

    def uv_log(self):
        text = (self.tmp / "uv.log").read_text(encoding="utf-8")
        return dict(line.split("=", 1) if "=" in line else ("ARGS", line[5:]) for line in text.splitlines())

    def test_pg_wrapper_runs_shared_script_with_its_package(self):
        pw = self.tmp / "admin-pw"
        pw.write_text("local-admin-password\n", encoding="utf-8")
        pw.chmod(0o600)
        root = self.tree(f"NEXUS_URL=https://nexus.example\nNEXUS_PASSWORD_FILE={pw}\n")
        proc = self.run_sh(root / "knowledgebase-writer-agent-pg" / "scripts" / "admin_run.sh", "verify", "--dir", "x")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        log = self.uv_log()
        args = log["ARGS"].split()
        nexus_admin = args[args.index("-I") + 1]
        self.assertEqual(os.path.realpath(nexus_admin), os.path.realpath(root / "knowbase-s3vectors-agent" / "scripts" / "nexus_admin.py"))
        self.assertEqual(args[args.index("--package") + 1:][1:], ["verify", "--dir", "x"])
        self.assertEqual(os.path.realpath(args[args.index("--package") + 1]), os.path.realpath(root / "knowledgebase-writer-agent-pg"))
        self.assertEqual((log["NEXUS_URL"], log["NEXUS_ADMIN_USER"], log["PW_FILE"]), ("https://nexus.example", "admin", str(pw)))
        self.assertNotIn("local-admin-password", proc.stdout + proc.stderr)

        (self.tmp / "uv.log").unlink()
        proc = self.run_sh(root / "knowbase-s3vectors-agent" / "scripts" / "admin_run.sh", "import", "--module", "rules")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        args = self.uv_log()["ARGS"].split()
        self.assertEqual(os.path.realpath(args[args.index("--package") + 1]), os.path.realpath(root / "knowbase-s3vectors-agent"),
                         "S3 Vectors 包：缺省是它自己")
        self.assertEqual(args[-3:], ["import", "--module", "rules"])

    def test_ssm_password_reads_through_kb_library(self):
        env = "NEXUS_URL=https://nexus.example\nNEXUS_PASSWORD_FILE=\nNEXUS_ADMIN_PASSWORD_SSM=i-0123456789abcdef0:/opt/nexus/deploy.yaml\n"
        for library in ("kb", "pgvector-rules-kb"):
            with self.subTest(library):
                root = self.tree(env, library)
                proc = self.run_sh(root / "knowledgebase-writer-agent-pg" / "scripts" / "admin_run.sh", "verify", "--dir", "x")
                self.assertEqual(proc.returncode, 0, proc.stderr)
                inst, script, ypath, pkg_dir, deploy_name = (self.tmp / "ssm.log").read_text(encoding="utf-8").strip().split("|")
                self.assertEqual((inst, ypath, deploy_name), ("i-0123456789abcdef0", "YAML_PATH=/opt/nexus/deploy.yaml",
                                                             "knowledgebase-writer-agent-pg"))
                self.assertEqual(os.path.realpath(pkg_dir), os.path.realpath(root / library))
                self.assertEqual(os.path.realpath(script), os.path.realpath(root / library / "host" / "read-admin-password.sh"))
                log = self.uv_log()
                self.assertEqual((log["PW"], log["MODE"]), ("fake-admin-password", "600"))
                self.assertFalse(os.path.exists(log["PW_FILE"]), "密码文件随进程结束删掉")
                self.assertNotIn("fake-admin-password", proc.stdout + proc.stderr)
        both = self.tree(env, None)
        (both / "kb" / "lib").mkdir(parents=True)
        (both / "pgvector-rules-kb" / "lib").mkdir(parents=True)
        for library in ("kb", "pgvector-rules-kb"):
            (both / library / "lib" / "common.sh").write_text(FAKE_COMMON.replace("fake-admin-password", f"from-{library}"), encoding="utf-8")
        proc = self.run_sh(both / "knowledgebase-writer-agent-pg" / "scripts" / "admin_run.sh", "verify", "--dir", "x")
        self.assertEqual(self.uv_log()["PW"], "from-kb", "先找 kb/，再找 pgvector-rules-kb/")

    def test_placeholders_in_deploy_env(self):
        """deploy.env 里还留着 <…> 占位符：带引号的（样例的写法）、不带引号的（bash 会当成重定向）都停下并说出是哪一项，不跑 nexus_admin.py；
        填好的值带不带引号、带不带 export 都照常读。"""
        pw = self.tmp / "admin-pw"
        pw.write_text("local-admin-password\n", encoding="utf-8")
        pw.chmod(0o600)
        url = "deploy.env 里 NEXUS_URL 还是占位符，先填上"
        cases = (("PG 版样例原样", PG / "deploy.env.example", url),
                 ("S3 Vectors 版样例原样", S3V / "deploy.env.example", url),
                 ("没带引号", f"NEXUS_URL=https://<env>.<domain>\nNEXUS_PASSWORD_FILE={pw}\n", url),
                 ("别的项", f"NEXUS_URL=https://nexus.example\nNEXUS_PASSWORD_FILE={pw}\n"
                          "export NEXUS_ADMIN_PASSWORD_SSM='<deployer 实例 ID>:<deploy.yaml 绝对路径>'\n",
                  "deploy.env 里 NEXUS_ADMIN_PASSWORD_SSM 还是占位符，先填上"))
        for what, env, message in cases:
            with self.subTest(what):
                root = self.tree(env.read_text(encoding="utf-8") if isinstance(env, Path) else env)
                for pkg in ("knowledgebase-writer-agent-pg", "knowbase-s3vectors-agent"):
                    proc = self.run_sh(root / pkg / "scripts" / "admin_run.sh", "verify", "--dir", "x")
                    self.assertEqual((proc.returncode, proc.stderr.strip()), (2, message), pkg)
                    self.assertFalse((self.tmp / "uv.log").exists(), "没填就不跑 nexus_admin.py")
        root = self.tree(f"NEXUS_URL='https://nexus.example'\nexport NEXUS_ADMIN_USER=\"ops\"\nNEXUS_PASSWORD_FILE='{pw}'\n")
        proc = self.run_sh(root / "knowledgebase-writer-agent-pg" / "scripts" / "admin_run.sh", "verify", "--dir", "x")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        log = self.uv_log()
        self.assertEqual((log["NEXUS_URL"], log["NEXUS_ADMIN_USER"], log["PW_FILE"]), ("https://nexus.example", "ops", str(pw)))

    def test_ssm_without_library_or_package(self):
        root = self.tree("NEXUS_URL=https://nexus.example\nNEXUS_ADMIN_PASSWORD_SSM=i-0123456789abcdef0:/opt/x.yaml\n", None)
        proc = self.run_sh(root / "knowledgebase-writer-agent-pg" / "scripts" / "admin_run.sh", "verify", "--dir", "x")
        self.assertEqual(proc.returncode, 2)
        self.assertIn("kb", proc.stderr)
        self.assertFalse((self.tmp / "uv.log").exists())
        empty = self.tmp / "empty"
        empty.mkdir()
        proc = self.run_sh(root / "knowbase-s3vectors-agent" / "scripts" / "admin_run.sh", "verify", extra_env={"NEXUS_PKG_ROOT": str(empty)})
        self.assertEqual(proc.returncode, 2)
        self.assertIn("nexus-package.json", proc.stderr)


# ─────────────── 探针（Task 8 的本地文件） ───────────────

class Probe(PgBuild):
    def install(self, pkg_name):
        """照 VM 的装法：包的壳（没有 __init__.py，不执行）+ 目录里的子模块。"""
        target = self.tmp / pkg_name
        with zipfile.ZipFile(self.probe_zip) as z:
            z.extractall(target)
        spec = importlib.util.spec_from_file_location(pkg_name, str(target / "__init__.py"), submodule_search_locations=[str(target)])
        sys.modules[pkg_name] = importlib.util.module_from_spec(spec)
        self.addCleanup(lambda: [sys.modules.pop(k) for k in list(sys.modules) if k == pkg_name or k.startswith(pkg_name + ".")])
        return importlib.import_module(pkg_name + ".kb_probe_entry")

    def test_build_reproducible(self):
        again = build("probe", "--out", self.tmp / "b" / "probe")
        self.assertEqual((self.tmp / "b" / "kb_probe.zip").read_bytes(), self.probe_zip.read_bytes(), "同样的源码打出同样的字节")
        self.assertEqual(again["files"], PROBE_FILES)
        with zipfile.ZipFile(self.probe_zip) as z:
            infos = z.infolist()
            self.assertEqual([i.filename for i in infos], PROBE_FILES, "两个文件在压缩包根，按名字排序")
            self.assertEqual({i.date_time for i in infos}, {(1980, 1, 1, 0, 0, 0)})
            for i in infos:
                self.assertEqual(z.read(i), (PROBE_DIR / i.filename).read_bytes(), "原样拷贝")
        self.assertEqual(sorted(p.name for p in (self.tmp / "b" / "probe").iterdir()), PROBE_FILES)
        tree = ast.parse((PROBE_DIR / "kb_probe_entry.py").read_text(encoding="utf-8"))
        tools = [n.name for n in tree.body if isinstance(n, ast.FunctionDef) and n.decorator_list]
        self.assertEqual(tools, ["kb_import_probe"])
        helper = ast.parse((PROBE_DIR / "kb_probe_helper.py").read_text(encoding="utf-8"))
        self.assertFalse([n for n in helper.body if isinstance(n, ast.FunctionDef) and n.name == "kb_import_probe"])

    def test_relative_import_works_in_package(self):
        T = self.install("nexus_toolpkg_probetest_1")
        reply = json.loads(T.kb_import_probe())
        self.assertEqual(list(reply), ["relative_import", "helper", "package", "python", "psycopg", "pdfplumber", "boto3"])
        self.assertEqual(reply["relative_import"], "ok")
        self.assertEqual(reply["package"], "nexus_toolpkg_probetest_1")
        self.assertIn("nexus_toolpkg_probetest_1.kb_probe_helper", reply["helper"])
        self.assertRegex(reply["python"], r"^3\.\d+\.\d+")
        for name in ("psycopg", "pdfplumber", "boto3"):
            self.assertIsInstance(reply[name], str)
            self.assertTrue(reply[name], name)
        import psycopg  # 本机测试环境（$KBPY）有 psycopg 3：应当报出它的版本
        self.assertEqual(reply["psycopg"], psycopg.__version__)
        if importlib.util.find_spec("boto3") is None:
            self.assertEqual(reply["boto3"], "absent")

    def test_failed_relative_import_is_reported(self):
        T = load_script(PROBE_DIR / "kb_probe_entry.py", "kb_probe_entry_toplevel")
        reply = json.loads(T.kb_import_probe())
        self.assertTrue(reply["relative_import"].startswith("ImportError"), reply)
        self.assertIsNone(reply["helper"])
        self.assertIn(reply["package"], ("", None))

    def test_default_build_unchanged(self):
        explicit = build("tools", "--env", ENV_EXAMPLE, "--out", self.tmp / "t" / "tools")
        self.assertEqual((self.tmp / "t" / "pg_kb_tools.zip").read_bytes(), self.zip.read_bytes(), "build_tools.py 与 build_tools.py tools 相同")
        self.assertEqual(explicit["files"], self.built["files"])
        self.assertEqual(json.loads(self.manifest.read_text(encoding="utf-8"))["files"], {n: sha256(b) for n, b in self.local.items()})


if __name__ == "__main__":
    unittest.main(verbosity=2)
