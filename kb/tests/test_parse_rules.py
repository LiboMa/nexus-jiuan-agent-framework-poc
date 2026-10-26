"""parse_rules.py 解析仿真审批矩阵（kb/tests/fixtures/sample-matrix.docx），末行是机读的 REPORT。

    python3 -B -m unittest discover -s kb/tests
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
