"""clauses + kb_parse：矩阵之外的文字 → 正文条款记录（rule_type=clause）；整份文档 → 记录 + 解析报告。
夹具都由 sample_docs 现生成（内容虚构）。

    $KBPY -m unittest kb/tests/test_clauses.py -v
"""
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
LIB = HERE.parent / "lib"
sys.path.insert(0, str(LIB))
sys.path.insert(0, str(HERE))
import clauses  # noqa: E402
import doc_blocks  # noqa: E402
import kb_parse  # noqa: E402
import parse_rules  # noqa: E402
import sample_docs  # noqa: E402

TAG, TITLE = "travel", "差旅管理办法"
FIXTURE = HERE / "fixtures" / "sample-matrix.docx"
LONG_HEADING = "境外出差" + "费用报销标准与审批流程" * 4  # 48 字
REPORT_KEYS = ["parser_version", "format", "general", "chapter_notes", "matrix", "clause", "table_row", "paragraph",
               "total", "chapters", "duplicates", "without_path", "split", "renumbered", "skipped", "tables", "warnings"]


def ids(records):
    return [r["rule_id"] for r in records]


def squash(s):
    return "".join(s.split())


class ClausesTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def parse(self, path, tag=TAG, title=TITLE):
        return kb_parse.parse_document(str(path), source_tag=tag, doc_title=title)

    def assert_doc_error(self, path, code):
        with self.assertRaises(doc_blocks.DocError) as cm:
            self.parse(path)
        self.assertEqual(cm.exception.code, code)
        self.assertTrue(cm.exception.message)

    def test_article_ids(self):
        text = sample_docs.sentences(12, 30)
        preamble = ("本章规定差旅管理的基本要求，", "适用于公司全体员工。")
        docx = sample_docs.docx(self.tmp / "travel.docx", [("p", TITLE), ("p", "第一章 总则"), ("p", "".join(preamble))]
                                + [("p", f"第{sample_docs.cn(n)}条　{s}") for n, s in enumerate(text, start=1)])
        # Markdown / PDF 一行一个块：每条折成两行，接回来要和 Word 的一样
        lines = [f"第{sample_docs.cn(n)}条 {s[:12]}\n{s[12:]}" for n, s in enumerate(text, start=1)]
        md = sample_docs.md(self.tmp / "travel.md", ["# 第一章 总则", "", *preamble, ""]
                            + [x for ln in lines for x in (*ln.split("\n"), "")])
        pdf = sample_docs.pdf(self.tmp / "travel.pdf", [["第一章 总则", *preamble] + [x for ln in lines[:6] for x in ln.split("\n")],
                                                         [x for ln in lines[6:] for x in ln.split("\n")]])
        for path, cover in ((docx, 1), (md, 0), (pdf, 0)):
            with self.subTest(path.suffix):
                records, report = self.parse(path)
                self.assertEqual(ids(records), ["travel-CH1"] + [f"travel-A{n}" for n in range(1, 13)])
                by_id = {r["rule_id"]: r for r in records}
                a12, ch1 = by_id["travel-A12"], by_id["travel-CH1"]
                self.assertEqual(a12["rule_type"], "clause")
                self.assertEqual(squash(a12["chapter"]), "第一章总则")
                self.assertEqual(a12["chapter_no"], 1)
                self.assertEqual(a12["seq_no"], "12")
                self.assertEqual(squash(a12["scope_controls"]), squash(text[11]), "条文不含「第十二条」，折行接上")
                self.assertEqual(squash(ch1["scope_controls"]), "".join(preamble))
                self.assertEqual(report["skipped"], {"cover": cover, "revision_tables": 0})
                self.assertEqual((report["clause"], report["total"]), (13, 13))
                if path is docx:
                    self.assertTrue(a12["content"].startswith("差旅管理办法 › 第一章 总则 › 第十二条："), a12["content"])
                    self.assertEqual(a12["extra"], {"kind": "clause"})
                    self.assertEqual(a12["business_item"], text[11][:-1], "没有条标题：取首句")
                    self.assertTrue(ch1["content"].startswith("差旅管理办法 › 第一章 总则：本章规定"), ch1["content"])
                    self.assertEqual(set(a12), set(parse_rules.blank("x", "matrix", 0, "", "")), "字段与矩阵记录相同")
                    self.assertEqual(report["chapters"], [{"no": 1, "title": "第一章 总则", "rows": 13}])
                if path is md:
                    self.assertEqual(a12["scope_controls"], text[11], "Markdown 相邻行是同一段：中文之间不加空格、不换行")
                if path is pdf:
                    self.assertEqual(a12["extra"], {"kind": "clause", "page": 2})

    def test_numbered_items(self):
        path = sample_docs.docx(self.tmp / "items.docx", [
            ("p", "费用报销细则"),
            ("p", "二、本细则适用于全体员工的出差费用报销。"),
            ("p", "三、费用范围"),
            ("p", "（一）交通费按实际发生额凭票报销。"),
            ("p", "（二）住宿费按城市标准报销，超出标准的部分由个人承担。"),
            ("p", "1.2.3 一线城市住宿标准为每晚不超过六百元。"),
            ("p", "第八条 出差补助按以下标准执行："),
            ("p", "（一）市内出差每天补助五十元；"),
            ("p", "（二）市外出差每天补助一百元。"),
        ])
        records, report = self.parse(path)
        self.assertEqual(ids(records), ["travel-S2", "travel-S3.1", "travel-S3.2", "travel-N1.2.3", "travel-A8"],
                         "只有标题的「三、费用范围」不成条，进下级的路径")
        by_id = {r["rule_id"]: r for r in records}
        s32 = by_id["travel-S3.2"]
        self.assertEqual((s32["seq_no"], s32["chapter"]), ("3.2", "三、费用范围"))
        self.assertEqual(s32["scope_controls"], "（二）住宿费按城市标准报销，超出标准的部分由个人承担。")
        self.assertEqual(s32["content"], "差旅管理办法 › 三、费用范围：（二）住宿费按城市标准报销，超出标准的部分由个人承担。")
        self.assertEqual(by_id["travel-N1.2.3"]["seq_no"], "1.2.3")
        self.assertEqual(by_id["travel-S2"]["scope_controls"], "二、本细则适用于全体员工的出差费用报销。")
        a8 = by_id["travel-A8"]
        self.assertEqual(a8["scope_controls"], "出差补助按以下标准执行：\n（一）市内出差每天补助五十元；\n（二）市外出差每天补助一百元。",
                         "条下的（一）（二）跟着这一条")
        self.assertEqual(a8["business_item"], "出差补助按以下标准执行")
        self.assertEqual(a8["chapter"], "", "「第八条」比「三、」高一级，不在它下面")
        with self.subTest("文档开头就是小项"):
            records, _ = self.parse(sample_docs.md(self.tmp / "small.md", ["（1）出差前应当提交出差申请。", "（2）返回后十日内提交报销单据。",
                                                                         "并附原始票据。"]))
            self.assertEqual(ids(records), ["travel-N1", "travel-N2"])
            self.assertEqual(records[1]["scope_controls"], "（2）返回后十日内提交报销单据。并附原始票据。")

    def test_long_clause_split(self):
        text = sample_docs.sentences(30, 50)  # 1,500 字
        records, report = self.parse(sample_docs.docx(self.tmp / "long.docx", [
            ("p", "第四条 出差须事先申请。"), ("p", "第五条 " + "".join(text)), ("p", "第六条 本办法自发布之日起施行。")]))
        self.assertEqual(ids(records), ["travel-A4", "travel-A5-a", "travel-A5-b", "travel-A5-c", "travel-A6"])
        parts = records[1:4]
        for r, part in zip(parts, "abc"):
            self.assertLessEqual(len(r["scope_controls"]), 600)
            self.assertTrue(r["scope_controls"].endswith("。"), "在句末断开")
            self.assertEqual(r["extra"], {"kind": "clause", "part": part})
            self.assertEqual(r["seq_no"], "5")
            self.assertTrue(r["content"].startswith("差旅管理办法 › 第五条："))
        self.assertEqual("".join(r["scope_controls"] for r in parts), "".join(text))
        self.assertEqual(report["split"], ["travel-A5"])
        with self.subTest("一句就超过 600 字：在 600 字处硬断"):
            records, report = self.parse(sample_docs.docx(self.tmp / "run-on.docx", [("p", "第五条 " + "差" * 700)]))
            self.assertEqual([len(r["scope_controls"]) for r in records], [600, 100])

    def test_markerless_prose(self):
        p1, p2, p3, p4 = ("".join(sample_docs.sentences(n, 50)) for n in (3, 4, 10, 2))
        path = sample_docs.md(self.tmp / "prose.md", [p1[:75], p1[75:], "", p2, "", p3, "", p4])
        records, report = self.parse(path)
        self.assertEqual(ids(records), ["travel-P001", "travel-P002", "travel-P003"])
        for r in records:
            self.assertLessEqual(len(r["scope_controls"]), 400)
            self.assertEqual(r["extra"], {"kind": "paragraph"})
            self.assertEqual((r["chapter"], r["chapter_no"]), ("", None))
            self.assertTrue(r["content"].startswith("差旅管理办法："))
        self.assertTrue(records[0]["scope_controls"].startswith(p1 + "\n" + p2), "折行接上；短段落合并")
        self.assertEqual(squash("".join(r["scope_controls"] for r in records)), p1 + p2 + p3 + p4)
        self.assertEqual((report["paragraph"], report["clause"]), (3, 0))
        self.assertEqual(records[0]["seq_no"], "001")

    def test_md_headings(self):
        records, report = self.parse(sample_docs.md(self.tmp / "h.md", [
            "# 差旅管理办法", "", "## 总则", "", "本办法适用于公司全体员工的国内出差，出差人员应当遵守本办法。", "",
            "## 报销标准", "", "### 交通费", "", "飞机经济舱、火车二等座按实际票价报销。", "",
            "### 住宿费", "", "住宿费按出差城市的标准报销，", "超出部分由个人承担。", "",
            "## " + LONG_HEADING, "", "境外出差的费用按另行发布的标准执行。"]))
        self.assertEqual(ids(records), ["travel-H1.1", "travel-H1.2.1", "travel-H1.2.2", "travel-H1.3"])
        self.assertEqual(records[3]["business_item"], LONG_HEADING[:40], "条标题至多 40 字")
        h121 = records[1]
        self.assertEqual(h121["chapter"], "差旅管理办法 › 报销标准 › 交通费")
        self.assertEqual(h121["business_item"], "交通费")
        self.assertEqual(h121["seq_no"], "1.2.1")
        self.assertEqual(h121["chapter_no"], None)
        self.assertEqual(h121["content"], "差旅管理办法 › 报销标准 › 交通费：飞机经济舱、火车二等座按实际票价报销。",
                         "第一级标题就是文档名时不重复")
        self.assertEqual(records[2]["scope_controls"], "住宿费按出差城市的标准报销，超出部分由个人承担。")
        self.assertEqual(records[0]["chapter"], "差旅管理办法 › 总则")

    def test_duplicate_article_numbers(self):
        records, report = self.parse(sample_docs.docx(self.tmp / "dup.docx", [
            ("p", "第一章 总则"), ("p", "第三条 出差须事先申请。"), ("p", "第三条 出差须按标准报销。"), ("p", "第三条 出差结束后及时报销。")]))
        self.assertEqual(ids(records), ["travel-A3", "travel-A3~2", "travel-A3~3"])
        self.assertEqual(report["renumbered"], ["travel-A3~2", "travel-A3~3"])
        self.assertEqual({r["seq_no"] for r in records}, {"3"})
        self.assertEqual(report["duplicates"], [])

    def test_cover_and_revision_log_skipped(self):
        # 夹具：三行封面（其中一段由几截短信息拼成、超过 40 字）、修改记录表、再一行封面，然后是矩阵各章
        body = [("p", "某虚构集团"),
                ("p", "文件编号：XG-CW-001 版本：V1.0 生效日期：2026-10-01 起草部门：财务部 发布范围：全集团"),
                ("p", "财务审批授权办法"),
                ("table", ["文档修改记录", "", ""], [["版本", "日期", "修改内容"], ["V1.0", "2026-10-01", "首次发布"]]),
                ("p", "仅供集团内部使用")]
        body += [("p", t) for t in sample_docs.make_sample_docx.PREFACE[1:]]
        for title, note, header, rows in sample_docs.make_sample_docx.CHAPTERS:
            body += [("p", title), ("p", note), ("table", header, rows)]
        path = sample_docs.docx(self.tmp / "cover.docx", body)
        records, report = self.parse(path)
        general, notes, matrix = parse_rules.parse(str(path))
        self.assertEqual(records, general + notes + matrix)
        self.assertFalse([r for r in records if r["rule_type"] == "clause"])
        self.assertEqual(report["skipped"], {"cover": 4, "revision_tables": 1})
        self.assertEqual(report["total"], len(general + notes + matrix))
        self.assertEqual(report["tables"], {"matrix": 3, "other": 1})
        with self.subTest("修改记录表在文末、标题在表前（表头以「序号」开头也不算没有章的矩阵）"):
            records, report = self.parse(sample_docs.docx(self.tmp / "tail.docx", [
                ("p", "第一条 出差须事先申请，经批准后方可出行。"), ("p", "文档修改记录"),
                ("table", ["序号", "版本", "修改内容"], [["1", "V1.0", "首次发布"]])]))
            self.assertEqual(ids(records), ["travel-A1"])
            self.assertEqual(records[0]["scope_controls"], "出差须事先申请，经批准后方可出行。")
            self.assertEqual(report["skipped"], {"cover": 0, "revision_tables": 1})
        with self.subTest("有条款标记的段落提到修改记录，也不是修改记录表的标题，条款不丢"):
            records, report = self.parse(sample_docs.docx(self.tmp / "mention.docx", [
                ("p", "第一条 出差须事先申请。"), ("p", "第二条 本办法修改记录见下表。"),
                ("table", ["版本", "日期", "修改内容"], [["V1.0", "2026-10-01", "首次发布"]])]))
            self.assertEqual(ids(records), ["travel-A1", "travel-A2", "travel-T1.1"], "条内的表排在这一条之后")
            self.assertEqual(records[1]["scope_controls"], "本办法修改记录见下表。")
            self.assertEqual(report["skipped"], {"cover": 0, "revision_tables": 0})
        with self.subTest("修改记录表前的标题段落随表不入库，不算封面"):
            records, report = self.parse(sample_docs.docx(self.tmp / "titled.docx", [
                ("p", "某虚构集团"), ("p", "差旅管理办法"), ("p", "文档修改记录"),
                ("table", ["版本", "日期", "修改内容"], [["V1.0", "2026-10-01", "首次发布"]]), ("p", "第一条 出差须事先申请。")]))
            self.assertEqual(ids(records), ["travel-A1"])
            self.assertEqual(report["skipped"], {"cover": 2, "revision_tables": 1})

    def test_cover_stops_at_wrapped_prose(self):
        # Markdown / PDF 一行一个块：没有标点的短行若和下一行是同一段的折行，就是正文，不是封面
        line1, line2 = "本办法适用于集团总部及各下属单位全体员工因公出差的交通住宿", "等费用的报销管理。"
        cases = {
            "md：首行没有标点、下一行接着同一句": (sample_docs.md(self.tmp / "w2.md", [line1, line2, "", "第一条 出差须事先申请。"]), 0),
            "md：一段折成三行，前两行都没有标点": (sample_docs.md(self.tmp / "w3.md", [line1[:15], line1[15:], line2, "",
                                                                       "第一条 出差须事先申请。"]), 0),
            "PDF：标题行之后是折了行的正文": (sample_docs.pdf(self.tmp / "w.pdf", [["差旅管理办法", line1, line2,
                                                                         "第一条 出差须事先申请。"]]), 1),
        }
        for name, (path, cover) in cases.items():
            with self.subTest(name):
                records, report = self.parse(path)
                self.assertEqual(ids(records), ["travel-P001", "travel-A1"])
                self.assertEqual(squash(records[0]["scope_controls"]), line1 + line2, "一个字都不丢")
                self.assertEqual(report["skipped"], {"cover": cover, "revision_tables": 0})
        with self.subTest("md：几行短的封面写在相邻行上，仍是封面"):
            records, report = self.parse(sample_docs.md(self.tmp / "c.md", ["某虚构集团", "差旅管理办法", "", "第一条 出差须事先申请。"]))
            self.assertEqual((ids(records), report["skipped"]["cover"]), (["travel-A1"], 2))

    def test_non_matrix_table_rows(self):
        path = sample_docs.xlsx(self.tmp / "std.xlsx", [
            ("住宿标准", [["城市", "住宿标准", "餐补"], ["北京", 600, 100], [None, 650, 120], ["成都", 450, None]], ["A2:A3"]),
            ("交通标准", [["职级", "交通工具"], ["普通员工", "火车二等座"]], []),
        ])
        records, report = self.parse(path)
        self.assertEqual(ids(records), ["travel-T1.1", "travel-T1.2", "travel-T1.3", "travel-T2.1"])
        self.assertEqual([r["scope_controls"] for r in records], [
            "城市：北京；住宿标准：600；餐补：100", "城市：北京；住宿标准：650；餐补：120", "城市：成都；住宿标准：450",
            "职级：普通员工；交通工具：火车二等座"])
        t11 = records[0]
        self.assertEqual(t11["extra"], {"kind": "table_row", "sheet": "住宿标准", "row": 1})
        self.assertEqual((t11["chapter"], t11["seq_no"], t11["business_item"]), ("住宿标准", "1.1", "北京"))
        self.assertEqual(t11["content"], "差旅管理办法 › 住宿标准：城市：北京；住宿标准：600；餐补：100")
        self.assertEqual((report["table_row"], report["tables"]), (4, {"matrix": 0, "other": 2}))
        with self.subTest("「序号」开头、没有审批符号的附表不是矩阵；首行只有表名的表，第二行才是表头"):
            records, report = self.parse(sample_docs.docx(self.tmp / "appendix.docx", [
                ("p", "一、总则"), ("p", "（一）本细则适用于全体员工的国内出差。"),
                ("p", "二、住宿标准"), ("table", ["序号", "城市", "标准"], [["1", "北京", "600"]]),
                ("table", ["差旅补助标准", "", ""], [["地区", "每天补助", "备注"], ["市内", "50", ""], ["市外", "100", "需审批"]])]))
            self.assertEqual(ids(records), ["travel-S1.1", "travel-T1.1", "travel-T2.1", "travel-T2.2"])
            self.assertEqual((report["matrix"], report["chapter_notes"], report["tables"]), (0, 0, {"matrix": 0, "other": 2}))
            self.assertEqual((records[1]["chapter"], records[1]["scope_controls"]), ("二、住宿标准", "序号：1；城市：北京；标准：600"),
                             "只有标题的「二、住宿标准」不成条，进表的路径")
            self.assertEqual((records[2]["chapter"], records[2]["scope_controls"], records[2]["extra"]["row"]),
                             ("二、住宿标准 › 差旅补助标准", "地区：市内；每天补助：50", 1))

    def test_document_errors(self):
        self.assert_doc_error(sample_docs.matrix_xlsx(self.tmp / "orphan.xlsx", names=["审批矩阵"]), "matrix_chapter_missing")
        big = sample_docs.xlsx(self.tmp / "big.xlsx", [("明细", [["事项", "金额"]] + [[f"事项{k}", k] for k in range(1, 2002)], [])])
        self.assert_doc_error(big, "too_many_records")
        with mock.patch.object(kb_parse, "MAX_RECORDS", 2001):
            self.assertEqual(self.parse(big)[1]["total"], 2001, "正好到上限不报错")
        self.assert_doc_error(sample_docs.docx(self.tmp / "cover-only.docx", [
            ("p", "某虚构集团"), ("p", "差旅管理办法"), ("p", "2026 年 10 月")]), "empty_document")
        _title, _note, header, rows = sample_docs.MATRIX[0]
        self.assert_doc_error(sample_docs.docx(self.tmp / "dup.docx", [("p", "一、立项审批"), ("table", header, [rows[0], rows[0]])]),
                              "duplicate_rule_ids")

    def test_pdf_matrix_warning(self):
        header = ["序号", "业务事项", "板块", "经办人", "总经理"]
        rows = [["1.1", "新产品立项", "甲板块", "①", "②√"], ["1.2", "设备更新立项", "乙板块", "①", "②√"]]
        records, report = self.parse(sample_docs.pdf(self.tmp / "m.pdf", [["一、立项审批", "立项审批以立项报告为准。", [header] + rows]]))
        self.assertEqual([r["rule_id"] for r in records if r["rule_type"] == "matrix"], ["C01-1.1", "C01-1.2"])
        self.assertIn("PDF 的合并单元格常读不全，审批矩阵请用 Word / Excel", report["warnings"])
        self.assertEqual(report["format"], "pdf")
        self.assertEqual([p["page"] for p in report["pages"]], [1])
        self.assertEqual(list(report), REPORT_KEYS[:-1] + ["pages", "warnings"])
        _, report = self.parse(sample_docs.pdf(self.tmp / "prose.pdf", [["第一条 出差须事先申请。"]]))
        self.assertEqual(report["warnings"], [], "没有矩阵的 PDF 不提醒")

    def test_report_has_parser_version(self):
        self.assertEqual((kb_parse.PARSER_VERSION, kb_parse.MAX_RECORDS), ("1", 2000))
        records, report = self.parse(FIXTURE)
        self.assertEqual(report["parser_version"], "1")
        self.assertEqual(list(report), REPORT_KEYS)
        general, notes, matrix = parse_rules.parse(str(FIXTURE))
        self.assertEqual(records, general + notes + matrix, "矩阵文档：记录与 parse_rules 逐条相同")
        self.assertEqual({k: report[k] for k in ("general", "chapter_notes", "matrix", "clause", "total")},
                         {"general": 3, "chapter_notes": 3, "matrix": 12, "clause": 0, "total": 18})
        self.assertEqual(report["chapters"], [{"no": 1, "title": "一、立项审批", "rows": 4}, {"no": 3, "title": "三、合同用印审批", "rows": 3},
                                              {"no": 5, "title": "五、付款审批", "rows": 5}])
        self.assertEqual(report["skipped"], {"cover": 1, "revision_tables": 0})
        self.assertEqual((report["format"], report["warnings"]), ("docx", []))

    def test_clause_records_interface(self):
        def blk(i, kind, text="", cells=None, **loc):
            return {"i": i, "kind": kind, "text": text, "level": None, "cells": cells, "loc": loc}
        blocks = [blk(0, "para", "第一条 出差须事先申请。"), blk(1, "para", "\ufffd" * 4),
                  blk(2, "table", cells=[[["", None]], [["", None]]]), blk(3, "para", "（一）经部门负责人批准。"),
                  blk(4, "para", "- 3 -", page=1), blk(5, "para", "第 3 页 共 9 页", page=1)]  # PDF 的页码行
        records, part = clauses.clause_records(blocks, set(), source_tag="t1", doc_title="")
        self.assertEqual(list(part), ["clause", "table_row", "paragraph", "split", "renumbered", "skipped", "empty_or_garbled"])
        self.assertEqual(part["empty_or_garbled"], [1, 2, 4, 5])
        self.assertEqual(ids(records), ["t1-A1"])
        self.assertEqual(records[0]["scope_controls"], "出差须事先申请。\n（一）经部门负责人批准。")
        self.assertEqual(records[0]["content"], "第一条：出差须事先申请。 （一）经部门负责人批准。", "没有文档名时只写存在的层级")
        records, part = clauses.clause_records(blocks, {0, 3}, source_tag="t1", doc_title="")
        self.assertEqual((records, part["clause"]), ([], 0), "skip 里的块不出条款")

    def test_chinese_numbers(self):
        for n in range(1, 1000):
            self.assertEqual(clauses.cn_int(sample_docs.cn(n)), n)
        for s, n in (("两百", 200), ("一百十", 110), ("一〇五", 105), ("１２", 12), ("12", 12), ("零", None), ("十十", None), ("千", None)):
            with self.subTest(s):
                self.assertEqual(clauses.cn_int(s), n)

    def test_runs_as_script_and_as_package(self):
        # kb/lib 的固定写法：python -I 当脚本跑；作为包（工具目录）时相对 import
        path = sample_docs.docx(self.tmp / "a.docx", [("p", "第一条 出差须事先申请。")])
        proc = subprocess.run([sys.executable, "-I", str(LIB / "kb_parse.py"), str(path), "t1"], capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn('"clause": 1', proc.stdout.strip().splitlines()[-1])
        root = str(HERE.parent.parent)  # kb/、kb/lib/ 没有 __init__.py：按命名空间包导入，__package__ = "kb.lib"
        proc = subprocess.run([sys.executable, "-I", "-c", f"import sys; sys.path.insert(0, {root!r}); "
                               "import kb.lib.kb_parse as k; print(k.clauses.__name__)"], capture_output=True, text=True)
        self.assertEqual((proc.returncode, proc.stdout.strip()), (0, "kb.lib.clauses"), proc.stderr)


if __name__ == "__main__":
    unittest.main()
