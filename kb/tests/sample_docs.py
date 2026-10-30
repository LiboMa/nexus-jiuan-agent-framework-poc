"""测试现生成的虚构文档（docx / xlsx / md / pdf），写进调用方给的路径（临时目录），不进仓库。

矩阵内容取自 make_sample_docx.CHAPTERS（与 sample-matrix.docx 同源），别的都是测试里现编的。
openpyxl、reportlab 只在这里用（生成夹具）；kb/lib 读文档只用标准库和 pdfplumber。
"""
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

import make_sample_docx

SML = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
RELS = "http://schemas.openxmlformats.org/package/2006/relationships"
MATRIX = make_sample_docx.CHAPTERS[:2]  # 一、立项审批；三、合同用印审批


def _zip(path, parts):
    path = Path(path)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, text in parts.items():
            z.writestr(name, text.encode("utf-8"))
    return path


def docx(path, body, styles=None):
    """body 里每项：("p", 文字[, 样式 ID]) 或 ("table", 表头, 行)（行里的 None = 与上一行纵向合并）。
    styles = {样式 ID: 样式名}，写进 word/styles.xml（例如 {"2": "标题 2"}）。"""
    xml = []
    for item in body:
        if item[0] == "table":
            xml.append(make_sample_docx.table(item[1], item[2]))
        elif len(item) > 2:
            xml.append(f'<w:p><w:pPr><w:pStyle w:val="{item[2]}"/></w:pPr>'
                       f'<w:r><w:t xml:space="preserve">{escape(item[1])}</w:t></w:r></w:p>')
        else:
            xml.append(make_sample_docx.para(item[1]))
    parts = {**make_sample_docx.PARTS,
             "word/document.xml": f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                                  f'<w:document {make_sample_docx.NS}><w:body>{"".join(xml)}</w:body></w:document>'}
    if styles:
        parts["word/styles.xml"] = (f'<w:styles {make_sample_docx.NS}>'
                                    + "".join(f'<w:style w:type="paragraph" w:styleId="{i}"><w:name w:val="{n}"/></w:style>'
                                              for i, n in styles.items())
                                    + '</w:styles>')
    return _zip(path, parts)


def xlsx(path, sheets):
    """照 Excel 的写法用标准库生成：字符串进 sharedStrings、数字写 <v>、rels 用相对路径（openpyxl 写的是内联字符串）。
    sheets = [(工作表名, 行, 合并区域)]；行里的 None 表示没有这个单元格；合并区域形如 "A2:A3"。"""
    strings, parts, sheet_xml, rel_xml = [], {}, [], []
    for n, (name, rows, merges) in enumerate(sheets, start=1):
        row_xml = []
        for r, row in enumerate(rows, start=1):
            cells = []
            for c, v in enumerate(row):
                ref = f"{chr(65 + c)}{r}"
                if v is None:
                    continue
                if isinstance(v, (int, float)):
                    cells.append(f'<c r="{ref}"><v>{v}</v></c>')
                else:
                    if v not in strings:
                        strings.append(v)
                    cells.append(f'<c r="{ref}" t="s"><v>{strings.index(v)}</v></c>')
            row_xml.append(f'<row r="{r}">{"".join(cells)}</row>')
        mc = (f'<mergeCells count="{len(merges)}">' + "".join(f'<mergeCell ref="{m}"/>' for m in merges)
              + '</mergeCells>') if merges else ""
        parts[f"xl/worksheets/sheet{n}.xml"] = f'<worksheet xmlns="{SML}"><sheetData>{"".join(row_xml)}</sheetData>{mc}</worksheet>'
        sheet_xml.append(f'<sheet name="{escape(name)}" sheetId="{n}" r:id="rId{n}"/>')
        rel_xml.append(f'<Relationship Id="rId{n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
                       f'relationships/worksheet" Target="worksheets/sheet{n}.xml"/>')
    parts["xl/workbook.xml"] = (f'<workbook xmlns="{SML}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/'
                                f'relationships"><sheets>{"".join(sheet_xml)}</sheets></workbook>')
    parts["xl/_rels/workbook.xml.rels"] = f'<Relationships xmlns="{RELS}">{"".join(rel_xml)}</Relationships>'
    parts["xl/sharedStrings.xml"] = (f'<sst xmlns="{SML}" count="{len(strings)}" uniqueCount="{len(strings)}">'
                                     + "".join(f"<si><t>{escape(s)}</t></si>" for s in strings) + "</sst>")
    return _zip(path, parts)


def matrix_xlsx(path, names=None):
    """docx 夹具前两章的矩阵，用 openpyxl 写成 xlsx：一章一个工作表，表名默认是章标题；
    纵向合并（行里的 None）写成合并区域。names 给了就按它命名，一个名字一章。"""
    import openpyxl
    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    for name, (title, _note, header, rows) in zip(names or [c[0] for c in MATRIX], MATRIX):
        ws = wb.create_sheet(name)
        ws.append(header)
        for row in rows:
            ws.append(["" if v is None else v for v in row])
        for j in range(len(header)):
            i = 0
            while i < len(rows):
                k = i
                while k + 1 < len(rows) and rows[k + 1][j] is None:
                    k += 1
                if k > i:  # 第 i 行起、到第 k 行的这一列合并（表头占第 1 行）
                    ws.merge_cells(start_row=i + 2, start_column=j + 1, end_row=k + 2, end_column=j + 1)
                i = k + 1
    wb.save(path)
    return Path(path)


def matrix_md(path):
    """docx 夹具前两章的矩阵写成 Markdown：「# 章标题」、章说明、管道表格（纵向合并的格照写上一行的值）。"""
    out = []
    for title, note, header, rows in MATRIX:
        out += [f"# {title}", "", note, "", "| " + " | ".join(header) + " |", "|" + " --- |" * len(header)]
        prev = [""] * len(header)
        for row in rows:
            prev = [p if v is None else v for v, p in zip(row, prev)]
            out.append("| " + " | ".join(prev) + " |")
        out.append("")
    Path(path).write_text("\n".join(out), encoding="utf-8")
    return Path(path)


def _canvas(path):
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.pdfgen import canvas
    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    return canvas.Canvas(str(path))


def pdf(path, pages):
    """pages 里每页是一串项：字符串是一行字，列表是一张带框线的表（行 × 列的字符串）。字体 STSong-Light。"""
    from reportlab.platypus import Table, TableStyle
    c = _canvas(path)
    for items in pages:
        y = 780
        for it in items:
            if isinstance(it, str):
                c.setFont("STSong-Light", 12)
                c.drawString(72, y, it)
                y -= 28
            else:
                t = Table(it)
                t.setStyle(TableStyle([("FONT", (0, 0), (-1, -1), "STSong-Light", 10),
                                       ("GRID", (0, 0), (-1, -1), 0.5, (0, 0, 0))]))
                _, h = t.wrapOn(c, 450, y)
                t.drawOn(c, 72, y - h)
                y -= h + 28
        c.showPage()
    c.save()
    return Path(path)


def scanned_pdf(path):
    """只有一个矩形、没有文字层的 PDF（像扫描件）。"""
    c = _canvas(path)
    c.rect(100, 100, 200, 200)
    c.showPage()
    c.save()
    return Path(path)


# ─────────────── 正文条款的夹具（clauses / kb_parse） ───────────────

def cn(n):
    """1..999 → 中文数字（十二、一百零五、九百九十九），给夹具编「第X条」。"""
    d = "零一二三四五六七八九"
    if n >= 100:
        h, r = divmod(n, 100)
        if r == 0:
            return d[h] + "百"
        return d[h] + "百" + ("零" + d[r] if r < 10 else d[r // 10] + "十" + (d[r % 10] if r % 10 else ""))
    if n >= 20:
        return d[n // 10] + "十" + (d[n % 10] if n % 10 else "")
    if n >= 10:
        return "十" + (d[n % 10] if n % 10 else "")
    return d[n]


def sentences(count, size=50):
    """count 句虚构的条文：每句正好 size 字（size ≤ 100）、以「。」结尾，句中没有别的句末标点（拆分测试按句末断开）。"""
    filler = "出差费用应当按照公司规定的标准据实报销并附原始票据经部门负责人审核后提交财务部门复核"
    return [(f"事项{k}的" + filler * 3)[: size - 1] + "。" for k in range(1, count + 1)]


def md(path, lines):
    """lines 逐行写成 UTF-8 的 Markdown（空字符串是空行）。"""
    Path(path).write_text("\n".join(lines) + "\n", encoding="utf-8")
    return Path(path)
