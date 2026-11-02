"""doc_blocks.read：docx / xlsx / md / pdf → 按原文顺序的块；读不了的文件回明确的错误码。夹具都由 sample_docs 现生成。

    $KBPY -m unittest discover -s kb/tests -v
"""
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "lib"))
sys.path.insert(0, str(HERE))
import doc_blocks  # noqa: E402
import sample_docs  # noqa: E402


def shape(blocks):
    return [(b["kind"], b["level"], b["text"]) for b in blocks]


class DocBlocksTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_docx_order_and_headings(self):
        path = sample_docs.docx(self.tmp / "a.docx", [
            ("p", "第一章 总则", "Heading1"),
            ("p", "第一条　为规范差旅报销，制定本办法。"),
            ("p", ""),
            ("p", "第一节 范围", "2"),
            ("table", ["序号", "事项"], [["1", "差旅"], ["2", None]]),
            ("p", "第二节 标准", "Heading2"),
            ("p", "（一）列表段落。", "ListParagraph"),
        ], styles={"2": "标题 2"})
        blocks, info = doc_blocks.read(str(path))
        self.assertEqual(info, {"format": "docx"})
        self.assertEqual([b["i"] for b in blocks], list(range(len(blocks))))
        self.assertEqual(shape(blocks), [
            ("heading", 1, "第一章 总则"),
            ("para", None, "第一条 为规范差旅报销，制定本办法。"),  # 已 norm：全角空格 → 半角
            ("heading", 2, "第一节 范围"),  # 样式名「标题 2」
            ("table", None, ""),
            ("heading", 2, "第二节 标准"),
            ("para", None, "（一）列表段落。"),
        ])
        self.assertEqual(blocks[3]["cells"], [[["序号", None], ["事项", None]],
                                              [["1", None], ["差旅", "restart"]],
                                              [["2", None], ["", "continue"]]])
        self.assertTrue(all(b["loc"] == {} for b in blocks))
        self.assertTrue(all(b["cells"] is None for b in blocks if b["kind"] != "table"))

    def test_xlsx_merges_and_sheets(self):
        path = sample_docs.xlsx(self.tmp / "a.xlsx", [
            ("一、立项审批", [["业务事项", "序号", "金额"],
                         ["新产品立项", "1.1", 3.0],
                         [None, "1.2", 2.5],
                         ["合计", "全部", None]], ["A2:A3", "B4:C4"]),
            ("说明", [["备注"], ["第二张表"]], []),
            ("空表", [], []),
        ])
        blocks, info = doc_blocks.read(str(path))
        self.assertEqual(info, {"format": "xlsx", "sheets": ["一、立项审批", "说明", "空表"]})
        self.assertEqual(shape(blocks), [("heading", 1, "一、立项审批"), ("table", None, ""),
                                         ("heading", 1, "说明"), ("table", None, "")])
        self.assertEqual([b["loc"] for b in blocks], [{"sheet": "一、立项审批"}] * 2 + [{"sheet": "说明"}] * 2)
        cells = blocks[1]["cells"]
        self.assertEqual(cells[1][0], ["新产品立项", "restart"])
        self.assertEqual(cells[2][0], ["", "continue"])
        self.assertEqual([c[0] for c in cells[1]], ["新产品立项", "1.1", "3"])  # 整数不带 .0
        self.assertEqual(cells[2][2], ["2.5", None])
        self.assertEqual(cells[3], [["合计", None], ["全部", None], ["", None]])  # 横向合并同 Word 的 gridSpan
        self.assertEqual(blocks[3]["cells"], [[["备注", None]], [["第二张表", None]]])

    def test_xlsx_from_openpyxl(self):
        blocks, info = doc_blocks.read(str(sample_docs.matrix_xlsx(self.tmp / "m.xlsx")))
        self.assertEqual(info["sheets"], ["一、立项审批", "三、合同用印审批"])
        cells = blocks[1]["cells"]
        self.assertEqual(cells[0][0], ["序号", None])
        self.assertEqual(cells[1][1], ["新产品立项", "restart"])
        self.assertEqual(cells[2][1], ["", "continue"])

    def test_md_bom_crlf_tables(self):
        path = self.tmp / "a.md"
        path.write_bytes(("\ufeff# 某制度\r\n\r\n## 三、合同用印\r\n合同用印以法务审核意见为前提。\r\n\r\n"
                          "| 序号 | 事项 |\r\n| --- | :---: |\r\n| 3.1 | 甲\\|乙 |\r\n| 3.2 | 丙 |\r\n\r\n结尾段落。\r\n").encode("utf-8"))
        blocks, info = doc_blocks.read(str(path))
        self.assertEqual(info, {"format": "md"})
        self.assertEqual(shape(blocks), [("heading", 1, "某制度"), ("heading", 2, "三、合同用印"),
                                         ("para", None, "合同用印以法务审核意见为前提。"),
                                         ("table", None, ""), ("para", None, "结尾段落。")])
        self.assertEqual([b["loc"] for b in blocks], [{"line": 1}, {"line": 3}, {"line": 4}, {"line": 6}, {"line": 11}])
        self.assertEqual(blocks[3]["cells"], [[["序号", None], ["事项", None]],
                                              [["3.1", None], ["甲|乙", None]],
                                              [["3.2", None], ["丙", None]]])

    def test_pdf_pages(self):
        pages = [["第一页：某虚构集团财务审批办法。", "一、立项审批以立项报告为准。"],
                 ["五、付款审批", [["序号", "业务事项", "经办人"], ["5.1", "供应商货款", "①"]], "表后一行文字。"]]
        path = sample_docs.pdf(self.tmp / "a.pdf", pages)
        flat = ["".join(x if isinstance(x, str) else "".join(c for row in x for c in row) for x in page) for page in pages]
        import pdfplumber
        with pdfplumber.open(path) as pdf:  # 自检：字体的文字层读得回原文，否则下面的断言没有意义
            self.assertEqual(pdf.pages[0].extract_text(), "\n".join(pages[0]))
            self.assertEqual("".join(pdf.pages[1].extract_text().split()), flat[1])
        blocks, info = doc_blocks.read(str(path))
        self.assertEqual(info, {"format": "pdf", "pages": [{"page": 1, "chars": len(flat[0])},
                                                           {"page": 2, "chars": len(flat[1])}]})
        self.assertEqual(shape(blocks), [("para", None, pages[0][0]), ("para", None, pages[0][1]),
                                         ("para", None, "五、付款审批"), ("table", None, ""),
                                         ("para", None, "表后一行文字。")])
        self.assertEqual([b["loc"] for b in blocks], [{"page": 1}] * 2 + [{"page": 2}] * 3)
        self.assertEqual(blocks[3]["cells"], [[[c, None] for c in row] for row in pages[1][1]])

    def assert_doc_error(self, path, code):
        with self.assertRaises(doc_blocks.DocError) as cm:
            doc_blocks.read(str(path))
        self.assertEqual(cm.exception.code, code)
        self.assertTrue(cm.exception.message)
        return cm.exception

    def test_odd_files(self):
        ole = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\0" * 504  # .doc / .xls / 加密的 Office 文件都是 OLE 容器
        raw = {
            "renamed.docx": ole, "encrypted.xlsx": ole, "old.xls": ole, "old.doc": ole,
            "broken.docx": b"PK\x03\x04" + b"garbage" * 20,
            "notes.txt": "纯文本".encode("utf-8"),
            "gbk.md": "# 三、合同用印\n合同用印以法务审核意见为前提。\n".encode("gbk"),
            "empty.docx": b"",
        }
        for name, data in raw.items():
            (self.tmp / name).write_bytes(data)
        for name, parts in (("other.docx", {"hello.txt": "不是 Office 文档"}),
                            ("badxml.docx", {"word/document.xml": "<w:document><没有闭合"})):
            with zipfile.ZipFile(self.tmp / name, "w") as z:
                for part, text in parts.items():
                    z.writestr(part, text)
        sample_docs.scanned_pdf(self.tmp / "scan.pdf")
        sample_docs.docx(self.tmp / "blank.docx", [("p", "")])
        sample_docs.docx(self.tmp / "docx-named.doc", [("p", "内容是 docx，扩展名是 .doc")])
        with open(self.tmp / "huge.pdf", "wb") as f:
            f.write(b"%PDF-1.4\n")
            f.truncate(50 * 1024 * 1024 + 1)
        expected = {
            "renamed.docx": "unsupported_format", "encrypted.xlsx": "unsupported_format",
            "old.xls": "unsupported_format", "old.doc": "unsupported_format", "docx-named.doc": "unsupported_format",
            "broken.docx": "unsupported_format", "other.docx": "unsupported_format",
            "badxml.docx": "unsupported_format", "notes.txt": "unsupported_format",
            "scan.pdf": "no_text_layer", "gbk.md": "encoding_unsupported",
            "empty.docx": "empty_document", "blank.docx": "empty_document", "huge.pdf": "file_too_large",
        }
        for name, code in expected.items():
            with self.subTest(name):
                self.assert_doc_error(self.tmp / name, code)
        with self.subTest("zip-encrypted.docx"):  # zip 层加了密码（zip -P）：不能冒出 RuntimeError
            if not shutil.which("zip"):
                self.skipTest("没有 zip 命令")
            src = self.tmp / "plain"
            with zipfile.ZipFile(sample_docs.docx(self.tmp / "plain.docx", [("p", "加了密码的虚构文档。")])) as z:
                z.extractall(src)
            subprocess.run(["zip", "-q", "-r", "-P", "pw", str(self.tmp / "zip-encrypted.docx"), "."], cwd=src, check=True)
            self.assertIn("密码", self.assert_doc_error(self.tmp / "zip-encrypted.docx", "unsupported_format").message)

    def test_size_guards(self):
        # 解压后的 XML 过大（zip 炸弹）、工作表展开后格数过多：阈值调小来测
        with mock.patch.object(doc_blocks, "MAX_PART_BYTES", 100):
            self.assert_doc_error(sample_docs.docx(self.tmp / "a.docx", [("p", "一段" * 100)]), "file_too_large")
        with mock.patch.object(doc_blocks, "MAX_SHEET_CELLS", 4):
            self.assert_doc_error(sample_docs.matrix_xlsx(self.tmp / "a.xlsx"), "file_too_large")

    def test_pdf_parser_unavailable(self):
        path = sample_docs.pdf(self.tmp / "a.pdf", [["一页文字。"]])
        with mock.patch.dict(sys.modules, {"pdfplumber": None}):  # import pdfplumber → ImportError
            self.assert_doc_error(path, "pdf_parser_unavailable")


if __name__ == "__main__":
    unittest.main()
