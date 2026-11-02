"""docx / xlsx / pdf / md → 按原文顺序的块（标题、段落、表格），给 parse_rules（矩阵）和正文条款共用。

    blocks, info = read(path)

块：{"i": 块号, "kind": "para" | "heading" | "table", "text", "level", "cells", "loc"}
  - para / heading：text 已 norm()；heading 的 level 是 1..9，para 的是 None；cells 是 None。
  - table：text 是 ""；cells[r][c] = [文字, vmerge]，vmerge ∈ None / "restart" / "continue"，与 Word 的
    w:vMerge 同义：纵向合并的后续格是 ["", "continue"]；横向合并按网格列展开，后面的格是空字符串（同 w:gridSpan）。
  - loc：xlsx {"sheet"}，pdf {"page"}，md {"line"}（从 1 起），docx {}。
  - 没有文字的段落、没有行的表不出块。
info：{"format": "docx" | "xlsx" | "pdf" | "md"}，pdf 另有 "pages": [{"page", "chars"}]（chars = 读出的非空白字数），
xlsx 另有 "sheets": [全部工作表名]。

格式按内容判断，不只看扩展名：zip 里有 word/document.xml 是 docx、有 xl/workbook.xml 是 xlsx；%PDF- 开头是 pdf；
.md / .markdown 按 UTF-8 读（去 BOM）。.doc / .xls、OLE 容器（老格式或加了密码的 Office 文件）、坏 zip 都报 unsupported_format。

只用标准库；PDF 用 pdfplumber（只在读 PDF 时 import，不做 OCR）。文件来自外部，属不可信输入。
读不了时抛 DocError(code, message)，code 见 DocError。
"""
import os
import posixpath
import re
import zipfile
import zlib
import xml.etree.ElementTree as ET

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
SML = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
PKG_REL = "{http://schemas.openxmlformats.org/package/2006/relationships}"
DOC_REL_ID = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
MAX_BYTES = 50 * 1024 * 1024        # 文件本身
MAX_PART_BYTES = 200 * 1024 * 1024  # zip 里单个 XML 解压后
MAX_SHEET_CELLS = 1_000_000         # 一个工作表展开成二维表后的格数
HEADING_STYLE = re.compile(r"^(?:heading|标题)\s*([1-9])$", re.I)
MD_HEADING = re.compile(r"^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$")
MD_DELIM = re.compile(r"^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$")
MD_PIPE = re.compile(r"(?<!\\)\|")
CELL_REF = re.compile(r"^([A-Z]+)(\d+)$")


class DocError(Exception):
    """读不了的文档。code：unsupported_format、empty_document、no_text_layer、encoding_unsupported、
    pdf_parser_unavailable、file_too_large；message 给人看（不含文档内容）。"""

    def __init__(self, code, message):
        super().__init__(f"{code}: {message}")
        self.code, self.message = code, message


# ─────────────── docx（text_of / table_grid / norm 从 parse_rules.py 挪来） ───────────────

def text_of(el):
    parts = []
    for p in el.iter(W + "p"):
        parts.append("".join(t.text or "" for t in p.iter(W + "t")))
    return "\n".join(s for s in (x.strip() for x in parts) if s)


def norm(s):
    return re.sub(r"[\s　]+", " ", s or "").strip()


def table_grid(tbl):
    """表格 → 行列表；每行是按网格列展开的 [文本, vMerge] 列表。"""
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
                row.append([txt if k == 0 else "", vm])
        rows.append(row)
    return rows


def _add(blocks, kind, text="", level=None, cells=None, **loc):
    blocks.append({"i": len(blocks), "kind": kind, "text": text, "level": level, "cells": cells, "loc": loc})


def _zread(z, name):
    if z.getinfo(name).file_size > MAX_PART_BYTES:
        raise DocError("file_too_large", f"文档里的 {name} 解压后超过 {MAX_PART_BYTES // 2**20} MB")
    return z.read(name)


def _read_docx(z):
    """只认 w:body 的直接子元素 w:p / w:tbl（与重构前的 parse_rules 相同）；标题样式（Heading1..9、标题 1..9，
    样式 ID 或 styles.xml 里的样式名）的段落是 heading。"""
    names = {}
    if "word/styles.xml" in z.namelist():
        for st in ET.fromstring(_zread(z, "word/styles.xml")).iter(W + "style"):
            n = st.find(W + "name")
            names[st.get(W + "styleId")] = n.get(W + "val", "") if n is not None else ""
    body = ET.fromstring(_zread(z, "word/document.xml")).find(W + "body")
    blocks = []
    for el in body if body is not None else ():
        if el.tag == W + "p":
            t = norm(text_of(el))
            if not t:
                continue
            ps = el.find(f"{W}pPr/{W}pStyle")
            sid = ps.get(W + "val", "") if ps is not None else ""
            m = HEADING_STYLE.match(sid) or HEADING_STYLE.match(names.get(sid, ""))
            _add(blocks, "heading" if m else "para", t, int(m.group(1)) if m else None)
        elif el.tag == W + "tbl":
            grid = table_grid(el)
            if grid:
                _add(blocks, "table", cells=grid)
    return blocks, {"format": "docx"}


# ─────────────── xlsx（标准库 zipfile + ElementTree） ───────────────

def _cell_text(s):
    """单元格文字：逐行去首尾空白、去空行（同 text_of 对多段落单元格的处理）。"""
    return "\n".join(x for x in (y.strip() for y in (s or "").splitlines()) if x)


def _si_text(si):
    """共享字符串 / 内联字符串：直接的 <t> 与富文本 <r><t>，跳过注音 <rPh>。"""
    out = []
    for ch in si:
        if ch.tag == SML + "t":
            out.append(ch.text or "")
        elif ch.tag == SML + "r":
            out.extend(t.text or "" for t in ch.iter(SML + "t"))
    return "".join(out)


def _xlsx_value(c, sst):
    t = c.get("t", "n")
    if t == "inlineStr":
        node = c.find(SML + "is")
        return _cell_text(_si_text(node)) if node is not None else ""
    v = c.find(SML + "v")
    v = (v.text or "") if v is not None else ""
    if t == "s":
        return _cell_text(sst[int(v)]) if v.isdigit() and int(v) < len(sst) else ""
    if t == "b":
        return {"1": "TRUE", "0": "FALSE"}.get(v, v)
    if t == "n" and re.fullmatch(r"-?\d+\.0*", v):  # 整数不带 .0
        return v.split(".")[0]
    return _cell_text(v)


def _ref(ref):
    m = CELL_REF.match(ref or "")
    if not m:
        return None
    col = 0
    for ch in m.group(1):
        col = col * 26 + ord(ch) - 64
    return int(m.group(2)), col


def _sheet_grid(ws, sst):
    """工作表 → 二维表（范围 = 有字的格的外框；全空的行去掉）。合并区域：跨行的，首行各格 restart、
    后续各行 ["", "continue"]；只跨列的，首格之后是空字符串（同 Word）。"""
    vals, rn = {}, 0
    for row in ws.iter(SML + "row"):
        rn = int(row.get("r") or rn + 1)
        cn = 0
        for c in row.findall(SML + "c"):
            rc = _ref(c.get("r"))
            rn, cn = rc if rc else (rn, cn + 1)
            v = _xlsx_value(c, sst)
            if v:
                vals[(rn, cn)] = v
    if not vals:
        return []
    top, bottom = min(r for r, _ in vals), max(r for r, _ in vals)
    left, right = min(c for _, c in vals), max(c for _, c in vals)
    if (bottom - top + 1) * (right - left + 1) > MAX_SHEET_CELLS:
        raise DocError("file_too_large", f"工作表展开后超过 {MAX_SHEET_CELLS} 格")
    grid = {(r, c): [vals.get((r, c), ""), None] for r in range(top, bottom + 1) for c in range(left, right + 1)}
    for mc in ws.iter(SML + "mergeCell"):
        ends = [_ref(x) for x in (mc.get("ref") or "").split(":")]
        if len(ends) != 2 or None in ends:
            continue
        (r1, c1), (r2, c2) = ends
        for r in range(max(r1, top), min(r2, bottom) + 1):
            for c in range(max(c1, left), min(c2, right) + 1):
                if r > r1:
                    grid[(r, c)] = ["", "continue"]
                else:
                    grid[(r, c)] = [grid[(r, c)][0] if c == c1 else "", "restart" if r2 > r1 else None]
    rows = [[grid[(r, c)] for c in range(left, right + 1)] for r in range(top, bottom + 1)]
    return [row for row in rows if any(cell != ["", None] for cell in row)]


def _read_xlsx(z):
    """每个工作表：先一个 heading（level 1，文字 = 工作表名），再一张表；没有字的工作表不出块。"""
    names = set(z.namelist())
    rels = {}
    if "xl/_rels/workbook.xml.rels" in names:
        for rel in ET.fromstring(_zread(z, "xl/_rels/workbook.xml.rels")).iter(PKG_REL + "Relationship"):
            rels[rel.get("Id")] = rel.get("Target", "")
    sst = []
    if "xl/sharedStrings.xml" in names:
        sst = [_si_text(si) for si in ET.fromstring(_zread(z, "xl/sharedStrings.xml")).iter(SML + "si")]
    blocks, sheets = [], []
    for sh in ET.fromstring(_zread(z, "xl/workbook.xml")).iter(SML + "sheet"):
        name = sh.get("name", "")
        sheets.append(name)
        target = rels.get(sh.get(DOC_REL_ID), "")
        part = target.lstrip("/") if target.startswith("/") else posixpath.normpath("xl/" + target)
        if not target or part not in names:
            continue
        rows = _sheet_grid(ET.fromstring(_zread(z, part)), sst)
        if rows:
            _add(blocks, "heading", norm(name), 1, sheet=name)
            _add(blocks, "table", cells=rows, sheet=name)
    return blocks, {"format": "xlsx", "sheets": sheets}


# ─────────────── md ───────────────

def _md_row(line):
    s = line.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|") and not s.endswith("\\|"):
        s = s[:-1]
    return [[_cell_text(c.replace("\\|", "|")), None] for c in MD_PIPE.split(s)]


def _read_md(path):
    """# 的个数是标题级别；管道表格（表头 + 对齐行 + 行）跳过对齐行，\\| 是字面的竖线；别的非空行一行一段。"""
    with open(path, "rb") as f:
        raw = f.read()
    try:
        lines = raw.decode("utf-8-sig").splitlines()
    except UnicodeDecodeError:
        raise DocError("encoding_unsupported", "Markdown 只收 UTF-8 编码；请另存为 UTF-8 再上传") from None
    blocks, k = [], 0
    while k < len(lines):
        line = lines[k]
        m = MD_HEADING.match(line)
        if m:
            if norm(m.group(2)):
                _add(blocks, "heading", norm(m.group(2)), len(m.group(1)), line=k + 1)
            k += 1
        elif (MD_PIPE.search(line) and k + 1 < len(lines) and "|" in lines[k + 1]
              and MD_DELIM.match(lines[k + 1])):
            start, rows, k = k, [_md_row(line)], k + 2
            while k < len(lines) and lines[k].strip() and MD_PIPE.search(lines[k]):
                rows.append(_md_row(lines[k]))
                k += 1
            _add(blocks, "table", cells=rows, line=start + 1)
        else:
            if norm(line):
                _add(blocks, "para", norm(line), line=k + 1)
            k += 1
    return blocks, {"format": "md"}


# ─────────────── pdf（pdfplumber） ───────────────

def _read_pdf(path):
    """按页：表格（有框线的）出 table，表格外的文字一行一段，页内按上下位置排。一页文字都读不出 → no_text_layer。"""
    try:
        import pdfplumber
    except ImportError:
        raise DocError("pdf_parser_unavailable", "运行环境里没有 pdfplumber，读不了 PDF；请改传 Word / Excel") from None
    try:
        pdf = pdfplumber.open(path)
    except Exception:  # pdfminer 的各种异常：文件损坏、加了密码
        raise DocError("unsupported_format", "PDF 打不开（文件损坏或加了密码）") from None
    blocks, pages = [], []
    with pdf:
        for n, page in enumerate(pdf.pages, start=1):
            pages.append({"page": n, "chars": sum(not ch.isspace() for ch in page.extract_text() or "")})
            tables = page.find_tables()
            boxes = [t.bbox for t in tables]

            def outside(obj, boxes=boxes):
                cx, cy = (obj["x0"] + obj["x1"]) / 2, (obj["top"] + obj["bottom"]) / 2
                return not any(x0 <= cx < x1 and top <= cy < bottom for x0, top, x1, bottom in boxes)

            items = [(t.bbox[1], "table", t.extract()) for t in tables]
            items += [(ln["top"], "para", ln["text"]) for ln in (page.filter(outside) if boxes else page).extract_text_lines()]
            for _, kind, x in sorted(items, key=lambda it: it[0]):
                if kind == "para" and norm(x):
                    _add(blocks, "para", norm(x), page=n)
                elif kind == "table" and x:
                    _add(blocks, "table", cells=[[[_cell_text(c), None] for c in row] for row in x], page=n)
    if not any(p["chars"] for p in pages):
        raise DocError("no_text_layer", "PDF 里读不出文字（扫描件或图片）；不做 OCR，请改传 Word / Excel 或带文字层的 PDF")
    return blocks, {"format": "pdf", "pages": pages}


# ─────────────── 入口 ───────────────

def _sniff(path):
    size = os.path.getsize(path)
    if size == 0:
        raise DocError("empty_document", "文件是空的（0 字节）")
    if size > MAX_BYTES:
        raise DocError("file_too_large", f"文件超过 {MAX_BYTES // 2**20} MB")
    ext = os.path.splitext(path)[1].lower()
    with open(path, "rb") as f:
        head = f.read(8)
    if ext in (".doc", ".xls") or head.startswith(b"\xd0\xcf\x11\xe0"):
        raise DocError("unsupported_format", "这是 .doc / .xls 老格式或加了密码的 Office 文件；请去掉密码、另存为 .docx / .xlsx 再上传")
    if head.startswith(b"%PDF-"):
        return "pdf"
    if head.startswith(b"PK"):
        try:
            with zipfile.ZipFile(path) as z:
                names = set(z.namelist())
                encrypted = any(i.flag_bits & 0x1 for i in z.infolist())
        except zipfile.BadZipFile:
            raise DocError("unsupported_format", "文件已损坏（不是完整的 zip），读不出内容") from None
        if encrypted:
            raise DocError("unsupported_format", "文件加了密码；请去掉密码、另存后再上传")
        if "word/document.xml" in names:
            return "docx"
        if "xl/workbook.xml" in names:
            return "xlsx"
        raise DocError("unsupported_format", "压缩包里既没有 Word 正文也没有 Excel 工作簿；只收 .docx / .xlsx / .pdf / .md")
    if ext in (".md", ".markdown"):
        return "md"
    raise DocError("unsupported_format", "只收 .docx / .xlsx / .pdf / .md")


def read(path):
    """读文档 → (blocks, info)；读不了、或一个块都读不出时抛 DocError。"""
    path = os.fspath(path)
    fmt = _sniff(path)
    if fmt == "pdf":
        blocks, info = _read_pdf(path)
    elif fmt == "md":
        blocks, info = _read_md(path)
    else:
        try:
            with zipfile.ZipFile(path) as z:
                blocks, info = (_read_docx if fmt == "docx" else _read_xlsx)(z)
        except (ET.ParseError, KeyError, ValueError, NotImplementedError, zipfile.BadZipFile, zlib.error, EOFError):
            raise DocError("unsupported_format", "文件已损坏（内部 XML 读不出），请用 Word / Excel 打开后另存再上传") from None
    if not blocks:
        raise DocError("empty_document", "文档里读不出文字")
    return blocks, info
