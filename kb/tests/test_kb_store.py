"""kb_store（PG 写入与管理的唯一实现）不连库的部分：锁是入库事务的第一句、record_sha256 与重构前相同、SQL 全部带参数。

    $KBPY -m unittest kb/tests/test_kb_store.py -v

假游标照 test_kb_admin.py：按 SQL 里的片段回预设的行，没预设的回空。
"""
import hashlib
import io
import json
import sys
import tempfile
import types
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
LIB = HERE.parent / "lib"
sys.path.insert(0, str(LIB))
import kb_parse  # noqa: E402
import kb_store  # noqa: E402

FIXTURE = HERE / "fixtures" / "sample-matrix.docx"
LOCK = "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('kb_ingest:' || %s))"
COLUMNS_BEFORE = ("rule_id", "rule_type", "chapter_no", "chapter", "seq_no", "business_item", "segment", "amount_tier",
                  "approval_path", "approval_path_text", "final_approver", "post_actions", "not_applicable", "extra",
                  "scope_controls", "chapter_note", "content", "embedding", "source_doc", "source_version",
                  "source_tag", "record_sha256")
# 重构前的 ingest_rules.py（COLUMNS / record_hash / 行的拼法）对 sample-matrix.docx 算出的值
# （source_tag=sample-matrix、source_doc=sample-matrix.docx、source_version=V1）
FIRST_HASH = "7c9263d03f2555b4ff5737af13e4657712fd40fe3e974f7cfbaf656f2cc52ebb"
ALL_HASHES = "a7606d281e7dbe4d37b30478e4845a01a4d0a8a823d875e3917592db63fa8e01"   # 18 条 record_sha256 依次拼接后的 sha256
HOSTILE = "x'); DROP TABLE approval_rules;--"
MARK = "zq-marker"                                                               # 合规的标识：只该出现在参数里


class FakeCursor:
    def __init__(self, conn):
        self.conn, self.description, self._rows, self.rowcount = conn, None, [], 0

    def execute(self, sql, params=None):
        self.conn.executed.append((" ".join(sql.split()), params))
        for pattern, (cols, rows) in self.conn.answers:
            if pattern in sql:
                self.description = [(c,) for c in cols]
                self._rows = list(rows)
                self.rowcount = len(rows)
                return
        self.description, self._rows, self.rowcount = None, [], 1

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return list(self._rows)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeConn:
    """commit / rollback 也记进 executed（"COMMIT" / "ROLLBACK"），好看出事务的边界。"""

    def __init__(self, answers=()):
        self.answers, self.executed = list(answers), []

    def cursor(self):
        return FakeCursor(self)

    def commit(self):
        self.executed.append(("COMMIT", None))

    def rollback(self):
        self.executed.append(("ROLLBACK", None))

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def table_answers(existing=(), vectors=("[0.1,0.2]",)):
    cols = ("rule_id", "rule_type", "content", "embedding", "source_doc", "source_tag", "record_sha256", "ingested_at")
    return [("to_regprocedure", (["ok"], [(True,)])),
            ("SELECT to_regclass", (["exists"], [(True,)])),
            ("SELECT tableowner", (["owner", "me"], [("nexus", "nexus")])),
            ("FROM information_schema.columns", (["column_name"], [(c,) for c in cols])),
            ("SELECT rule_id, record_sha256", (["rule_id", "sha", "has", "tag", "content", "doc"], list(existing))),
            ("kb_embed_batch", (["v"], [(list(vectors),)])),
            ("RETURNING id", (["id"], [(7,)])),
            ("SELECT rule_type, count(*) FROM approval_rules GROUP BY 1", (["rule_type", "n"], [("matrix", 1)])),   # 命令行的摘要
            ("SELECT count(*) FROM approval_rules WHERE embedding IS NULL", (["n"], [(0,)]))]


class FakePsycopg:
    """把 sys.modules["psycopg"] 换成只会 connect 的假模块，退出时换回原来的（或删掉）。"""

    def __init__(self, conn):
        self.conn = conn

    def __enter__(self):
        self.saved = sys.modules.get("psycopg")
        fake = types.ModuleType("psycopg")
        fake.connect = lambda **kw: self.conn
        sys.modules["psycopg"] = fake

    def __exit__(self, *exc):
        if self.saved is None:
            sys.modules.pop("psycopg", None)
        else:
            sys.modules["psycopg"] = self.saved
        return False


def run_ingest_rules(conn, rules, extra=()):
    import ingest_rules
    with tempfile.TemporaryDirectory() as tmp, FakePsycopg(conn):
        path = Path(tmp) / "rules.json"
        path.write_text(json.dumps(rules, ensure_ascii=False), encoding="utf-8")
        pw = Path(tmp) / "pw"
        pw.write_text("x", encoding="utf-8")
        ddl = Path(tmp) / "ddl.sql"
        ddl.write_text("CREATE TABLE IF NOT EXISTS {table} (rule_id text)", encoding="utf-8")
        argv = ["ingest_rules.py", "--rules", str(path), "--port", "5432", "--db", "nexus", "--user", "nexus", "--password-file", str(pw),
                "--table", "approval_rules", "--ddl", str(ddl), "--source-tag", "sample-matrix", "--source-doc", "仿真.docx",
                "--model", "amazon.titan-embed-text-v2:0", "--dim", "1024", "--region", "us-east-1", "--embed", "sql", "--prune", *extra]
        out = io.StringIO()
        with mock.patch.object(sys, "argv", argv), redirect_stdout(out):
            ingest_rules.main()
    return json.loads(out.getvalue().strip().splitlines()[-1])


class LockFirst(unittest.TestCase):
    """Review Focus 1：deploy.sh（ingest_rules）和 Agent 的工具同时入库时，后到的一方等锁。两条路进 kb_store.ingest 后，
    事务的第一句都是同一把 advisory lock（键 = hashtext('kb_ingest:' || 表名)，与 kb_search.sql / 换模型脚本相同）。"""

    def entered(self, conn):
        """包住 kb_store.ingest：记下进入时 conn.executed 已有几条。"""
        marks, real = [], kb_store.ingest

        def wrapper(c, *args, **kw):
            marks.append(len(c.executed))
            return real(c, *args, **kw)
        return marks, mock.patch.object(kb_store, "ingest", wrapper)

    def test_lock_first_in_both_paths(self):
        rules = [{"rule_id": "C05-5.1", "rule_type": "matrix", "content": "【五、付款审批】5.1 供应商货款"}]
        # ingest_rules 路径（deploy.sh ingest）
        cli = FakeConn(table_answers())
        marks, patch = self.entered(cli)
        with patch:
            summary = run_ingest_rules(cli, rules)
        self.assertEqual(summary["inserted"], 1)
        self.assertEqual(len(marks), 1, "--embed sql 走 kb_store.ingest")
        cli_first = cli.executed[marks[0]]
        self.assertEqual(cli.executed[marks[0] - 1], ("COMMIT", None), "建表那个事务已提交：锁是入库事务的第一句")
        self.assertEqual(cli.executed[0], (LOCK, ("approval_rules",)), "建表（DDL）那个事务也先拿锁")

        # 工具路径：先记一行上传（单独提交），再入库
        tool = FakeConn(table_answers())
        with tool.cursor() as cur:
            doc_id = kb_store.record_document(cur, file_name="仿真.docx", sha256="ab" * 32, size_bytes=10, uploaded_by="agent",
                                              source_tag="sample-matrix", doc_title="仿真办法", source_version="V1",
                                              report={"total": 1}, status="ingesting")
        tool.commit()
        rows = kb_store.prepare(rules, source_tag="sample-matrix", source_doc="仿真办法", source_version="V1")
        marks, patch = self.entered(tool)
        with patch:
            result = kb_store.ingest(tool, "approval_rules", rows, source_tag="sample-matrix", document_id=doc_id)
        self.assertEqual(result["inserted"], 1)
        tool_first = tool.executed[marks[0]]
        self.assertEqual(tool.executed[marks[0] - 1], ("COMMIT", None))

        self.assertEqual(cli_first, (LOCK, ("approval_rules",)))
        self.assertEqual(tool_first, cli_first, "两条路同一句、同一个参数")
        self.assertEqual(tool.executed[-1], ("COMMIT", None))
        # 入库事务里只有一次提交（在最后）：锁一直拿到写完
        self.assertEqual([s for s, _ in tool.executed[marks[0]:]].count("COMMIT"), 1)

    def test_management_writes_take_the_same_lock(self):
        for fn in (kb_store.deactivate, kb_store.restore, kb_store.delete):
            conn = FakeConn(table_answers())
            fn(conn, "approval_rules", "sample-matrix")
            self.assertEqual(conn.executed[0], (LOCK, ("approval_rules",)), fn.__name__)
            self.assertEqual(conn.executed[-1], ("COMMIT", None), fn.__name__)

    def test_dry_run_and_conflict_roll_back(self):
        rules = kb_store.prepare([{"rule_id": "C05-5.1", "rule_type": "matrix", "content": "新的"}],
                                 source_tag="sample-matrix", source_doc="仿真.docx", source_version="")
        conn = FakeConn(table_answers())
        plan = kb_store.ingest(conn, "approval_rules", rows=rules, source_tag="sample-matrix", dry_run=True)
        self.assertEqual((plan["inserted"], plan["will_insert"]), (1, ["C05-5.1"]))
        self.assertEqual(conn.executed[-1], ("ROLLBACK", None))
        self.assertFalse(any("kb_embed" in s for s, _ in conn.executed), "dry-run 不算向量")
        conn = FakeConn(table_answers(existing=[("C05-5.1", "s", True, "finance-approval-v4", "旧", "x.docx")]))
        with self.assertRaises(kb_store.KbError) as caught:
            kb_store.ingest(conn, "approval_rules", rules, source_tag="sample-matrix")
        self.assertEqual((caught.exception.code, caught.exception.extra["conflicts"]), ("rule_conflict", ["C05-5.1"]))
        self.assertEqual(conn.executed[-1], ("ROLLBACK", None))
        self.assertFalse(any(s.startswith(("INSERT", "UPDATE", "DELETE")) for s, _ in conn.executed))


class RecordHash(unittest.TestCase):
    def test_record_hash_frozen(self):
        self.assertEqual(kb_store.COLUMNS, COLUMNS_BEFORE)
        self.assertEqual(kb_store.JSONB, {"approval_path", "extra"})
        records, _ = kb_parse.parse_document(FIXTURE, source_tag="sample-matrix", doc_title="sample-matrix.docx")
        rows = kb_store.prepare(records, source_tag="sample-matrix", source_doc="sample-matrix.docx", source_version="V1")
        self.assertEqual(rows[0]["rule_id"], "G-01")
        self.assertEqual(rows[0]["record_sha256"], FIRST_HASH)
        self.assertEqual(kb_store.record_hash(rows[0]), FIRST_HASH)
        self.assertEqual(hashlib.sha256("".join(r["record_sha256"] for r in rows).encode()).hexdigest(), ALL_HASHES)
        # 入库用的行：全部列、向量空着、JSONB 列是 JSON 文本；不改调用方的记录
        self.assertEqual(tuple(rows[0]), COLUMNS_BEFORE)
        self.assertIsNone(rows[0]["embedding"])
        self.assertEqual(rows[0]["approval_path"], "[]")
        self.assertIsInstance(records[0]["approval_path"], list)

    def test_tag_re(self):
        for ok in ("sample-matrix", "finance-approval-v4", "a1", "a" * 63):
            self.assertIsNotNone(kb_store.TAG_RE.fullmatch(ok), ok)
        for bad in ("a", "-ab", "Ab", "a_b", "a" * 64, "a b", "ab\n"):
            self.assertIsNone(kb_store.TAG_RE.fullmatch(bad), bad)


class Parameterised(unittest.TestCase):
    """值一律走参数，不拼进 SQL；表名先过 [a-z_][a-z0-9_]*，调用方和类型名之类只从写死的几个里选。"""

    def test_sql_is_parameterised(self):
        rows = kb_store.prepare([{"rule_id": MARK + "-1", "rule_type": "clause", "content": HOSTILE, "business_item": HOSTILE,
                                  "extra": {"k": HOSTILE}}], source_tag=MARK, source_doc=HOSTILE, source_version=HOSTILE)
        existing = [(MARK + "-2", "s", True, MARK, HOSTILE, HOSTILE), (MARK + "-1", "s", True, MARK, "旧" + HOSTILE, HOSTILE)]
        conn = FakeConn(table_answers(existing=existing))
        result = kb_store.ingest(conn, "approval_rules", rows, source_tag=MARK, document_id=3)
        self.assertEqual((result["reembedded"], result["removed"]), (1, 1))
        with conn.cursor() as cur:
            kb_store.record_document(cur, file_name=HOSTILE, sha256=HOSTILE, size_bytes=1, uploaded_by=HOSTILE, source_tag=MARK,
                                     doc_title=HOSTILE, source_version=HOSTILE, report={"k": HOSTILE})
            kb_store.set_document_status(cur, 3, "ingesting", source_tag=MARK, doc_title=HOSTILE, source_version=HOSTILE)
            kb_store.set_document_status(cur, 3, "ingested", result={"k": HOSTILE}, source_tag=MARK, doc_title=HOSTILE)
            kb_store.set_document_status(cur, 3, "failed", error=HOSTILE, result={"k": HOSTILE})
            kb_store.recover(cur, 30)
            kb_store.history(cur, 5)
            kb_store.show(cur, 3)
            kb_store.tags(cur, "approval_rules")
            kb_store.search(cur, HOSTILE, 5, HOSTILE, "page")
            kb_store.search_log(cur, 5)
            kb_store.ensure_owner(cur, "approval_rules")
            kb_store.embed_model(cur)
            kb_store.ensure_archive(cur, "approval_rules")
            kb_store.list_sources(cur, "approval_rules")
            kb_store.source_detail(cur, "approval_rules", MARK)
            kb_store.check(cur, "approval_rules", MARK)
            kb_store.check(cur, "approval_rules")
        for fn in (kb_store.deactivate, kb_store.restore, kb_store.delete):
            fn(conn, "approval_rules", MARK)
        params = [p for _, p in conn.executed if p]
        self.assertTrue(any(HOSTILE in json.dumps(p, ensure_ascii=False, default=str) for p in params))
        for sql, _ in conn.executed:
            self.assertNotIn("DROP TABLE", sql)
            self.assertNotIn(MARK, sql)

    def test_bad_table_names_are_refused_before_any_sql(self):
        rows = kb_store.prepare([{"rule_id": "C01-1.1", "rule_type": "matrix", "content": "x"}], source_tag="ab", source_doc="d",
                                source_version="")
        calls = [lambda c, t: kb_store.ingest(c, t, rows, source_tag="ab"),
                 lambda c, t: kb_store.deactivate(c, t, "ab"), lambda c, t: kb_store.restore(c, t, "ab"),
                 lambda c, t: kb_store.delete(c, t, "ab"),
                 lambda c, t: kb_store.ensure_owner(c.cursor(), t), lambda c, t: kb_store.ensure_archive(c.cursor(), t),
                 lambda c, t: kb_store.tags(c.cursor(), t), lambda c, t: kb_store.list_sources(c.cursor(), t),
                 lambda c, t: kb_store.source_detail(c.cursor(), t, "ab"), lambda c, t: kb_store.check(c.cursor(), t)]
        for bad in ("rules; drop", "Approval_rules", "1rules", "approval-rules", "public.approval_rules", ""):
            for call in calls:
                conn = FakeConn(table_answers())
                with self.assertRaises(kb_store.KbError) as caught:
                    call(conn, bad)
                self.assertEqual(caught.exception.code, "invalid_parameter")
                self.assertEqual(conn.executed, [], bad)

    def test_bad_tags_callers_and_statuses_are_refused_before_any_sql(self):
        rows = kb_store.prepare([{"rule_id": "C01-1.1", "rule_type": "matrix", "content": "x"}], source_tag="Bad Tag", source_doc="d",
                                source_version="")
        calls = [lambda c: kb_store.ingest(c, "approval_rules", rows, source_tag="Bad Tag"),
                 lambda c: kb_store.deactivate(c, "approval_rules", HOSTILE), lambda c: kb_store.restore(c, "approval_rules", HOSTILE),
                 lambda c: kb_store.delete(c, "approval_rules", HOSTILE),
                 lambda c: kb_store.source_detail(c.cursor(), "approval_rules", HOSTILE),
                 lambda c: kb_store.check(c.cursor(), "approval_rules", HOSTILE),
                 lambda c: kb_store.search(c.cursor(), "q", 5, None, "page'); --"),
                 lambda c: kb_store.set_document_status(c.cursor(), 1, "done'; --")]
        for call in calls:
            conn = FakeConn(table_answers())
            with self.assertRaises(kb_store.KbError) as caught:
                call(conn)
            self.assertEqual(caught.exception.code, "invalid_parameter")
            self.assertEqual(conn.executed, [])

    def test_empty_rows_are_refused_before_any_sql(self):
        for embed in ("sql", "sql-legacy"):
            conn = FakeConn(table_answers())
            with self.assertRaises(kb_store.KbError) as caught:
                kb_store.ingest(conn, "approval_rules", [], source_tag="sample-matrix", prune=True, embed=embed)
            self.assertEqual(caught.exception.code, "empty_document")
            self.assertEqual(conn.executed, [], "不拿锁、一句不执行")

    def test_only_the_deploy_path_falls_back_to_per_row_kb_embed(self):
        rows = kb_store.prepare([{"rule_id": "C01-1.1", "rule_type": "matrix", "content": "x"}], source_tag="sample-matrix",
                                source_doc="d", source_version="")
        no_batch = [a for a in table_answers() if a[0] != "to_regprocedure"]
        conn = FakeConn(no_batch)
        with self.assertRaises(kb_store.KbError) as caught:
            kb_store.ingest(conn, "approval_rules", rows, source_tag="sample-matrix")
        self.assertEqual(caught.exception.code, "kb_not_ready")
        self.assertFalse(any(s.startswith(("INSERT", "UPDATE", "DELETE", "SELECT kb_embed")) for s, _ in conn.executed))
        conn = FakeConn(no_batch + [("SELECT kb_embed(%s)::text", (["e"], [("[0.1,0.2]",)]))])
        self.assertEqual(kb_store.ingest(conn, "approval_rules", rows, source_tag="sample-matrix", embed="sql-legacy")["inserted"], 1)
        self.assertEqual([p for s, p in conn.executed if s.startswith("SELECT kb_embed(%s)::text")], [("x",)])
        with self.assertRaises(kb_store.KbError):
            kb_store.ingest(FakeConn(table_answers()), "approval_rules", rows, source_tag="sample-matrix", embed="bedrock")

    def test_ingest_refuses_rows_of_another_tag_and_autocommit(self):
        rows = kb_store.prepare([{"rule_id": "C01-1.1", "rule_type": "matrix", "content": "x"}], source_tag="other-doc",
                                source_doc="d", source_version="")
        conn = FakeConn(table_answers())
        with self.assertRaises(kb_store.KbError):
            kb_store.ingest(conn, "approval_rules", rows, source_tag="sample-matrix")
        conn.autocommit = True
        with self.assertRaises(kb_store.KbError):
            kb_store.ingest(conn, "approval_rules", rows, source_tag="other-doc")
        self.assertEqual(conn.executed, [])


class KbErrorShape(unittest.TestCase):
    def test_code_message_extra(self):
        e = kb_store.KbError("rule_conflict", "2 条规则编号已属于库里另一份文档", conflicts=["C01-1.1"])
        self.assertEqual((e.code, e.message, e.extra, str(e)), ("rule_conflict", "2 条规则编号已属于库里另一份文档",
                                                               {"conflicts": ["C01-1.1"]}, "2 条规则编号已属于库里另一份文档"))


class TitanOnlyBedrock(unittest.TestCase):
    def test_cohere_with_embed_bedrock_exits_before_connecting(self):
        import ingest_rules
        conn = FakeConn(table_answers())
        argv = ["ingest_rules.py", "--rules", "/nonexistent.json", "--port", "5432", "--db", "nexus", "--user", "nexus",
                "--password-file", "/nonexistent", "--table", "approval_rules", "--ddl", "/nonexistent.sql", "--source-tag", "sample-matrix",
                "--source-doc", "仿真.docx", "--model", "us.cohere.embed-v4:0", "--dim", "1024", "--region", "us-east-1", "--embed", "bedrock"]
        with FakePsycopg(conn), mock.patch.object(sys, "argv", argv), self.assertRaises(SystemExit) as stop:
            ingest_rules.main()
        self.assertIn("--embed sql", str(stop.exception.code))
        self.assertEqual(conn.executed, [])
        self.assertNotIn("boto3", sys.modules)


if __name__ == "__main__":
    unittest.main()
