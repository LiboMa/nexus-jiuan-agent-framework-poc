"""本机测试：拼装出的工具目录 .build/tools 照 Nexus VM 的装法装成包 nexus_toolpkg_localtest_1，三个工具在 PGlite 上逐个跑。

    python3 -I knowledgebase-writer-agent-pg/scripts/build_tools.py --env knowledgebase-writer-agent-pg/deploy.env.example
    bash kb/tests/run_pglite.sh 55432                                   # 另一个终端
    KB_TEST_PG_PORT=55432 $KBPY knowledgebase-writer-agent-pg/tests/local_test.py      # zsh：${=KBPY}

- 装法与 VM 相同：包的壳由 spec_from_file_location + submodule_search_locations 建（目录里没有 __init__.py，不执行），
  入口与核心模块都是包里的子模块，彼此只能相对 import。kb/lib 不放进 sys.path：入口要是写成 import kb_store，这里就装不上。
- 替身：knowbase-s3vectors-agent/tests/stubs 的 strands（@tool 原样返回函数）和 nexus_utils.secret_key（测试设定「注入」的
  数据库密钥，给的是 PGlite 的连接字段）。数据库是 kb/tests/pg_harness 建的（假的 kb_embed_impl，不调 Bedrock）。
- 没设 KB_TEST_PG_PORT 时连库的用例 skipped；拼装、密钥缺失、错误去敏这几条照跑。
- 跑完 test_contract_replies 写 .build/contract-replies.json：各操作的回复（内容全部虚构），给 Task 7 的契约测试用。
- 锁等待与语句时限（lock_timeout 30s / statement_timeout 240s）：PGlite 只有一个后端、一次一个事务，测不了真的锁冲突，
  所以 SHOW 连接上的设置，再用假的数据库错误（SQLSTATE 55P03 / 57014）走工具的错误映射：等锁超时回「知识库正忙」，
  一句超时回「这次操作超时」，两种说法不同。
夹具全部虚构：kb/tests/fixtures/sample-matrix.docx 与 kb/tests/sample_docs 现生成的文档。
"""
import ast
import hashlib
import importlib
import importlib.util
import json
import os
import re
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import unittest
import zipfile
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
PKG_DIR = HERE.parent
REPO = PKG_DIR.parent
KB = REPO / "kb"
LIB = KB / "lib"
BUILD = PKG_DIR / ".build"
TOOLS = BUILD / "tools"
BUILD_SCRIPT = PKG_DIR / "scripts" / "build_tools.py"
ENV_EXAMPLE = PKG_DIR / "deploy.env.example"
ENTRY_SRC = PKG_DIR / "tools" / "pg_kb_tools.py"
FIXTURE = KB / "tests" / "fixtures" / "sample-matrix.docx"
STUBS = REPO / "knowbase-s3vectors-agent" / "tests" / "stubs"
REPLIES = BUILD / "contract-replies.json"
PKG = "nexus_toolpkg_localtest_1"
CORE = ("doc_blocks.py", "parse_rules.py", "clauses.py", "kb_parse.py", "kb_store.py")
FILES = tuple(sorted(CORE + ("pg_kb_tools.py",)))
TOOL_NAMES = ("rules_writer", "rules_search", "rules_manager")
OPS = ["describe", "ingest", "preview", "list", "detail", "deactivate", "restore", "delete", "check", "search"]
ERROR_TYPES = {"credentials_missing", "invalid_parameter", "invalid_source_id", "file_not_found", "file_too_large", "unsupported_format",
               "empty_document", "no_text_layer", "encoding_unsupported", "pdf_parser_unavailable", "matrix_chapter_missing",
               "duplicate_rule_ids", "too_many_records", "rule_conflict", "source_inactive", "not_found", "rate_limited", "kb_not_ready",
               "table_owner", "db_unavailable", "embedding_failed", "internal_error"}
HEADER_RE = re.compile(r"^# 由 kb/lib@(?:[0-9a-f]{7,40}|unknown)(?:-dirty)? 生成，勿改（knowledgebase-writer-agent-pg/scripts/build_tools.py）$")
PASSWORD = "kb-local-test"
TABLE = "approval_rules"
FIXTURE_IDS = 18                     # sample-matrix.docx：3 general、3 chapter_note、12 matrix
PROSE = ["第一条 出差人员应当乘坐经济舱，特殊情况经部门负责人批准。", "第二条 住宿费按城市标准据实报销，超标部分自理。",
         "第三条 出差结束后十日内提交报销单据。"]
TIMEOUTS = ("30s", "4min")           # SHOW lock_timeout / statement_timeout：PG 把 240s 显示成 4min
TIMEOUTS_MS = ("30000", "240000")    # pg_settings 里的毫秒数
BUSY = {"error_type": "db_unavailable", "message": "知识库正忙（另一项入库或换模型正在进行），请稍后再试", "suggestion": "过一两分钟再试一次"}
TIMED_OUT = {"error_type": "db_unavailable", "message": "这次操作超时（入库或检索太慢），请稍后再试；文档很大时可以拆开入库",
             "suggestion": "过几分钟再试一次；文档很大就拆成几份、各用自己的制度标识入库；一直超时请管理员检查数据库主机的负载"}

sys.path.insert(0, str(STUBS))
sys.path.insert(0, str(KB / "tests"))   # pg_harness、sample_docs；kb/lib 故意不放（见文件头）
import pg_harness as H  # noqa: E402
import sample_docs  # noqa: E402
from nexus_utils import secret_key  # noqa: E402

T = None   # 装好的入口模块 nexus_toolpkg_localtest_1.pg_kb_tools（setUpModule）


def load_tools():
    """照 VM：包的壳 + 目录里的子模块。壳不执行（没有 __init__.py），__path__ = 工具目录。"""
    if not (TOOLS / "pg_kb_tools.py").is_file():
        raise RuntimeError(f"没有 {TOOLS}/pg_kb_tools.py：先跑 python3 -I {BUILD_SCRIPT.relative_to(REPO)} --env {ENV_EXAMPLE.relative_to(REPO)}")
    spec = importlib.util.spec_from_file_location(PKG, str(TOOLS / "__init__.py"), submodule_search_locations=[str(TOOLS)])
    sys.modules[PKG] = importlib.util.module_from_spec(spec)
    return importlib.import_module(PKG + ".pg_kb_tools")


def setUpModule():
    global T
    T = load_tools()


# ─────────────── 测试台客户端的回复校验（照 poc/app/kb-steward-client.mjs 的 SHAPES / failedShape 写成 Python） ───────────────

def _count(v):
    return isinstance(v, int) and not isinstance(v, bool) and v >= 0


def _same(reply, given):
    return isinstance(reply, dict) and reply.get("source_id") == given.get("source_id")


SHAPES = {
    "describe": lambda r, i: r.get("protocol") == "kb.rules/v1" and isinstance(r.get("backend"), str)
    and isinstance(r.get("ops"), list) and all(isinstance(o, str) for o in r["ops"]),
    "ingest": lambda r, i: r.get("status") in ("ingested", "skipped") and _same(r, i) and isinstance(r.get("source_version"), str)
    and all(_count(r.get(k)) for k in ("rules_total", "written", "removed", "unchanged")) and isinstance(r.get("conflicts"), list)
    and ("report" not in r or isinstance(r["report"], dict)),
    "list": lambda r, i: isinstance(r.get("sources"), list) and all(isinstance(s, dict) and isinstance(s.get("source_id"), str)
                                                                    for s in r["sources"]),
    "detail": lambda r, i: isinstance(r.get("source"), dict) and _same(r["source"], i) and isinstance(r.get("rule_ids"), list),
    "deactivate": lambda r, i: _same(r, i) and _count(r.get("affected")),
    "restore": lambda r, i: _same(r, i) and _count(r.get("affected")),
    "delete": lambda r, i: _same(r, i) and _count(r.get("affected")),
    "check": lambda r, i: isinstance(r.get("ok"), bool) and isinstance(r.get("problems"), list),
    "search": lambda r, i: isinstance(r.get("filter"), dict) and isinstance(r.get("results"), list)
    and all(isinstance(h, dict) and isinstance(h.get("rule_id"), str) for h in r["results"]),
}


def bench_accepts(op, given, reply):
    if not isinstance(reply, dict):
        return False
    if reply.get("success") is False:
        return isinstance(reply.get("error_type"), str) and isinstance(reply.get("message"), str) \
            and ("conflicts" not in reply or isinstance(reply["conflicts"], list))
    return reply.get("success") is True and SHAPES[op](reply, given)


# ─────────────── 公用 ───────────────

class Base(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.addCleanup(secret_key.set_tool_credentials, None)

    def call(self, fn, **kw):
        """调工具 → dict。回复是一行 JSON；失败的形态、错误码在全集里、不带密码。"""
        raw = fn(**kw)
        self.assertIsInstance(raw, str)
        reply = json.loads(raw)
        self.assertNotIn(PASSWORD, raw)
        self.assertIsInstance(reply.get("success"), bool, raw)
        if reply["success"] is False:
            self.assertIn(reply.get("error_type"), ERROR_TYPES, raw)
            self.assertIsInstance(reply.get("message"), str, raw)
            self.assertTrue(reply["message"], raw)
            self.assertTrue(set(reply) <= {"success", "error_type", "message", "suggestion", "conflicts", "source_id", "report",
                                           "document_id"}, raw)
        return reply

    def fixture(self, name="上传的制度.docx"):
        """附件：夹具复制进临时目录（文件名与 title 不同，source_doc 取 title）。"""
        path = self.tmp / name
        shutil.copyfile(FIXTURE, path)
        return str(path)


class PgCase(Base):
    def setUp(self):
        super().setUp()
        self.conn = H.connect()
        self.addCleanup(self.conn.close)
        self.conn.autocommit = True   # PGlite 一次一个事务：工具连上来时，这边不能开着事务
        # PGlite 只有一个后端，会话级的 SET 在各连接之间是共用的：工具设的时限会留下来。每个用例从缺省值开始，结束时也复原
        # （同一个 PGlite 上接着跑的 kb/tests 不受影响）
        self.reset_timeouts()
        self.addCleanup(self.reset_timeouts)
        H.reset(self.conn)
        self.creds = {"host": "127.0.0.1", "port": os.environ["KB_TEST_PG_PORT"], "database": "postgres", "username": "postgres",
                      "password": PASSWORD}
        secret_key.set_tool_credentials(self.creds)

    def reset_timeouts(self):
        for name in ("lock_timeout", "statement_timeout"):
            self.conn.execute(f"RESET {name}")

    def q(self, sql, params=None):
        return self.conn.execute(sql, params).fetchall()

    def one(self, sql, params=None):
        return self.q(sql, params)[0][0]

    def run_sql(self, sql, params=None):
        self.conn.execute(sql, params)

    def calls(self):
        return self.one("SELECT count(*) FROM kb_fake_embed_calls")

    def state(self):
        return {r[0]: r[1:] for r in self.q(f"SELECT rule_id, record_sha256, embedding::text, source_tag, source_doc, source_version, "
                                            f"ingested_at FROM {TABLE}")}

    def documents(self):
        return self.q("SELECT id, status, source_tag, doc_title, error FROM kb_documents ORDER BY id")

    def ingest(self, source_id, path=None, **kw):
        return self.call(T.rules_writer, file_path=path or self.fixture(), source_id=source_id, **kw)


# ─────────────── 不连库 ───────────────

class Offline(Base):
    def test_package_loaded_like_vm(self):
        self.assertEqual(T.__name__, PKG + ".pg_kb_tools")
        self.assertEqual((T.kb_store.__name__, T.kb_parse.__name__, T.doc_blocks.__name__),
                         (PKG + ".kb_store", PKG + ".kb_parse", PKG + ".doc_blocks"))
        self.assertEqual(T.kb_parse.clauses.__name__, PKG + ".clauses", "核心模块之间也是相对 import")
        self.assertNotIn(str(TOOLS), sys.path)
        for name in ("kb_store", "kb_parse", "doc_blocks", "clauses", "parse_rules"):
            self.assertNotIn(name, sys.modules, f"{name} 不该作为顶层模块装进来")
        self.assertEqual(T._TABLE, "approval_rules")
        self.assertTrue(all(callable(getattr(T, n)) for n in TOOL_NAMES))

    def test_describe_shape(self):
        reply = self.call(T.rules_manager, action="describe")   # 不要密钥：替身此时给的是 None
        self.assertEqual(reply["success"], True)
        self.assertEqual((reply["protocol"], reply["backend"], reply["ops"]), ("kb.rules/v1", "pg", OPS))
        self.assertEqual(reply["parser_version"], T.kb_parse.PARSER_VERSION)
        self.assertTrue(bench_accepts("describe", {}, reply))
        self.assertEqual(self.call(T.rules_manager, action=" Describe ")["ops"], OPS, "action 不分大小写、去空白")
        bad = self.call(T.rules_manager, action="explode")
        self.assertEqual(bad["error_type"], "invalid_parameter")

    def test_credentials_missing(self):
        for creds in (None, {}, {"host": "127.0.0.1", "port": "5432", "database": "postgres", "username": "postgres"}):
            with self.subTest(creds=creds):
                secret_key.set_tool_credentials(creds)
                for fn, kw in ((T.rules_writer, {"file_path": self.fixture(), "source_id": "cred-test"}),
                               (T.rules_writer, {"file_path": self.fixture(), "source_id": "cred-test", "dry_run": True}),
                               (T.rules_search, {"question": "合同用印"}),
                               (T.rules_manager, {"action": "list"}),
                               (T.rules_manager, {"action": "check"})):
                    reply = self.call(fn, **kw)
                    self.assertEqual(reply["error_type"], "credentials_missing", (fn.__name__, kw, reply))

    def test_errors_redacted(self):
        secret = "S3cret-Value-9"
        server = FakeAuthFailServer()
        self.addCleanup(server.close)
        closed = free_port()
        cases = {
            "密码错（服务端回 28P01）": {"host": "127.0.0.1", "port": str(server.port), "database": "postgres", "username": "postgres",
                                       "password": secret},
            "端口不通": {"host": "127.0.0.1", "port": str(closed), "database": "postgres", "username": "postgres", "password": secret},
            "主机名解析不了": {"host": "kb-secret-host.invalid", "port": "15432", "database": "postgres", "username": "postgres",
                               "password": secret},
        }
        for name, creds in cases.items():
            secret_key.set_tool_credentials(creds)
            for fn, kw in ((T.rules_manager, {"action": "list"}), (T.rules_search, {"question": "合同用印"}),
                           (T.rules_writer, {"file_path": self.fixture(), "source_id": "redact-test"})):
                with self.subTest(name, tool=fn.__name__):
                    raw = fn(**kw)
                    reply = json.loads(raw)
                    self.assertEqual(reply.get("error_type"), "db_unavailable", raw)
                    for leak in (secret, creds["host"], creds["port"], "kb-secret-host", "127.0.0.1"):
                        self.assertNotIn(leak, raw, f"{name}：回复里有 {leak!r}")
        self.assertGreater(server.attempts, 0, "替身服务确实收到了登录请求")
        secret_key.set_tool_credentials(cases["密码错（服务端回 28P01）"])
        self.assertIn("密码", json.loads(T.rules_manager(action="list"))["message"])

    def test_busy_errors_mapped(self):
        """等锁超过 lock_timeout（55P03）→ db_unavailable「知识库正忙」；一句超过 statement_timeout（57014）→ db_unavailable
        「这次操作超时」（说法不同：前者是别人占着，后者是这次太慢）。都不带主机、端口、密码。"""
        import psycopg.errors as E
        creds = {"host": "kb-secret-host.internal", "port": "15432", "database": "postgres", "username": "postgres", "password": "S3cret-Value-9"}
        for cls, state, text, expected in ((E.LockNotAvailable, "55P03", "canceling statement due to lock timeout", BUSY),
                                           (E.QueryCanceled, "57014", "canceling statement due to statement timeout", TIMED_OUT)):
            with self.subTest(state):
                e = cls(f"{text} (host=kb-secret-host.internal port=15432 password=S3cret-Value-9, 10.0.1.10:5432)")
                self.assertEqual(e.sqlstate, state)
                reply = T._as_failure(e, creds)
                self.assertEqual(reply, {"success": False, **expected})
                raw = json.dumps(reply, ensure_ascii=False)
                for leak in ("kb-secret-host", "15432", "S3cret", "10.0.1.10", "5432"):
                    self.assertNotIn(leak, raw)
        self.assertNotEqual(BUSY["message"], TIMED_OUT["message"])
        other = T._as_failure(E.ConnectionTimeout("connection timeout expired"), creds)
        self.assertEqual(other["error_type"], "db_unavailable")
        self.assertNotIn(other["message"], (BUSY["message"], TIMED_OUT["message"]), "连不上既不是「正忙」也不是「这次操作超时」")

    def test_no_tool_names_in_core(self):
        for name in CORE:
            with self.subTest(name):
                tree = ast.parse((TOOLS / name).read_text(encoding="utf-8"))
                defs = {n.name for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))}
                self.assertFalse(defs & set(TOOL_NAMES), f"{name} 里有顶层 {defs & set(TOOL_NAMES)}：平台按函数名找文件会指错")
        tree = ast.parse((TOOLS / "pg_kb_tools.py").read_text(encoding="utf-8"))
        tools = {n.name: n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in TOOL_NAMES}
        self.assertEqual(set(tools), set(TOOL_NAMES))
        for n in tools.values():
            self.assertEqual([ast.unparse(d) for d in n.decorator_list], ["tool"], n.name)
        imports = [ast.unparse(n) for n in tree.body if isinstance(n, (ast.Import, ast.ImportFrom))]
        self.assertIn("from . import doc_blocks, kb_parse, kb_store", imports)
        self.assertIn("from strands import tool", imports)
        self.assertIn("from nexus_utils.secret_key import get_tool_credentials", imports)
        self.assertFalse([i for i in imports if re.search(r"\b(boto3|botocore|psycopg2)\b", i)], imports)

    def test_build_reproducible_and_faithful(self):
        outs = [self.tmp / k / "tools" for k in ("a", "b")]
        lines = [build(out, ENV_EXAMPLE) for out in outs]
        zips = [(out.parent / "pg_kb_tools.zip").read_bytes() for out in outs]
        self.assertEqual(zips[0], zips[1], "同样的源码打出同样的字节")
        a = outs[0]
        commit = lines[0]["source_commit"]
        self.assertRegex(commit, r"^(?:[0-9a-f]{7,40}|unknown)(?:-dirty)?$")
        self.assertEqual(sorted(p.name for p in a.iterdir()), list(FILES))
        with zipfile.ZipFile(a.parent / "pg_kb_tools.zip") as z:
            infos = z.infolist()
            self.assertEqual([i.filename for i in infos], list(FILES), "文件在压缩包根，按名字排序")
            self.assertEqual({i.date_time for i in infos}, {(1980, 1, 1, 0, 0, 0)})
            for i in infos:
                self.assertEqual(z.read(i), (a / i.filename).read_bytes(), i.filename)
        for name in CORE:
            with self.subTest(name):
                first, rest = (a / name).read_text(encoding="utf-8").split("\n", 1)
                self.assertRegex(first, HEADER_RE)
                self.assertIn(f"kb/lib@{commit} ", first)
                self.assertEqual(rest, (LIB / name).read_text(encoding="utf-8"), "去掉第 1 行与 kb/lib 的源文件相同")
        src = ENTRY_SRC.read_text(encoding="utf-8")
        self.assertEqual((a / "pg_kb_tools.py").read_text(encoding="utf-8"),
                         render_block(src, ['_TABLE = "approval_rules"', f'_BUILD = "{commit}"']), "入口只改了渲染段")
        manifest = json.loads((a.parent / "MANIFEST.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest, {"source_commit": commit,
                                    "files": {n: hashlib.sha256((a / n).read_bytes()).hexdigest() for n in FILES}})
        self.assertEqual(lines[0]["files"], list(FILES))
        for name in FILES:
            self.assertEqual((TOOLS / name).read_bytes(), (a / name).read_bytes(), f"装进来测的 .build/tools/{name} 不是最新拼装的")

        env = self.tmp / "deploy.env"
        env.write_text("# 注释\nRULES_TABLE=rules_v2\n", encoding="utf-8")
        build(self.tmp / "c" / "tools", env)
        self.assertIn('_TABLE = "rules_v2"', (self.tmp / "c" / "tools" / "pg_kb_tools.py").read_text(encoding="utf-8"))
        env.write_text("RULES_TABLE=Rules;DROP\n", encoding="utf-8")
        proc = subprocess.run([sys.executable, "-I", "-B", str(BUILD_SCRIPT), "--env", str(env), "--out", str(self.tmp / "d" / "tools")],
                              capture_output=True, text=True)
        self.assertNotEqual(proc.returncode, 0, "非法表名要拒绝")
        self.assertFalse((self.tmp / "d" / "tools" / "pg_kb_tools.py").exists())


# ─────────────── 连库（PGlite） ───────────────

class Writer(PgCase):
    def test_ingest_then_skipped(self):
        first = self.ingest("sample-matrix", title="虚构审批矩阵", source_version="V1")
        self.assertEqual((first["success"], first["status"], first["rules_total"], first["written"], first["inserted"]),
                         (True, "ingested", FIXTURE_IDS, FIXTURE_IDS, FIXTURE_IDS), first)
        self.assertEqual((first["removed"], first["unchanged"], first["updated"], first["reembedded"], first["conflicts"]), (0, 0, 0, 0, []))
        self.assertEqual((first["source_id"], first["source_version"], first["parser_version"]), ("sample-matrix", "V1", T.kb_parse.PARSER_VERSION))
        self.assertEqual(first["embedding_model"], {"model": "cohere.embed-v4:0", "dim": 1024})
        self.assertEqual(first["report"]["total"], FIXTURE_IDS)
        self.assertEqual(first["report"]["parser_version"], T.kb_parse.PARSER_VERSION)
        self.assertIsInstance(first["document_id"], int)
        self.assertTrue(bench_accepts("ingest", {"source_id": "sample-matrix"}, first))
        calls = self.calls()
        self.assertEqual(calls, FIXTURE_IDS)
        before = self.state()
        self.assertEqual({v[3] for v in before.values()}, {"虚构审批矩阵"}, "source_doc = title")

        again = self.ingest("sample-matrix", title="虚构审批矩阵", source_version="V1")
        self.assertEqual((again["status"], again["written"], again["removed"], again["unchanged"], again["rules_total"]),
                         ("skipped", 0, 0, FIXTURE_IDS, FIXTURE_IDS), again)
        self.assertTrue(bench_accepts("ingest", {"source_id": "sample-matrix"}, again))
        self.assertEqual(self.calls(), calls, "没变的不重算向量")
        self.assertEqual(self.state(), before, "一条没写")
        docs = self.documents()
        self.assertEqual([(d[0], d[1], d[2], d[3]) for d in docs],
                         [(first["document_id"], "superseded", "sample-matrix", "虚构审批矩阵"),
                          (again["document_id"], "ingested", "sample-matrix", "虚构审批矩阵")])
        size, sha = self.q("SELECT size_bytes, sha256 FROM kb_documents WHERE id = %s", (again["document_id"],))[0]
        self.assertEqual((size, sha), (FIXTURE.stat().st_size, hashlib.sha256(FIXTURE.read_bytes()).hexdigest()))

        no_title = self.ingest("sample-matrix", source_version="V1")
        self.assertEqual((no_title["status"], no_title["updated"], no_title["reembedded"]), ("ingested", FIXTURE_IDS, 0),
                         "没给 title：source_doc 换成附件文件名，只改说明、不重算向量")
        self.assertEqual({v[3] for v in self.state().values()}, {"上传的制度.docx"})
        self.assertEqual(self.calls(), calls)

    def test_preview_writes_nothing(self):
        reply = self.ingest("sample-matrix", title="虚构审批矩阵", dry_run=True)
        self.assertEqual((reply["success"], reply["status"], reply["rules_total"], reply["written"], reply["inserted"]),
                         (True, "previewed", FIXTURE_IDS, FIXTURE_IDS, FIXTURE_IDS), reply)
        self.assertEqual(len(reply["will_insert"]), FIXTURE_IDS)
        self.assertEqual(reply["will_insert"], sorted(reply["will_insert"]))
        self.assertEqual((reply["will_update"], reply["will_remove"]), ([], []))
        self.assertNotIn("document_id", reply)
        self.assertEqual(self.one(f"SELECT count(*) FROM {TABLE}"), 0)
        self.assertEqual(self.calls(), 0, "预览不调 kb_embed_batch")
        self.assertEqual(self.documents(), [], "预览不记上传")
        self.assertEqual(self.ingest("sample-matrix", dry_run="true")["status"], "previewed")
        self.assertEqual(self.calls(), 0)

        self.ingest("sample-matrix", title="虚构审批矩阵")
        calls = self.calls()
        reply = self.ingest("sample-matrix", title="虚构审批矩阵 V2", dry_run=True)
        self.assertEqual((reply["status"], reply["written"], reply["updated"], len(reply["will_update"]), reply["will_insert"]),
                         ("previewed", FIXTURE_IDS, FIXTURE_IDS, FIXTURE_IDS, []))
        self.assertEqual(self.calls(), calls)
        self.assertEqual(len(self.documents()), 1)
        self.assertEqual(self.ingest("sample-matrix", title="虚构审批矩阵", dry_run="false")["status"], "skipped", "字符串 false 不是预览")

    def test_cross_path_unchanged(self):
        """Review Focus 2：deploy.sh 的路（parse_rules.py → ingest_rules.py --embed sql）入过库，再经工具用同一个标识、同一个 title。"""
        tag, title = "cross-path", "虚构审批矩阵（交叉路径）"
        rules = self.tmp / "rules.json"
        proc = subprocess.run([sys.executable, "-I", "-B", str(LIB / "parse_rules.py"), str(FIXTURE), str(rules)], capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        pw = self.tmp / "pw"
        pw.write_text(PASSWORD + "\n", encoding="utf-8")
        pw.chmod(0o600)
        proc = subprocess.run([sys.executable, "-I", "-B", str(LIB / "ingest_rules.py"), "--rules", str(rules), "--port", self.creds["port"],
                               "--db", "postgres", "--user", "postgres", "--password-file", str(pw), "--table", TABLE,
                               "--ddl", str(KB / "sql" / "approval_rules.sql"), "--source-tag", tag, "--source-doc", title,
                               "--model", H.COHERE, "--dim", "1024", "--region", "us-east-1", "--embed", "sql", "--prune"],
                              capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        summary = json.loads(proc.stdout.strip().splitlines()[-1])
        self.assertEqual((summary["inserted"], summary["rows_without_embedding"]), (FIXTURE_IDS, 0))
        calls, before = self.calls(), self.state()

        reply = self.ingest(tag, title=title)
        self.assertEqual((reply["status"], reply["written"], reply["removed"], reply["unchanged"], reply["rules_total"]),
                         ("skipped", 0, 0, FIXTURE_IDS, FIXTURE_IDS), reply)
        self.assertEqual(self.calls(), calls)
        self.assertEqual(self.state(), before, "两条路的 record_sha256 一致：一条不写")

    def test_four_formats(self):
        docs = {
            "docx": (sample_docs.docx(self.tmp / "prose.docx", [("p", "第一章 总则")] + [("p", s) for s in PROSE]),
                     {"clause": 3}, [f"fmt-docx-A{n}" for n in (1, 2, 3)]),
            "xlsx": (sample_docs.matrix_xlsx(self.tmp / "matrix.xlsx"), {"matrix": 7},
                     ["C01-1.1", "C01-1.2", "C01-1.3", "C01-1.4", "C03-3.1", "C03-3.2", "C03-3.3"]),
            "md": (sample_docs.md(self.tmp / "notes.md", ["# 第一章 总则", "", *[x for s in PROSE for x in (s, "")],
                                                         "| 城市 | 住宿标准 |", "| --- | --- |", "| 北京 | 600 |", "| 成都 | 450 |", ""]),
                   {"clause": 5}, ["fmt-md-A1", "fmt-md-A2", "fmt-md-A3", "fmt-md-T1.1", "fmt-md-T1.2"]),
            "pdf": (sample_docs.pdf(self.tmp / "prose.pdf", [["第一章 总则", *PROSE]]), {"clause": 3}, [f"fmt-pdf-A{n}" for n in (1, 2, 3)]),
        }
        for fmt, (path, types, ids) in docs.items():
            with self.subTest(fmt):
                tag = f"fmt-{fmt}"
                reply = self.call(T.rules_writer, file_path=str(path), source_id=tag, title="虚构差旅办法")
                self.assertEqual((reply["success"], reply["status"], reply["rules_total"], reply["written"]),
                                 (True, "ingested", len(ids), len(ids)), reply)
                self.assertEqual((reply["report"]["format"], reply["report"]["parser_version"], reply["report"]["total"]),
                                 (fmt, T.kb_parse.PARSER_VERSION, len(ids)))
                self.assertEqual(dict(self.q(f"SELECT rule_type, count(*) FROM {TABLE} WHERE source_tag = %s GROUP BY 1", (tag,))), types)
                self.assertEqual([r[0] for r in self.q(f"SELECT rule_id FROM {TABLE} WHERE source_tag = %s ORDER BY 1", (tag,))], sorted(ids))
                expected, _ = T.kb_parse.parse_document(str(path), source_tag=tag, doc_title="虚构差旅办法")
                got = dict(self.q(f"SELECT rule_id, content FROM {TABLE} WHERE source_tag = %s", (tag,)))
                self.assertEqual(got, {r["rule_id"]: r["content"] for r in expected})

    def test_conflict_refused(self):
        self.ingest("doc-a", title="虚构审批矩阵")
        before, calls = self.state(), self.calls()
        for dry_run in (True, False):
            with self.subTest(dry_run=dry_run):
                reply = self.ingest("doc-b", title="另一份虚构制度", dry_run=dry_run)
                self.assertEqual(reply["error_type"], "rule_conflict", reply)
                self.assertEqual(len(reply["conflicts"]), FIXTURE_IDS)
                self.assertEqual(reply["conflicts"], sorted(before))
                self.assertTrue(bench_accepts("ingest", {"source_id": "doc-b"}, reply))
                self.assertEqual(self.state(), before, "表不变")
                self.assertEqual(self.calls(), calls)
        docs = self.documents()
        self.assertEqual([(d[1], d[2]) for d in docs], [("ingested", "doc-a"), ("failed", "doc-b")])
        self.assertIn("doc-a", docs[1][4])

    def test_bad_inputs_write_nothing(self):
        """Review Focus 3 在工具这一层：读不出、不合规的附件回明确的错误码，表里一条不写，kb_documents 不留记录。"""
        ole = self.tmp / "renamed.docx"
        ole.write_bytes(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\0" * 4096)
        empty = self.tmp / "empty.docx"
        empty.write_bytes(b"")
        big = self.tmp / "big.docx"
        with open(big, "wb") as f:
            f.truncate(50 * 1024 * 1024 + 1)
        gbk = self.tmp / "gbk.md"
        gbk.write_bytes("第一条 出差须事先申请。".encode("gbk"))
        broken = self.tmp / "broken.docx"
        broken.write_bytes(FIXTURE.read_bytes()[:2000])
        cases = [
            ({"source_id": "Bad_ID"}, "invalid_source_id"),
            ({"source_id": "x"}, "invalid_source_id"),
            ({"source_id": "bad-file", "file_path": str(self.tmp / "missing.docx")}, "file_not_found"),
            ({"source_id": "bad-file", "file_path": str(self.tmp)}, "file_not_found"),
            ({"source_id": "bad-file", "file_path": ""}, "invalid_parameter"),
            ({"source_id": "bad-file", "file_path": str(big)}, "file_too_large"),
            ({"source_id": "bad-file", "file_path": str(ole)}, "unsupported_format"),
            ({"source_id": "bad-file", "file_path": str(broken)}, "unsupported_format"),
            ({"source_id": "bad-file", "file_path": str(empty)}, "empty_document"),
            ({"source_id": "bad-file", "file_path": str(gbk)}, "encoding_unsupported"),
            ({"source_id": "bad-file", "file_path": str(sample_docs.scanned_pdf(self.tmp / "scan.pdf"))}, "no_text_layer"),
            ({"source_id": "bad-file", "title": "长" * 201}, "invalid_parameter"),
        ]
        for kw, code in cases:
            with self.subTest(code, **{k: str(v)[-30:] for k, v in kw.items()}):
                reply = self.call(T.rules_writer, **{"file_path": self.fixture(), **kw})
                self.assertEqual(reply["error_type"], code, reply)
                self.assertNotIn(str(self.tmp), reply["message"], "错误里不带附件的完整路径")
        self.assertEqual(self.one(f"SELECT count(*) FROM {TABLE}"), 0)
        self.assertEqual(self.documents(), [])
        self.assertEqual(self.calls(), 0)

    def test_embedding_failed_marks_document_failed(self):
        v1 = sample_docs.docx(self.tmp / "v1.docx", [("p", "第一章 总则"), ("p", PROSE[0]), ("p", PROSE[1])])
        ok = self.call(T.rules_writer, file_path=str(v1), source_id="emb-doc", title="虚构差旅办法")
        self.assertEqual(ok["status"], "ingested")
        before, calls = self.state(), self.calls()
        v2 = sample_docs.docx(self.tmp / "v2.docx", [("p", "第一章 总则"), ("p", PROSE[0]), ("p", "第二条 住宿费按标准__FAIL__报销。")])
        reply = self.call(T.rules_writer, file_path=str(v2), source_id="emb-doc", title="虚构差旅办法")
        self.assertEqual(reply["error_type"], "embedding_failed", reply)
        self.assertIn("Bedrock", reply["message"])
        self.assertEqual(self.state(), before, "整份回滚，知识库不变")
        self.assertEqual(self.calls(), calls)
        docs = self.documents()
        self.assertEqual([d[1] for d in docs], ["ingested", "failed"])
        self.assertIn("Bedrock", docs[1][4])
        self.assertEqual(reply.get("document_id"), docs[1][0])

    def test_kb_not_ready(self):
        self.run_sql("DROP FUNCTION kb_embed_batch(text[], text)")
        for dry_run in (True, False):
            reply = self.ingest("not-ready", dry_run=dry_run)
            self.assertEqual(reply["error_type"], "kb_not_ready", reply)
            self.assertIn("升级", reply["message"])
        self.assertEqual(self.one(f"SELECT count(*) FROM {TABLE}"), 0)
        self.assertEqual([d[1] for d in self.documents()], ["failed"])
        self.run_sql(f"DROP TABLE {TABLE} CASCADE")
        for fn, kw in ((T.rules_manager, {"action": "list"}), (T.rules_search, {"question": "合同用印"}),
                       (T.rules_writer, {"file_path": self.fixture(), "source_id": "not-ready"})):
            with self.subTest(fn.__name__):
                self.assertEqual(self.call(fn, **kw)["error_type"], "kb_not_ready")


class Timeouts(PgCase):
    """工具连上库之后、做任何事之前：lock_timeout 30s、statement_timeout 240s（低于测试台入库的 5 分钟时限），已提交。"""

    def settings(self, conn):
        with conn.cursor() as cur:
            shown = tuple(cur.execute(f"SHOW {n}").fetchone()[0] for n in ("lock_timeout", "statement_timeout"))
            ms = tuple(cur.execute("SELECT setting FROM pg_settings WHERE name = %s", (n,)).fetchone()[0]
                       for n in ("lock_timeout", "statement_timeout"))
        return shown, ms

    def test_connection_has_timeouts(self):
        self.assertEqual(self.settings(self.conn), (("0", "0"), ("0", "0")), "起点是缺省值（不限）")
        conn = T._connect(self.creds)
        self.addCleanup(T._close, conn)
        self.assertEqual(conn.info.transaction_status.name, "IDLE", "设完已提交：入库锁仍是下一个事务的第一句")
        self.assertEqual(self.settings(conn), (TIMEOUTS, TIMEOUTS_MS))
        conn.rollback()
        self.assertEqual(self.settings(conn), (TIMEOUTS, TIMEOUTS_MS), "会话级设置，回滚撤不掉（_write / _manage 都会先 rollback）")

    def test_every_tool_connection_has_timeouts(self):
        """三个工具真正用的连接：关掉之前看一眼设置。"""
        self.assertEqual(self.settings(self.conn)[0], ("0", "0"))
        seen, close = [], T._close

        def spy(conn):
            try:
                conn.rollback()
                seen.append(self.settings(conn)[0])
            finally:
                close(conn)
        with mock.patch.object(T, "_close", spy):
            self.assertEqual(self.ingest("timeout-doc", title="虚构审批矩阵")["status"], "ingested")
            self.assertEqual(self.ingest("timeout-doc", title="虚构审批矩阵", dry_run=True)["status"], "previewed")
            self.assertTrue(self.call(T.rules_search, question="合同用印")["success"])
            for action in ("list", "check", "deactivate", "restore"):
                self.assertTrue(self.call(T.rules_manager, action=action, source_id="timeout-doc" if action != "list" else "")["success"])
        self.assertEqual(seen, [TIMEOUTS] * 7)

    def test_busy_through_tools(self):
        """等不到入库锁（55P03）回「知识库正忙」、一句超时（57014）回「这次操作超时」：库里都整份回滚；入库的上传记录记成 failed。"""
        import psycopg.errors as E
        self.ingest("busy-doc", title="虚构审批矩阵")
        before, calls = self.state(), self.calls()

        def raising(cls, text):
            def boom(*a, **kw):
                raise cls(f"{text} (host=127.0.0.1 port={self.creds['port']})")
            return boom
        lock_wait = raising(E.LockNotAvailable, "canceling statement due to lock timeout")
        too_long = raising(E.QueryCanceled, "canceling statement due to statement timeout")
        v2 = sample_docs.docx(self.tmp / "v2.docx", [("p", "第一章 总则"), ("p", PROSE[0])])
        cases = [("ingest：等锁", "lock", lock_wait, BUSY, T.rules_writer, {"file_path": self.fixture(), "source_id": "busy-doc", "title": "改名"}),
                 ("ingest：算向量超时", "_vectors", too_long, TIMED_OUT, T.rules_writer, {"file_path": str(v2), "source_id": "busy-doc"}),
                 ("search：超时", "search", too_long, TIMED_OUT, T.rules_search, {"question": "合同用印"})]
        cases += [(f"{action}：{why}", "lock", fn, expected, T.rules_manager, {"action": action, "source_id": "busy-doc"})
                  for action in ("deactivate", "restore", "delete")
                  for why, fn, expected in (("等锁", lock_wait, BUSY), ("超时", too_long, TIMED_OUT))]
        for name, target, fn, expected, tool, kw in cases:
            with self.subTest(name):
                docs = len(self.documents())
                with mock.patch.object(T.kb_store, target, fn):
                    raw = tool(**kw)
                reply = json.loads(raw)
                self.assertEqual({k: reply.get(k) for k in ("success", *expected)}, {"success": False, **expected}, raw)
                for leak in ("127.0.0.1", self.creds["port"], PASSWORD):
                    self.assertNotIn(leak, raw)
                self.assertEqual(self.state(), before, "一条没改")
                self.assertEqual(self.calls(), calls)
                if tool is T.rules_writer:
                    doc = self.documents()[-1]
                    self.assertEqual((len(self.documents()), doc[1], doc[4]), (docs + 1, "failed", expected["message"]))
                    self.assertEqual(reply.get("document_id"), doc[0])
                else:
                    self.assertEqual(len(self.documents()), docs, "上传记录没删")
        self.assertTrue(self.one("SELECT to_regclass(%s) IS NULL", (f"public.{TABLE}_archive",)), "没下线：归档表都没建")


class Search(PgCase):
    def test_search_contract_fields(self):
        self.ingest("search-doc", title="虚构审批矩阵")
        question = "合同用印 审批"
        expected = self.q("SELECT rule_id, score FROM kb_search(%s, 5, NULL, 'verify')", (question,))
        reply = self.call(T.rules_search, question=question, segment="甲板块", amount=300000, top_k=5)
        self.assertTrue(reply["success"], reply)
        self.assertEqual(reply["filter"], {"segment": None, "amount": None, "note": "PG 方式按关键词 + 语义排序，不按板块 / 金额过滤"})
        self.assertTrue(bench_accepts("search", {}, reply))
        hits = reply["results"]
        self.assertEqual([h["rule_id"] for h in hits], [r[0] for r in expected])
        rows = {r[0]: r[1:] for r in self.q(f"SELECT rule_id, rule_type, chapter_no, segment, source_tag, content, business_item, "
                                            f"amount_tier, approval_path_text, final_approver FROM {TABLE}")}
        for hit, (rid, score) in zip(hits, expected):
            rule_type, chapter_no, segment, tag, content, item, tier, path, final = rows[rid]
            self.assertEqual(hit["text"], content)
            self.assertEqual(hit["source_id"], "search-doc")
            self.assertIsNone(hit["amt_kind"])
            self.assertIsInstance(hit["segments"], list)
            self.assertEqual(hit["segments"], [segment] if segment else [])
            self.assertEqual(hit["distance"], round(1 - float(score), 4))
            self.assertEqual((hit["rule_type"], hit["chapter_no"], hit["business_item"], hit["amount_tier"], hit["approval_path_text"],
                              hit["final_approver"]), (rule_type, chapter_no, item, tier, path, final))
            self.assertIsInstance(hit["keyword_hits"], int)
        self.assertEqual(self.q("SELECT caller, question, k FROM kb_search_log WHERE caller = 'agent'"), [("agent", question, 5)],
                         "提交了：检索日志记下工具的这一次（不在只读事务里）")
        for top_k, n in ((0, 1), (99, 20), ("3", 3)):
            with self.subTest(top_k=top_k):
                got = self.call(T.rules_search, question="审批", top_k=top_k)
                self.assertEqual(self.one("SELECT k FROM kb_search_log ORDER BY id DESC LIMIT 1"), n)
                self.assertLessEqual(len(got["results"]), n)
        for kw in ({"question": "  "}, {"question": "审批", "top_k": "很多"}, {"question": "长" * 2001}):
            self.assertEqual(self.call(T.rules_search, **kw)["error_type"], "invalid_parameter")

    def test_rate_limited(self):
        """Review Focus 5：撞上每分钟上限回 rate_limited（建议一分钟后再试），不是 0 条结果。"""
        self.ingest("rate-doc", title="虚构审批矩阵")
        self.run_sql("INSERT INTO kb_search_log (at, caller, question, k) SELECT now(), 'page', '虚构问题', 8 FROM generate_series(1, 60)")
        reply = self.call(T.rules_search, question="合同用印")
        self.assertEqual(reply["error_type"], "rate_limited", reply)
        self.assertIn("一分钟", reply.get("suggestion", ""))
        self.assertNotIn("results", reply)

        self.run_sql("INSERT INTO kb_fake_embed_calls (model, purpose, via, input) "
               "SELECT 'x', 'search_document', 'batch', 'x' FROM generate_series(1, 2000)")
        before = self.state()
        md = sample_docs.md(self.tmp / "new.md", ["# 第一章 总则", "", PROSE[0]])
        reply = self.call(T.rules_writer, file_path=str(md), source_id="rate-new")
        self.assertEqual(reply["error_type"], "rate_limited", reply)
        self.assertIn("一分钟", reply.get("suggestion", ""))
        self.assertEqual(self.state(), before)
        self.assertEqual(self.q("SELECT status FROM kb_documents WHERE source_tag = 'rate-new'"), [("failed",)])


class Manager(PgCase):
    def test_manage_flow(self):
        tag = "flow-doc"
        self.ingest(tag, title="虚构审批矩阵", source_version="V1")
        found = lambda: [h for h in self.call(T.rules_search, question="合同用印 审批", top_k=20)["results"] if h["source_id"] == tag]
        self.assertTrue(found())

        listed = self.call(T.rules_manager, action="list")
        self.assertTrue(bench_accepts("list", {}, listed))
        item = next(s for s in listed["sources"] if s["source_id"] == tag)
        self.assertEqual((item["title"], item["source_version"], item["file_name"], item["rules_total"], item["status"]),
                         ("虚构审批矩阵", "V1", "上传的制度.docx", FIXTURE_IDS, "active"))
        self.assertEqual(item["doc_hash"], hashlib.sha256(FIXTURE.read_bytes()).hexdigest())
        self.assertRegex(item["ingested_at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00$")
        detail = self.call(T.rules_manager, action="detail", source_id=tag)
        self.assertTrue(bench_accepts("detail", {"source_id": tag}, detail))
        self.assertEqual(len(detail["rule_ids"]), FIXTURE_IDS)

        check = self.call(T.rules_manager, action="check", source_id="")
        self.assertEqual((check["ok"], check["problems"]), (True, []), check)
        self.assertTrue(self.call(T.rules_manager, action="check", source_id=tag)["ok"])

        off = self.call(T.rules_manager, action="deactivate", source_id=tag)
        self.assertEqual((off["success"], off["source_id"], off["affected"]), (True, tag, FIXTURE_IDS), off)
        self.assertEqual(found(), [], "下线后检索不到")
        self.assertTrue(self.call(T.rules_manager, action="check", source_id=tag)["ok"], "下线的（在归档表里）也是有这份制度")
        self.assertEqual(next(s for s in self.call(T.rules_manager, action="list")["sources"] if s["source_id"] == tag)["status"], "inactive")
        again = self.ingest(tag, title="虚构审批矩阵", source_version="V1")
        self.assertEqual(again["error_type"], "source_inactive", again)
        self.assertEqual(self.one(f"SELECT count(*) FROM {TABLE}"), 0, "不出现「在线一份、归档一份」")

        on = self.call(T.rules_manager, action="restore", source_id=tag)
        self.assertEqual((on["source_id"], on["affected"]), (tag, FIXTURE_IDS))
        self.assertTrue(found())
        self.assertTrue(self.call(T.rules_manager, action="check")["ok"])

        self.run_sql(f"UPDATE {TABLE} SET embedding = NULL WHERE rule_id = (SELECT min(rule_id) FROM {TABLE})")
        bad = self.call(T.rules_manager, action="check", source_id=tag)
        self.assertEqual(bad["ok"], False)
        self.assertEqual([(p["code"], p["source_id"]) for p in bad["problems"]], [("missing_embedding", tag)])
        self.assertTrue(bench_accepts("check", {}, bad))

        gone = self.call(T.rules_manager, action="delete", source_id=tag)
        self.assertEqual((gone["source_id"], gone["affected"]), (tag, FIXTURE_IDS))
        self.assertEqual([s for s in self.call(T.rules_manager, action="list")["sources"] if s["source_id"] == tag], [])
        self.assertEqual(self.q("SELECT count(*) FROM kb_documents WHERE source_tag = %s", (tag,)), [(0,)])
        for action in ("detail", "deactivate", "restore", "delete"):
            with self.subTest(action):
                self.assertEqual(self.call(T.rules_manager, action=action, source_id=tag)["error_type"], "not_found")
                self.assertEqual(self.call(T.rules_manager, action=action, source_id="")["error_type"], "invalid_parameter")
                self.assertEqual(self.call(T.rules_manager, action=action, source_id="Bad_ID")["error_type"], "invalid_source_id")
        self.assertEqual(self.call(T.rules_manager, action="check", source_id="Bad_ID")["error_type"], "invalid_source_id")

    def test_check_unknown_source_not_found(self):
        """check 给了 source_id、却没有这份制度（规则表、归档表里都没有）：回 not_found（同 detail），不是 ok:true；什么都不写。"""
        self.ingest("check-doc", title="虚构审批矩阵")
        before, calls = self.state(), self.calls()
        reply = self.call(T.rules_manager, action="check", source_id="no-such-doc")
        self.assertEqual(reply, {"success": False, "error_type": "not_found", "message": "知识库里没有制度「no-such-doc」，无从校验",
                                 "suggestion": "用 list 查看已有的制度；不带 source_id 的 check 校验全部（包括卡住的上传）"})
        self.assertTrue(bench_accepts("check", {"source_id": "no-such-doc"}, reply))
        self.assertEqual((self.state(), self.calls()), (before, calls), "没有抽样重算向量，库里一条没变")
        # 有的照常校验；不带 source_id 照常查全部
        self.assertEqual(self.call(T.rules_manager, action="check", source_id="check-doc"), {"success": True, "ok": True, "problems": []})
        self.assertEqual(self.call(T.rules_manager, action="check"), {"success": True, "ok": True, "problems": []})

    def test_contract_replies(self):
        """各操作的回复都过测试台客户端的校验；写 .build/contract-replies.json（虚构内容）给 Task 7 的契约测试。"""
        tag, other = "fin-approval-demo", "other-demo"
        doc = {"source_id": tag, "source_version": "V1", "title": "某虚构集团财务审批授权办法"}
        steps = [
            ("describe", {}, lambda: T.rules_manager(action="describe")),
            ("preview", doc, lambda: T.rules_writer(file_path=self.fixture(), dry_run=True, **doc)),
            ("ingest", doc, lambda: T.rules_writer(file_path=self.fixture(), **doc)),
            ("ingest", doc, lambda: T.rules_writer(file_path=self.fixture(), **doc)),
            ("list", {}, lambda: T.rules_manager(action="list")),
            ("detail", {"source_id": tag}, lambda: T.rules_manager(action="detail", source_id=tag)),
            ("search", {"question": "合同用印 审批", "segment": "", "top_k": 3},
             lambda: T.rules_search(question="合同用印 审批", segment="", top_k=3)),
            ("check", {"source_id": ""}, lambda: T.rules_manager(action="check", source_id="")),
            ("check", {"source_id": tag}, lambda: T.rules_manager(action="check", source_id=tag)),
            ("deactivate", {"source_id": tag}, lambda: T.rules_manager(action="deactivate", source_id=tag)),
            ("restore", {"source_id": tag}, lambda: T.rules_manager(action="restore", source_id=tag)),
            ("ingest", {**doc, "source_id": other}, lambda: T.rules_writer(file_path=self.fixture(), **{**doc, "source_id": other})),
            ("detail", {"source_id": "no-such-demo"}, lambda: T.rules_manager(action="detail", source_id="no-such-demo")),
            ("check", {"source_id": "no-such-demo"}, lambda: T.rules_manager(action="check", source_id="no-such-demo")),
            ("delete", {"source_id": tag}, lambda: T.rules_manager(action="delete", source_id=tag)),
        ]
        replies = []
        for op, given, run in steps:
            raw = run()
            self.assertNotIn(PASSWORD, raw)
            reply = json.loads(raw)
            if op != "preview":
                self.assertTrue(bench_accepts(op, given, reply), (op, reply))
            replies.append({"op": op, "input": given, "reply": reply})
        statuses = [(r["op"], r["reply"].get("status") or r["reply"].get("error_type")) for r in replies if r["op"] in ("preview", "ingest", "detail")]
        self.assertEqual(statuses, [("preview", "previewed"), ("ingest", "ingested"), ("ingest", "skipped"), ("detail", None),
                                    ("ingest", "rule_conflict"), ("detail", "not_found")])
        BUILD.mkdir(exist_ok=True)
        out = {"protocol": "kb.rules/v1", "backend": "pg", "build": T._BUILD,
               "note": "knowledgebase-writer-agent-pg/tests/local_test.py 在 PGlite 上生成；内容全部虚构。preview 是 PG 版独有的操作，不在测试台的 SHAPES 里",
               "replies": replies}
        text = json.dumps(out, ensure_ascii=False, indent=1)
        for leak in (PASSWORD, "127.0.0.1", self.creds["port"]):
            self.assertNotIn(leak, json.dumps([r["reply"] for r in replies if r["reply"].get("success") is False], ensure_ascii=False))
        self.assertNotIn(PASSWORD, text)
        REPLIES.write_text(text + "\n", encoding="utf-8")


# ─────────────── 小工具 ───────────────

def build(out, env):
    proc = subprocess.run([sys.executable, "-I", "-B", str(BUILD_SCRIPT), "--env", str(env), "--out", str(out)], capture_output=True, text=True)
    if proc.returncode != 0:
        raise AssertionError(f"build_tools.py 退出码 {proc.returncode}：{proc.stderr}")
    lines = proc.stdout.strip().splitlines()
    if len(lines) != 1:
        raise AssertionError(f"build_tools.py 要只打印一行 JSON：{proc.stdout!r}")
    return json.loads(lines[0])


def render_block(src, lines):
    """源码里 # >>> deploy-config 与 # <<< deploy-config 之间换成 lines。"""
    out, inside = [], False
    for line in src.splitlines(keepends=True):
        if line.startswith("# >>> deploy-config"):
            out.append(line)
            out.extend(x + "\n" for x in lines)
            inside = True
        elif line.startswith("# <<< deploy-config"):
            out.append(line)
            inside = False
        elif not inside:
            out.append(line)
    return "".join(out)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class FakeAuthFailServer:
    """只会拒绝登录的 PG 替身：SSL / GSS 请求回 N，启动包回 ErrorResponse 28P01（PGlite 不校验密码，测不了「密码错」）。"""

    def __init__(self):
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(8)
        self.port = self.sock.getsockname()[1]
        self.attempts = 0
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            with conn:
                try:
                    while True:
                        n = struct.unpack("!I", _recv(conn, 4))[0]
                        body = _recv(conn, n - 4)
                        if struct.unpack("!I", body[:4])[0] in (80877103, 80877104):   # SSLRequest / GSSENCRequest
                            conn.sendall(b"N")
                            continue
                        self.attempts += 1
                        fields = b'SFATAL\0VFATAL\0C28P01\0Mpassword authentication failed for user "postgres"\0\0'
                        conn.sendall(b"E" + struct.pack("!I", len(fields) + 4) + fields)
                        break
                except (OSError, struct.error):
                    pass

    def close(self):
        self.sock.close()


def _recv(conn, n):
    buf = b""
    while len(buf) < n:
        chunk = conn.recv(n - len(buf))
        if not chunk:
            raise OSError("closed")
        buf += chunk
    return buf


if __name__ == "__main__":
    unittest.main(verbosity=2)
