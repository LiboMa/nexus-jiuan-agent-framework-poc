"""kb_store 在真 PG（本机 PGlite + pgvector，假的 kb_embed_impl）上：入库的对比 / 冲突 / 清理 / 回滚、下线 / 恢复 / 删除、校验，
以及改薄之后的命令行 ingest_rules.py、kb_admin.py（子进程，照 deploy.sh 的 python -I 跑）。

    bash kb/tests/run_pglite.sh 55432        # 另一个终端
    KB_TEST_PG_PORT=55432 $KBPY -m unittest kb/tests/test_kb_store_pg.py -v

没设 KB_TEST_PG_PORT 时都是 skipped。夹具全部虚构（sample-matrix.docx、测试现生成的 Markdown）。
"""
import copy
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
LIB = HERE.parent / "lib"
sys.path.insert(0, str(LIB))
sys.path.insert(0, str(HERE))
import kb_parse  # noqa: E402
import kb_store  # noqa: E402
import pg_harness as H  # noqa: E402
import sample_docs  # noqa: E402

TABLE, TAG, DOC = "approval_rules", "sample-matrix", "sample-matrix.docx"
FIXTURE = HERE / "fixtures" / "sample-matrix.docx"
RECORDS = kb_parse.parse_document(FIXTURE, source_tag=TAG, doc_title=DOC)[0]          # 18 条：3 general、3 chapter_note、12 matrix
IDS = sorted(r["rule_id"] for r in RECORDS)
BY_TYPE = {"chapter_note": 3, "general": 3, "matrix": 12}


def records(**changes):
    """夹具记录的副本；changes = {rule_id: {列: 新值}}。"""
    out = copy.deepcopy(RECORDS)
    for r in out:
        r.update(changes.get(r["rule_id"], {}))
    return out


def rows(recs=None, tag=TAG, version="V1", doc=DOC):
    return kb_store.prepare(RECORDS if recs is None else recs, source_tag=tag, source_doc=doc, source_version=version)


def tiny_records(tmp):
    """虚构的两条正文条款（Markdown → parse_document）：tiny-doc-A1、tiny-doc-A2。"""
    path = sample_docs.md(Path(tmp) / "tiny.md", ["# 虚构差旅办法", "", "第一条 出差人员应当乘坐经济舱，特殊情况经部门负责人批准。", "",
                                                  "第二条 住宿费按城市标准据实报销，超标部分自理。"])
    return kb_parse.parse_document(path, source_tag="tiny-doc", doc_title="虚构差旅办法")[0]


class StoreCase(unittest.TestCase):
    def setUp(self):
        self.conn = H.connect()
        self.addCleanup(self.conn.close)
        H.reset(self.conn)
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)

    def q(self, sql, params=None):
        """读完就提交：入库要在一个新事务里、以锁开头。"""
        got = self.conn.execute(sql, params).fetchall()
        self.conn.commit()
        return got

    def one(self, sql, params=None):
        return self.q(sql, params)[0][0]

    def run_sql(self, sql, params=None):
        self.conn.execute(sql, params)
        self.conn.commit()

    def calls(self):
        return self.one("SELECT count(*) FROM kb_fake_embed_calls")

    def state(self, table=TABLE):
        return {r[0]: r[1:] for r in self.q(f"SELECT rule_id, record_sha256, embedding::text, source_tag, source_version FROM {table}")}

    def ingest(self, the_rows, tag=TAG, **kw):
        result = kb_store.ingest(self.conn, TABLE, the_rows, source_tag=tag, **kw)
        self.assertIdle()
        return result

    def assertIdle(self):
        status = self.conn.info.transaction_status
        self.assertEqual(status, type(status).IDLE, "kb_store 的写入函数结束时提交或回滚了自己的事务")

    def counts(self, result):
        return {k: result[k] for k in ("rules_total", "inserted", "updated", "reembedded", "unchanged", "removed")}

    def record_doc(self, tag=TAG, status="ingesting", name="仿真办法.docx", sha="ab" * 32):
        with self.conn.cursor() as cur:
            doc_id = kb_store.record_document(cur, file_name=name, sha256=sha, size_bytes=2109, uploaded_by="agent", source_tag=tag,
                                              doc_title="仿真办法", source_version="V1", report={"total": 18}, status=status)
        self.conn.commit()
        return doc_id


class Ingest(StoreCase):
    def test_insert_then_all_unchanged_without_new_vectors(self):
        first = self.ingest(rows())
        self.assertEqual(self.counts(first), {"rules_total": 18, "inserted": 18, "updated": 0, "reembedded": 0, "unchanged": 0, "removed": 0})
        self.assertEqual((first["will_insert"], first["will_update"], first["will_remove"]), (IDS, [], []))
        self.assertEqual(self.q("SELECT via, purpose, count(*) FROM kb_fake_embed_calls GROUP BY 1, 2"), [("batch", "search_document", 18)])
        state = self.state()
        self.assertEqual(sorted(state), IDS)
        for r in RECORDS:
            self.assertTrue(H.same_vector(state[r["rule_id"]][1], H.fake_vector(H.COHERE, "search_document", r["content"])), r["rule_id"])
        self.assertEqual({v[2] for v in state.values()}, {TAG})

        again = self.ingest(rows())
        self.assertEqual(self.counts(again), {"rules_total": 18, "inserted": 0, "updated": 0, "reembedded": 0, "unchanged": 18, "removed": 0})
        self.assertEqual((again["will_insert"], again["will_update"], again["will_remove"]), ([], [], []))
        self.assertEqual(self.calls(), 18, "全部不变：一个新向量都不算")
        self.assertEqual(self.state(), state)

    def test_columns_outside_content_are_updated_keeping_the_vector(self):
        self.ingest(rows())
        before = self.state()
        changed = records(**{"C01-1.1": {"final_approver": "某虚构岗位", "post_actions": "归档", "extra": {"备注": "虚构"}}})
        result = self.ingest(rows(changed, version="V2"))
        self.assertEqual(self.counts(result), {"rules_total": 18, "inserted": 0, "updated": 18, "reembedded": 0, "unchanged": 0, "removed": 0})
        self.assertEqual(result["will_update"], IDS)
        self.assertEqual(self.calls(), 18)
        after = self.state()
        self.assertEqual({k: v[1] for k, v in after.items()}, {k: v[1] for k, v in before.items()}, "向量不变")
        self.assertEqual({v[3] for v in after.values()}, {"V2"})
        self.assertEqual(self.q(f"SELECT final_approver, post_actions, extra FROM {TABLE} WHERE rule_id = 'C01-1.1'"),
                         [("某虚构岗位", "归档", {"备注": "虚构"})])
        self.assertEqual(self.ingest(rows(changed, version="V2"))["unchanged"], 18)

    def test_content_change_is_reembedded(self):
        self.ingest(rows())
        new = RECORDS[14]["content"] + "（修订：须附银行回单）"
        result = self.ingest(rows(records(**{RECORDS[14]["rule_id"]: {"content": new}})))
        self.assertEqual(self.counts(result), {"rules_total": 18, "inserted": 0, "updated": 0, "reembedded": 1, "unchanged": 17, "removed": 0})
        self.assertEqual(result["will_update"], [RECORDS[14]["rule_id"]])
        self.assertEqual(self.calls(), 19)
        vec = self.one(f"SELECT embedding::text FROM {TABLE} WHERE rule_id = %s", (RECORDS[14]["rule_id"],))
        self.assertTrue(H.same_vector(vec, H.fake_vector(H.COHERE, "search_document", new)))

    def test_rule_dropped_by_the_new_version_is_removed(self):
        self.ingest(rows())
        result = self.ingest(rows(RECORDS[:-1]))
        self.assertEqual(self.counts(result), {"rules_total": 17, "inserted": 0, "updated": 0, "reembedded": 0, "unchanged": 17, "removed": 1})
        self.assertEqual(result["will_remove"], ["C05-5.5"])
        self.assertNotIn("C05-5.5", self.state())
        kept = self.ingest(rows(RECORDS[:-2]), prune=False)
        self.assertEqual((kept["removed"], kept["will_remove"]), (0, []))
        self.assertEqual(len(self.state()), 17, "prune=False 不删")

    def test_prune_only_touches_rows_of_this_tag(self):
        self.ingest(rows())
        tiny = kb_store.prepare(tiny_records(self.tmp), source_tag="tiny-doc", source_doc="虚构差旅办法", source_version="")
        self.ingest(tiny, tag="tiny-doc")
        self.run_sql(f"INSERT INTO {TABLE} (rule_id, rule_type, content) VALUES ('M-1', 'general', '手工写入的一行')")
        for dry in (True, False):
            result = self.ingest(rows(RECORDS[:-1]), dry_run=dry)
            self.assertEqual((result["will_remove"], result["removed"], result["untagged_not_in_doc"]), (["C05-5.5"], 1, 1), dry)
        state = self.state()
        self.assertEqual(sorted(k for k, v in state.items() if v[2] != TAG), ["M-1", "tiny-doc-A1", "tiny-doc-A2"], "别的标签、没有标签的行都不删")
        self.assertNotIn("C05-5.5", state)

    def test_rule_id_of_another_tag_is_a_conflict_and_nothing_is_written(self):
        self.ingest(rows())
        before, calls = self.state(), self.calls()
        other = rows(RECORDS[:2] + [dict(RECORDS[2], rule_id="X-01")], tag="other-doc", doc="另一份虚构办法.docx")
        with self.assertRaises(kb_store.KbError) as caught:
            self.ingest(other, tag="other-doc")
        self.assertEqual(caught.exception.code, "rule_conflict")
        self.assertEqual(caught.exception.extra["conflicts"], ["G-01", "G-02"])
        self.assertIn("2 条规则编号已属于库里另一份文档（sample-matrix）", caught.exception.message)
        self.assertIdle()
        self.assertEqual(self.state(), before, "一条不写（X-01 也没写）")
        self.assertEqual(self.calls(), calls)

    def test_untagged_rows_of_the_same_document_are_claimed(self):
        g1, g2 = RECORDS[0], RECORDS[1]
        self.run_sql(f"INSERT INTO {TABLE} (rule_id, rule_type, content, embedding, source_doc) VALUES (%s, 'general', %s, kb_embed(%s), %s)",
                     (g1["rule_id"], g1["content"], g1["content"], DOC))
        self.run_sql(f"INSERT INTO {TABLE} (rule_id, rule_type, content) VALUES (%s, 'general', %s)", (g2["rule_id"], g2["content"]))
        vec, calls = self.state()[g1["rule_id"]][1], self.calls()
        result = self.ingest(rows())
        self.assertEqual(self.counts(result), {"rules_total": 18, "inserted": 16, "updated": 1, "reembedded": 1, "unchanged": 0, "removed": 0})
        self.assertEqual(result["will_update"], ["G-01", "G-02"])
        state = self.state()
        self.assertEqual(state[g1["rule_id"]][1], vec, "正文没变、已有向量：只补标签")
        self.assertEqual({v[2] for v in state.values()}, {TAG})
        self.assertEqual(self.calls(), calls + 17)

    def test_untagged_rows_of_another_document_conflict(self):
        self.run_sql(f"INSERT INTO {TABLE} (rule_id, rule_type, content, source_doc) VALUES ('G-01', 'general', '手工的', '另一份虚构办法.docx')")
        with self.assertRaises(kb_store.KbError) as caught:
            self.ingest(rows())
        self.assertEqual((caught.exception.code, caught.exception.extra["conflicts"]), ("rule_conflict", ["G-01"]))
        self.assertIn("另一份虚构办法.docx", caught.exception.message)
        self.assertEqual(self.q(f"SELECT rule_id, source_tag FROM {TABLE}"), [("G-01", None)])
        self.assertEqual(self.calls(), 0)

    def test_dry_run_writes_nothing_and_embeds_nothing(self):
        doc_id = self.record_doc()
        plan = self.ingest(rows(), dry_run=True, document_id=doc_id)
        self.assertEqual(self.counts(plan), {"rules_total": 18, "inserted": 18, "updated": 0, "reembedded": 0, "unchanged": 0, "removed": 0})
        self.assertEqual(plan["will_insert"], IDS)
        self.assertEqual((self.state(), self.calls()), ({}, 0))
        self.assertEqual(self.one("SELECT status FROM kb_documents WHERE id = %s", (doc_id,)), "ingesting")
        self.ingest(rows())
        before = self.state()
        changed = records(**{"C03-3.1": {"content": "改过的虚构正文"}})[:-1]
        plan = self.ingest(rows(changed), dry_run=True)
        self.assertEqual(self.counts(plan), {"rules_total": 17, "inserted": 0, "updated": 0, "reembedded": 1, "unchanged": 16, "removed": 1})
        self.assertEqual((plan["will_update"], plan["will_remove"]), (["C03-3.1"], ["C05-5.5"]))
        self.assertEqual((self.state(), self.calls()), (before, 18))

    def test_embedding_failure_rolls_back_the_whole_document(self):
        self.ingest(rows())
        before, calls = self.state(), self.calls()
        doc_id = self.record_doc()
        bad = rows(records(**{"C05-5.2": {"content": "虚构正文 __FAIL__"}}) + [dict(RECORDS[0], rule_id="G-09")], version="V2")
        with self.assertRaisesRegex(Exception, "kb_embed：Bedrock 返回 500"):
            self.ingest(bad, document_id=doc_id)
        self.assertIdle()
        self.assertEqual(self.state(), before, "整份回滚：V2 的元数据更新、新增的 G-09 都没写")
        self.assertEqual(self.calls(), calls)
        self.assertEqual(self.one("SELECT status FROM kb_documents WHERE id = %s", (doc_id,)), "ingesting")
        with self.conn.cursor() as cur:   # 调用方随后在新事务里记失败
            kb_store.set_document_status(cur, doc_id, "failed", error="kb_embed：Bedrock 返回 500")
        self.conn.commit()
        self.assertEqual(self.one("SELECT status FROM kb_documents WHERE id = %s", (doc_id,)), "failed")

    def test_document_row_is_marked_ingested_and_the_previous_superseded(self):
        first = self.record_doc()
        self.ingest(rows(), document_id=first)
        second = self.record_doc(sha="cd" * 32)
        result = self.ingest(rows(version="V2"), document_id=second)
        docs = dict(self.q("SELECT id, status FROM kb_documents"))
        self.assertEqual(docs, {first: "superseded", second: "ingested"})
        stored = self.one("SELECT result FROM kb_documents WHERE id = %s", (second,))
        self.assertEqual(stored["rules_total"], 18)
        self.assertEqual(stored["updated"], result["updated"])
        self.assertIsNotNone(self.one("SELECT finished_at FROM kb_documents WHERE id = %s", (second,)))

    def test_refuses_a_connection_with_an_open_transaction(self):
        # 锁要是入库事务的第一句：调用方没提交的事务不能被并进来
        self.conn.execute("SELECT 1")
        for call in (lambda: kb_store.ingest(self.conn, TABLE, rows(), source_tag=TAG), lambda: kb_store.delete(self.conn, TABLE, TAG)):
            with self.assertRaises(kb_store.KbError) as caught:
                call()
            self.assertEqual(caught.exception.code, "invalid_parameter")
        self.conn.rollback()
        self.assertEqual((self.state(), self.calls()), ({}, 0))

    def test_titan_callable_embed(self):
        seen = []

        def titan(texts):
            seen.append(list(texts))
            return ["[" + ",".join(f"{x:.7f}" for x in H.fake_vector(H.TITAN, "x", t)) + "]" for t in texts]
        self.ingest(rows(), embed=titan)
        self.assertEqual(len(seen), 1, "一次给全部要算的正文")
        self.assertEqual(sorted(seen[0]), sorted(r["content"] for r in RECORDS))
        self.assertEqual(self.calls(), 0)
        vec = self.state()["G-01"][1]
        self.assertTrue(H.same_vector(vec, H.fake_vector(H.TITAN, "x", RECORDS[0]["content"]), tol=1e-5))
        with self.assertRaises(kb_store.KbError):
            self.ingest(rows(records(**{"G-01": {"content": "新的"}})), embed=lambda texts: [])
        self.assertEqual(self.state()["G-01"][1], vec)

    def test_legacy_database_without_kb_embed_batch(self):
        # kb_search.sql 还是 Task 3 之前的版本（没有 kb_embed_batch）：只有 deploy.sh 的路（embed="sql-legacy"）逐条调
        # kb_embed(text)，同一个库里的模型
        self.run_sql("DROP FUNCTION kb_embed_batch(text[], text)")
        result = self.ingest(rows(RECORDS[:3]), embed="sql-legacy")
        self.assertEqual(result["inserted"], 3)
        self.assertEqual(self.q("SELECT via, count(*) FROM kb_fake_embed_calls GROUP BY 1"), [("single", 3)])

    def test_agent_path_reports_kb_not_ready_without_kb_embed_batch(self):
        # 工具的路（缺省 embed="sql"）不回落：库还没升级就报 kb_not_ready，预览也一样，一条不写、一个向量不算
        self.run_sql("DROP FUNCTION kb_embed_batch(text[], text)")
        for dry in (False, True):
            with self.assertRaises(kb_store.KbError) as caught:
                self.ingest(rows(), dry_run=dry)
            self.assertEqual(caught.exception.code, "kb_not_ready")
            self.assertIn("kb_embed_batch", caught.exception.message)
        self.assertEqual((self.state(), self.calls()), ({}, 0))
        # 表不存在也是 kb_not_ready（deploy.sh 的路照旧按空表对比，由它先建表）
        self.run_sql(f"DROP TABLE {TABLE}")
        with self.assertRaises(kb_store.KbError) as caught:
            self.ingest(rows())
        self.assertEqual(caught.exception.code, "kb_not_ready")
        self.assertIn(TABLE, caught.exception.message)

    def test_empty_rows_are_refused_before_anything(self):
        # 空的新版本加上 prune 会删光这份制度：不拿锁、一句不执行，表不变
        self.ingest(rows())
        before = self.state()
        for embed in ("sql", "sql-legacy"):
            for dry in (False, True):
                with self.assertRaises(kb_store.KbError) as caught:
                    self.ingest([], prune=True, dry_run=dry, embed=embed)
                self.assertEqual(caught.exception.code, "empty_document")
        self.assertEqual(self.state(), before)


class Manage(StoreCase):
    def test_source_inactive_refuses_ingest(self):
        # Review Focus 4：已下线（在归档表里）的制度又来入库 → source_inactive，一条不写，不会「在线一份、归档一份」
        self.ingest(rows())
        self.assertEqual(kb_store.deactivate(self.conn, TABLE, TAG), 18)
        self.assertIdle()
        calls = self.calls()
        for dry in (False, True):
            with self.assertRaises(kb_store.KbError) as caught:
                self.ingest(rows(version="V2"), dry_run=dry)
            self.assertEqual(caught.exception.code, "source_inactive")
            self.assertIn("恢复", caught.exception.message)
            self.assertIn("删除", caught.exception.message)
        self.assertEqual(self.state(), {})
        self.assertEqual(self.one(f"SELECT count(*) FROM {TABLE}_archive WHERE source_tag = %s", (TAG,)), 18)
        self.assertEqual(self.calls(), calls)

    def test_deactivate_hides_from_kb_search_and_restore_brings_it_back(self):
        self.ingest(rows())
        before = self.state()
        search = "SELECT rule_id FROM kb_search('合同 用印', 5, NULL, 'test')"
        hits = [r[0] for r in self.q(search)]
        self.assertTrue(hits and set(hits) <= set(IDS))
        self.assertEqual(kb_store.deactivate(self.conn, TABLE, TAG), 18)
        self.assertEqual(self.q(search), [])
        self.assertEqual(self.one(f"SELECT count(*) FROM {TABLE} WHERE content ILIKE '%%合同%%'"), 0, "审核 Agent 的 ILIKE 补查也看不到")
        self.assertEqual(self.one(f"SELECT count(*) FROM {TABLE}_archive WHERE archived_at IS NOT NULL"), 18)
        self.assertEqual(self.state(f"{TABLE}_archive"), before)
        self.assertEqual(kb_store.restore(self.conn, TABLE, TAG), 18)
        self.assertIdle()
        self.assertEqual([r[0] for r in self.q(search)], hits)
        self.assertEqual(self.state(), before, "向量（和其他列）原样回来")
        self.assertEqual(self.one(f"SELECT count(*) FROM {TABLE}_archive"), 0)
        self.assertEqual(self.ingest(rows())["unchanged"], 18)

    def test_restore_conflicts_when_a_rule_id_was_taken_meanwhile(self):
        self.ingest(rows())
        kb_store.deactivate(self.conn, TABLE, TAG)
        self.ingest(rows([dict(RECORDS[10], content="另一份制度的虚构正文")], tag="other-doc", doc="另一份虚构办法.docx"), tag="other-doc")
        with self.assertRaises(kb_store.KbError) as caught:
            kb_store.restore(self.conn, TABLE, TAG)
        self.assertEqual((caught.exception.code, caught.exception.extra["conflicts"]), ("rule_conflict", [RECORDS[10]["rule_id"]]))
        self.assertIdle()
        self.assertEqual(self.one(f"SELECT count(*) FROM {TABLE}_archive WHERE source_tag = %s", (TAG,)), 18, "一条不挪")
        self.assertEqual(self.q(f"SELECT rule_id, source_tag FROM {TABLE}"), [(RECORDS[10]["rule_id"], "other-doc")])
        self.assertEqual(kb_store.restore(self.conn, TABLE, "no-such-doc"), 0)
        self.assertEqual(kb_store.deactivate(self.conn, TABLE, "no-such-doc"), 0)

    def test_delete_removes_rules_from_both_tables_and_registrations(self):
        first = self.record_doc()
        self.ingest(rows(), document_id=first)
        self.ingest(rows(version="V2"), document_id=self.record_doc(sha="cd" * 32))
        tiny = kb_store.prepare(tiny_records(self.tmp), source_tag="tiny-doc", source_doc="虚构差旅办法", source_version="")
        self.ingest(tiny, tag="tiny-doc", document_id=self.record_doc(tag="tiny-doc"))
        with self.conn.cursor() as cur:
            kb_store.ensure_archive(cur, TABLE)
        self.run_sql(f"INSERT INTO {TABLE}_archive (rule_id, rule_type, content, source_tag, archived_at) VALUES ('G-99', 'general', '旧的', %s, now())",
                     (TAG,))
        self.assertEqual(kb_store.delete(self.conn, TABLE, TAG), 19)
        self.assertIdle()
        self.assertEqual(self.one(f"SELECT count(*) FROM {TABLE} WHERE source_tag = %s", (TAG,)), 0)
        self.assertEqual(self.one(f"SELECT count(*) FROM {TABLE}_archive WHERE source_tag = %s", (TAG,)), 0)
        self.assertEqual(self.one("SELECT count(*) FROM kb_documents WHERE source_tag = %s", (TAG,)), 0)
        self.assertEqual(sorted(self.state()), ["tiny-doc-A1", "tiny-doc-A2"], "别的制度不动")
        self.assertEqual(self.one("SELECT count(*) FROM kb_documents WHERE source_tag = 'tiny-doc'"), 1)
        self.assertEqual(kb_store.delete(self.conn, TABLE, TAG), 0)

    def test_list_and_detail(self):
        doc_id = self.record_doc(name="仿真办法.docx", sha="ab" * 32)
        self.ingest(rows(), document_id=doc_id)
        tiny = kb_store.prepare(tiny_records(self.tmp), source_tag="tiny-doc", source_doc="虚构差旅办法", source_version="")
        self.ingest(tiny, tag="tiny-doc")
        kb_store.deactivate(self.conn, TABLE, "tiny-doc")
        with self.conn.cursor() as cur:
            items = kb_store.list_sources(cur, TABLE)
            detail = kb_store.source_detail(cur, TABLE, TAG)
            missing = kb_store.source_detail(cur, TABLE, "no-such-doc")
        self.conn.commit()
        by_id = {i["source_id"]: i for i in items}
        self.assertEqual(sorted(by_id), ["sample-matrix", "tiny-doc"])
        keys = ["source_id", "title", "source_version", "file_name", "doc_hash", "rules_total", "status", "ingested_at", "updated_at", "by_type"]
        for item in items:
            self.assertEqual(list(item), keys)
            for k in ("ingested_at", "updated_at"):
                self.assertRegex(item[k], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$")
        s = by_id[TAG]
        self.assertEqual((s["title"], s["source_version"], s["file_name"], s["doc_hash"], s["rules_total"], s["status"], s["by_type"]),
                         (DOC, "V1", "仿真办法.docx", "ab" * 32, 18, "active", BY_TYPE))
        t = by_id["tiny-doc"]
        # 类型与 S3 Vectors 版相同：没有上传记录（deploy.sh 入的、或不带 document_id）时 file_name / doc_hash 是 ""，不是 null
        self.assertEqual((t["title"], t["source_version"], t["file_name"], t["doc_hash"], t["rules_total"], t["status"], t["by_type"]),
                         ("虚构差旅办法", "", "", "", 2, "inactive", {"clause": 2}))
        for item in items:
            for k in ("source_id", "title", "source_version", "file_name", "doc_hash", "status", "ingested_at", "updated_at"):
                self.assertIsInstance(item[k], str, k)
            self.assertIsInstance(item["rules_total"], int)
        self.assertEqual(detail, {"source": s, "rule_ids": IDS})
        self.assertIsNone(missing)
        json.dumps(items)   # 回复直接能序列化


class Check(StoreCase):
    def test_clean_knowledge_base_is_ok(self):
        self.ingest(rows())
        with self.conn.cursor() as cur:
            self.assertEqual(kb_store.check(cur, TABLE), {"ok": True, "problems": []})
            self.assertEqual(kb_store.check(cur, TABLE, TAG), {"ok": True, "problems": []})
        self.conn.commit()

    def test_check_finds_each_problem(self):
        doc_id = self.record_doc(tag="tiny-doc")
        tiny = kb_store.prepare(tiny_records(self.tmp), source_tag="tiny-doc", source_doc="虚构差旅办法", source_version="")
        self.ingest(tiny, tag="tiny-doc", document_id=doc_id)
        self.ingest(rows())
        self.run_sql(f"UPDATE {TABLE} SET embedding = NULL WHERE rule_id = 'C05-5.5'")                          # 没向量
        self.run_sql(f"INSERT INTO {TABLE} (rule_id, rule_type, content, embedding) VALUES ('M-1', 'general', '手工', kb_embed('手工'))")  # 没标签
        with self.conn.cursor() as cur:
            kb_store.ensure_archive(cur, TABLE)
        self.conn.commit()
        self.run_sql(f"INSERT INTO {TABLE}_archive (rule_id, rule_type, content, source_tag, archived_at) "
                     "VALUES ('C01-1.1', 'matrix', '旧的', 'old-doc', now())")                                    # 两张表重复
        stuck = self.record_doc()
        self.run_sql("UPDATE kb_documents SET started_at = now() - interval '31 minutes' WHERE id = %s", (stuck,))  # 卡在 ingesting
        self.record_doc(tag="tiny-doc")                                                                         # 刚开始的不算
        self.run_sql(f"DELETE FROM {TABLE} WHERE rule_id = 'tiny-doc-A2'")                                       # 登记 2 条、表里 1 条
        self.run_sql(f"UPDATE {TABLE} SET embedding = kb_embed('别的文字') WHERE rule_id = 'tiny-doc-A1'")         # 篡改过的向量
        with self.conn.cursor() as cur:
            self.run_sql("UPDATE kb_meta SET value = '512' WHERE key = 'embed_dim'")
            wrong_dim = kb_store.check(cur, TABLE, TAG)
            self.conn.commit()
            self.run_sql("DELETE FROM kb_meta")                                                                  # 没有 kb_meta
            everything = kb_store.check(cur, TABLE)
            tiny_only = kb_store.check(cur, TABLE, "tiny-doc")
            tag_only = kb_store.check(cur, TABLE, TAG)
        self.conn.commit()

        self.assertIn(("wrong_dimension", TAG), {(p["code"], p["source_id"]) for p in wrong_dim["problems"]})
        for result in (everything, tiny_only, tag_only):
            self.assertFalse(result["ok"])
            for p in result["problems"]:
                self.assertEqual(sorted(p), ["code", "detail", "source_id"])
                self.assertIsInstance(p["detail"], str)
        got = {(p["code"], p["source_id"]) for p in everything["problems"]}
        expected = {("missing_embedding", TAG), ("untagged", None), ("duplicate_rule_id", TAG), ("stuck_ingest", TAG),
                    ("count_mismatch", "tiny-doc"), ("kb_meta_missing", None)}
        self.assertLessEqual(expected, got)
        self.assertLessEqual(got - expected, {("embedding_drift", "tiny-doc")}, "抽到 tiny-doc-A1 才报；别的都没被篡改")
        self.assertIn("C05-5.5", next(p["detail"] for p in everything["problems"] if p["code"] == "missing_embedding"))
        self.assertIn("C01-1.1", next(p["detail"] for p in everything["problems"] if p["code"] == "duplicate_rule_id"))
        self.assertEqual({(p["code"], p["source_id"]) for p in tiny_only["problems"]},
                         {("count_mismatch", "tiny-doc"), ("embedding_drift", "tiny-doc"), ("kb_meta_missing", None)})
        self.assertEqual({(p["code"], p["source_id"]) for p in tag_only["problems"]},
                         {("missing_embedding", TAG), ("duplicate_rule_id", TAG), ("stuck_ingest", TAG), ("kb_meta_missing", None)})

    def test_recover_only_touches_stale_ingests_unless_minutes_is_zero(self):
        old, fresh = self.record_doc(), self.record_doc()
        self.run_sql("UPDATE kb_documents SET started_at = now() - interval '31 minutes' WHERE id = %s", (old,))
        with self.conn.cursor() as cur:
            self.assertEqual(kb_store.recover(cur, 30), 1)
            self.assertEqual(kb_store.recover(cur, 0), 1)
        self.conn.commit()
        self.assertEqual(dict(self.q("SELECT id, status FROM kb_documents")), {old: "failed", fresh: "failed"})


class Cli(StoreCase):
    """改薄之后的命令行：摘要的键名和条数口径与重构前相同（下面的期望值是重构前的 ingest_rules.py 对同一夹具的输出）。"""
    RUN = {"table": TABLE, "rules_in_doc": 18, "inserted": 18, "updated": 0, "unchanged": 0, "pruned": 0, "dry_run": False, "retagged": 0,
           "untagged_not_in_doc": 0, "conflicts": 0, "conflict_ids": [], "rows_by_type": BY_TYPE, "rows_without_embedding": 0}

    def setUp(self):
        super().setUp()
        self.conn.autocommit = True   # PGlite 一次一个事务：子进程跑的时候，这边不能开着事务
        (self.tmp / "pw").write_text("kb-local-test\n", encoding="utf-8")
        proc = subprocess.run([sys.executable, "-I", "-B", str(LIB / "parse_rules.py"), str(FIXTURE), str(self.tmp / "rules.json")],
                              capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.rules = json.loads((self.tmp / "rules.json").read_text(encoding="utf-8"))

    def q(self, sql, params=None):
        return self.conn.execute(sql, params).fetchall()

    def run_sql(self, sql, params=None):
        self.conn.execute(sql, params)

    def db_args(self):
        return ["--port", os.environ["KB_TEST_PG_PORT"], "--db", "postgres", "--user", "postgres", "--password-file", str(self.tmp / "pw")]

    def ingest_cli(self, rules=None, tag=TAG, *extra, embed="sql", model=H.COHERE):
        path = self.tmp / "rules.json"
        if rules is not None:
            path = self.tmp / f"rules-{len(list(self.tmp.iterdir()))}.json"
            path.write_text(json.dumps(rules, ensure_ascii=False), encoding="utf-8")
        return subprocess.run([sys.executable, "-I", "-B", str(LIB / "ingest_rules.py"), "--rules", str(path), *self.db_args(),
                               "--table", TABLE, "--ddl", str(LIB.parent / "sql" / "approval_rules.sql"), "--source-tag", tag,
                               "--source-doc", DOC, "--source-version", "V1", "--model", model, "--dim", "1024", "--region", "us-east-1",
                               "--embed", embed, *extra], capture_output=True, text=True)

    def summary(self, proc):
        self.assertEqual(proc.returncode, 0, proc.stderr)
        lines = proc.stdout.strip().splitlines()
        self.assertEqual(len(lines), 1, proc.stdout)
        return json.loads(lines[0])

    def test_ingest_rules_summary_same_as_before(self):
        dry = self.summary(self.ingest_cli(None, TAG, "--prune", "--dry-run"))
        self.assertEqual(list(dry.items()), [("table", TABLE), ("rules_in_doc", 18), ("inserted", 18), ("updated", 0), ("unchanged", 0),
                                             ("pruned", 0), ("dry_run", True), ("retagged", 0), ("untagged_not_in_doc", 0),
                                             ("conflicts", 0), ("conflict_ids", []), ("pruned_ids", [])])
        self.assertEqual(self.calls(), 0)
        first = self.summary(self.ingest_cli(None, TAG, "--prune", "--smoke-question", "合同 用印"))
        smoke = first.pop("smoke_top3")
        self.assertEqual(list(first.items()), list(self.RUN.items()))
        self.assertEqual(len(smoke), 3)
        self.assertRegex(smoke[0], r"^[A-Z0-9.-]+:-?\d+\.\d+$")
        self.assertEqual(self.q("SELECT via, count(*) FROM kb_fake_embed_calls WHERE purpose = 'search_document' GROUP BY 1"), [("batch", 18)])
        again = self.summary(self.ingest_cli(None, TAG, "--prune"))
        self.assertEqual(list(again.items()), list({**self.RUN, "inserted": 0, "unchanged": 18}.items()))

        v2 = [dict(r) for r in self.rules[:-1]]
        v2[0]["content"] += "（修订）"
        v2[1]["final_approver"] = "某虚构岗位"
        changed = {"rules_in_doc": 17, "inserted": 0, "updated": 1, "unchanged": 15, "pruned": 1, "retagged": 1}
        dry = self.summary(self.ingest_cli(v2, TAG, "--prune", "--dry-run"))
        self.assertEqual(list(dry.items()), [("table", TABLE), ("rules_in_doc", 17), ("inserted", 0), ("updated", 1), ("unchanged", 15),
                                             ("pruned", 1), ("dry_run", True), ("retagged", 1), ("untagged_not_in_doc", 0),
                                             ("conflicts", 0), ("conflict_ids", []), ("pruned_ids", ["C05-5.5"])])
        run = self.summary(self.ingest_cli(v2, TAG, "--prune"))
        expected = {**self.RUN, **changed, "pruned_ids": ["C05-5.5"], "rows_by_type": {**BY_TYPE, "matrix": 11}}
        order = list(self.RUN)[:11] + ["pruned_ids", "rows_by_type", "rows_without_embedding"]
        self.assertEqual(list(run.items()), [(k, expected[k]) for k in order])

        before = self.q(f"SELECT rule_id, record_sha256, source_tag FROM {TABLE} ORDER BY 1")
        dry = self.summary(self.ingest_cli(v2, "other-doc", "--prune", "--dry-run"))
        self.assertEqual((dry["conflicts"], dry["conflict_ids"], dry["inserted"], dry["unchanged"]), (17, sorted(r["rule_id"] for r in v2), 0, 0))
        proc = self.ingest_cli(v2, "other-doc", "--prune")
        self.assertEqual(proc.returncode, 1)
        self.assertEqual(proc.stdout, "")
        self.assertIn("17 条规则编号已属于库里另一份文档（sample-matrix）", proc.stderr)
        self.assertIn("没有写库", proc.stderr)
        self.assertEqual(self.q(f"SELECT rule_id, record_sha256, source_tag FROM {TABLE} ORDER BY 1"), before)

    def test_empty_rules_file_is_refused(self):
        self.summary(self.ingest_cli(None, TAG, "--prune"))
        before = self.q(f"SELECT rule_id, record_sha256, source_tag FROM {TABLE} ORDER BY 1")
        for extra in (("--prune",), ("--prune", "--dry-run")):
            proc = self.ingest_cli([], TAG, *extra)
            self.assertNotEqual(proc.returncode, 0, extra)
            self.assertEqual(proc.stdout, "")
            self.assertIn("empty_document", proc.stderr)
            self.assertNotIn("Traceback", proc.stderr)
        self.assertEqual(self.q(f"SELECT rule_id, record_sha256, source_tag FROM {TABLE} ORDER BY 1"), before)
        self.assertEqual(len(before), 18)

    def test_embed_bedrock_is_titan_only(self):
        proc = self.ingest_cli(None, TAG, embed="bedrock", model=H.COHERE)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("--embed sql", proc.stderr)
        proc = self.ingest_cli(None, TAG, embed="bedrock", model=H.TITAN)          # kb_meta 登记的是 Cohere v4
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("embedding_model_mismatch", proc.stderr)
        self.assertNotIn("Traceback", proc.stderr)
        self.assertEqual(self.q(f"SELECT count(*) FROM {TABLE}"), [(0,)])

    def admin(self, *argv):
        proc = subprocess.run([sys.executable, "-I", "-B", str(LIB / "kb_admin.py"), *self.db_args(), *argv], capture_output=True, text=True)
        self.assertEqual(proc.stdout.count("\n"), 1, proc.stdout + proc.stderr)
        return proc.returncode, json.loads(proc.stdout)

    def test_kb_admin_prints_one_json_line(self):
        self.summary(self.ingest_cli(None, TAG, "--prune"))
        report, result = self.tmp / "report.json", self.tmp / "result.json"
        report.write_text(json.dumps({"matrix": 12}), encoding="utf-8")
        result.write_text(json.dumps({"inserted": 18}), encoding="utf-8")
        code, out = self.admin("record", "--name", "仿真'办法.docx", "--sha256", "ab" * 32, "--size", "2109", "--by", "local:poc", "--report", str(report))
        doc_id = out["id"]
        self.assertEqual(self.admin("status", str(doc_id), "--status", "ingested", "--result", str(result), "--source-tag", TAG,
                                    "--doc-title", "仿真办法", "--source-version", "V1"), (0, {"ok": True}))
        code, out = self.admin("history", "--limit", "5")
        self.assertEqual((code, out["items"][0]["id"], out["items"][0]["status"], out["items"][0]["report"]), (0, doc_id, "ingested", {"matrix": 12}))
        self.assertEqual(self.admin("show", str(doc_id))[1]["item"]["result"], {"inserted": 18})
        self.assertEqual(self.admin("tags"), (0, {"items": [{"source_tag": TAG, "source_doc": DOC, "source_version": "V1", "rows": 18}]}))
        code, out = self.admin("search", "合同 用印", "--k", "3")
        self.assertEqual((code, len(out["items"])), (0, 3))
        self.assertLessEqual({"rule_id", "score", "keyword_hits"}, set(out["items"][0]))
        code, out = self.admin("search-log", "--limit", "1")
        self.assertEqual((out["items"][0]["caller"], out["items"][0]["question"]), ("page", "合同 用印"))
        self.assertEqual(self.admin("recover"), (0, {"recovered": 0}))
        code, out = self.admin("--table", "rules; drop", "tags")
        self.assertEqual(code, 1)
        self.assertIn("error", out)


if __name__ == "__main__":
    unittest.main()
