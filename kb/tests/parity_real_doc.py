"""本机对照（不进测试集）：真实制度经重构前（19e5bf9）与现在的 parse_rules.py 解析，输出逐字节相同。

    KB_REAL_DOC=/path/to/制度.docx python3 -I kb/tests/parity_real_doc.py

真实制度不进仓库：只打印 {"old": 条数, "new": 条数, "identical": 是否相同}，不打印任何内容。
两个解析器的输出写在临时目录里，跑完即删；它们的标准输出（含章名）只拿来比，不打印。

另打印整份文档入口 kb_parse.parse_document 的计数 {"total", "clause", "skipped"}（同样不打印内容），
真实制度应是 {"total": 102, "clause": 0, "skipped": {"cover": 4, "revision_tables": 1}}：封面与修改记录不入库，
矩阵之外没有别的条款。
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
NEW = HERE.parent / "lib" / "parse_rules.py"
BASE = "19e5bf9"
sys.path.insert(0, str(HERE.parent / "lib"))
import kb_parse  # noqa: E402


def run(parser, doc, out):
    proc = subprocess.run([sys.executable, "-I", str(parser), doc, str(out)], capture_output=True)
    if not out.exists():
        sys.exit(f"{parser.name} 没有写出结果（退出码 {proc.returncode}）")
    return proc.stdout, out.read_bytes()


def main():
    doc = os.environ.get("KB_REAL_DOC")
    if not doc or not os.path.isfile(doc):
        print("先设 KB_REAL_DOC=<真实制度 .docx 的路径>", file=sys.stderr)
        return 2
    with tempfile.TemporaryDirectory() as tmp:
        old = Path(tmp) / "parse_rules_old.py"
        old.write_bytes(subprocess.run(["git", "-C", str(REPO), "show", f"{BASE}:kb/lib/parse_rules.py"],
                                       capture_output=True, check=True).stdout)
        old_out, old_json = run(old, doc, Path(tmp) / "old.json")
        new_out, new_json = run(NEW, doc, Path(tmp) / "new.json")
    print(json.dumps({"old": len(json.loads(old_json)), "new": len(json.loads(new_json)),
                      "identical": old_json == new_json and old_out == new_out}))
    try:
        _, report = kb_parse.parse_document(doc, source_tag="parity-check", doc_title="parity-check")
    except kb_parse.doc_blocks.DocError as e:
        print(json.dumps({"parse_document_error": e.code}))
        return 1
    print(json.dumps({"total": report["total"], "clause": report["clause"], "skipped": report["skipped"]}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
