"""parse_rules.py 解析仿真审批矩阵（kb/tests/fixtures/sample-matrix.docx），末行是机读的 REPORT。
sample-matrix.expected.json 是重构前的解析器对这份夹具的输出（基准），重构后逐条相同。

    $KBPY -m unittest discover -s kb/tests -v
"""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
PARSER = HERE.parent / "lib" / "parse_rules.py"
FIXTURE = HERE / "fixtures" / "sample-matrix.docx"
EXPECTED = HERE / "fixtures" / "sample-matrix.expected.json"
sys.path.insert(0, str(HERE.parent / "lib"))
sys.path.insert(0, str(HERE))
import doc_blocks  # noqa: E402
import parse_rules  # noqa: E402
import sample_docs  # noqa: E402


def run(docx):
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "rules.json"
        proc = subprocess.run([sys.executable, "-I", str(PARSER), str(docx), str(out)], capture_output=True, text=True)
        rules = json.loads(out.read_text(encoding="utf-8")) if out.exists() else []
    return proc, rules


class ParseRulesTest(unittest.TestCase):
    def test_fixture_is_current(self):
        sys.path.insert(0, str(HERE))
        import make_sample_docx
        with tempfile.TemporaryDirectory() as tmp:
            fresh = make_sample_docx.build(Path(tmp) / "x.docx")
            self.assertEqual(fresh.read_bytes(), FIXTURE.read_bytes(), "仿真文档和生成脚本不一致：重跑 make_sample_docx.py")

    def test_report_line_and_rules(self):
        proc, rules = run(FIXTURE)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        last = proc.stdout.strip().splitlines()[-1]
        self.assertTrue(last.startswith("REPORT "), last)
        report = json.loads(last[len("REPORT "):])
        self.assertEqual(report["matrix"], 12)
        self.assertEqual(report["general"], 3)
        self.assertEqual(report["chapter_notes"], 3)
        self.assertEqual(report["total"], 18)
        self.assertEqual(report["duplicates"], [])
        self.assertEqual(report["without_path"], [])
        self.assertEqual([c["no"] for c in report["chapters"]], [1, 3, 5])
        self.assertEqual([c["rows"] for c in report["chapters"]], [4, 3, 5])
        self.assertEqual(report["chapters"][0]["title"], "一、立项审批")
        matrix = [r for r in rules if r["rule_type"] == "matrix"]
        self.assertEqual(len([r for r in matrix if r["rule_id"].startswith("C05-")]), 5)
        self.assertTrue(all(r["business_item"] for r in matrix), "纵向合并的业务事项按上一行展开")
        by_id = {r["rule_id"]: r for r in rules}
        self.assertEqual(by_id["C01-1.2"]["business_item"], "新产品立项")
        self.assertEqual(by_id["C01-1.2"]["final_approver"], "总经理")
        self.assertEqual(by_id["C05-5.4"]["post_actions"], "总经理")
        self.assertEqual(by_id["C05-5.1"]["extra"], {"备注": "月结"})

    def test_matches_golden(self):
        general, notes, matrix = parse_rules.parse(str(FIXTURE))
        self.assertEqual(general + notes + matrix, json.loads(EXPECTED.read_text(encoding="utf-8")))
        with tempfile.TemporaryDirectory() as tmp:  # 命令行写出的文件与基准逐字节相同
            out = Path(tmp) / "rules.json"
            subprocess.run([sys.executable, "-I", str(PARSER), str(FIXTURE), str(out)], capture_output=True, check=True)
            self.assertEqual(out.read_bytes(), EXPECTED.read_bytes())

    def test_used_blocks_and_old_imports(self):
        blocks, _ = doc_blocks.read(str(FIXTURE))
        r = parse_rules.parse_blocks(blocks)
        self.assertEqual(set(range(len(blocks))) - r.used, {0}, "只有封面标题没被矩阵解析用掉")
        self.assertEqual(r.orphans, [])
        self.assertIs(parse_rules.norm, doc_blocks.norm)
        self.assertIs(parse_rules.text_of, doc_blocks.text_of)
        self.assertIs(parse_rules.table_grid, doc_blocks.table_grid)

    def test_matrix_same_in_xlsx_and_md(self):
        want = [(r["rule_id"], r["content"]) for r in parse_rules.parse(str(FIXTURE))[2] if r["chapter_no"] in (1, 3)]
        self.assertEqual(len(want), 7)
        with tempfile.TemporaryDirectory() as tmp:
            for build, name in ((sample_docs.matrix_xlsx, "m.xlsx"), (sample_docs.matrix_md, "m.md")):
                with self.subTest(name):
                    _, _, matrix = parse_rules.parse(str(build(Path(tmp) / name)))
                    self.assertEqual([(r["rule_id"], r["content"]) for r in matrix], want)

    def test_orphan_matrix_table(self):
        with tempfile.TemporaryDirectory() as tmp:
            blocks, _ = doc_blocks.read(str(sample_docs.matrix_xlsx(Path(tmp) / "o.xlsx", names=["审批矩阵"])))
        r = parse_rules.parse_blocks(blocks)
        self.assertEqual(r.orphans, [b["i"] for b in blocks if b["kind"] == "table"])
        self.assertEqual(len(r.orphans), 1)
        self.assertEqual(r.matrix, [])

    def test_chapter_does_not_carry_across_sheets(self):
        # 「一、立项审批」之后的工作表「Sheet2」不是章：它的矩阵表是 orphan，表名也不算上一章的章节说明
        with tempfile.TemporaryDirectory() as tmp:
            blocks, _ = doc_blocks.read(str(sample_docs.matrix_xlsx(Path(tmp) / "two.xlsx", names=["一、立项审批", "Sheet2"])))
        r = parse_rules.parse_blocks(blocks)
        sheet2 = [b["i"] for b in blocks if b["loc"]["sheet"] == "Sheet2"]
        self.assertEqual(r.orphans, [b["i"] for b in blocks if b["kind"] == "table" and b["i"] in sheet2])
        self.assertEqual({m["rule_id"] for m in r.matrix}, {"C01-1.1", "C01-1.2", "C01-1.3", "C01-1.4"})
        self.assertEqual(r.notes, [])
        self.assertFalse(r.used & set(sheet2))

    def test_textless_docx_parses_to_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = sample_docs.docx(Path(tmp) / "blank.docx", [("p", "")])
            self.assertEqual(parse_rules.parse(str(path)), ([], [], []), "与重构前相同：读得开、没有文字的文档解析为空")

    def test_not_a_matrix_document(self):
        with tempfile.TemporaryDirectory() as tmp:
            import zipfile
            bad = Path(tmp) / "plain.docx"
            with zipfile.ZipFile(bad, "w") as z:
                z.writestr("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
                                               '<w:p><w:r><w:t>一份普通文档</w:t></w:r></w:p></w:body></w:document>')
            proc, _ = run(bad)
        self.assertEqual(proc.returncode, 3)
        self.assertIn("文档结构与解析器不匹配", proc.stderr)
        report = json.loads(proc.stdout.strip().splitlines()[-1][len("REPORT "):])
        self.assertEqual(report["matrix"], 0)


if __name__ == "__main__":
    unittest.main()
