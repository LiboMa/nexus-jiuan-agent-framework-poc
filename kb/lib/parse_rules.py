"""把「审批矩阵」格式的制度 .docx 解析成规则记录（JSON）。

用法:
    python3 -I parse_rules.py <in.docx> <out.json>

只用标准库；docx 来自外部，属不可信输入，请以 -I（隔离模式）运行。

适配的文档结构（以《财务事项审批及授权管理办法》V4.0 为样本）:
  - 「制度说明」段落之后、第一个章节标题之前的段落 → rule_type=general（制度说明（一）~（五）与图例）。
  - 章节标题形如「一、立项审批」（中文数字 + 顿号）。标题与表格之间、表格之后的段落 → 该章 chapter_note。
  - 每章一张矩阵表，表头第一列是「序号」，固定列：序号 / 业务事项 / 板块 / 金额档 / 触发情形 /
    适用范围与控制要点；其余列中出现过审批符号（①…⑩、√、▲、不适用）的是「角色列」，没出现过的是「说明列」
    （如第九章「发起与维护」），说明列的值进 extra 并拼进 content。
  - 纵向合并单元格（w:vMerge=continue）沿用上一行的值；横向合并（w:gridSpan）按网格列展开。
  - 一行 = 一条规则：rule_id = C<两位章号>-<序号>，例如 C05-3.2。

换一份结构不同的制度文档时，先跑本脚本看统计与 duplicate 行，再按 GUIDE.md「7.4 换文档」调整。

输出的最后一行是「REPORT <JSON>」（各类条数、各章行数、重复编号、缺审批路径的行），失败时也有。

退出码: 0 正常；2 参数错误；3 解析结果为空或有重复 rule_id（大概率是文档结构不匹配）。
"""
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
CHAPTER_RE = re.compile(r"^([一二三四五六七八九十]+)、(.+)$")
CN_NUM = {c: i for i, c in enumerate("一二三四五六七八九十", start=1)}
MARK_RE = re.compile(r"[①②③④⑤⑥⑦⑧⑨⑩]")
MARK_NUM = {c: i for i, c in enumerate("①②③④⑤⑥⑦⑧⑨⑩", start=1)}
FIXED_COLS = ("序号", "业务事项", "板块", "金额档 / 触发情形")
SCOPE_COL = "适用范围与控制要点"


def text_of(el):
    parts = []
    for p in el.iter(W + "p"):
        parts.append("".join(t.text or "" for t in p.iter(W + "t")))
    return "\n".join(s for s in (x.strip() for x in parts) if s)


def cn_chapter_no(s):
    if s in CN_NUM:
        return CN_NUM[s]
    if s.startswith("十") and len(s) == 2:
        return 10 + CN_NUM[s[1]]
    return None


def norm(s):
    return re.sub(r"[\s　]+", " ", s or "").strip()


def table_grid(tbl):
    """表格 → 行列表；每行是按网格列展开的 (文本, vMerge) 列表。"""
    rows = []
    for tr in tbl.findall(W + "tr"):
        row = []
        for tc in tr.findall(W + "tc"):
            pr = tc.find(W + "tcPr")
            span, vm = 1, None
            if pr is not None:
                gs = pr.find(W + "gridSpan")
                if gs is not None:
                    span = int(gs.get(W + "val", "1"))
                v = pr.find(W + "vMerge")
                if v is not None:
                    vm = v.get(W + "val", "continue")
            txt = text_of(tc)
            for k in range(span):
                row.append((txt if k == 0 else "", vm))
        rows.append(row)
    return rows


def blank(rule_id, rule_type, chapter_no, chapter, content, **kw):
    rec = {"rule_id": rule_id, "rule_type": rule_type, "chapter_no": chapter_no, "chapter": chapter,
           "chapter_note": "", "seq_no": "", "business_item": "", "segment": "", "amount_tier": "",
           "approval_path": [], "approval_path_text": "", "final_approver": "", "post_actions": "",
           "not_applicable": "", "scope_controls": "", "extra": {}, "content": content}
    rec.update(kw)
    return rec


def parse(src):
    with zipfile.ZipFile(src) as z:
        root = ET.fromstring(z.read("word/document.xml"))
    body = root.find(W + "body")

    general, records = [], []
    chapter, chapter_no, notes = None, None, []
    chapter_notes, chapter_titles = {}, {}
    in_preface = True
    for el in body:
        if el.tag == W + "p":
            t = norm(text_of(el))
            if not t:
                continue
            m = CHAPTER_RE.match(t)
            if m and cn_chapter_no(m.group(1)):
                chapter, chapter_no, notes = t, cn_chapter_no(m.group(1)), []
                chapter_notes[chapter_no], chapter_titles[chapter_no] = notes, chapter
                in_preface = False
                continue
            (general if in_preface else notes).append(t)
        elif el.tag == W + "tbl":
            grid = table_grid(el)
            if not grid or chapter is None:
                continue
            header = [norm(c[0]) for c in grid[0]]
            if not header or header[0] != "序号":
                continue
            prev = [""] * len(header)
            rows = []
            for row in grid[1:]:
                vals = []
                for j in range(len(header)):
                    txt, vm = row[j] if j < len(row) else ("", None)
                    vals.append(prev[j] if vm == "continue" else txt)
                prev = vals
                rows.append(dict(zip(header, vals)))
            others = [h for h in header if h and h not in FIXED_COLS and h != SCOPE_COL]
            roles = [h for h in others
                     if any(MARK_RE.search(r.get(h, "")) or "√" in r.get(h, "") or "▲" in r.get(h, "")
                            or norm(r.get(h, "")) == "不适用" for r in rows)]
            notes_cols = [h for h in others if h not in roles]
            for cell in rows:
                seq = norm(cell.get("序号", ""))
                if not seq:
                    continue
                path, post, excluded = [], [], []
                for r in roles:
                    v = norm(cell.get(r, ""))
                    if not v:
                        continue
                    if v == "不适用":
                        excluded.append(r)
                        continue
                    nums = [MARK_NUM[c] for c in MARK_RE.findall(v)]
                    if nums:
                        path.append({"step": min(nums), "role": r, "mark": v, "final": "√" in v})
                    elif "▲" in v:
                        post.append(r)
                    else:
                        path.append({"step": None, "role": r, "mark": v, "final": "√" in v})
                path.sort(key=lambda x: (x["step"] is None, x["step"] or 0))
                final = [p["role"] for p in path if p["final"]]
                path_text = " → ".join(f'{p["role"]}{p["mark"]}' for p in path)
                if post:
                    path_text += "；审批后办理/报备：" + "、".join(post) + "（▲）"
                item = norm(cell.get("业务事项", ""))
                seg = norm(cell.get("板块", ""))
                tier = norm(cell.get("金额档 / 触发情形", ""))
                scope = (cell.get(SCOPE_COL, "") or "").strip()
                extra = {h: norm(cell.get(h, "")) for h in notes_cols if norm(cell.get(h, ""))}
                if not path and tier == "不适用":
                    path_desc, final_desc = "该板块不适用此事项", "不适用"
                else:
                    path_desc, final_desc = path_text or "无", "、".join(final) or "未标注"
                content = (f"【{chapter}】{seq} {item}｜板块：{seg}｜金额档/触发情形：{tier}"
                           f"｜审批路径：{path_desc}"
                           f"｜最终审批：{final_desc}"
                           + (f"｜不适用：{'、'.join(excluded)}" if excluded else "")
                           + "".join(f"｜{h}：{v}" for h, v in extra.items())
                           + (f"｜适用范围与控制要点：{norm(scope)}" if scope else ""))
                records.append(blank(
                    f"C{chapter_no:02d}-{seq}", "matrix", chapter_no, chapter, content,
                    seq_no=seq, business_item=item, segment=seg, amount_tier=tier,
                    approval_path=path, approval_path_text=path_text, final_approver="、".join(final),
                    post_actions="、".join(post), not_applicable="、".join(excluded),
                    scope_controls=scope, extra=extra))

    # 制度说明（一）~（五）与图例 → general（跳过封面与修改记录；「图例说明」这个标题本身不成条）
    start = next((i for i, t in enumerate(general) if t == "制度说明"), None)
    gen = [t for t in (general[start + 1:] if start is not None else []) if t != "图例说明"]
    gen_records = [blank(f"G-{i:02d}", "general", 0, "制度说明 / 图例说明", f"【制度说明 / 图例说明】{t}",
                         seq_no=str(i), business_item=t.split("。")[0][:40])
                   for i, t in enumerate(gen, start=1)]

    note_records = []
    for no in sorted(chapter_notes):
        text = "\n".join(chapter_notes[no])
        for r in records:
            if r["chapter_no"] == no:
                r["chapter_note"] = text
        if text:
            note_records.append(blank(f"C{no:02d}-NOTE", "chapter_note", no, chapter_titles[no],
                                      f"【{chapter_titles[no]}】章节说明：{norm(text)}",
                                      chapter_note=text, business_item=chapter_titles[no]))
    return gen_records, note_records, records


def main(argv):
    if len(argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    gen_records, note_records, records = parse(argv[1])
    out = gen_records + note_records + records
    with open(argv[2], "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(f"general={len(gen_records)} chapter_notes={len(note_records)} matrix={len(records)} total={len(out)}")
    for no, ch in sorted({(r["chapter_no"], r["chapter"]) for r in records}):
        print(f"  {no:2d} {ch[:50]}  rows={sum(1 for r in records if r['chapter_no'] == no)}")
    ids = [r["rule_id"] for r in out]
    dup = sorted({i for i in ids if ids.count(i) > 1})
    no_path = [r["rule_id"] for r in records if not r["approval_path"] and r["amount_tier"] != "不适用"]
    print("duplicate rule_ids:", dup or "none")
    print("matrix rows without approval path (excluding 不适用):", no_path or "none")
    # 末行给程序读（「制度知识库」页的解析报告）；解析失败时也打，好让页面说清是哪里不对
    chapters = [{"no": no, "title": ch, "rows": sum(1 for r in records if r["chapter_no"] == no)}
                for no, ch in sorted({(r["chapter_no"], r["chapter"]) for r in records})]
    print("REPORT " + json.dumps({"general": len(gen_records), "chapter_notes": len(note_records), "matrix": len(records),
                                  "total": len(out), "chapters": chapters, "duplicates": dup, "without_path": no_path},
                                 ensure_ascii=False))
    if not records or dup:
        print("解析结果为空或有重复 rule_id：文档结构与解析器不匹配，见 GUIDE.md「7.4 换文档」", file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
