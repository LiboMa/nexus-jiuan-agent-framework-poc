"""块 → 正文条款记录（rule_type=clause）：审批矩阵之外的条款、编号项、标题下的正文、没编号的段落、非矩阵表格的行。

    records, part = clause_records(blocks, skip, source_tag="travel", doc_title="差旅管理办法")

blocks 是 doc_blocks.read() 的块；skip 是审批矩阵用掉的块号（parse_rules.parse_blocks 的 used）：这些块不出条款，
其中的章标题（「一、立项审批」）只用来给后面的非矩阵表格定章。记录的字段与矩阵记录相同（parse_rules.blank），
rule_type=clause，编号是「<source_tag>-<条号>」：

  第十二条 → A12                        章、节下第一条之前的正文 → CH3、CH3.2
  三、（二） → S3.2；只有 三、 → S3       1.2.3 / 1. → N1.2.3 / N1
  （1）（一）① 是小项，跟着上一级走；文档开头就是小项时按 N1 编
  标题下的正文 → H<各级序号>（H2.3）    没有任何编号的段落 → P001…（合并到 ≤ 400 字）
  非矩阵表格每行一条 → T<表序号>.<行号>，文字「表头：值；…」
  超过 600 字在 。！？； 处拆成 -a、-b…；同一文档里编号重复，第二个起加 ~2、~3

一条一块：「第X条」到下一个同级或更高级的标记（条、节、章、标题）为止，条下的「一、」「（一）」「1.」都跟着这一条。
只有标题的「三、费用范围」「1. 总则」后面紧跟着下级（或一张表）时不成条，标题进下级的路径（chapter）。
Markdown / PDF 一行一个块：同一段的折行（Markdown 相邻的行；PDF 上一行没到句末）接起来，中文之间不加空格；
Word 一段一个块，段与段之间换行。

字段：chapter =「章 › 节」（标题路径）；chapter_no = 第X章的章号（没有就是 None）；seq_no = 条号；
business_item = 条标题（≤ 20 字、在第一个 ：/。/空格之前，或【】里的），没有就取首句（≤ 40 字）；
scope_controls = 条文（含跟着走的小项）；content =「文档名 › 章 › 节 › 第X条：条文」（只写存在的层级）；
extra = {"kind": clause | table_row | paragraph, "page"?, "sheet"?, "row"?, "part"?}。

不入库（只计数）：
  - 封面：从文档开头起连续的短段落：没有条款标记、没有句末标点（。！？；）、括号外没有「，」，并且 ≤ 40 字，
    或是 Word 文本框那种几行拼成的一段（≤ 120 字、空白分开的每一截都 ≤ 40 字）。遇到有标记或长的段落、标题、
    矩阵用掉的块、不是修改记录的表就停；PDF 只看第 1 页。Markdown 相邻的行是同一段，整段一起判断；
    PDF 的一行若和下一行（不像封面的）是同一段的折行，它就是正文的开头，封面到此为止；
  - 修改记录表：首行或紧挨着的前一个短段落含「修改记录 / 修订记录 / 版本记录」（那个短段落也不入库，不算封面；
    有条款标记的段落不当标题，例如「第二条 本办法修改记录见下表。」照常成条）；
  - 空的或疑似乱码的块、PDF 的页码行：块号写进 empty_or_garbled。
"""
import os
import re
import sys
from collections import namedtuple

if __package__:
    from . import parse_rules
else:  # python -I kb/lib/clauses.py：-I 不把脚本所在目录放进 sys.path
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import parse_rules

norm = parse_rules.norm

CLAUSE_MAX = 600       # 一块超过就按句子拆成 -a、-b…
PROSE_MAX = 400        # 没编号的段落合并到这么长
COVER_MAX = 40         # 封面的短段落
COVER_BLOCK_MAX = 120  # 封面上几行拼成的一段（Word 文本框）
TITLE_MAX = 20         # 条标题
ITEM_MAX = 40          # business_item
SENTENCE_END = "。！？；"
TERMINAL = tuple("。！？；：…")  # PDF：上一行以这些结尾就是一段的末尾

CN = "零〇一二两三四五六七八九十百"
EM = r"(?:\*\*|__)?"  # Markdown 粗体包着的标记：**第一条**
STRUCT_RE = re.compile(rf"^{EM}第\s*([{CN}\d]+)\s*([章节条])\s*{EM}")
S1_RE = re.compile(rf"^{EM}([{CN}]+)\s*[、．]\s*{EM}")
S2_RE = re.compile(rf"^{EM}[（(]\s*([{CN}]+)\s*[)）]\s*{EM}")
SMALL_RE = re.compile(rf"^{EM}(?:[（(]\s*(\d{{1,3}})\s*[)）]|(\d{{1,3}})[)）])\s*{EM}")
CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳"
CIRCLED_RE = re.compile(rf"^([{CIRCLED}])\s*")
N_MULTI_RE = re.compile(rf"^{EM}([1-9]\d{{0,2}}(?:[.．]\d{{1,3}})+)[.．]?(?![\d.．])\s*{EM}")
N_ONE_RE = re.compile(rf"^{EM}([1-9]\d{{0,2}})[.．、](?![\d.．])\s*{EM}")
PSEUDO_RE = re.compile(rf"^{EM}(?:总则|附则|分则|罚则){EM}$")  # 单独一行的「总则」「附则」当章看
LIST_RE = re.compile(r"^[-*+]\s")  # Markdown 的列表项
# 「第三条的规定」「第三条第二款」「第三条至第五条」是引用，不是标记
REFERENCE = ("的", "之", "所", "中", "至", "到", "和", "及", "或", "与", "、", "，", ",", "；", "规定", "第", "项", "款")
UNITS = tuple("万元亿千百%％倍天日月年个人次份号岁米")  # 「1.5 万元」不是编号
REVISION_RE = re.compile("修改记录|修订记录|版本记录")
PAGE_NO_RE = re.compile(r"^(?:[-—–_~·\s]*\d{1,4}[-—–_~·\s]*|第\s*\d{1,4}\s*页(?:\s*[/，,]?\s*共\s*\d{1,4}\s*页)?"
                        r"|\d{1,4}\s*/\s*\d{1,4}|page\s*\d{1,4}(?:\s*of\s*\d{1,4})?)$", re.I)
CID_RE = re.compile(r"\(cid:\d+\)")  # pdfminer 认不出的字形
CN_DIGIT = {"零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
CN_NUM_RE = re.compile(r"^(?:([一二两三四五六七八九])百)?(?:零?([一二两三四五六七八九])?(十))?零?([一二三四五六七八九])?$")
S1_RANK, N_RANK = 20.0, 30.0  # 路径栈里「X、」与多级编号的位置：低于一切章、节、标题

Marker = namedtuple("Marker", "kind num end label small")  # small：小项的种类（同种的下一项另起一块）


def cn_int(s):
    """「十二」「一百零五」「九百九十九」「两百」「一〇五」「12」「１２」→ 整数；认不出或是 0 → None。中文数字认到 999。"""
    s = (s or "").strip()
    if s.isdecimal():
        return int(s) or None
    if len(s) > 1 and "〇" in s and all(c in CN_DIGIT for c in s):  # 逐位写的「一〇五」
        n = int("".join(str(CN_DIGIT[c]) for c in s))
        return n if 0 < n <= 999 else None
    m = CN_NUM_RE.match(s)
    if not s or not m:
        return None
    h, t, ten, u = m.groups()
    n = (CN_DIGIT[h] * 100 if h else 0) + ((CN_DIGIT[t] if t else 1) * 10 if ten else 0) + (CN_DIGIT[u] if u else 0)
    return n or None


def marker(text):
    """段首的条款标记 → Marker；没有 → None。end 是条文开始的位置（标记后的空白、冒号已跳过）。"""
    m = STRUCT_RE.match(text)
    if m:
        tail = text[m.end(2):].lstrip("*_")
        n = cn_int(m.group(1))
        if n is None or (tail and not tail[0].isspace() and tail.startswith(REFERENCE)):
            return None
        end = m.end()
        while end < len(text) and text[end] in "：: ":
            end += 1
        return Marker({"章": "chapter", "节": "section", "条": "article"}[m.group(2)], n, end,
                      f"第{m.group(1)}{m.group(2)}", None)
    for regex, kind, small in ((S2_RE, "s2", "cn"), (SMALL_RE, "small", "paren"), (CIRCLED_RE, "small", "circled"),
                               (S1_RE, "s1", None)):
        m = regex.match(text)
        if m:
            raw = next(g for g in m.groups() if g)
            n = CIRCLED.index(raw) + 1 if small == "circled" else cn_int(raw)
            if n:
                return Marker(kind, n, m.end(), _clean(m.group(0)), small)
    m = N_MULTI_RE.match(text)
    if m and not text[m.end():].startswith(UNITS):
        return Marker("n", ".".join(str(int(x)) for x in re.split("[.．]", m.group(1))), m.end(), _clean(m.group(0)), None)
    m = N_ONE_RE.match(text)
    if m:
        return Marker("n", str(int(m.group(1))), m.end(), _clean(m.group(0)), None)
    return None


def _clean(t):
    return re.sub(r"\*\*|__", "", t).strip()


def _first_sentence(text):
    return re.split(r"[。！？；\n]", text.strip(), maxsplit=1)[0].strip()[:ITEM_MAX]


def _title(rest):
    """条标题：【】里的，或第一个 ：/。/空格 之前 ≤ 20 字的；都没有就取首句（≤ 40 字）。"""
    s = rest.strip()
    m = re.match(rf"^[【\[]([^】\]\n]{{1,{TITLE_MAX}}})[】\]]", s)
    if m:
        return m.group(1).strip()
    m = re.match(rf"^([^：:。\s]{{1,{TITLE_MAX}}})[：:。\s]", s)
    return m.group(1) if m else _first_sentence(s)


def _head(text, mk):
    """路径里的「三、费用范围」「1. 总则」：标记 + 条标题。"""
    return _clean(text[:mk.end] + _title(text[mk.end:]))


def _split(text, limit):
    """按句末（。！？；）拆成每段 ≤ limit 字；一句就超过 limit 的在 limit 处硬断。"""
    out, text = [], text.strip()
    while len(text) > limit:
        cut = max(text.rfind(c, 0, limit) for c in SENTENCE_END) + 1
        cut = cut if cut > 0 else limit
        out.append(text[:cut].rstrip())
        text = text[cut:].lstrip()
    return out + [text] if text else out


def _part(k):
    """第 k 段（从 0 起）→ a、b…z、aa、ab…"""
    s, k = "", k + 1
    while k:
        k, r = divmod(k - 1, 26)
        s = chr(97 + r) + s
    return s


def _cjk(ch):
    o = ord(ch)
    return 0x2e80 <= o <= 0x9fff or 0xf900 <= o <= 0xfaff or 0xff00 <= o <= 0xffef or 0x3000 <= o <= 0x303f


def _sep(a, b):
    """块 a 与紧跟着的块 b 之间：同一段的折行 → ""（挨着中文）或 " "；另起一段 → "\\n"。"""
    if marker(b["text"]) or LIST_RE.match(b["text"]):
        return "\n"
    la, lb = a["loc"], b["loc"]
    if "line" in la and "line" in lb:      # Markdown：相邻的行是同一段
        soft = lb["line"] == la["line"] + 1
    elif "page" in la and "page" in lb:    # PDF：上一行没到句末
        soft = not a["text"].endswith(TERMINAL)
    else:                                  # Word：一段一个块
        soft = False
    if not soft:
        return "\n"
    return "" if _cjk(a["text"][-1]) or _cjk(b["text"][0]) else " "


def _join(blocks, cut=0):
    """块 → 条文；第一个块从 cut 起（去掉「第X条」）。"""
    out, prev = "", None
    for b in blocks:
        t = (b["text"][cut:] if prev is None else b["text"]).strip()
        if prev is not None and out and t:
            out += _sep(prev, b)
        out += t
        prev = b
    return out.strip()


def _empty_or_garbled(b):
    if b["kind"] == "table":
        t = "".join(c[0] or "" for row in b["cells"] or [] for c in row)
    else:
        t = b["text"] or ""
        if "page" in b["loc"] and PAGE_NO_RE.match(t.strip()):
            return True
    s = CID_RE.sub("\ufffd", "".join(t.split()))
    if not s:
        return True
    bad = sum(1 for ch in s if ch == "\ufffd" or "\ue000" <= ch <= "\uf8ff" or ord(ch) < 32 or 0x7f <= ord(ch) < 0xa0)
    return bad * 10 > len(s) * 3


def revision_tables(blocks, skip=()):
    """修改记录表的块号，与紧挨在表前、写着「修改记录」之类的短段落的块号 → (表, 段落)。"""
    tables, titles = set(), set()
    for k, b in enumerate(blocks):
        if b["kind"] != "table" or b["i"] in skip or not b["cells"]:
            continue
        prev = blocks[k - 1] if k else None
        titled = bool(prev and prev["kind"] != "table" and prev["i"] not in skip and len(prev["text"]) <= COVER_MAX
                      and REVISION_RE.search(prev["text"]) and not marker(prev["text"]))
        if titled or any(REVISION_RE.search(c[0] or "") for c in b["cells"][0]):
            tables.add(b["i"])
            if titled:
                titles.add(prev["i"])
    return tables, titles


def _cover_like(t):
    if marker(t) or PSEUDO_RE.match(t) or any(c in t for c in SENTENCE_END):
        return False
    bare = re.sub(r"（[^）]*）|\([^)]*\)", "", t)
    if "，" in bare or bare.endswith("、"):
        return False
    return len(t) <= COVER_MAX or (len(t) <= COVER_BLOCK_MAX and max(len(s) for s in t.split()) <= COVER_MAX)


def _wraps(a, b, skip):
    """b 是 a 那一段的折行（Markdown 相邻的行；PDF 上一行没到句末）。"""
    return b["kind"] == "para" and b["i"] not in skip and _sep(a, b) != "\n"


def _cover(blocks, skip, dropped):
    """封面的块号。dropped（修改记录表与它的标题段落、空块、乱码块）跳过，不打断也不计数。"""
    kept = [b for b in blocks if b["i"] not in dropped]
    out, k = set(), 0
    while k < len(kept):
        b = kept[k]
        if b["i"] in skip or b["kind"] != "para" or b["loc"].get("page", 1) > 1:
            break
        unit = [b]  # Markdown：相邻的行是同一段，整段一起判断
        while "line" in b["loc"] and k + len(unit) < len(kept) and _wraps(unit[-1], kept[k + len(unit)], skip):
            unit.append(kept[k + len(unit)])
        if not _cover_like(_join(unit)):
            break
        nxt = kept[k + len(unit)] if k + len(unit) < len(kept) else None
        if nxt is not None and _wraps(unit[-1], nxt, skip) and not _cover_like(nxt["text"]):
            break  # PDF：这一行和下一行是同一段的折行，是正文的开头
        out.update(x["i"] for x in unit)
        k += len(unit)
    return out


class _Walker:
    """按原文顺序走一遍块：stack 是当前的路径（章、节、标题、「X、」、多级编号），cur 是正在收的一块。"""

    def __init__(self, tag, doc_title):
        self.tag, self.doc_title = tag, doc_title
        self.stack, self.cur, self.prose, self.items = [], None, [], []
        self.tables = self.paragraphs = 0

    # ── 路径 ──
    def path(self):
        return [e["title"] for e in self.stack]

    def find(self, kind):
        return next((e for e in reversed(self.stack) if e["kind"] == kind), None)

    def chapter_no(self):
        e = self.find("chapter")
        return e["no"] if e else None

    def rank_for(self, kind, level):
        """标题按级别；Word 正文里的「第X章」排在文档名标题之下，「第X节」在章之下。"""
        if level:
            return float(level)
        same = self.find(kind)
        if same:
            return same["rank"]
        if kind == "section":
            ch = self.find("chapter")
            return ch["rank"] + 0.25 if ch else 1.75
        return 1.5

    def pop_to(self, rank):
        while self.stack and self.stack[-1]["rank"] >= rank:
            self.stack.pop()

    def push(self, kind, rank, title, no=None, heading=False, item=None):
        seq = 0
        while self.stack and self.stack[-1]["rank"] >= rank:
            e = self.stack.pop()
            if e["rank"] == rank and e["seq"]:
                seq = e["seq"]
        entry = {"kind": kind, "rank": rank, "title": title, "no": no, "seq": seq + 1 if heading else None, "item": item}
        self.stack.append(entry)
        return entry

    def h_seq(self):
        return ".".join(str(e["no"] if e["kind"] in ("chapter", "section") else e["seq"])
                        for e in self.stack if e["kind"] in ("chapter", "section", "heading"))

    # ── 块 ──
    def open(self, lid, seq, b, *, of, cut=0, mark_end=0, label=None, path=None, small=None, entry=None, item=None):
        self.flush_prose()
        self.cur = {"id": lid, "seq": seq, "blocks": [b], "of": of, "cut": cut, "mark_end": mark_end, "label": label,
                    "path": self.path() if path is None else path, "chapter_no": self.chapter_no(),
                    "small": small, "entry": entry, "item": item, "children": False, "after": []}

    def open_body(self, b):
        top = self.stack[-1]
        if top["kind"] == "chapter":
            seq = str(top["no"])
            lid = f"CH{seq}"
        elif top["kind"] == "section":
            seq = f"{self.chapter_no() or 0}.{top['no']}"
            lid = f"CH{seq}"
        elif top["kind"] == "heading":
            seq = self.h_seq()
            lid = f"H{seq}"
        else:  # 「X、」或多级编号的标题下、它自己那一块已经收完之后的文字
            seq = str(top["no"])
            lid = ("S" if top["kind"] == "s1" else "N") + seq
        self.open(lid, seq, b, of="body", item=top["item"])

    def add(self, b):
        if self.cur:
            self.cur["blocks"].append(b)
        elif self.stack:
            self.open_body(b)
        else:
            self.prose.append(b)

    def title_only(self, c):
        rest = c["blocks"][0]["text"][c["mark_end"]:].strip()
        return len(c["blocks"]) == 1 and len(rest) <= TITLE_MAX and not re.search("[。！？；，,]", rest)

    def close(self):
        self.flush_prose()
        c, self.cur = self.cur, None
        if c is None:
            return
        text = _join(c["blocks"], c["cut"])
        if text and not (c["children"] and self.title_only(c)):  # 只有标题、紧跟着下级：标题已在下级的路径里
            item = (c["item"] or _first_sentence(text)) if c["of"] == "body" else _title(text[c["mark_end"]:])
            self.items.append({"id": c["id"], "kind": "clause", "seq": c["seq"], "chapter_no": c["chapter_no"],
                               "path": c["path"], "label": c["label"], "text": text, "item": item[:ITEM_MAX],
                               "loc": c["blocks"][0]["loc"]})
        self.items.extend(c["after"])  # 这一块里的表格行排在这一块之后

    def flush_prose(self):
        """没有任何结构的段落：折行接成段，长段按句子拆，再把相邻的段合并到 ≤ 400 字，编 P001…"""
        blocks, self.prose = self.prose, []
        paras = []
        for k, b in enumerate(blocks):
            sep = _sep(blocks[k - 1], b) if k else "\n"
            if sep == "\n":
                paras.append([b["text"], b])
            else:
                paras[-1][0] += sep + b["text"]
        chunks = []
        for text, b in paras:
            for piece in _split(text, PROSE_MAX):
                if chunks and len(chunks[-1][0]) + 1 + len(piece) <= PROSE_MAX:
                    chunks[-1][0] += "\n" + piece
                else:
                    chunks.append([piece, b])
        for text, b in chunks:
            self.paragraphs += 1
            seq = f"{self.paragraphs:03d}"
            self.items.append({"id": f"P{seq}", "kind": "paragraph", "seq": seq, "chapter_no": None, "path": [],
                               "label": None, "text": text, "item": _first_sentence(text), "loc": b["loc"]})

    def text(self, b):
        t, heading = b["text"], b["kind"] == "heading"
        level = b["level"] if heading else None
        mk = marker(t)
        if mk is None and PSEUDO_RE.match(t):
            self.close()
            self.push("heading", self.rank_for("chapter", level), _clean(t), heading=True, item=_clean(t))
            return
        if heading and (mk is None or mk.kind not in ("chapter", "section", "article", "s1")):
            self.close()
            self.push("heading", float(level), _clean(t), heading=True, item=_clean(t))
            return
        if mk is None:
            self.add(b)
            return
        k, cur = mk.kind, self.cur
        if k in ("chapter", "section"):
            self.close()
            self.push(k, self.rank_for(k, level), _clean(t), no=mk.num, heading=heading)
            return
        if k == "s1" and heading:  # Markdown 的「## 三、费用范围」：下面的（一）（二）编 S3.1、S3.2
            self.close()
            self.push("s1", float(level), _head(t, mk), no=mk.num, heading=True, item=_title(t[mk.end:]))
            return
        if k == "article":
            self.close()
            self.pop_to(S1_RANK)
            self.open(f"A{mk.num}", str(mk.num), b, of="article", cut=mk.end, label=_clean(mk.label))
            return
        if cur and cur["of"] == "article":  # 条下的「一、」「（一）」「1.」都跟着这一条
            self.add(b)
            return
        if k == "s1":
            self.close()
            self.pop_to(S1_RANK)
            path = self.path()
            entry = self.push("s1", S1_RANK, _head(t, mk), no=mk.num, item=_title(t[mk.end:]))
            self.open(f"S{mk.num}", str(mk.num), b, of="s1", mark_end=mk.end, path=path, entry=entry)
            return
        s1 = self.find("s1")
        if k == "s2" and s1:
            if cur and cur["of"] == "s1" and cur["entry"] is s1:
                cur["children"] = True
            self.close()
            self.pop_to(N_RANK)
            seq = f"{s1['no']}.{mk.num}"
            self.open(f"S{seq}", seq, b, of="s2", mark_end=mk.end)
            return
        if k in ("s2", "small"):
            if cur and cur["small"] == mk.small:  # 文档开头那一串小项的下一项
                self.close()
            elif cur or self.stack:  # 小项跟着上一级走
                self.add(b)
                return
            self.close()
            self.open(f"N{mk.num}", str(mk.num), b, of="small", mark_end=mk.end, small=mk.small)
            return
        # k == "n"：1. / 1.2.3
        depth = mk.num.count(".") + 1
        if depth == 1 and s1 and cur and cur["of"] in ("s1", "s2"):  # 「（二）」下的 1. 2. 是列举
            self.add(b)
            return
        if cur and cur["of"] == "n" and mk.num.startswith(cur["seq"] + "."):
            cur["children"] = True
        self.close()
        self.pop_to(N_RANK + depth)
        path = self.path()
        entry = self.push("n", N_RANK + depth, _head(t, mk), no=mk.num, item=_title(t[mk.end:]))
        self.open(f"N{mk.num}", mk.num, b, of="n", mark_end=mk.end, path=path, entry=entry)

    def table(self, b):
        """不是矩阵、也不是修改记录的表：每行一条「表头：值；…」。首行只有一格有字的是表名，下一行才是表头。"""
        self.flush_prose()
        self.tables += 1
        path, chapter_no = self.path(), self.chapter_no()
        if self.cur and self.cur["of"] in ("s1", "n"):
            self.cur["children"] = True
        if self.cur and self.cur["of"] == "article":
            path = self.cur["path"] + [self.cur["label"]]
        rows, prev = [], []
        for row in b["cells"]:
            prev = [prev[j] if vm == "continue" and j < len(prev) else norm(txt) for j, (txt, vm) in enumerate(row)]
            rows.append(prev)
        if len(rows) >= 3 and len(rows[0]) > 1 and sum(1 for v in rows[0] if v) == 1:
            path = path + [next(v for v in rows[0] if v)]
            rows = rows[1:]
        header, data = (rows[0], rows[1:]) if len(rows) > 1 else ([], rows)
        out = self.cur["after"] if self.cur else self.items
        for r, vals in enumerate(data, start=1):
            if header:
                text = "；".join(f"{header[j] if j < len(header) and header[j] else f'列{j + 1}'}：{v}"
                                for j, v in enumerate(vals) if v)
            else:
                text = "；".join(v for v in vals if v)
            if text:
                out.append({"id": f"T{self.tables}.{r}", "kind": "table_row", "seq": f"{self.tables}.{r}",
                                   "chapter_no": chapter_no, "path": path, "label": None, "text": text,
                                   "item": next(v for v in vals if v)[:ITEM_MAX], "loc": b["loc"], "row": r})

    def matrix_block(self, b):
        """矩阵用掉的块不出条款；其中的章标题（一、立项审批）给后面的非矩阵表格定章。"""
        self.close()
        m = parse_rules.CHAPTER_RE.match(b["text"]) if b["kind"] != "table" else None
        if m and parse_rules.cn_chapter_no(m.group(1)):
            level = b["level"] if b["kind"] == "heading" else None
            self.push("chapter", self.rank_for("chapter", level), b["text"], no=parse_rules.cn_chapter_no(m.group(1)),
                      heading=bool(level))

    # ── 收尾：重复编号加 ~2，超长拆 -a，拼成记录 ──
    def finish(self):
        self.close()
        records, split, renumbered, seen = [], [], [], {}
        for it in self.items:
            lid = it["id"]
            seen[lid] = seen.get(lid, 0) + 1
            if seen[lid] > 1:
                lid = f"{lid}~{seen[lid]}"
                renumbered.append(f"{self.tag}-{lid}")
            pieces = [it["text"]] if it["kind"] == "paragraph" else _split(it["text"], CLAUSE_MAX)
            if len(pieces) > 1:
                split.append(f"{self.tag}-{lid}")
            levels = it["path"][1:] if it["path"] and it["path"][0] == self.doc_title else it["path"]
            head = " › ".join(x for x in [self.doc_title, *levels, it["label"]] if x)
            for k, piece in enumerate(pieces):
                part = _part(k) if len(pieces) > 1 else None
                extra = {"kind": it["kind"]}
                extra.update((key, it["loc"][key]) for key in ("page", "sheet") if key in it["loc"])
                if "row" in it:
                    extra["row"] = it["row"]
                if part:
                    extra["part"] = part
                body = norm(piece)
                records.append(parse_rules.blank(
                    f"{self.tag}-{lid}" + (f"-{part}" if part else ""), "clause", it["chapter_no"], " › ".join(it["path"]),
                    f"{head}：{body}" if head else body,
                    seq_no=it["seq"], business_item=it["item"], scope_controls=piece, extra=extra))
        counts = {k: sum(1 for r in records if r["extra"]["kind"] == k) for k in ("clause", "table_row", "paragraph")}
        return records, {**counts, "split": split, "renumbered": renumbered}


def clause_records(blocks, skip, *, source_tag, doc_title):
    """块 → (记录, 报告的一部分)。报告：{"clause", "table_row", "paragraph"（各类条数）, "split"（拆开了的编号）,
    "renumbered"（加了 ~2 的编号）, "skipped": {"cover", "revision_tables"}, "empty_or_garbled"（块号）}。"""
    skip = set(skip)
    bad = [b["i"] for b in blocks if b["i"] not in skip and _empty_or_garbled(b)]
    revision, titles = revision_tables(blocks, skip)
    dropped = set(bad) | revision | titles
    cover = _cover(blocks, skip, dropped)
    drop = dropped | cover
    w = _Walker(source_tag, doc_title)
    for b in blocks:
        if b["i"] in skip:
            w.matrix_block(b)
        elif b["i"] in drop:
            continue
        elif b["kind"] == "table":
            w.table(b)
        else:
            w.text(b)
    records, part = w.finish()
    part["skipped"] = {"cover": len(cover), "revision_tables": len(revision)}
    part["empty_or_garbled"] = bad
    return records, part
