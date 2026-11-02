"""整份文档 → 规则记录与解析报告：审批矩阵（parse_rules）+ 其余文字的正文条款（clauses）。

    records, report = parse_document(path, source_tag="travel", doc_title="差旅管理办法")
    python3 -I kb_parse.py <文档> <制度标识> [<文档名>]     # 只打印末行 REPORT <JSON>（失败时 ERROR <JSON>）

- 认出了审批矩阵的文档：矩阵、制度说明、章节说明照 parse_rules（与它的输出逐条相同），矩阵没用掉的块交给 clauses。
- 没有矩阵的文档整份按正文条款解析（parse_rules 认的「X、」章在这里是「三、（二）→ S3.2」的编号）。
  parse_rules 认作矩阵的表（首格「序号」）里一张像矩阵的都没有（见 _looks_like_matrix），也算没有矩阵。
记录的字段是 approval_rules 除 embedding、source_*、record_sha256 之外的全部列（来源字段由入库那一步补）。

报告：{"parser_version", "format", "general", "chapter_notes", "matrix", "clause", "table_row", "paragraph", "total",
"chapters": [{"no", "title", "rows"}]（有矩阵时是矩阵各章的行数，同 parse_rules；没有时是正文各章的条数）,
"duplicates", "without_path", "split", "renumbered", "skipped": {"cover", "revision_tables"},
"tables": {"matrix", "other"}, "pages"（只有 PDF：每页读出的字数）, "warnings": [给人看的提醒]}。

读不了或结构不对时抛 doc_blocks.DocError(code, message)：doc_blocks.read 的各种错误码，外加
matrix_chapter_missing（审批矩阵表前面没有章标题）、duplicate_rule_ids、too_many_records（超过 MAX_RECORDS 条）、
empty_document（一条记录都没有）。表头首格是「序号」、但既没有矩阵的固定列也没有审批符号的表（多半是附表）、
以及修改记录表，不算「没有章的矩阵」。
"""
import json
import os
import re
import sys
from collections import Counter

if __package__:
    from . import clauses, doc_blocks, parse_rules
else:  # python -I kb/lib/kb_parse.py：-I 不把脚本所在目录放进 sys.path
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import clauses
    import doc_blocks
    import parse_rules

PARSER_VERSION = "1"
MAX_RECORDS = 2000
PDF_MATRIX_WARNING = "PDF 的合并单元格常读不全，审批矩阵请用 Word / Excel"
CHAPTER_TITLE_RE = re.compile(r"^第\s*\S+?\s*章")


def _looks_like_matrix(table):
    """首列「序号」之外，还有矩阵的固定列或审批符号（①…⑩、√、▲）。"""
    grid = table["cells"]
    header = {parse_rules.norm(c[0]) for c in grid[0]}
    if header & {*parse_rules.FIXED_COLS[1:], parse_rules.SCOPE_COL}:
        return True
    return any(parse_rules.MARK_RE.search(c[0]) or "√" in c[0] or "▲" in c[0] for row in grid[1:] for c in row)


def _chapters(matrix, clause_recs):
    if matrix:
        return [{"no": no, "title": ch, "rows": sum(1 for r in matrix if r["chapter_no"] == no)}
                for no, ch in sorted({(r["chapter_no"], r["chapter"]) for r in matrix})]
    rows = Counter()
    for r in clause_recs:
        if r["chapter_no"] is not None:
            title = next((p for p in r["chapter"].split(" › ") if CHAPTER_TITLE_RE.match(p)), "")
            rows[(r["chapter_no"], title)] += 1
    return [{"no": no, "title": title, "rows": n} for (no, title), n in sorted(rows.items())]


def parse_document(path, *, source_tag, doc_title):
    """读文档 → (records, report)；records 依次是制度说明、章节说明、矩阵行、正文条款。"""
    blocks, info = doc_blocks.read(path)
    m = parse_rules.parse_blocks(blocks)
    revision, _ = clauses.revision_tables(blocks)
    orphans = [i for i in m.orphans if i not in revision and _looks_like_matrix(blocks[i])]
    if orphans:
        raise doc_blocks.DocError("matrix_chapter_missing",
                                  f"有 {len(orphans)} 张审批矩阵表前面没有章标题；请在表前加上形如「一、立项审批」的章标题"
                                  "（Excel 可把工作表改名为章标题）再上传")
    matrix_tables = [i for i in sorted(m.used) if blocks[i]["kind"] == "table"]
    if not any(_looks_like_matrix(blocks[i]) for i in matrix_tables):
        matrix_tables = []  # 「一、住宿标准」下只有「序号 | 城市 | 标准」这种附表：不是矩阵文档
    if matrix_tables:
        general, notes, matrix, skip = m.general, m.notes, m.matrix, m.used
    else:
        general, notes, matrix, skip = [], [], [], set()
    clause_recs, part = clauses.clause_records(blocks, skip, source_tag=source_tag, doc_title=doc_title)
    records = general + notes + matrix + clause_recs
    if not records:
        raise doc_blocks.DocError("empty_document", "文档里除了封面和修改记录，没有可入库的内容")
    counts = Counter(r["rule_id"] for r in records)
    dup = sorted(k for k, n in counts.items() if n > 1)
    if dup:
        raise doc_blocks.DocError("duplicate_rule_ids", f"编号重复：{'、'.join(dup[:10])}" + ("等" if len(dup) > 10 else "")
                                  + "；同一章的矩阵里序号不能重复")
    if len(records) > MAX_RECORDS:
        raise doc_blocks.DocError("too_many_records", f"解析出 {len(records)} 条，超过一份文档 {MAX_RECORDS} 条的上限；请拆成几份上传")

    warnings = []
    if info["format"] == "pdf" and matrix_tables:
        warnings.append(PDF_MATRIX_WARNING)
    blank_pages = [p["page"] for p in info.get("pages", []) if not p["chars"]]
    if blank_pages:
        warnings.append(f"PDF 第 {'、'.join(map(str, blank_pages))} 页读不出文字（可能是扫描页），这些页没有入库")
    if part["empty_or_garbled"]:
        warnings.append(f"{len(part['empty_or_garbled'])} 个块是空的或疑似乱码，没有入库（块号 "
                        f"{'、'.join(map(str, part['empty_or_garbled'][:20]))}）")
    n_tables = sum(1 for b in blocks if b["kind"] == "table")
    report = {
        "parser_version": PARSER_VERSION, "format": info["format"],
        "general": len(general), "chapter_notes": len(notes), "matrix": len(matrix),
        "clause": part["clause"], "table_row": part["table_row"], "paragraph": part["paragraph"], "total": len(records),
        "chapters": _chapters(matrix, clause_recs), "duplicates": dup,
        "without_path": [r["rule_id"] for r in matrix if not r["approval_path"] and r["amount_tier"] != "不适用"],
        "split": part["split"], "renumbered": part["renumbered"], "skipped": part["skipped"],
        "tables": {"matrix": len(matrix_tables), "other": n_tables - len(matrix_tables)},
    }
    if "pages" in info:
        report["pages"] = info["pages"]
    report["warnings"] = warnings
    return records, report


def main(argv):
    if len(argv) not in (3, 4):
        print(__doc__, file=sys.stderr)
        return 2
    title = argv[3] if len(argv) == 4 else os.path.basename(argv[1])
    try:
        _, report = parse_document(argv[1], source_tag=argv[2], doc_title=title)
    except doc_blocks.DocError as e:
        print("ERROR " + json.dumps({"code": e.code, "message": e.message}, ensure_ascii=False))
        return 3
    print("REPORT " + json.dumps(report, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
