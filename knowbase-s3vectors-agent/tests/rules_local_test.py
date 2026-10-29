"""本机离线测试：规则工具模块 s3vectors_rules_tools.py（一行一条规则、过滤条件由代码拼），不连 AWS、不花钱。

替身是 fake_aws.py 的 S3 Vectors / Bedrock；三个索引的配置与 infra/aws_setup.sh 建的一致：
  rules（1536 维，不可过滤 text）、rule_sources（1 维，不可过滤 title / file_name / doc_hash）、audit（1 维，不可过滤 detail）。
对照：解析 = kb/lib/parse_rules.py（子进程跑同一份文件）；金额档 = 研究 tiers.py 跑一次的结果（写死在 RESEARCH_TIERS）；
过滤 = E10 的 keep(rule, f, True, True, False)（照写在 ref_keep()）。运行时不读研究目录，也不读 nexus-customer-deploy。
文档全部虚构：kb/tests/fixtures/sample-matrix.docx，以及本文件现生成的几份。

用法（在任意目录）：
  uv run --no-project --with boto3 --with python-docx --with openpyxl --with pdfplumber \
      python -I knowbase-s3vectors-agent/tests/rules_local_test.py
"""
import copy
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import zipfile
from xml.sax.saxutils import escape

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.join(HERE, "stubs"))
sys.path.insert(0, HERE)

import boto3  # noqa: E402

import fake_aws  # noqa: E402
from nexus_utils import secret_key  # noqa: E402

TOOLS = os.path.join(HERE, "..", "tools", "s3vectors_rules_tools.py")
FIXTURE = os.path.join(REPO, "kb", "tests", "fixtures", "sample-matrix.docx")
REF_PARSER = os.path.join(REPO, "kb", "lib", "parse_rules.py")
BUCKET = "local-test-rules-bucket"
CREDS = {"access_key_id": "FAKE-ACCESS-KEY-ID-LOCAL-TEST", "secret_access_key": "fake-secret-for-local-test"}

S3V = fake_aws.FakeS3Vectors(BUCKET, {
    "rules": {"dimension": 1536, "non_filterable": ["text"]},
    "rule_sources": {"dimension": 1, "non_filterable": ["title", "file_name", "doc_hash"]},
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

spec = importlib.util.spec_from_file_location("s3vectors_rules_tools", TOOLS)
T = importlib.util.module_from_spec(spec)
spec.loader.exec_module(T)

PASSED = []


def check(name, cond, detail=""):
    if not cond:
        raise SystemExit(f"FAIL {name}: {detail}")
    PASSED.append(name)
    print(f"PASS {name}")


def call(fn, **kw):
    return json.loads(fn(**kw))


# ─────────────── 对照：研究 tiers.py 跑一次的结果（R8：写死，不在运行时读研究目录） ───────────────
RESEARCH_TIERS = {
    "": (None, False, None, False, None),
    "总投资≤50 万": (None, False, 500000.0, True, "range"),
    "总投资＞50 万": (500000.0, False, None, False, "range"),
    "不限金额": (None, False, None, False, "any"),
    "不适用": (None, False, None, False, None),
    "总金额≤20 万": (None, False, 200000.0, True, "range"),
    "总金额＞20 万": (200000.0, False, None, False, "range"),
    "单笔≤1 万": (None, False, 10000.0, True, "range"),
    "单笔 ＞1 万": (10000.0, False, None, False, "range"),
    "≤20万": (None, False, 200000.0, True, "range"),
    "<20万": (None, False, 200000.0, False, "range"),
    ">20万": (200000.0, False, None, False, "range"),
    ">20万且≤50万": (200000.0, False, 500000.0, True, "range"),
    "≥50万": (500000.0, True, None, False, "range"),
    "≥5万且<10万": (50000.0, True, 100000.0, False, "range"),
    "不论金额": (None, False, None, False, "any"),
    "研发项目": (None, False, None, False, None),
    "升级事项（四类）：……": (None, False, None, False, "mixed"),
    "个人借款≤5万；备用金≤1万": (None, False, None, False, "mixed"),
}


# ─────────────── 对照：E10 的 segs() / overlap() / keep() 与研究的 amount_matches()，照写 ───────────────
def ref_segs(s):
    s = (s or "").replace(" ", "")
    if not s or s == "全板块":
        return {"*"}
    return {x for x in s.replace("／", "/").split("/") if x}


def ref_overlap(a, b):
    return "*" in a or "*" in b or bool(a & b)


def ref_amount_matches(interval, amt):
    lo, lo_incl, hi, hi_incl, kind = interval
    if amt is None or kind in (None, "mixed", "any"):
        return True
    if lo is not None and (amt < lo or (amt == lo and not lo_incl)):
        return False
    if hi is not None and (amt > hi or (amt == hi and not hi_incl)):
        return False
    return True


def ref_keep(rule, f):
    """= E10 keep(rule, f, use_seg=True, use_amt=True, use_ch=False)。"""
    if f.get("seg") and not ref_overlap(ref_segs(rule["segment"]), {f["seg"]}):
        return False
    if f.get("amt") is not None and not ref_amount_matches(RESEARCH_TIERS[rule["amount_tier"]], f["amt"]):
        return False
    return True


def ref_parse(path):
    """kb/lib/parse_rules.py 对同一文件的输出：(规则记录, REPORT, 退出码)。"""
    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, "rules.json")
        proc = subprocess.run([sys.executable, "-I", REF_PARSER, path, out], capture_output=True, text=True)
        rules = json.load(open(out, encoding="utf-8")) if os.path.exists(out) else []
    last = proc.stdout.strip().splitlines()[-1]
    assert last.startswith("REPORT "), last
    return rules, json.loads(last[len("REPORT "):]), proc.returncode


# ─────────────── 虚构的审批矩阵 .docx（结构照 parse_rules.py 适配的格式） ───────────────
HEADER = ["序号", "业务事项", "板块", "金额档 / 触发情形", "经办人", "部门主管", "总经理", "适用范围与控制要点"]
NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'


def _p(text):
    return f'<w:p><w:r><w:t xml:space="preserve">{escape(text)}</w:t></w:r></w:p>'


def _tr(cells):
    return "<w:tr>" + "".join(f"<w:tc>{_p(c)}</w:tc>" for c in cells) + "</w:tr>"


def write_docx(path, document_xml):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("word/document.xml", document_xml)
    return path


def make_matrix(path, chapters):
    """chapters: [(章标题, 章说明, 行)]；行 = (序号, 业务事项, 板块, 金额档, 经办人, 部门主管, 总经理, 控制要点)。"""
    body = []
    for title, note, rows in chapters:
        body.append(_p(title))
        if note:
            body.append(_p(note))
        body.append("<w:tbl>" + _tr(HEADER) + "".join(_tr(r) for r in rows) + "</w:tbl>")
    return write_docx(path, f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                            f'<w:document {NS}><w:body>{"".join(body)}</w:body></w:document>')


def fixture_variant(path, *edits):
    """把 fixture 的 document.xml 按 edits（函数）依次改写，另存一份。"""
    with zipfile.ZipFile(FIXTURE) as z:
        xml = z.read("word/document.xml").decode("utf-8")
    for edit in edits:
        new = edit(xml)
        assert new != xml, "改写没有生效"
        xml = new
    return write_docx(path, xml)


def edit_row_33(xml):
    assert xml.count("租赁物权属证明") == 1
    return xml.replace("租赁物权属证明", "租赁物权属证明与租赁台账")


def drop_row_55(xml):
    return re.sub(r"<w:tr>(?:(?!</w:tr>).)*?>5\.5</w:t>.*?</w:tr>", "", xml, count=1, flags=re.S)


# 板块与金额档的各种写法：多板块、全板块、开闭区间、非金额条件、混合条件（全部虚构）
SEG_DEMO = [("七、费用报销", "费用报销以发票和审批单为依据。", [
    ("7.1", "差旅费报销", "九安/甲板块", "≤20万", "①", "②√", "", "行程单与发票一致"),
    ("7.2", "差旅费报销", "九安/甲板块", ">20万且≤50万", "①", "②", "③√", "附出差审批单"),
    ("7.3", "差旅费报销", "九安/甲板块", "≥50万", "①", "②", "③√", "附出差审批单与预算"),
    ("7.4", "会议费报销", "全板块", "不论金额", "①", "②√", "", "会议通知与签到表"),
    ("7.5", "招待费报销", "乙板块", "≤20万", "①", "②√", "", "招待事由"),
    ("7.6", "研发材料费", "九安", "研发项目", "①", "②√", "", "项目编号"),
    ("7.7", "系统升级费用", "全板块", "升级事项（四类）：……", "①", "②", "③√", "升级清单"),
    ("7.8", "培训费报销", "九安", "<20万", "①", "②√", "", "培训通知"),
    ("7.9", "培训费报销", "九安", ">20万", "①", "②", "③√", "培训合同"),
    ("7.10", "备用金", "甲板块", "≥5万且<10万", "①", "②√", "", "备用金申请"),
    ("7.11", "个人借款与备用金", "乙板块", "个人借款≤5万；备用金≤1万", "①", "②√", "", "借款单"),
])]
# 已下线的一份：规则对任何板块、金额都命中——检索里出现它，说明 active 过滤没起作用
RETIRED = [("九、资产处置", "", [
    ("9.1", "资产报废", "全板块", "不论金额", "①", "②√", "", "报废清单"),
    ("9.2", "资产转让", "九安", "≤20万", "①", "②√", "", "评估报告"),
])]


def keys_of(source_id):
    return sorted(k for k, v in S3V.store["rules"].items() if v["metadata"].get("source_id") == source_id)


def main():
    with tempfile.TemporaryDirectory(prefix="s3v-rules-test-") as tmp:
        run(tmp)


def run(tmp):
    changed = fixture_variant(os.path.join(tmp, "matrix-changed.docx"), edit_row_33)
    dropped = fixture_variant(os.path.join(tmp, "matrix-dropped.docx"), edit_row_33, drop_row_55)
    seg_doc = make_matrix(os.path.join(tmp, "seg-demo.docx"), SEG_DEMO)
    retired_doc = make_matrix(os.path.join(tmp, "retired.docx"), RETIRED)

    # ── 渲染段：五个名字都在、只出现一次（scripts/render.py 按环境改写这一段） ──
    src = open(TOOLS, encoding="utf-8").read()
    block = src.split("# >>> deploy-config", 1)[1].split("# <<< deploy-config", 1)[0] if src.count("# >>> deploy-config") == 1 \
        and src.count("# <<< deploy-config") == 1 else ""
    names = re.findall(r"^(_[A-Z_]+) = ", block, flags=re.M)
    check("deploy_config_block", names == ["_REGION", "_VECTOR_BUCKET", "_RULES_INDEX", "_SOURCES_INDEX", "_AUDIT_INDEX"]
          and T._SOURCES_INDEX == "rule_sources" and T._AUDIT_INDEX == "audit", names)

    # ── 没渲染（桶名、索引名为空）时说清楚，不发请求 ──
    secret_key.set_tool_credentials(CREDS)
    r = call(T.rules_manager, action="list")
    check("not_rendered", r["error_type"] == "not_configured" and not SESSIONS, r)
    T._VECTOR_BUCKET, T._RULES_INDEX = BUCKET, "rules"

    # ── credentials_missing：三个工具都不回落默认凭证链 ──
    secret_key.set_tool_credentials(None)
    outs = [call(T.rules_writer, file_path=FIXTURE, source_id="fin-approval"),
            call(T.rules_search, question="新产品立项"),
            call(T.rules_manager, action="list")]
    secret_key.set_tool_credentials({"access_key_id": CREDS["access_key_id"]})
    outs.append(call(T.rules_manager, action="check"))
    check("credentials_missing", all(o.get("error_type") == "credentials_missing" for o in outs)
          and not SESSIONS and BR.texts_embedded == 0 and sum(S3V.calls.values()) == 0, outs)
    secret_key.set_tool_credentials(CREDS)

    # ── parse_matches_kb：与 kb/lib/parse_rules.py 对同一文件逐条一致，REPORT 相同 ──
    for name, path in (("fixture", FIXTURE), ("seg_demo", seg_doc)):
        ref_rules, ref_report, code = ref_parse(path)
        records, report = T.parse_matrix(path)
        check(f"parse_matches_kb_{name}", code == 0 and len(records) == len(ref_rules) > 0
              and [(x["rule_id"], x["rule_type"], x["content"]) for x in records]
              == [(x["rule_id"], x["rule_type"], x["content"]) for x in ref_rules]
              and json.loads(json.dumps(records, ensure_ascii=False)) == ref_rules and report == ref_report,
              (report, ref_report))
    fixture_ref, fixture_report, _ = ref_parse(FIXTURE)
    check("fixture_shape", fixture_report["total"] == 18 and fixture_report["matrix"] == 12, fixture_report)

    # ── tiers_match_research：与研究 tiers.py 的结果相同 ──
    got = {s: T.tier_interval(s) for s in RESEARCH_TIERS}
    check("tiers_match_research", got == RESEARCH_TIERS,
          {s: (got[s], RESEARCH_TIERS[s]) for s in RESEARCH_TIERS if got[s] != RESEARCH_TIERS[s]})
    check("tiers_brief_cases", T.tier_interval("≤20万") == (None, False, 200000.0, True, "range")
          and T.tier_interval(">20万且≤50万") == (200000.0, False, 500000.0, True, "range")
          and T.tier_interval("不论金额")[4] == "any" and T.tier_interval("升级事项（四类）…")[4] == "mixed"
          and T.tier_interval("研发项目")[4] is None)

    # ── metadata_fits：可过滤元数据（除 text）≤ 2 KB；长字段不另存 ──
    source = {"source_id": "fin-approval", "source_version": "V4.0", "ingested_at": 1761630000}
    sizes = []
    for path in (FIXTURE, seg_doc):
        for rec in T.parse_matrix(path)[0]:
            md = T.rule_metadata(rec, source)
            filterable = {k: v for k, v in md.items() if k != "text"}
            sizes.append(len(json.dumps(filterable, ensure_ascii=False).encode("utf-8")))
            assert md["text"] == rec["content"] and md["active"] is True and len(md["rule_sha"]) == 16, md
            assert not {"business_item", "approval_path_text", "scope_controls", "chapter", "chapter_note"} & set(md), md
    check("metadata_fits", max(sizes) <= 2048, max(sizes))
    print(f"     max filterable metadata on the fixture docs: {max(sizes)} bytes")
    md = T.rule_metadata({"rule_id": "X", "rule_type": "matrix", "chapter_no": 7, "segment": "九安/甲板块",
                          "amount_tier": ">20万且≤50万", "content": "正文"}, source)
    check("metadata_shape", {k: md[k] for k in ("source_id", "source_version", "rule_type", "chapter_no", "segments",
                                                "amt_kind", "lo", "lo_incl", "hi", "hi_incl", "active", "ingested_at")}
          == {"source_id": "fin-approval", "source_version": "V4.0", "rule_type": "matrix", "chapter_no": 7,
              "segments": ["九安", "甲板块"], "amt_kind": "range", "lo": 200000.0, "lo_incl": False, "hi": 500000.0,
              "hi_incl": True, "active": True, "ingested_at": 1761630000}, md)
    md2 = T.rule_metadata({"rule_id": "G-01", "rule_type": "general", "chapter_no": 0, "segment": "",
                           "amount_tier": "", "content": "说明"}, source)
    check("metadata_unbounded", md2["segments"] == ["*"] and md2["amt_kind"] == "other"
          and md2["lo"] == -1e13 and md2["hi"] == 1e13 and md2["lo_incl"] is True and md2["hi_incl"] is True, md2)

    # ── 参数校验 ──
    plain = write_docx(os.path.join(tmp, "plain.docx"), f'<w:document {NS}><w:body>{_p("一份普通文档")}</w:body></w:document>')
    notzip = os.path.join(tmp, "broken.docx")
    open(notzip, "wb").write(b"not a zip file")
    huge_seg = make_matrix(os.path.join(tmp, "huge-seg.docx"), [("二、虚构章", "", [
        ("2.1", "虚构事项", "甲" * 800, "不论金额", "①", "②√", "", "")])])
    check("bad_source_id", call(T.rules_writer, file_path=FIXTURE, source_id="../x")["error_type"] == "invalid_parameter")
    check("missing_file", call(T.rules_writer, file_path=os.path.join(tmp, "nope.docx"), source_id="a")["error_type"] == "file_not_found")
    check("not_docx", call(T.rules_writer, file_path=os.path.join(tmp, "x.pdf"), source_id="a")["error_type"] == "unsupported_format")
    r = call(T.rules_writer, file_path=plain, source_id="plain")
    check("not_a_matrix", r["error_type"] == "not_a_matrix" and r["report"]["matrix"] == 0, r)
    check("broken_docx", call(T.rules_writer, file_path=notzip, source_id="broken")["error_type"] == "parse_failed")
    r = call(T.rules_writer, file_path=huge_seg, source_id="huge")
    check("metadata_too_large_refused", r["error_type"] == "metadata_too_large" and r["rule_ids"] == ["C02-2.1"]
          and not S3V.store["rules"], r)
    check("bad_action", call(T.rules_manager, action="drop")["error_type"] == "invalid_parameter")
    check("action_needs_source", call(T.rules_manager, action="deactivate")["error_type"] == "invalid_parameter")
    check("search_needs_question", call(T.rules_search, question="  ")["error_type"] == "invalid_parameter")
    check("search_bad_amount", all(call(T.rules_search, question="立项", amount=a)["error_type"] == "invalid_parameter"
                                   for a in ("二十万", float("nan"), True)))
    check("no_writes_yet", not S3V.store["rules"] and not S3V.store["rule_sources"] and BR.texts_embedded == 0)

    # ── writer_ingests_and_reingests ──
    r = call(T.rules_writer, file_path=FIXTURE, source_id="fin-approval", source_version="V4.0", title="虚构审批矩阵")
    check("ingest_first", r["success"] and r["status"] == "ingested" and r["written"] == r["rules_total"] == 18
          and r["removed"] == 0 and r["unchanged"] == 0 and r["conflicts"] == [] and r["source_id"] == "fin-approval"
          and r["source_version"] == "V4.0" and r["report"] == fixture_report, r)
    check("keys_are_rule_ids", keys_of("fin-approval") == sorted(x["rule_id"] for x in fixture_ref))
    stored = S3V.store["rules"]["C05-5.4"]["metadata"]
    check("stored_rule", stored["text"] == next(x["content"] for x in fixture_ref if x["rule_id"] == "C05-5.4")
          and stored["segments"] == ["全部板块"] and stored["amt_kind"] == "range" and stored["lo"] == 10000.0
          and stored["active"] is True and stored["source_version"] == "V4.0", stored)
    reg = S3V.store["rule_sources"]["fin-approval"]
    check("registry_written", reg["data"] == [1.0] and reg["metadata"]["rules_total"] == 18
          and reg["metadata"]["status"] == "active" and reg["metadata"]["title"] == "虚构审批矩阵"
          and reg["metadata"]["file_name"] == "sample-matrix.docx" and len(reg["metadata"]["doc_hash"]) == 64, reg)
    audits = [v["metadata"] for v in S3V.store["audit"].values()]
    check("audit_written", len(audits) == 1 and audits[0]["operation"] == "rules_ingest"
          and json.loads(audits[0]["detail"])["written"] == 18, audits)
    first_ingested_at = reg["metadata"]["ingested_at"]

    embedded, puts = BR.texts_embedded, S3V.calls["PutVectors"]
    r = call(T.rules_writer, file_path=FIXTURE, source_id="fin-approval", source_version="V4.0")
    check("same_file_skipped", r["success"] and r["status"] == "skipped" and r["written"] == 0 and r["rules_total"] == 18
          and r["unchanged"] == 18 and BR.texts_embedded == embedded and S3V.calls["PutVectors"] == puts, r)

    r = call(T.rules_writer, file_path=changed, source_id="fin-approval", source_version="V4.0")
    check("one_row_changed", r["success"] and r["status"] == "ingested" and r["written"] == 1
          and r["unchanged"] == r["rules_total"] - 1 == 17 and r["removed"] == 0
          and BR.texts_embedded == embedded + 1 and "租赁台账" in S3V.store["rules"]["C03-3.3"]["metadata"]["text"], r)

    r = call(T.rules_writer, file_path=dropped, source_id="fin-approval", source_version="V4.0")
    check("one_row_removed", r["success"] and r["removed"] == 1 and r["written"] == 0 and r["unchanged"] == 17
          and r["rules_total"] == 17 and "C05-5.5" not in S3V.store["rules"]
          and S3V.store["rule_sources"]["fin-approval"]["metadata"]["rules_total"] == 17, r)
    check("first_ingest_time_kept", S3V.store["rule_sources"]["fin-approval"]["metadata"]["ingested_at"] == first_ingested_at)

    # ── 登记和文件都没变、索引里却少了一条：check 建议的「再上传一次」真能修好，不按登记直接 skip ──
    S3V.store["rules"].pop("C01-1.2")
    r = call(T.rules_manager, action="check")
    check("check_flags_missing_key", r["ok"] is False and r["problems"][0]["kind"] == "count_mismatch", r)
    r = call(T.rules_writer, file_path=dropped, source_id="fin-approval", source_version="V4.0")
    check("reupload_repairs_missing_key", r["success"] and r["status"] == "ingested" and r["written"] == 1
          and r["unchanged"] == 16 and r["removed"] == 0 and "C01-1.2" in S3V.store["rules"]
          and call(T.rules_manager, action="check")["ok"] is True, r)

    # ── writer_refuses_conflict：编号已属于另一个 source_id 时整份拒绝 ──
    before, embedded = copy.deepcopy(S3V.store["rules"]), BR.texts_embedded
    r = call(T.rules_writer, file_path=FIXTURE, source_id="other-policy", source_version="V1")
    check("writer_refuses_conflict", not r["success"] and r["error_type"] == "rule_conflict" and "C01-1.1" in r["conflicts"]
          and r["conflicts"] == sorted(keys_of("fin-approval")) and S3V.store["rules"] == before
          and "other-policy" not in S3V.store["rule_sources"] and BR.texts_embedded == embedded, r)

    # ── 再加两份：seg-demo（在线）、retired-policy（下线） ──
    r = call(T.rules_writer, file_path=seg_doc, source_id="seg-demo", source_version="2026", title="板块金额样例")
    check("ingest_seg_demo", r["success"] and r["written"] == 12, r)
    r = call(T.rules_writer, file_path=retired_doc, source_id="retired-policy")
    check("ingest_retired", r["success"] and r["written"] == 2, r)
    r = call(T.rules_manager, action="deactivate", source_id="retired-policy")
    check("deactivate_retired", r["success"] and r["source_id"] == "retired-policy" and r["affected"] == 2
          and all(S3V.store["rules"][k]["metadata"]["active"] is False for k in keys_of("retired-policy")), r)

    # ── filter_matches_keep（Review Focus 2）：假 S3 Vectors 按 build_filter 选出的集合 = E10 keep() 在本机算的集合 ──
    live = ref_parse(dropped)[0] + ref_parse(seg_doc)[0]
    probe = [1.0] + [0.0] * 1535
    mismatches, sizes_seen = [], set()
    for seg in ("九安", "全板块", "", "甲板块"):
        for amt in (200000, 200000.01, None, 500000, 10000, 0):
            flt = T.build_filter(seg, amt)
            res = S3V.query_vectors(vectorBucketName=BUCKET, indexName="rules", topK=100, queryVector={"float32": probe},
                                    filter=flt, returnMetadata=True)
            got = {v["key"] for v in res["vectors"]}
            want = {x["rule_id"] for x in live if ref_keep(x, {"seg": seg, "amt": amt})}
            sizes_seen.add(len(want))
            if got != want or any(v["metadata"]["active"] is not True for v in res["vectors"]):
                mismatches.append({"seg": seg, "amt": amt, "extra": sorted(got - want), "missing": sorted(want - got)})
            s = call(T.rules_search, question="付款审批", segment=seg, amount=amt, top_k=100)
            dists = [x["distance"] for x in s["results"]]
            if s["filter"] != flt or {x["rule_id"] for x in s["results"]} != want or dists != sorted(dists):
                mismatches.append({"seg": seg, "amt": amt, "via": "rules_search", "filter": s["filter"]})
    check("filter_matches_keep", not mismatches and len(sizes_seen) > 5, mismatches or sizes_seen)

    def picked(seg, amt):
        return {x["rule_id"] for x in call(T.rules_search, question="审批", segment=seg, amount=amt, top_k=100)["results"]}
    # 200,000 落在「≤20 万」之内、「>20 万」「<20 万」之外；多一分钱就反过来
    at, above = picked("", 200000), picked("", 200000.01)
    check("boundary_200000", {"C03-3.1", "C07-7.1"} <= at and not ({"C03-3.2", "C07-7.2", "C07-7.8", "C07-7.9"} & at)
          and {"C03-3.2", "C07-7.2", "C07-7.9"} <= above and not ({"C03-3.1", "C07-7.1", "C07-7.8"} & above),
          (sorted(at), sorted(above)))
    # 50 万同时落在「>20 万且≤50 万」和「≥50 万」里，不落在「总投资＞50 万」里
    at50 = picked("", 500000)
    check("boundary_500000", {"C07-7.2", "C07-7.3", "C01-1.1"} <= at50 and "C01-1.2" not in at50, sorted(at50))
    all_seg = picked("全板块", None)
    check("segment_all_and_none", all_seg == {x["rule_id"] for x in live if ref_segs(x["segment"]) == {"*"}}
          and "C07-7.4" in all_seg and "C07-7.1" not in all_seg and picked("九安", None) >= {"C07-7.1", "C07-7.6", "C07-7.4"}
          and "C07-7.5" not in picked("九安", None) and len(picked("", None)) == len(live), sorted(all_seg))
    check("non_amount_rules_kept", {"C07-7.4", "C07-7.6", "C07-7.7", "C07-7.11", "G-01", "C01-NOTE"} <= picked("", 123.0))
    check("no_filter_without_inputs", T.build_filter("", None) == {"active": {"$eq": True}}
          and "amt_kind" not in json.dumps(T.build_filter("九安", None))
          and "segments" not in json.dumps(T.build_filter("", 200000))
          and T.build_filter("  ", None) == {"active": {"$eq": True}})
    check("retired_never_returned", not ({"C09-9.1", "C09-9.2"} & picked("", None)))

    # ── 再上传到已下线的制度：照样入库，仍是下线 ──
    retired2 = make_matrix(os.path.join(tmp, "retired-2.docx"), [(RETIRED[0][0], "", RETIRED[0][2] + [
        ("9.3", "资产出租", "全板块", "不论金额", "①", "②√", "", "租赁合同")])])
    r = call(T.rules_writer, file_path=retired2, source_id="retired-policy")
    check("reingest_keeps_inactive", r["success"] and r["written"] == 1 and r["unchanged"] == 2
          and S3V.store["rules"]["C09-9.3"]["metadata"]["active"] is False
          and S3V.store["rule_sources"]["retired-policy"]["metadata"]["status"] == "inactive"
          and "C09-9.3" not in picked("", None), r)
    # 同一文件换了版本号：不算「同一份」，每条规则带上新版本号重写
    r = call(T.rules_writer, file_path=retired2, source_id="retired-policy", source_version="V2")
    check("new_version_rewrites", r["success"] and r["status"] == "ingested" and r["written"] == 3 and r["unchanged"] == 0
          and {S3V.store["rules"][k]["metadata"]["source_version"] for k in keys_of("retired-policy")} == {"V2"}
          and S3V.store["rule_sources"]["retired-policy"]["metadata"]["source_version"] == "V2", r)
    r = call(T.rules_writer, file_path=retired2, source_id="retired-policy")
    check("version_kept_when_omitted", r["status"] == "skipped" and r["source_version"] == "V2", r)

    # ── 近似检索少回一条时多取再截断 ──
    S3V.ann_shortfall = True
    target = next(x["content"] for x in fixture_ref if x["rule_id"] == "C01-1.1")
    r = call(T.rules_search, question=target, top_k=1)
    check("overfetch_beats_ann_shortfall", len(r["results"]) == 1 and r["results"][0]["rule_id"] == "C01-1.1", r)
    S3V.ann_shortfall = False
    hit = r["results"][0]
    check("search_result_shape", set(hit) == {"rule_id", "rule_type", "chapter_no", "segments", "amt_kind", "source_id",
                                              "text", "distance"} and hit["text"] == target
          and hit["source_id"] == "fin-approval" and hit["chapter_no"] == 1 and hit["segments"] == ["甲板块"], hit)

    # ── list / detail ──
    r = call(T.rules_manager, action="list")
    by = {s["source_id"]: s for s in r["sources"]}
    check("list", r["success"] and set(by) == {"fin-approval", "seg-demo", "retired-policy"}
          and set(by["fin-approval"]) == {"source_id", "title", "source_version", "file_name", "doc_hash", "rules_total",
                                          "status", "ingested_at", "updated_at"}
          and by["fin-approval"]["rules_total"] == 17 and by["retired-policy"]["status"] == "inactive"
          and by["seg-demo"]["status"] == "active" and by["retired-policy"]["title"] == "retired", r)
    r = call(T.rules_manager, action="detail", source_id="seg-demo")
    check("detail", r["success"] and r["source"]["source_id"] == "seg-demo" and r["rule_ids"] == keys_of("seg-demo")
          and len(r["rule_ids"]) == 12, r)
    check("detail_unknown", call(T.rules_manager, action="detail", source_id="nope")["error_type"] == "source_not_found")

    # ── deactivate_restore_delete ──
    q = "差旅费报销 九安/甲板块 ≤20万 行程单与发票一致"
    base = call(T.rules_search, question=q, top_k=5)["results"]
    check("seg_demo_searchable", base and base[0]["rule_id"] == "C07-7.1" and base[0]["source_id"] == "seg-demo", base)
    r = call(T.rules_manager, action="deactivate", source_id="seg-demo")
    gone = call(T.rules_search, question=q, top_k=5)["results"]
    check("deactivate_hides", r["success"] and r["affected"] == 12 and gone
          and all(x["source_id"] != "seg-demo" for x in gone)
          and S3V.store["rule_sources"]["seg-demo"]["metadata"]["status"] == "inactive", (r, gone))
    check("deactivate_idempotent", call(T.rules_manager, action="deactivate", source_id="seg-demo")["affected"] == 0)
    r = call(T.rules_manager, action="restore", source_id="seg-demo")
    back = call(T.rules_search, question=q, top_k=5)["results"]
    check("restore_same_distance", r["success"] and r["affected"] == 12
          and [(x["rule_id"], x["distance"]) for x in back] == [(x["rule_id"], x["distance"]) for x in base], (base, back))
    check("check_ok", call(T.rules_manager, action="check") == {"success": True, "ok": True, "problems": []})

    saved = S3V.store["rules"].pop("C07-7.3")
    r = call(T.rules_manager, action="check")
    check("check_finds_count_mismatch", r["success"] and r["ok"] is False
          and any(p["kind"] == "count_mismatch" and p["source_id"] == "seg-demo" and p["registered"] == 12
                  and p["indexed"] == 11 for p in r["problems"]), r)
    S3V.store["rules"]["C07-7.3"] = saved
    S3V.store["rules"]["C07-7.4"]["metadata"]["active"] = False
    r = call(T.rules_manager, action="check")
    check("check_finds_status_mismatch", r["ok"] is False
          and [p["kind"] for p in r["problems"]] == ["status_mismatch"] and r["problems"][0]["source_id"] == "seg-demo", r)
    S3V.store["rules"]["C07-7.4"]["metadata"]["active"] = True
    S3V.store["rules"]["C77-1"] = {"data": fake_aws.embed("孤儿"), "metadata": {**saved["metadata"], "source_id": "ghost"}}
    r = call(T.rules_manager, action="check")
    check("check_finds_unregistered", r["ok"] is False and [p["kind"] for p in r["problems"]] == ["unregistered_rules"]
          and r["problems"][0]["source_id"] == "ghost", r)
    S3V.store["rules"].pop("C77-1")

    audits_before = len(S3V.store["audit"])
    r = call(T.rules_manager, action="delete", source_id="seg-demo")
    check("delete", r["success"] and r["affected"] == 12 and not keys_of("seg-demo")
          and "seg-demo" not in S3V.store["rule_sources"] and len(S3V.store["audit"]) == audits_before + 1, r)
    check("delete_unknown", call(T.rules_manager, action="delete", source_id="seg-demo")["error_type"] == "source_not_found")
    check("check_ok_after_delete", call(T.rules_manager, action="check")["ok"] is True)
    ops = sorted(v["metadata"]["operation"] for v in S3V.store["audit"].values())
    check("audit_ops", {"rules_ingest", "rules_deactivate", "rules_restore", "rules_delete"} <= set(ops), ops)

    # ── 错误映射：不带密钥 ──
    S3V.deny = True
    r = call(T.rules_manager, action="list")
    check("access_denied_mapped", r["error_type"] == "access_denied" and CREDS["secret_access_key"] not in json.dumps(r), r)
    S3V.deny = False
    T._VECTOR_BUCKET = "no-such-bucket"
    check("kb_not_found_mapped", call(T.rules_manager, action="list")["error_type"] == "kb_not_found")
    T._VECTOR_BUCKET = BUCKET
    BR.deny_models = {"global.cohere.embed-v4:0"}
    r = call(T.rules_search, question=target, top_k=1)
    check("embed_fallback_us", r["success"] and r["results"][0]["rule_id"] == "C01-1.1"
          and BR.calls["us.cohere.embed-v4:0"] >= 1, r)
    BR.deny_models = {"global.cohere.embed-v4:0", "us.cohere.embed-v4:0"}
    r = call(T.rules_writer, file_path=seg_doc, source_id="seg-demo")
    check("embed_denied_no_write", r["error_type"] == "embedding_access_denied" and not keys_of("seg-demo")
          and "seg-demo" not in S3V.store["rule_sources"], r)
    BR.deny_models = set()

    # ── 写到一半失败（登记没写上）：check 看得出来，再上传同一文件补齐，不重新向量化 ──
    S3V.fail_put_on = "rule_sources"
    r = call(T.rules_writer, file_path=seg_doc, source_id="seg-demo")
    check("partial_failure_reported", r["error_type"] == "write_failed" and len(keys_of("seg-demo")) == 12
          and "seg-demo" not in S3V.store["rule_sources"], r)
    S3V.fail_put_on = None
    r = call(T.rules_manager, action="check", source_id="seg-demo")
    check("check_sees_partial", r["ok"] is False and r["problems"][0]["kind"] == "unregistered_rules", r)
    embedded = BR.texts_embedded
    r = call(T.rules_writer, file_path=seg_doc, source_id="seg-demo")
    check("reupload_heals", r["success"] and r["written"] == 0 and r["unchanged"] == 12 and BR.texts_embedded == embedded
          and call(T.rules_manager, action="check")["ok"] is True, r)
    call(T.rules_manager, action="delete", source_id="seg-demo")

    # ── 批量：130 条 → 嵌入分两批（≤ 96）、PutVectors 分批（≤ 500，替身会拦超限的请求） ──
    bulk = make_matrix(os.path.join(tmp, "bulk.docx"), [("八、批量登记", "", [
        (f"8.{i}", f"虚构事项{i}", "甲板块", "不论金额", "①", "②√", "", f"虚构要点{i}") for i in range(1, 131)])])
    calls_before = BR.calls["global.cohere.embed-v4:0"]
    r = call(T.rules_writer, file_path=bulk, source_id="bulk-demo")
    check("bulk_batches", r["success"] and r["written"] == 130 and len(keys_of("bulk-demo")) == 130
          and BR.calls["global.cohere.embed-v4:0"] - calls_before == 2, r)
    check("bulk_delete", call(T.rules_manager, action="delete", source_id="bulk-demo")["affected"] == 130
          and not keys_of("bulk-demo"))

    check("every_session_used_injected_key", SESSIONS and all(s.get("aws_access_key_id") == CREDS["access_key_id"]
                                                               for s in SESSIONS))
    print(f"\n{len(PASSED)} checks passed")


if __name__ == "__main__":
    main()
