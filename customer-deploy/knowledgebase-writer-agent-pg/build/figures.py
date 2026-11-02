"""知识库文档管家（PG 版）交付说明与部署指南的图（中文）。画法与 S3 Vectors 版的 figures.py 相同：深色画布、Manim 配色，
颜色在全文只表达一种含义。

颜色约定：蓝 = Nexus 平台、Agent 与工具；青绿 = PostgreSQL（库、表、库里的函数）；紫 = Bedrock 嵌入模型；
棕 = 密钥与 IAM 身份；绿 = 用的人与前端（测试台、调用方）；红 = 失败或不允许；灰 = 本机准备与说明文字。

用法：python3 -I build/figures.py [<assets 目录>]   → 写出 fig-<name>.zh.svg（缺省写到包里的 assets/）
每个文字行按字宽估一次是否超出所在的框；估出来超了就在 stderr 打一行「可能溢出」，退出码 1（改短文字或放宽框再跑）。
图里的数字来自 2026-10-30 参考环境的实测（tests/e2e_results.json、kb/GUIDE.md 7.6），去敏后写死在这里。
"""
import html
import os
import sys

FONT = ("'Latin Modern Roman','CMU Serif',Charter,'Iowan Old Style',Georgia,"
        "'Noto Serif SC','Source Han Serif SC','Songti SC','PingFang SC','Hiragino Sans GB','Microsoft YaHei',serif")
MONO = "'SF Mono',Menlo,Consolas,'Liberation Mono',monospace"
C = {
    "bg": "#171717", "panel": "#1E1E1E", "text": "#ECE9E2", "grey": "#9A9A9A", "dim": "#5E5E5E",
    "blue": "#58C4DD", "yellow": "#F4D345", "teal": "#5CD0B3",
    "brown": "#CD853F", "green": "#83C167", "red": "#FC6255", "purple": "#9A72AC",
}
HERE = os.path.dirname(os.path.abspath(__file__))
WARNINGS = []


def tw(s, size, mono=False):
    """估一行字的宽度（像素）：中日韩文字与全角标点按 1 个字号宽，等宽字体 0.6，其余西文 0.56，空格 0.28。"""
    w = 0.0
    for ch in s:
        o = ord(ch)
        if ch == " ":
            w += size * 0.28
        elif ch == "·":
            w += size * 0.4
        elif o >= 0x2000:
            w += size
        else:
            w += size * (0.6 if mono else 0.56)
    return w


def fits(where, s, size, avail, mono=False):
    need = tw(s, size, mono)
    if need > avail:
        WARNINGS.append(f"{where}：「{s}」约 {need:.0f}px，框里只有 {avail:.0f}px")


class Svg:
    def __init__(self, w, h, uid, title):
        self.w, self.h, self.uid, self.title = w, h, uid, title
        self.parts, self.markers = [], {}

    def marker(self, color):
        if color not in self.markers:
            self.markers[color] = f"arw-{self.uid}-{len(self.markers)}"
        return self.markers[color]

    @staticmethod
    def _attrs(**kw):
        out = []
        for k, v in kw.items():
            if v is None:
                continue
            out.append(f'{k.rstrip("_").replace("_", "-")}="{html.escape(str(v), quote=True)}"')
        return " ".join(out)

    def line(self, x1, y1, x2, y2, color, width=2.0, dash=None, arrow=False, opacity=None):
        m = f' marker-end="url(#{self.marker(color)})"' if arrow else ""
        a = self._attrs(x1=f"{x1:.1f}", y1=f"{y1:.1f}", x2=f"{x2:.1f}", y2=f"{y2:.1f}", stroke=color, stroke_width=width,
                        stroke_dasharray=dash, opacity=opacity)
        self.parts.append(f'<line {a} stroke-linecap="round"{m}/>')

    def path(self, d, color, width=2.0, dash=None, arrow=False, opacity=None):
        m = f' marker-end="url(#{self.marker(color)})"' if arrow else ""
        a = self._attrs(d=d, stroke=color, stroke_width=width, fill="none", stroke_dasharray=dash, opacity=opacity)
        self.parts.append(f'<path {a} stroke-linecap="round" stroke-linejoin="round"{m}/>')

    def rect(self, x, y, w, h, color, fill=None, rx=6, width=1.6, dash=None, opacity=None):
        a = self._attrs(x=f"{x:.1f}", y=f"{y:.1f}", width=f"{w:.1f}", height=f"{h:.1f}", rx=rx, stroke=color,
                        stroke_width=width, fill=fill or "none", stroke_dasharray=dash, opacity=opacity)
        self.parts.append(f"<rect {a}/>")

    def circle(self, cx, cy, r, color, fill=None, width=1.6):
        a = self._attrs(cx=f"{cx:.1f}", cy=f"{cy:.1f}", r=r, stroke=color, stroke_width=width, fill=fill or "none")
        self.parts.append(f"<circle {a}/>")

    def text(self, x, y, s, color=None, size=15, anchor="start", mono=False, italic=False, weight=None):
        a = self._attrs(x=f"{x:.1f}", y=f"{y:.1f}", fill=color or C["text"], font_size=size, text_anchor=anchor,
                        font_family=MONO if mono else FONT, font_style="italic" if italic else None, font_weight=weight)
        self.parts.append(f"<text {a}>{html.escape(s)}</text>")

    def note(self, x, y, s, avail, color=None, size=13, italic=False, anchor="start", mono=False):
        """说明文字：同 text，另按 avail 估一次宽度。"""
        fits(f"{self.uid} 说明", s, size, avail, mono)
        self.text(x, y, s, color=color, size=size, italic=italic, anchor=anchor, mono=mono)

    def render(self, background=True):
        defs = "".join(
            f'<marker id="{mid}" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="11" markerHeight="11" '
            f'markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0,0 L12,6 L0,12 z" fill="{col}"/></marker>'
            for col, mid in self.markers.items())
        bg = f'<rect width="{self.w}" height="{self.h}" fill="{C["bg"]}"/>' if background else ""
        return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {self.w} {self.h}" role="img" '
                f'aria-labelledby="t-{self.uid}" class="fig-svg" id="svg-{self.uid}">'
                f'<title id="t-{self.uid}">{html.escape(self.title)}</title><defs>{defs}</defs>{bg}{"".join(self.parts)}</svg>')


def _line(ln):
    """lines 里的一项：字符串，或 (文字, 颜色键)，或 (文字, 颜色键, "mono")。"""
    if isinstance(ln, str):
        return ln, "text", False
    return ln[0], ln[1], len(ln) > 2 and ln[2] == "mono"


def box(s, x, y, w, color, title, lines=(), dashed=False, title_size=15, line_size=13, fill=None, h=None):
    """带标题的框，返回高度。lines 的每项见 _line。"""
    h = h or 38 + 21 * len(lines)
    s.rect(x, y, w, h, color, fill=fill or C["panel"], dash="6 5" if dashed else None)
    fits(f"{s.uid} 框标题", title, title_size, w - 26)
    s.text(x + 13, y + 25, title, color=color, size=title_size)
    for i, ln in enumerate(lines):
        txt, col, mono = _line(ln)
        size = line_size - (1 if mono else 0)
        fits(f"{s.uid}「{title}」", txt, size, w - 26, mono)
        s.text(x + 13, y + 25 + 21 * (i + 1), txt, color=C[col], size=size, mono=mono)
    return h


def numbered(s, x, y, w, h, color, n, title, lines=(), dashed=False, line_size=12.5, title_size=14.5):
    """步骤框：左上角是序号圆（序号可以是 1、A1 这样的短串）。"""
    s.rect(x, y, w, h, color, fill=C["panel"], dash="6 5" if dashed else None)
    label = str(n)
    s.circle(x + 20, y + 21, 12 if len(label) < 3 else 13, color, fill=C["bg"])
    s.text(x + 20, y + 25.5 if len(label) == 1 else y + 25, label, color=color, size=13 if len(label) == 1 else 11, anchor="middle")
    fits(f"{s.uid} 步骤标题", title, title_size, w - 48)
    s.text(x + 40, y + 26, title, color=color, size=title_size)
    for i, ln in enumerate(lines):
        txt, col, mono = _line(ln)
        size = line_size - (1 if mono else 0)
        fits(f"{s.uid} 步骤「{title}」", txt, size, w - 24, mono)
        s.text(x + 13, y + 50 + 19 * i, txt, color=C[col], size=size, mono=mono)


def legend(s, x, y, items, size=13, step=24, avail=400):
    for i, (txt, col) in enumerate(items):
        s.line(x + 4, y - 5 + step * i, x + 30, y - 5 + step * i, C[col], width=3)
        s.note(x + 40, y + step * i, txt, avail, color=C[col], size=size)


# ─────────────────────────────── 图 1：架构与数据流 ───────────────────────────────
def fig_arch():
    s = Svg(1120, 620, "arch-zh", "图　架构与数据流：谁调谁、数据写到哪、向量在哪算")
    # 左：用的人与前端
    box(s, 24, 84, 210, C["green"], "前端 / 测试台（调用方）", ["「制度知识库」页的后端", "A2A · kb.rules/v1", ("调用密钥 nxa_…", "brown")])
    box(s, 24, 236, 210, C["green"], "Nexus 对话（人）", ["上传附件，说「入库」", "先预览，确认后才写"])
    s.line(236, 120, 280, 120, C["green"], width=2.2, arrow=True)
    s.path("M236,274 L252,274 L252,148 L280,148", C["green"], width=2.2, arrow=True)
    legend(s, 28, 388, [("Nexus 平台、Agent 与工具", "blue"), ("PostgreSQL：表与库里的函数", "teal"),
                        ("Bedrock 嵌入模型", "purple"), ("密钥与 IAM 身份", "brown"), ("用的人与前端", "green")],
           size=12.5, avail=170)

    # 中：Nexus
    s.rect(264, 40, 430, 560, C["blue"], width=1.2, dash="6 5")
    s.text(280, 64, "Nexus v0.3.28", color=C["blue"], size=15)
    box(s, 284, 84, 390, C["blue"], "知识库文档管家（PG 版）· A2A / MCP 发布",
        ["规则请求：只调对应的工具一次，原样回 JSON", "对话：入库先预览；下线、删除前先确认"])
    s.line(479, 166, 479, 218, C["blue"], width=2, arrow=True)
    s.rect(284, 186, 390, 180, C["blue"], width=1.1, dash="4 4")
    s.text(300, 208, "隔离环境（Firecracker VM）", color=C["blue"], size=13.5)
    box(s, 300, 222, 358, C["blue"], "工具目录 kb_pg_steward_<hash>",
        [("rules_writer · rules_search · rules_manager", "text", "mono"), "入口 pg_kb_tools.py + kb/lib 的 5 个核心模块",
         "模型不读附件、不搬运规则、不算向量", ("实测：Python 3.13.15 · psycopg 3.3.4", "grey")])
    box(s, 284, 406, 390, C["brown"], "Nexus 密钥 pg_kb（数据库凭证）",
        [("host · port · database · username · password", "text", "mono"), "kb/deploy.sh connector 建的那把（应用用户）"])
    s.line(400, 404, 400, 346, C["brown"], width=2.2, arrow=True)
    s.note(410, 392, "每次调用前注入", 160, color=C["brown"], size=12)
    box(s, 284, 504, 390, C["blue"], "审核 Agent（审单）",
        [("PG 连接器：kb_search(问题, 8) + ILIKE 补查", "text"), ("连接器绑定的也是这把密钥", "brown")])

    # 右：PG 主机与 Bedrock
    s.rect(794, 40, 304, 376, C["teal"], width=1.2, dash="6 5")
    s.text(810, 64, "PG 主机（私网 IP，5432）", color=C["teal"], size=15)
    box(s, 810, 84, 272, C["teal"], "approval_rules",
        ["矩阵 · 制度说明 · 章节说明 · 正文条款", ("content + embedding vector(1024)", "text", "mono"), "审核 Agent 查的就是这张表"])
    box(s, 810, 201, 272, C["teal"], "其他表",
        ["approval_rules_archive（下线的）", "kb_documents（每次入库一行）", "kb_meta（登记的向量模型）"])
    box(s, 810, 318, 272, C["teal"], "库里的函数",
        ["kb_embed_batch / kb_embed：算向量", "kb_search：关键词 → 条款靠后 → 语义"])
    box(s, 810, 466, 272, C["purple"], "Amazon Bedrock",
        ["Cohere Embed v4 · 1024 维", ("PG 主机的实例角色调用", "brown")])
    s.line(946, 400, 946, 464, C["purple"], width=2.2, arrow=True)
    s.note(956, 438, "HTTPS", 80, color=C["purple"], size=12)

    # 工具 → PG；审核 Agent → PG
    s.line(660, 268, 792, 268, C["teal"], width=2.4, arrow=True)
    s.note(744, 258, "psycopg 3", 96, color=C["teal"], size=12, anchor="middle")
    s.note(744, 288, "VM 出站已放行", 96, color=C["teal"], size=12, anchor="middle")
    s.path("M676,548 L760,548 L760,364 L808,364", C["teal"], width=2.2, arrow=True)
    s.note(754, 450, "连接器", 60, color=C["teal"], size=12, anchor="end")
    s.note(754, 468, "SQL", 60, color=C["teal"], size=12, anchor="end")
    return s


# ─────────────────────────────── 图 2：部署步骤 ───────────────────────────────
def fig_steps():
    s = Svg(1040, 650, "steps-zh", "图　部署步骤：A PG 知识库 → B Agent → C 端到端验证 → D 接前端")
    x0, area = 160, 856
    lanes = [  # (字母, 名字, 副标题, 颜色, 顶边 y)
        ("A", "PG 知识库", "repo/kb/", "teal", 34),
        ("B", "Agent", "Nexus 上", "blue", 150),
        ("C", "端到端", "虚构文档", "yellow", 390),
        ("D", "接前端", "kb.rules/v1", "green", 510),
    ]
    for letter, name, sub, col, y in lanes:
        s.circle(42, y + 30, 15, C[col], fill=C["bg"])
        s.text(42, y + 35, letter, color=C[col], size=15, anchor="middle")
        s.note(64, y + 30, name, 88, color=C[col], size=14)
        s.note(64, y + 50, sub, 88, color=C["grey"], size=11.5 if sub.isascii() else 12, mono=sub.isascii())

    def row(steps, y, w):
        pos = []
        gap = (area - w * len(steps)) / (len(steps) - 1) if len(steps) > 1 else 0
        for i, (n, ttl, l1, l2, col, dashed) in enumerate(steps):
            x = x0 + i * (w + gap)
            numbered(s, x, y, w, 84, C[col], n, ttl, [l1, (l2, "grey")], dashed=dashed)
            pos.append((x, y))
        return pos, gap

    def chain(pos, w, gap, dashed_last=False):
        for i in range(len(pos) - 1):
            x, y = pos[i]
            last = dashed_last and i == len(pos) - 2
            s.line(x + w + 2, y + 42, x + w + gap - 3, y + 42, C["grey"], width=1.6, arrow=True, dash="4 4" if last else None)

    def down(a, b, w):
        (xa, ya), (xb, yb) = a, b
        mid = (ya + 84 + yb) / 2
        s.path(f"M{xa + w / 2:.0f},{ya + 86} L{xa + w / 2:.0f},{mid:.0f} L{xb + w / 2:.0f},{mid:.0f} L{xb + w / 2:.0f},{yb - 3}",
               C["grey"], width=1.6, arrow=True)

    wa, wa2 = 270, 416
    pa, ga = row([("A1", "部署 PG 知识库（新建或接管）", "填 deploy.env → preflight → all --dry-run → all",
                   "repo/kb/deploy.sh · 20–40 分钟", "teal", False),
                  ("A2", "已有旧 Titan 库：换成 Cohere v4", "基线 → 改实例角色 → 一个事务迁移 → 对比",
                   "只有旧库要做 · 30–60 分钟（含 IAM 生效）", "teal", True)], 40, wa2)
    chain(pa, wa2, ga, dashed_last=True)
    wb = 196
    pb1, gb = row([("B1", "连 Operator", "填本包的 deploy.env", "接入包 · 5 分钟", "blue", False),
                   ("B2", "复制 Agent", "clone-preview → clone", "Operator · 2 分钟", "blue", False),
                   ("B3", "导入工具包", "声明 pg_kb，verify 核对", "管理员脚本 · 3 分钟", "blue", False),
                   ("B4", "绑定数据库密钥", "configured=True ×3", "Operator · 1 分钟", "brown", False)], 160, wb)
    chain(pb1, wb, gb)
    pb2 = []
    for i, (n, ttl, l1, l2, col) in enumerate([("B5", "保存提示词", "render.py → PUT prompt", "Operator · 2 分钟", "blue"),
                                                ("B6", "对话冒烟", "describe、list", "Nexus 对话 · 3 分钟", "blue"),
                                                ("B7", "发布 A2A / MCP", "调用密钥 → A2A describe", "Operator + 脚本 · 5 分钟", "blue")]):
        x = x0 + i * (wb + gb)
        numbered(s, x, 270, wb, 84, C[col], n, ttl, [l1, (l2, "grey")])
        pb2.append((x, 270))
    chain(pb2, wb, gb)
    # A1 → B1（A2 是可选的，做完同样接 B1）
    xa, ya = pa[0]
    xb, yb = pb1[0]
    s.path(f"M{xa + wa2 / 2:.0f},{ya + 86} L{xa + wa2 / 2:.0f},{ya + 102} L{xb + wb / 2:.0f},{ya + 102} L{xb + wb / 2:.0f},{yb - 3}",
           C["grey"], width=1.6, arrow=True)
    s.note(pa[1][0] + 14, ya + 104, "没有旧 Titan 库就跳过 A2", 260, color=C["grey"], size=12, italic=True)
    down(pb1[3], pb2[0], wb)
    pc, gc = row([("C1", "生成虚构文档", "make_e2e_docs.py：5 份", "uv · 1 分钟", "yellow", False),
                  ("C2", "照清单验证", "入库 · 检索 · 冲突 · 下线 · 恢复 · 正文", "对话 + a2a_rules.mjs · 15 分钟", "yellow", False),
                  ("C3", "清理与校验", "delete 测试制度 → check → list", "a2a_rules.mjs · 3 分钟", "yellow", False)], 400, wa)
    chain(pc, wa, gc)
    xb7, yb7 = pb2[2]
    xc1, yc1 = pc[0]
    s.path(f"M{xb7 + wb / 2:.0f},{yb7 + 86} L{xb7 + wb / 2:.0f},{yb7 + 108} L{xc1 + wa / 2:.0f},{yb7 + 108} L{xc1 + wa / 2:.0f},{yc1 - 3}",
           C["grey"], width=1.6, arrow=True)
    pd, gd = row([("D1", "前端启用调用密钥", "前端的「Agent 接入」页", "管理员 · 2 分钟", "green", False),
                  ("D2", "配发布编号", "KB_PG_PUBLICATION_ID", "测试台的部署配置", "green", False),
                  ("D3", "按 kb.rules/v1 调用", "先 describe，再按 ops 开功能", "前端代码 · 视改动而定", "green", False)], 520, wa)
    chain(pd, wa, gd)
    down(pc[2], pd[0], wa)
    s.note(44, 634, "第一次做：A、B 两部分约 1 小时（不含 A2）；C 约 20 分钟；D 看前端改动。每一步的命令见部署指南的同名小节。",
           960, color=C["grey"], size=13, italic=True)
    return s


# ─────────────────────────────── 图 3：工具包的三种导入方式 ───────────────────────────────
def fig_import():
    s = Svg(1040, 490, "import-zh", "图　工具包 nexus/pg_kb_tools.zip 的三种导入方式：两种能用，网页导入不行")
    box(s, 280, 24, 480, C["blue"], "nexus/pg_kb_tools.zip（预打好的工具包）",
        ["入口 pg_kb_tools.py + kb/lib 的 5 个核心模块（共 6 个文件）", "旁边的 MANIFEST.json 逐个文件记 sha256"])
    cols = [24, 364, 704]
    w = 312
    tops = 150
    h1 = box(s, cols[0], tops, w, C["blue"], "① 一条命令（推荐）",
             [("admin_run.sh import --module pg", "text", "mono"), ("--file nexus/pg_kb_tools.zip", "text", "mono"),
              "先查压缩包：编译、@tool、对 MANIFEST", "确认时声明 pg_kb / database_credentials",
              "结果写进 .state/import.json", ("管理员账号（密码放在 600 文件）", "brown")])
    box(s, cols[1], tops, w, C["blue"], "② 纯 API（curl）",
        [("POST /api/v2/tools/import/upload", "text", "mono"), "multipart 字段 file → review_id",
         ("POST /api/v2/tools/import/confirm", "text", "mono"), "tools[] 写 key_name / key_type / 字段",
         "dir_label=kb_pg_steward", ("管理员令牌；编码工具也能照做", "brown")])
    box(s, cols[2], tops, w, C["red"], "③ 网页「导入工具」",
        ["确认页只沿用审查识别的「凭证参数」", "三个工具没有凭证参数", "→ 登记成「不需要密钥」",
         "→ 平台不注入 → credentials_missing", "v0.3.28 没有事后补登记的接口", ("所以不要用网页导入这个包", "red")], dashed=True)
    # 标题的删除线与角标
    s.line(cols[2] + 12, tops + 20, cols[2] + 12 + tw("③ 网页「导入工具」", 15), tops + 20, C["red"], width=1.6)
    for x, ok in zip(cols, (True, True, False)):
        cx, cy = x + w - 26, tops + 20
        s.circle(cx, cy, 13, C["green"] if ok else C["red"], fill=C["bg"])
        if ok:
            s.path(f"M{cx - 6},{cy} L{cx - 1.5},{cy + 5} L{cx + 6.5},{cy - 5.5}", C["green"], width=2.4)
        else:
            s.line(cx - 5.5, cy - 5.5, cx + 5.5, cy + 5.5, C["red"], width=2.4)
            s.line(cx - 5.5, cy + 5.5, cx + 5.5, cy - 5.5, C["red"], width=2.4)
    # 压缩包 → 三种方式
    for x, col, dash in zip(cols, ("blue", "blue", "red"), (None, None, "5 4")):
        s.path(f"M520,106 L520,126 L{x + w / 2:.0f},126 L{x + w / 2:.0f},{tops - 3}", C[col], width=1.8, arrow=True, dash=dash)
    yb = tops + h1 + 34
    box(s, 24, yb, 652, C["blue"], "导入结果：工具目录 kb_pg_steward_<8 位十六进制>，这就是 v1",
        ["3 个工具 requires_key：key_name=pg_kb · key_type=database_credentials",
         "→ 绑定 PUT /api/v2/keys/tool-bindings → verify：configured=True ×3"])
    for x in cols[:2]:
        s.line(x + w / 2, tops + h1 + 2, x + w / 2, yb - 3, C["blue"], width=1.8, arrow=True)
    box(s, cols[2], yb, w, C["red"], "结果：调用时报 credentials_missing",
        ["只能删掉这个工具目录，", "改用 ① 或 ② 重新导入"], dashed=True)
    s.line(cols[2] + w / 2, tops + h1 + 2, cols[2] + w / 2, yb - 3, C["red"], width=1.8, arrow=True, dash="5 4")
    s.note(24, yb + 112, "Operator 只发 JSON（不能 multipart），角色封顶 editor，所以导入由管理员做。三种方式的完整写法见 nexus/IMPORT.md。",
           992, color=C["grey"], size=13, italic=True)
    return s


# ─────────────────────────────── 图 4：一次 rules_writer 调用里的入库 ───────────────────────────────
def fig_ingest():
    s = Svg(1040, 520, "ingest-zh", "图　一次 rules_writer 调用：解析 → 一条一块 → 对比 → 上锁 → 库里算向量 → 写入")
    w, h, gap, x0 = 176, 92, 18, 44
    steps = [("检查参数与附件", ["制度标识合规", "附件 ≤ 50 MB，四种格式"], "blue"),
             ("解析", ["矩阵一行一条", "正文一条一块（clauses）"], "blue"),
             ("算记录哈希", [("record_sha256", "text", "mono"), "除向量外的全部列"], "blue"),
             ("连库（5 秒超时）", [("注入的密钥 pg_kb", "brown"), "等锁 30 秒 · 每句 240 秒"], "teal"),
             ("记上传记录", [("kb_documents 一行", "text"), "ingesting，单独提交"], "teal"),
             ("入库锁", [("kb_ingest:<表>", "text", "mono"), "与 deploy.sh、迁移共用"], "teal"),
             ("对比", ["新增 · 只改说明 · 重算", "不变 · 删除（同一制度）"], "teal"),
             ("冲突就拒绝", ["编号属于别的制度", "rule_conflict，不写"], "red"),
             ("库里算向量", [("kb_embed_batch", "text", "mono"), "只算新增和正文改了的"], "purple"),
             ("写入并提交", ["upsert，删旧编号", "记录改成 ingested"], "teal")]
    pos = [(x0 + i * (w + gap), 34) for i in range(5)] + [(x0 + i * (w + gap), 200) for i in range(5)]
    s.rect(32, 168, 976, 138, C["teal"], width=1.2, dash="6 5")
    s.text(994, 188, "一个事务（任何一步失败，整份回滚）", color=C["teal"], size=13, anchor="end")
    for n, ((ttl, lines, col), (x, y)) in enumerate(zip(steps, pos), start=1):
        numbered(s, x, y, w, h, C[col], n, ttl, lines)
    for i in list(range(4)) + list(range(5, 9)):
        x, y = pos[i]
        s.line(x + w + 2, y + h / 2, x + w + gap - 3, y + h / 2, C["grey"], width=1.6, arrow=True)
    x5, y5 = pos[4]
    x6, y6 = pos[5]
    s.path(f"M{x5 + w / 2:.0f},{y5 + h + 2} L{x5 + w / 2:.0f},{y5 + h + 22} L{x6 + w / 2:.0f},{y5 + h + 22} L{x6 + w / 2:.0f},{y6 - 3}",
           C["grey"], width=1.6, arrow=True)
    # 预览与失败
    s.rect(44, 324, 952, 40, C["blue"], fill=C["panel"], dash="5 4")
    s.note(60, 349, "preview（dry_run=true）：跳过第 5、9、10 步，对比完就回滚，回 previewed 和将新增 / 更新 / 删除的编号；不写库、不算向量",
           920, color=C["blue"], size=13)
    s.rect(44, 376, 952, 40, C["red"], fill=C["panel"], dash="5 4")
    s.note(60, 401, "第 6–10 步失败（Bedrock 报错、等锁超 30 秒、一句超 240 秒……）：整份回滚，第 5 步那一行改成 failed，回复带 document_id",
           920, color=C["red"], size=13)
    legend(s, 44, 446, [("第 4 步：平台注入的 Nexus 密钥 pg_kb（数据库应用用户）", "brown"),
                        ("第 9 步：PG 主机的实例角色调 Bedrock Cohere v4（工具自己不调）", "purple")], size=13, avail=900)
    s.note(44, 504, "实测：真实制度再入库 102 条 unchanged（skipped，一条不写、不算向量）；虚构矩阵新增 7 条；冲突矩阵整份拒绝；A2A 一次约 17 秒",
           960, color=C["grey"], size=13, italic=True)
    return s


# ─────────────────────────────── 图 5：旧 Titan 库换成 Cohere v4 ───────────────────────────────
def fig_switch():
    s = Svg(1040, 440, "switch-zh", "图　旧 Titan 库换成 Cohere v4：基线、改权限、一个事务迁移、对比、回退")
    w, h, gap, x0 = 176, 92, 18, 44
    steps = [("用本交付的 kb/", ["拷 deploy.env、.state/", "旧目录不再跑 db"], "grey"),
             ("以 Titan 跑 db", ["装新函数，不动向量", ("EMBED_MODEL_ID=Titan", "text", "mono")], "teal"),
             ("基线", [("regress --label titan", "text", "mono"), "两套题 + 已知问题"], "teal"),
             ("改实例角色", ["加 Cohere v4 的权限", "等约 10 分钟生效"], "brown"),
             ("看计划", [("db --dry-run", "text", "mono"), ("--migrate-embeddings", "text", "mono")], "teal"),
             ("迁移", ["一个事务：备份 → 重算", "→ 登记 kb_meta"], "teal"),
             ("对比", [("regress --label cohere", "text", "mono"), "--compare：前 5 不降"], "teal"),
             ("审核 Agent 端到端", [("verify --e2e", "text", "mono"), "规则问答 + A2A 回归"], "blue"),
             ("收尾", ["删回归留下的检索日志", "验收后再删备份表"], "grey")]
    pos = [(x0 + i * (w + gap), 34) for i in range(5)] + [(x0 + i * (w + gap), 190) for i in range(4)]
    for n, ((ttl, lines, col), (x, y)) in enumerate(zip(steps, pos), start=1):
        numbered(s, x, y, w, h, C[col], n, ttl, lines)
    for i in list(range(4)) + list(range(5, 8)):
        x, y = pos[i]
        s.line(x + w + 2, y + h / 2, x + w + gap - 3, y + h / 2, C["grey"], width=1.6, arrow=True)
    x5, y5 = pos[4]
    x6, y6 = pos[5]
    s.path(f"M{x5 + w / 2:.0f},{y5 + h + 2} L{x5 + w / 2:.0f},{y5 + h + 32} L{x6 + w / 2:.0f},{y5 + h + 32} L{x6 + w / 2:.0f},{y6 - 3}",
           C["grey"], width=1.6, arrow=True)
    # 回退（第 7、8 步不过）
    x7, y7 = pos[6]
    s.path(f"M{x7 + w / 2:.0f},{y7 + h + 2} L{x7 + w / 2:.0f},{y7 + h + 24}", C["red"], width=1.6, dash="5 4", arrow=True)
    s.rect(44, y7 + h + 28, 952, 40, C["red"], fill=C["panel"], dash="5 4")
    s.note(60, y7 + h + 53, "第 7、8 步不过：EMBED_MODEL_ID 改回 Titan → db --dry-run --restore-embeddings → db --restore-embeddings（一个事务，拷回旧向量）",
           920, color=C["red"], size=13)
    s.note(44, y7 + h + 98, "防混用：db 阶段先读库里 kb_meta 登记的模型，与 EMBED_MODEL_ID 不同就停；迁移、回退都要显式加参数。",
           960, color=C["teal"], size=13)
    s.note(44, y7 + h + 124, "参考环境（10-30）：一个事务重算 102 条；前 5 命中 主题 46 → 49 / 58、改写 20 → 22 / 26；IAM 改完约 9 分钟内 Bedrock 间歇 403。",
           960, color=C["grey"], size=13, italic=True)
    return s


FIGURES = {"arch": fig_arch, "steps": fig_steps, "import": fig_import, "ingest": fig_ingest, "switch": fig_switch}


def svg(name, background=True):
    return FIGURES[name]().render(background=background)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(HERE), "assets")
    os.makedirs(out, exist_ok=True)
    for name in FIGURES:
        with open(os.path.join(out, f"fig-{name}.zh.svg"), "w", encoding="utf-8") as fh:
            fh.write(svg(name))
    for w in WARNINGS:
        print("可能溢出：" + w, file=sys.stderr)
    print("wrote", len(FIGURES), "figures to", out)
    return 1 if WARNINGS else 0


if __name__ == "__main__":
    sys.exit(main())
