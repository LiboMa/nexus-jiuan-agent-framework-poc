"""kb_admin.py（上传历史、检索、检索日志的管理命令）与 ingest_rules.py --embed sql：用假连接测，不连真库。

    python3 -B -m unittest discover -s kb/tests
"""
import io
import json
import sys
import tempfile
import types
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

LIB = Path(__file__).resolve().parent.parent / "lib"
sys.path.insert(0, str(LIB))


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
    def __init__(self, answers=()):
        self.answers, self.executed, self.commits = list(answers), [], 0

    def cursor(self):
        return FakeCursor(self)

    def commit(self):
        self.commits += 1

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def admin(argv, conn):
    import kb_admin
    with tempfile.TemporaryDirectory() as tmp:
        pw = Path(tmp) / "pw"
        pw.write_text("s3cret-password-value\n", encoding="utf-8")
        out = io.StringIO()
        with redirect_stdout(out):
            code = kb_admin.main(["--host", "10.0.1.10", "--port", "5432", "--db", "nexus", "--user", "nexus", "--password-file", str(pw), *argv],
                                 connect=lambda a: conn)
    text = out.getvalue()
    return code, text


class KbAdminTest(unittest.TestCase):
    def test_record_is_parameterised_and_prints_one_json_line(self):
        conn = FakeConn([("RETURNING id", (["id"], [(7,)]))])
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
            json.dump({"matrix": 12}, f)
        code, text = admin(["record", "--name", "仿真'; DROP TABLE x;--.docx", "--sha256", "ab" * 32, "--size", "1234", "--by", "local:poc-reviewer",
                            "--report", f.name], conn)
        self.assertEqual(code, 0)
        self.assertEqual(text.count("\n"), 1)
        self.assertEqual(json.loads(text), {"id": 7})
        sql, params = conn.executed[0]
        self.assertIn("INSERT INTO kb_documents", sql)
        self.assertNotIn("DROP TABLE", sql, "用户给的值只走参数")
        self.assertIn("仿真'; DROP TABLE x;--.docx", params)
        self.assertEqual(conn.commits, 1)
        self.assertNotIn("s3cret", text)

    def test_ingested_supersedes_the_previous_ingest_of_the_same_tag(self):
        conn = FakeConn()
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
            json.dump({"inserted": 0, "unchanged": 12}, f)
        code, text = admin(["status", "9", "--status", "ingested", "--result", f.name, "--source-tag", "sample-matrix", "--doc-title", "仿真办法",
                            "--source-version", "V1"], conn)
        self.assertEqual((code, json.loads(text)), (0, {"ok": True}))
        statements = [sql for sql, _ in conn.executed]
        supersede = next(i for i, sql in enumerate(statements) if "status = 'superseded'" in sql)
        self.assertIn("source_tag = %s", statements[supersede])
        self.assertIn("id <> %s", statements[supersede])
        self.assertEqual(conn.executed[supersede][1][0], "sample-matrix")
        self.assertTrue(any("finished_at = now()" in sql for sql in statements))

    def test_recover_marks_interrupted_ingests_failed(self):
        conn = FakeConn([("RETURNING id", (["id"], [(3,), (4,)]))])
        code, text = admin(["recover"], conn)
        self.assertEqual(json.loads(text), {"recovered": 2})
        self.assertIn("status = 'ingesting'", conn.executed[0][0])
        self.assertIn("服务重启，入库中断", conn.executed[0][1])

    def test_history_and_search_log_serialise_dates_and_numbers(self):
        at = datetime(2026, 10, 26, 8, 0, tzinfo=timezone.utc)
        conn = FakeConn([("FROM kb_documents", (["id", "file_name", "uploaded_at", "status", "report"], [(5, "仿真.docx", at, "ingested", {"matrix": 12})])),
                         ("FROM kb_search_log", (["id", "at", "caller", "hits", "took_ms"], [(1, at, "agent", [{"rule_id": "C05-5.2", "score": 0.81}], 120)]))])
        code, text = admin(["history", "--limit", "20"], conn)
        self.assertEqual(json.loads(text)["items"][0], {"id": 5, "file_name": "仿真.docx", "uploaded_at": "2026-10-26T08:00:00+00:00", "status": "ingested", "report": {"matrix": 12}})
        self.assertEqual(conn.executed[0][1], (20,))
        code, text = admin(["search-log"], conn)
        self.assertEqual(json.loads(text)["items"][0]["caller"], "agent")

    def test_search_calls_kb_search_as_the_page(self):
        conn = FakeConn([("FROM kb_search", (["rule_id", "score"], [("C05-5.2", Decimal("0.8123"))]))])
        code, text = admin(["search", "供应商 货款 单笔 2 万", "--k", "5"], conn)
        self.assertEqual(json.loads(text), {"items": [{"rule_id": "C05-5.2", "score": 0.8123}]})
        sql, params = conn.executed[0]
        self.assertIn("FROM kb_search(%s, %s, %s, 'page')", sql)
        self.assertEqual(params, ("供应商 货款 单笔 2 万", 5, None))

    def test_tags_and_bad_table_name(self):
        conn = FakeConn([("FROM approval_rules", (["source_tag", "source_doc", "rows"], [("finance-approval-v4", "x.docx", 102)]))])
        code, text = admin(["tags"], conn)
        self.assertEqual(json.loads(text)["items"][0]["rows"], 102)
        code, text = admin(["--table", "rules; drop", "tags"], conn)
        self.assertNotEqual(code, 0)
        self.assertIn("error", json.loads(text))


class IngestSqlEmbedTest(unittest.TestCase):
    def test_sql_mode_embeds_in_the_database_without_boto3(self):
        conn = FakeConn([("SELECT to_regclass", (["exists"], [(False,)])), ("SELECT kb_embed(%s)::text", (["e"], [("[0.1,0.2]",)])),
                         ("GROUP BY 1", (["rule_type", "n"], [("matrix", 1)])), ("embedding IS NULL", (["n"], [(0,)]))])
        fake = types.ModuleType("psycopg")
        fake.connect = lambda **kw: conn
        sys.modules["psycopg"] = fake
        sys.modules.pop("boto3", None)
        sys.modules.pop("ingest_rules", None)
        import ingest_rules
        with tempfile.TemporaryDirectory() as tmp:
            rules = Path(tmp) / "rules.json"
            rules.write_text(json.dumps([{"rule_id": "C05-5.1", "rule_type": "matrix", "content": "【五、付款审批】5.1 供应商货款"}], ensure_ascii=False), encoding="utf-8")
            pw = Path(tmp) / "pw"
            pw.write_text("x", encoding="utf-8")
            ddl = Path(tmp) / "ddl.sql"
            ddl.write_text("CREATE TABLE IF NOT EXISTS {table} (rule_id text)", encoding="utf-8")
            sys.argv = ["ingest_rules.py", "--rules", str(rules), "--port", "5432", "--db", "nexus", "--user", "nexus", "--password-file", str(pw),
                        "--table", "approval_rules", "--ddl", str(ddl), "--source-tag", "sample-matrix", "--source-doc", "仿真.docx",
                        "--model", "amazon.titan-embed-text-v2:0", "--dim", "1024", "--region", "us-east-1", "--embed", "sql"]
            out = io.StringIO()
            with redirect_stdout(out):
                ingest_rules.main()
        self.assertNotIn("boto3", sys.modules, "--embed sql 不用 boto3")
        embeds = [params for sql, params in conn.executed if sql.startswith("SELECT kb_embed(%s)::text")]
        self.assertEqual(embeds, [("【五、付款审批】5.1 供应商货款",)])
        self.assertEqual(json.loads(out.getvalue().strip().splitlines()[-1])["inserted"], 1)


if __name__ == "__main__":
    unittest.main()
