"""本机离线测试：用 fake_aws.py 的 S3 Vectors / Bedrock 替身跑一遍六个工具的全部分支，不连 AWS、不花钱。

用法（在任意目录）：
  uv run --no-project --with boto3 --with python-docx --with openpyxl --with pdfplumber \
      python -I knowbase-s3vectors-agent/tests/local_test.py
"""
import importlib.util
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "stubs"))
sys.path.insert(0, HERE)

import boto3  # noqa: E402
from docx import Document  # noqa: E402

import fake_aws  # noqa: E402
from nexus_utils import secret_key  # noqa: E402

TOOLS = os.path.join(HERE, "..", "tools", "s3vectors_kb_tools.py")
BUCKET = "knowbase-s3v-demo"
CREDS = {"access_key_id": "FAKE-ACCESS-KEY-ID-LOCAL-TEST", "secret_access_key": "fake-secret-for-local-test"}

S3V = fake_aws.FakeS3Vectors(BUCKET, {
    "chunks": {"dimension": 1536, "non_filterable": ["text", "file_name"]},
    "docs": {"dimension": 1536, "non_filterable": ["file_name", "doc_hash", "embedding_model", "page_or_row_count",
                                                   "quality_flag"]},
    "audit": {"dimension": 1, "non_filterable": ["detail"]},
})
BR = fake_aws.FakeBedrock()
SESSIONS = []


class _Session:
    def __init__(self, **kw):
        SESSIONS.append(kw)
        self.kw = kw

    def client(self, name, **_):
        assert name == "s3vectors", name
        assert self.kw.get("aws_access_key_id") == CREDS["access_key_id"], "S3 Vectors 必须用注入的密钥"
        return S3V


def _client(name, **_):
    assert name == "bedrock-runtime", f"只有 Bedrock 走默认凭证链，不应创建 {name}"
    return BR


boto3.Session = _Session
boto3.client = _client

spec = importlib.util.spec_from_file_location("s3vectors_kb_tools", TOOLS)
T = importlib.util.module_from_spec(spec)
spec.loader.exec_module(T)

PASSED = []
# 测试替身的「向量」只看字符二元组：问句要和目标段落有足够多相同的字，才能稳定排第一
Q_SECRET = "本文档的唯一暗号是：白鹭-5831"


def check(name, cond, detail=""):
    if not cond:
        raise SystemExit(f"FAIL {name}: {detail}")
    PASSED.append(name)
    print(f"PASS {name}")


def call(fn, **kw):
    return json.loads(fn(**kw))


def make_docx(path, title, paragraphs, table=None):
    doc = Document()
    doc.add_heading(title, level=1)
    for p in paragraphs:
        doc.add_paragraph(p)
    if table:
        t = doc.add_table(rows=1, cols=len(table[0]))
        for i, h in enumerate(table[0]):
            t.rows[0].cells[i].text = h
        for row in table[1:]:
            cells = t.add_row().cells
            for i, v in enumerate(row):
                cells[i].text = v
    doc.save(path)


def main():
    tmp = tempfile.mkdtemp(prefix="s3v-kb-test-")
    a = os.path.join(tmp, "知识库写入链路自检.docx")
    b = os.path.join(tmp, "差旅报销规定.docx")
    c = os.path.join(tmp, "长文档.docx")
    make_docx(a, "知识库写入链路自检（E2E 测试文档）", [
        "这是一份为验证「知识库文档管家（S3 Vectors 版）」写入链路而生成的合成测试文档，不包含任何业务数据。",
        "本文档的唯一暗号是：白鹭-5831。检索这个暗号，应当能命中本文档。",
        "测试范围：文档解析、文本分块、通过运行环境 IAM 角色调用 Amazon Bedrock 生成向量、写入 Amazon S3 Vectors、语义检索、统计与删除。",
    ], [["项目", "说明"], ["向量模型", "Cohere Embed v4，1536 维"], ["向量库", "Amazon S3 Vectors"]])
    make_docx(b, "差旅报销规定", ["员工出差住宿标准按城市分档，一线城市每晚不超过 600 元。",
                                  "机票须提前七天预订经济舱，特殊情况报部门负责人审批。"])
    make_docx(c, "长文档", [f"第 {i} 段：" + "这是用于测试分批写入的长段落内容，" * 18 for i in range(160)])

    # ── 凭证缺失 ──
    secret_key.set_tool_credentials(None)
    r = call(T.s3vectors_writer, file_path=a)
    check("credentials_missing", r["error_type"] == "credentials_missing", r)
    secret_key.set_tool_credentials(CREDS)

    # ── 参数校验 ──
    check("bad_strategy", call(T.s3vectors_writer, file_path=a, write_strategy="upsert")["error_type"] == "invalid_parameter")
    check("no_input", call(T.s3vectors_writer)["error_type"] == "invalid_parameter")
    check("bad_format", call(T.s3vectors_writer, file_path=os.path.join(tmp, "x.txt"))["error_type"] == "unsupported_format")
    check("missing_file", call(T.s3vectors_writer, file_path=os.path.join(tmp, "nope.docx"))["error_type"] == "file_not_found")
    check("too_many_tags", call(T.s3vectors_writer, file_path=a, tags=[str(i) for i in range(11)])["error_type"] == "invalid_parameter")
    check("tags_byte_budget", call(T.s3vectors_writer, file_path=a, tags=["标" * 30 + str(i) for i in range(8)])["error_type"] == "invalid_parameter")

    # ── 一步入库 ──
    r = call(T.s3vectors_writer, file_path=a, tags=["测试", "E2E"])
    check("ingest_a", r["success"] and r["dedup_status"] == "inserted" and r["written_chunks"] >= 1, r)
    doc_a = r["doc_id"]
    check("doc_id_format", T._DOC_ID_RE.match(doc_a) is not None, doc_a)
    check("embed_model_global", r["embedding_model"] == "global.cohere.embed-v4:0" and r["dimension"] == 1536, r)
    check("audit_written", bool(r["audit_log_id"]) and len(S3V.store["audit"]) == 1)
    reg = S3V.store["docs"][doc_a]["metadata"]
    check("registry_ingested", reg["status"] == "ingested" and reg["chunk_count"] == r["written_chunks"]
          and reg["doc_id"] == doc_a and reg["tags"] == ["测试", "E2E"], reg)
    ck = S3V.store["chunks"][f"{doc_a}#00000"]["metadata"]
    check("chunk_metadata", ck["active"] is True and ck["doc_id"] == doc_a and "白鹭" in "".join(
        m["metadata"]["text"] for k, m in S3V.store["chunks"].items() if k.startswith(doc_a)), ck)

    # ── 去重 ──
    before = BR.texts_embedded
    r = call(T.s3vectors_writer, file_path=a)
    check("skip_same_content", r["success"] and r["status"] == "skipped" and BR.texts_embedded == before, r)
    r = call(T.s3vectors_writer, file_path=a, write_strategy="insert")
    check("insert_duplicate", r["error_type"] == "duplicate_document", r)

    # ── 分步入库：同一文件得到同一 doc_id ──
    p = call(T.document_parser, file_path=a, file_format="docx")
    ch = call(T.text_chunker, text=p["structured_text"], chunk_size=128, chunk_overlap=16)
    r = call(T.s3vectors_writer, doc_metadata={**p["metadata"], "doc_hash": p["doc_hash"]}, chunks=ch["chunks"],
             write_strategy="overwrite")
    check("chunks_mode_same_doc", r["success"] and r["doc_id"] == doc_a and r["dedup_status"] == "overwritten", r)
    n_small = r["written_chunks"]
    check("smaller_chunks_more_pieces", n_small > 1, n_small)
    r = call(T.s3vectors_writer, file_path=a, write_strategy="overwrite")
    n_big = r["written_chunks"]
    left = [k for k in S3V.store["chunks"] if k.startswith(doc_a)]
    check("overwrite_deletes_stale", len(left) == n_big < n_small, (len(left), n_big, n_small))
    check("overwrite_keeps_first_ingest_time", S3V.store["docs"][doc_a]["metadata"]["ingested_at"] == reg["ingested_at"])
    r = call(T.s3vectors_writer, doc_metadata={"doc_hash": "sha256:e2e_selftest", "file_name": "x.docx", "file_format": "docx"},
             chunks=[{"chunk_index": 0, "content": "x"}])
    check("made_up_hash_rejected", r["error_type"] == "invalid_parameter", r)

    # ── 第二、三份文档 ──
    doc_b = call(T.s3vectors_writer, file_path=b)["doc_id"]
    puts_before = S3V.calls["PutVectors"]
    r = call(T.s3vectors_writer, file_path=c)
    doc_c = r["doc_id"]
    check("long_doc_batches", r["written_chunks"] > 100 and S3V.calls["PutVectors"] - puts_before >= 4, r["written_chunks"])

    # ── 检索 ──
    r = call(T.s3vectors_search, query="白鹭-5831 暗号是什么", top_k=3)
    check("search_hit", r["success"] and r["results"] and r["results"][0]["doc_id"] == doc_a, r)
    check("search_filter_active", r["filter"] == {"active": {"$eq": True}}, r["filter"])
    r = call(T.s3vectors_search, query="住宿标准", filters={"file_name": "差旅"}, top_k=5)
    check("search_by_file_name", r["results"] and all(x["doc_id"] == doc_b for x in r["results"]), r)
    r = call(T.s3vectors_search, query="住宿标准", filters={"tags": ["E2E"]}, top_k=5)
    check("search_by_tag", r["results"] and all(x["doc_id"] == doc_a for x in r["results"]), r)
    r = call(T.s3vectors_search, filters={"doc_id": doc_c}, top_k=5)
    check("list_doc_chunks_in_order", [x["chunk_index"] for x in r["results"]] == [0, 1, 2, 3, 4], r)
    r = call(T.s3vectors_search, query="出差住宿和机票", scope="documents", top_k=2)
    check("search_documents_scope", r["results"] and r["results"][0]["doc_id"] == doc_b, r)
    check("search_needs_input", call(T.s3vectors_search)["error_type"] == "invalid_parameter")
    S3V.ann_shortfall = True
    r = call(T.s3vectors_search, query=Q_SECRET, top_k=1)
    check("overfetch_beats_ann_shortfall", len(r["results"]) == 1 and r["results"][0]["doc_id"] == doc_a, r)
    r = call(T.s3vectors_search, query="出差住宿和机票", scope="documents", top_k=1)
    check("overfetch_documents_scope", len(r["results"]) == 1 and r["results"][0]["doc_id"] == doc_b, r)
    S3V.ann_shortfall = False
    r = call(T.s3vectors_search, query="完全无关的内容 xyz", similarity_threshold=0.99)
    check("threshold_filters_all", r["success"] and r["total_count"] == 0 and "tip" in r, r)

    # ── 统计 ──
    r = call(T.s3vectors_statistics, query_type="dashboard_stats")
    total_chunks = sum(1 for _ in S3V.store["chunks"])
    check("dashboard", r["total_documents"] == 3 and r["total_chunks"] == total_chunks
          and r["format_distribution"] == {"docx": 3} and r["index"]["dimension"] == 1536, r)
    check("dashboard_recent_ops", r["recent_operations"]["count"] >= 5, r["recent_operations"])
    r = call(T.s3vectors_statistics, query_type="document_list", page=1, page_size=2)
    check("document_list_paging", r["total_count"] == 3 and len(r["documents"]) == 2 and r["total_pages"] == 2, r)
    r = call(T.s3vectors_statistics, query_type="document_detail", filters={"doc_id": doc_b})
    check("document_detail", r["document"]["file_name"] == "差旅报销规定.docx" and r["document"]["status"] == "ingested", r)
    r = call(T.s3vectors_statistics, query_type="content_sample", filters={"doc_id": doc_c})
    check("content_sample", r["sampled_chunks"] == 20 and r["total_chunks"] > 100, r["sampled_chunks"])

    # ── 软删除 / 恢复 ──
    r = call(T.s3vectors_manager, operation="delete", doc_id=doc_a, delete_mode="soft")
    check("soft_delete", r["success"] and r["delete_mode"] == "soft", r)
    r = call(T.s3vectors_search, query=Q_SECRET, top_k=5)
    check("soft_deleted_not_searchable", all(x["doc_id"] != doc_a for x in r["results"]), r)
    r = call(T.s3vectors_search, query=Q_SECRET, top_k=5, include_deleted=True)
    check("include_deleted", r["results"][0]["doc_id"] == doc_a and r["results"][0].get("deleted") is True, r)
    check("dashboard_after_soft", call(T.s3vectors_statistics, query_type="dashboard_stats")["deleted_documents"] == 1)
    check("soft_twice", call(T.s3vectors_manager, operation="delete", doc_id=doc_a, delete_mode="soft")["error_type"] == "already_deleted")
    r = call(T.s3vectors_writer, file_path=a)
    check("skip_deleted_hints_restore", r["status"] == "skipped" and "restore" in r["message"], r)
    check("consistency_ok_after_soft", call(T.s3vectors_manager, operation="consistency_check")["consistency_passed"])
    r = call(T.s3vectors_manager, operation="restore", doc_id=doc_a)
    check("restore", r["success"], r)
    r = call(T.s3vectors_search, query=Q_SECRET, top_k=3)
    check("restored_searchable", r["results"][0]["doc_id"] == doc_a, r)
    check("restore_not_deleted", call(T.s3vectors_manager, operation="restore", doc_id=doc_a)["error_type"] == "not_deleted")

    # ── 一致性校验能发现问题 ──
    S3V.store["chunks"]["doc_ffffffffffffffffffffffff#00000"] = {"data": fake_aws.embed("孤儿"), "metadata": {
        "doc_id": "doc_ffffffffffffffffffffffff", "chunk_index": 0, "active": True, "file_format": "docx",
        "ingested_at": 0, "char_count": 2, "text": "孤儿", "file_name": "孤儿.docx"}}
    S3V.store["docs"][doc_b]["metadata"]["chunk_count"] += 1
    r = call(T.s3vectors_manager, operation="consistency_check")
    check("consistency_finds_issues", not r["consistency_passed"] and r["orphan_vectors"] == 1 and r["missing_records"] == 1, r)
    S3V.store["chunks"].pop("doc_ffffffffffffffffffffffff#00000")
    S3V.store["docs"][doc_b]["metadata"]["chunk_count"] -= 1
    S3V.listed_with_metadata.clear()
    call(T.s3vectors_manager, operation="consistency_check")
    check("consistency_lists_keys_only", S3V.listed_with_metadata["chunks"] == 0, dict(S3V.listed_with_metadata))
    call(T.s3vectors_manager, operation="delete", doc_id=doc_b, delete_mode="soft")
    S3V.store["chunks"][f"{doc_b}#00000"]["metadata"]["active"] = True      # 模拟软删除只改了一半
    r = call(T.s3vectors_manager, operation="consistency_check")
    check("consistency_finds_flag_mismatch", len(r["status_mismatches"]) == 1
          and r["status_mismatches"][0]["doc_id"] == doc_b, r)
    S3V.store["chunks"][f"{doc_b}#00000"]["metadata"]["active"] = False
    call(T.s3vectors_manager, operation="restore", doc_id=doc_b)

    # ── 写到一半失败 → failed，再入库自动修复 ──
    S3V.fail_put_on = "chunks"
    r = call(T.s3vectors_writer, file_path=b, write_strategy="overwrite")
    check("partial_failure_marked", r["error_type"] == "write_failed" and S3V.store["docs"][doc_b]["metadata"]["status"] == "failed", r)
    S3V.fail_put_on = None
    r = call(T.s3vectors_manager, operation="consistency_check")
    check("consistency_sees_unfinished", len(r["unfinished_documents"]) == 1, r)
    r = call(T.s3vectors_writer, file_path=b)          # skip 也会修复未完成的入库
    check("repair_on_reingest", r["success"] and r["dedup_status"] == "repaired", r)

    # ── 硬删除 ──
    r = call(T.s3vectors_manager, operation="delete", doc_id=doc_c, delete_mode="hard")
    check("hard_delete", r["success"] and not any(k.startswith(doc_c) for k in S3V.store["chunks"])
          and doc_c not in S3V.store["docs"], r)
    check("delete_unknown", call(T.s3vectors_manager, operation="delete", doc_id="doc_" + "0" * 24)["error_type"] == "document_not_found")
    check("delete_bad_id", call(T.s3vectors_manager, operation="delete", doc_id="../x")["error_type"] == "invalid_parameter")
    check("consistency_final", call(T.s3vectors_manager, operation="consistency_check")["consistency_passed"])

    # ── 错误映射 ──
    S3V.deny = True
    r = call(T.s3vectors_statistics, query_type="dashboard_stats")
    check("access_denied_mapped", r["error_type"] == "access_denied" and CREDS["secret_access_key"] not in json.dumps(r), r)
    S3V.deny = False
    old_bucket = T._VECTOR_BUCKET
    T._VECTOR_BUCKET = "no-such-bucket"
    check("kb_not_found_mapped", call(T.s3vectors_statistics, query_type="dashboard_stats")["error_type"] == "kb_not_found")
    T._VECTOR_BUCKET = old_bucket

    # ── 嵌入模型回退：global 无权限时用 us ──
    BR.deny_models = {"global.cohere.embed-v4:0"}
    r = call(T.s3vectors_search, query=Q_SECRET, top_k=1)
    check("embed_fallback_us", r["success"] and r["results"][0]["doc_id"] == doc_a and BR.calls["us.cohere.embed-v4:0"] >= 1, r)
    BR.deny_models = {"global.cohere.embed-v4:0", "us.cohere.embed-v4:0"}
    r = call(T.s3vectors_writer, file_path=c)
    check("embed_denied_no_write", r["error_type"] == "embedding_access_denied" and not any(k.startswith(doc_c) for k in S3V.store["chunks"]), r)
    BR.deny_models = set()

    # ── 原有工具保持不变 ──
    check("parser_unchanged", call(T.document_parser, file_path=b, file_format="docx")["metadata"]["file_format"] == "docx")
    check("every_session_used_injected_key", all(s.get("aws_access_key_id") == CREDS["access_key_id"] for s in SESSIONS))
    print(f"\n{len(PASSED)} checks passed")


if __name__ == "__main__":
    main()
