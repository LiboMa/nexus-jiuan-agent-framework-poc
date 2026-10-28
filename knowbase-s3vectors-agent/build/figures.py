"""交付说明与操作指南的图（中英各一份），3Blue1Brown 风格：深色画布、Manim 配色，颜色在全文只表达一种含义。

颜色约定：蓝 = Agent、工具与 Nexus 平台；黄 = S3 Vectors；棕 = 密钥与 IAM 身份；紫 = Bedrock 嵌入模型；
青绿 = PostgreSQL（只在对照图里出现）；绿 = 前端应用（audit-nexus）；红 = 失败或不允许；灰 = 本机准备与说明文字。

用法：python3 -I figures.py <assets_dir>   → 写出 fig-<name>.<zh|en>.svg
HTML 生成器也直接加载本文件，把同一份 SVG 内联进页面（id 按「图名 + 语言」区分，可以同页共存）。
"""
import html
import json
import os
import sys

FONT = ("'Latin Modern Roman','CMU Serif',Charter,'Iowan Old Style',Georgia,"
        "'Noto Serif SC','Source Han Serif SC','Songti SC','PingFang SC','Hiragino Sans GB','Microsoft YaHei',serif")
MONO = "'SF Mono',Menlo,Consolas,'Liberation Mono',monospace"
C = {
    "bg": "#171717", "panel": "#1E1E1E", "text": "#ECE9E2", "grey": "#9A9A9A", "dim": "#5E5E5E",
    "grid": "#236B8E", "blue": "#58C4DD", "yellow": "#F4D345", "teal": "#5CD0B3",
    "brown": "#CD853F", "green": "#83C167", "red": "#FC6255", "purple": "#9A72AC",
}
HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS = os.path.join(os.path.dirname(HERE), "tests", "e2e_results.json")


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

    def render(self, background=True):
        defs = "".join(
            f'<marker id="{mid}" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="11" markerHeight="11" '
            f'markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0,0 L12,6 L0,12 z" fill="{col}"/></marker>'
            for col, mid in self.markers.items())
        bg = f'<rect width="{self.w}" height="{self.h}" fill="{C["bg"]}"/>' if background else ""
        return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {self.w} {self.h}" role="img" '
                f'aria-labelledby="t-{self.uid}" class="fig-svg" id="svg-{self.uid}">'
                f'<title id="t-{self.uid}">{html.escape(self.title)}</title><defs>{defs}</defs>{bg}{"".join(self.parts)}</svg>')


def box(s, x, y, w, color, title, lines=(), dashed=False, title_size=15, line_size=13, mono=(), fill=None, h=None):
    """带标题的框：lines 里每项是字符串，或 (文字, 颜色键)；mono 是要用等宽字体的行号集合。返回高度。"""
    h = h or 38 + 21 * len(lines)
    s.rect(x, y, w, h, color, fill=fill or C["panel"], dash="6 5" if dashed else None)
    s.text(x + 13, y + 25, title, color=color, size=title_size)
    for i, ln in enumerate(lines):
        txt, col = (ln, "text") if isinstance(ln, str) else ln
        m = i in mono
        s.text(x + 13, y + 25 + 21 * (i + 1), txt, color=C[col], size=line_size - (1 if m else 0), mono=m)
    return h


def numbered(s, x, y, w, h, color, n, title, lines=(), dashed=False, line_size=12.5):
    """步骤框：左上角是序号圆。"""
    s.rect(x, y, w, h, color, fill=C["panel"], dash="6 5" if dashed else None)
    s.circle(x + 20, y + 21, 12, color, fill=C["bg"])
    s.text(x + 20, y + 26, str(n), color=color, size=13, anchor="middle")
    s.text(x + 40, y + 26, title, color=color, size=14.5)
    for i, ln in enumerate(lines):
        txt, col = (ln, "text") if isinstance(ln, str) else ln
        s.text(x + 13, y + 50 + 19 * i, txt, color=C[col], size=line_size)


def results():
    try:
        return json.load(open(RESULTS, encoding="utf-8"))
    except (OSError, ValueError):
        return {}


# ─────────────────────────────── 文字 ───────────────────────────────
T = {
    "compare": {
        "zh": dict(title="图 1　PostgreSQL 版与 S3 Vectors 版", left="PostgreSQL 版", right="S3 Vectors 版",
                   l=[("document_parser → text_chunker", ["解析、分块：两个版本相同"]),
                      ("bedrock_embedding", ["运行角色调 Bedrock，返回 1024 维向量"]),
                      ("pgvector_connector", ["写入三张表，有事务", ("密钥 pgvector_connection（数据库密码）", "brown")]),
                      ("PostgreSQL + pgvector", ["常驻实例；VM 出站要放行私网地址"]),
                      ("vector_search(query_vector)", ["模型先把问句向量化，再把向量传进来"])],
                   carry="模型把向量抄进下一个工具的参数",
                   r=[("s3vectors_writer(file_path)", ["一步完成：解析 → 分块 → 向量化 → 写入", "模型只传附件路径"]),
                      ("Bedrock", ["Cohere Embed v4，1536 维", "运行角色，工具内部调用"]),
                      ("密钥 s3vectors_kb", ["专用 IAM 用户", "只授权这一个向量桶"]),
                      ("S3 Vectors：一个桶、三个索引", ["按存储量和请求次数计费，没有实例"]),
                      ("s3vectors_search(query) · 只读连接器", ["问句在工具里向量化；过滤条件由代码拼"])],
                   vec="向量", key="读写"),
        "en": dict(title="Figure 1  The PostgreSQL version and the S3 Vectors version", left="PostgreSQL version",
                   right="S3 Vectors version",
                   l=[("document_parser → text_chunker", ["Parsing and chunking: the same in both"]),
                      ("bedrock_embedding", ["Runtime role calls Bedrock, returns 1024 dims"]),
                      ("pgvector_connector", ["Writes three tables in a transaction",
                                              ("key pgvector_connection (DB password)", "brown")]),
                      ("PostgreSQL + pgvector", ["Always-on instance; VM egress to a private IP"]),
                      ("vector_search(query_vector)", ["Model embeds the question, passes the vector"])],
                   carry="The model copies the vectors|into the next tool's arguments",
                   r=[("s3vectors_writer(file_path)", ["One call: parse → chunk → embed → write",
                                                       "The model passes only the attachment path"]),
                      ("Bedrock", ["Cohere Embed v4, 1536 dims", "Runtime role, called inside the tool"]),
                      ("key s3vectors_kb", ["Dedicated IAM user", "Allowed on this one vector bucket"]),
                      ("S3 Vectors: one bucket, three indexes", ["Pay for storage and requests; no instance"]),
                      ("s3vectors_search(query) · read-only connector", ["Question embedded in the tool; filters built in code"])],
                   vec="vectors", key="read/write"),
    },
    "layout": {
        "zh": dict(title="图 2　一个向量桶、三个索引", bucket="向量桶 knowbase-s3v-demo　·　SSE-S3 加密　·　us-east-1",
                   key="键", vec="向量", filt="可过滤（每条 ≤ 2 KB）", nonf="不可过滤（随结果返回）",
                   idx=[("chunks · 1536 维", "一条 = 一个文本块", "doc_…#00001", "Cohere Embed v4，余弦"),
                        ("docs · 1536 维", "一条 = 一份文档（登记表）", "doc_c03ffe7f…", "文本块向量的平均"),
                        ("audit · 1 维", "一条 = 一次写入 / 删除 / 恢复", "1793161894705-c3e2…", "常量 [1.0]")],
                   foot="元数据合计每条 ≤ 40 KB、≤ 50 个键；不可过滤的键每个索引 ≤ 10 个，建索引时定好、之后不能改。"),
        "en": dict(title="Figure 2  One vector bucket, three indexes",
                   bucket="Vector bucket knowbase-s3v-demo  ·  SSE-S3 encryption  ·  us-east-1",
                   key="key", vec="vector", filt="Filterable (≤ 2 KB per record)", nonf="Non-filterable (returned only)",
                   idx=[("chunks · 1536 dims", "one record = one chunk", "doc_…#00001", "Cohere Embed v4, cosine"),
                        ("docs · 1536 dims", "one record = one document", "doc_c03ffe7f…", "mean of its chunk vectors"),
                        ("audit · 1 dim", "one record = one write / delete / restore", "1793161894705-c3e2…", "constant [1.0]")],
                   foot="Metadata ≤ 40 KB and ≤ 50 keys per record; ≤ 10 non-filterable keys per index, fixed when the index is created."),
    },
    "ingest": {
        "zh": dict(title="图 3　一步入库：s3vectors_writer 内部的九步",
                   steps=[("解析", ["与 PostgreSQL 版同一解析器", "doc_id 由 SHA256 推出"], "blue"),
                          ("分块", ["512 字，重叠 64 字"], "blue"),
                          ("查登记表", ["skip：已存在就返回", "insert：已存在就报错"], "yellow"),
                          ("向量化", ["Cohere v4，1536 维", "96 段一批，全成功才继续"], "purple"),
                          ("登记 ingesting", ["docs 索引，平均向量"], "yellow"),
                          ("写文本块", ["PutVectors，100 条一批"], "yellow"),
                          ("删旧块", ["覆盖时：新版本没有的键"], "yellow"),
                          ("登记 ingested", ["docs 索引"], "yellow"),
                          ("操作记录", ["audit 索引"], "yellow")],
                   fail="第 6、7 步失败：登记改成 failed，写一条 ingest_failed；再入库一次（任一策略）自动重写，dedup_status=repaired",
                   cred=[("第 3、5–9 步：密钥 s3vectors_kb（只授权这个桶）", "brown"), ("第 4 步：运行环境的 IAM 角色", "purple")],
                   measured="实测：3 块的文档，工具 1.7 秒；同一内容再入库 0.6 秒（skipped，不向量化）"),
        "en": dict(title="Figure 3  One-call ingest: the nine steps inside s3vectors_writer",
                   steps=[("Parse", ["Same parser as PG version", "doc_id from the SHA256"], "blue"),
                          ("Chunk", ["512 characters, 64 overlap"], "blue"),
                          ("Check registry", ["skip: exists → return it", "insert: exists → error"], "yellow"),
                          ("Embed", ["Cohere v4, 1536 dims", "96 per batch; all or nothing"], "purple"),
                          ("Mark ingesting", ["docs index, mean vector"], "yellow"),
                          ("Write chunks", ["PutVectors, 100 per batch"], "yellow"),
                          ("Drop old chunks", ["overwrite: unused old keys"], "yellow"),
                          ("Mark ingested", ["docs index"], "yellow"),
                          ("Audit record", ["audit index"], "yellow")],
                   fail="Steps 6–7 fail: registry → failed, plus an ingest_failed record; ingesting again (any strategy) rewrites it, dedup_status=repaired",
                   cred=[("Steps 3, 5–9: key s3vectors_kb (this bucket only)", "brown"), ("Step 4: the runtime IAM role", "purple")],
                   measured="Measured: a 3-chunk document took 1.7 s in the tool; the same content again took 0.6 s (skipped, no embedding)"),
    },
    "read": {
        "zh": dict(title="图 4　三条读路径，与近似检索的实测返回条数",
                   paths=[("Agent：s3vectors_search", ["密钥 s3vectors_kb · 过滤由代码拼", "多取 max(2k, k+5) 条再截断"], "blue"),
                          ("其他 Agent：data_connector_query", ["连接器只读令牌 · 过滤写在 params", "建议 top_k ≥ 8"], "blue"),
                          ("前端后端：kb_cli.py", ["同一份工具代码，在 Nexus 之外运行", "凭证：本机 AWS 凭证或凭证文件"], "green")],
                   index="chunks 索引", same="三条路径的查询向量相同：相似度 0.4978 ↔ 距离 0.5022",
                   chart="近似检索：要 topK 条，实际回来几条", chart_sub="索引里共 3 个向量；方块 = 最多能回的条数（topK 与 3 取小），实心 = 实际返回",
                   q=["白鹭-5831 唯一暗号", "清理方式 硬删除", "文档目的"], note="topK=1 时，3 个问题里有 2 个一条都没回来"),
        "en": dict(title="Figure 4  Three read paths, and how many results approximate search returned",
                   paths=[("Agent: s3vectors_search", ["key s3vectors_kb · filters built in code", "fetches max(2k, k+5), then trims"], "blue"),
                          ("Other agents: data_connector_query", ["connector's read-only token · filter in params", "use top_k ≥ 8"], "blue"),
                          ("App backend: kb_cli.py", ["the same tool code, run outside Nexus", "credentials: local AWS profile or file"], "green")],
                   index="chunks index", same="All three embed the question the same way: similarity 0.4978 ↔ distance 0.5022",
                   chart="Approximate search: asked for topK, got how many", chart_sub="3 vectors in the index; squares = most possible, filled = returned",
                   q=["egret-5831 code phrase", "cleanup, hard delete", "purpose of the doc"],
                   note="With topK=1, two of the three questions returned nothing"),
    },
    "creds": {
        "zh": dict(title="图 5　两把身份，各管一段",
                   host=("Nexus 主机", ["密钥值存在 Secrets Manager", "按绑定解析：本人 → 工具创建者", ("每轮随载荷发给 VM，只在内存里", "brown")]),
                   vm="隔离环境（Firecracker VM）",
                   tool=("s3vectors_* 工具", ["调用前 SecretKeyInjector 注入", "get_tool_credentials()", "拿不到就报错，不回落默认凭证"]),
                   s3v=("S3 Vectors", ["knowbase-s3v-demo", ("专用 IAM 用户的密钥", "brown"), ("只授权这一个桶", "brown")]),
                   br=("Bedrock", ["Cohere Embed v4", ("运行环境的 IAM 角色", "purple")]),
                   grant="密钥值", k="读写", role="嵌入",
                   deny=["运行角色直接写用户的向量桶：不允许", "平台代码：「角色上限只放向量读」"],
                   conn=("只读连接器（IAM 模式）", ["主机按连接器签发只读令牌", "Query / Get / List + 调嵌入模型"]),
                   conn_arrow="data_connector_query（只读）"),
        "en": dict(title="Figure 5  Two identities, each with one job",
                   host=("Nexus host", ["Key values live in Secrets Manager", "Binding: your own → tool creator's", ("Sent with each turn, in memory only", "brown")]),
                   vm="Isolated environment (Firecracker VM)",
                   tool=("s3vectors_* tools", ["SecretKeyInjector before each call", "get_tool_credentials()", "No key → error, never the default chain"]),
                   s3v=("S3 Vectors", ["knowbase-s3v-demo", ("dedicated IAM user's key", "brown"), ("allowed on this bucket only", "brown")]),
                   br=("Bedrock", ["Cohere Embed v4", ("the runtime IAM role", "purple")]),
                   grant="key", k="read/write", role="embed",
                   deny=["Runtime role → user's vector bucket: no writes", "Platform code: role ceiling allows vector reads only"],
                   conn=("Read-only connector (IAM mode)", ["Host signs a read-only token per connector", "Query / Get / List + embedding calls"]),
                   conn_arrow="data_connector_query (read-only)"),
    },
    "steps": {
        "zh": dict(title="图 1　从零到接上前端的十步",
                   s=[("填 deploy.env", "文本编辑器", "grey"), ("建 AWS 资源", "aws_setup.sh", "brown"),
                      ("Nexus 密钥", "key-create 或网页", "brown"), ("准备 Agent", "Operator 复制", "blue"),
                      ("导入工具", "管理员脚本", "blue"), ("提示词 + 绑定", "Operator", "blue"),
                      ("只读连接器", "Operator", "yellow"), ("对话验证", "Nexus 对话", "blue"),
                      ("A2A / MCP 发布", "Operator + 网页", "blue"), ("接 audit-nexus", "第 10 章", "green")],
                   total="前九步约 30 分钟；改动 audit-nexus 的工作量看选哪种接法"),
        "en": dict(title="Figure 1  Ten steps from nothing to a connected frontend",
                   s=[("Fill deploy.env", "text editor", "grey"), ("AWS resources", "aws_setup.sh", "brown"),
                      ("Nexus key", "key-create or web", "brown"), ("Get an agent", "Operator clone", "blue"),
                      ("Import tools", "admin script", "blue"), ("Prompt + binding", "Operator", "blue"),
                      ("Read-only connector", "Operator", "yellow"), ("Verify in chat", "Nexus chat", "blue"),
                      ("A2A / MCP publish", "Operator + web", "blue"), ("Connect audit-nexus", "chapter 10", "green")],
                   total="Steps 1–9 take about 30 minutes; the audit-nexus work depends on the option you pick"),
    },
    "frontend": {
        "zh": dict(title="图 2　audit-nexus 接同一个知识库的三种方式",
                   app=("audit-nexus 后端", ["九安 v0.7.10 + 外壳（Node）", "「制度知识库」页、对话入口"]),
                   nexus="Nexus",
                   kb=("知识库文档管家（A2A 发布）", ["工具读写，密钥 s3vectors_kb", "发布者本人的绑定"]),
                   audit=("审核 Agent（A2A 发布）", ["动态配置里绑定只读连接器", "data_connector_query"]),
                   s3v=("S3 Vectors 向量桶", ["chunks / docs / audit"]), br=("Bedrock", ["Cohere Embed v4"]),
                   a="A　调用密钥 nxa_…（读写）", c="C　调用密钥 nxa_…（审核）", c2="只读令牌",
                   b="B　子进程 kb_cli.py · AWS 凭证文件（前端 IAM 用户）", b2="嵌入",
                   kb2="读写"),
        "en": dict(title="Figure 2  Three ways for audit-nexus to use the same knowledge base",
                   app=("audit-nexus backend", ["Jiuan v0.7.10 + shell (Node)", "policy KB page, chat entry"]),
                   nexus="Nexus",
                   kb=("KB agent (A2A publication)", ["tools read/write, key s3vectors_kb", "publisher's own binding"]),
                   audit=("Audit agent (A2A publication)", ["read-only connector in its config", "data_connector_query"]),
                   s3v=("S3 Vectors bucket", ["chunks / docs / audit"]), br=("Bedrock", ["Cohere Embed v4"]),
                   a="A  call key nxa_… (read/write)", c="C  call key nxa_… (review)", c2="read-only token",
                   b="B  subprocess kb_cli.py · AWS credentials file (app IAM user)", b2="embed",
                   kb2="read/write"),
    },
}


# ─────────────────────────────── 图 ───────────────────────────────
def fig_compare(lang):
    t = T["compare"][lang]
    s = Svg(1040, 600, f"compare-{lang}", t["title"])
    s.text(40, 46, t["left"], color=C["teal"], size=19)
    s.text(540, 46, t["right"], color=C["yellow"], size=19)
    s.line(520, 30, 520, 580, C["dim"], width=1, dash="3 6")
    lc = ["blue", "purple", "blue", "teal", "blue"]
    ly = [72, 168, 284, 404, 506]
    for (ttl, lines), col, y in zip(t["l"], lc, ly):
        box(s, 40, y, 460, C[col], ttl, lines, mono=(), title_size=15)
    s.line(270, 134, 270, 166, C["blue"], arrow=True)
    s.line(270, 230, 270, 282, C["red"], arrow=True, dash="5 4")
    for i, part in enumerate(t["carry"].split("|")):
        s.text(284, 254 + 17 * i if "|" in t["carry"] else 262, part, color=C["red"], size=13, italic=True)
    s.line(270, 368, 270, 402, C["blue"], arrow=True)
    s.line(270, 506, 270, 468, C["blue"], arrow=True)
    # 右列
    box(s, 540, 72, 460, C["blue"], t["r"][0][0], t["r"][0][1])
    box(s, 540, 196, 222, C["purple"], t["r"][1][0], t["r"][1][1])
    box(s, 778, 196, 222, C["brown"], t["r"][2][0], t["r"][2][1])
    box(s, 540, 330, 460, C["yellow"], t["r"][3][0], t["r"][3][1], dashed=True)
    box(s, 540, 452, 460, C["blue"], t["r"][4][0], t["r"][4][1])
    s.line(650, 156, 650, 194, C["purple"], arrow=True)
    s.line(889, 156, 889, 194, C["brown"], arrow=True)
    s.line(650, 280, 650, 328, C["purple"], arrow=True)
    s.text(660, 310, t["vec"], color=C["purple"], size=12.5, italic=True)
    s.line(889, 280, 889, 328, C["brown"], arrow=True)
    s.text(899, 310, t["key"], color=C["brown"], size=12.5, italic=True)
    s.line(770, 452, 770, 394, C["blue"], arrow=True)
    return s


def fig_layout(lang):
    t = T["layout"][lang]
    s = Svg(1040, 600, f"layout-{lang}", t["title"])
    s.rect(40, 30, 960, 46, C["yellow"], fill=C["panel"])
    s.text(520, 59, t["bucket"], color=C["yellow"], size=16, anchor="middle")
    filt = [["doc_id", "chunk_index", "active", "file_format", "ingested_at", "char_count", "tags"],
            ["doc_id", "status", "file_format", "chunk_count", "ingested_at", "updated_at", "tags"],
            ["operation", "doc_id", "at"]]
    nonf = [["text", "file_name"], ["file_name", "doc_hash", "embedding_model", "page_or_row_count", "quality_flag"], ["detail"]]
    for i, (ttl, sub, key, vec) in enumerate(t["idx"]):
        x, y, w = 40 + i * 330, 96, 300
        s.rect(x, y, w, 448, C["yellow"], fill=C["panel"], width=1.2)
        s.text(x + 16, y + 30, ttl, color=C["yellow"], size=17)
        s.text(x + 16, y + 54, sub, color=C["grey"], size=13)
        s.text(x + 16, y + 84, t["key"], color=C["grey"], size=13)
        s.text(x + 62, y + 84, key, color=C["text"], size=12.5, mono=True)
        s.text(x + 16, y + 108, t["vec"], color=C["grey"], size=13)
        s.text(x + 62, y + 108, vec, color=C["grey"] if i == 2 else C["purple"], size=13)
        fy = y + 126
        s.rect(x + 14, fy, w - 28, 34 + 18 * 7, C["text"], width=1.1)
        s.text(x + 26, fy + 22, t["filt"], color=C["text"], size=12.5)
        for j, k in enumerate(filt[i]):
            s.text(x + 26, fy + 44 + 18 * j, k, color=C["text"], size=12, mono=True)
        ny = fy + 34 + 18 * 7 + 14
        s.rect(x + 14, ny, w - 28, 34 + 18 * 5, C["grey"], width=1.2, dash="5 4")
        s.text(x + 26, ny + 22, t["nonf"], color=C["grey"], size=12.5)
        for j, k in enumerate(nonf[i]):
            s.text(x + 26, ny + 44 + 18 * j, k, color=C["text"], size=12, mono=True)
    s.text(40, 576, t["foot"], color=C["grey"], size=13)
    return s


def fig_ingest(lang):
    t = T["ingest"][lang]
    s = Svg(1040, 470, f"ingest-{lang}", t["title"])
    w, h, gap, x0 = 176, 92, 18, 44
    pos = []
    for i in range(5):
        pos.append((x0 + i * (w + gap), 34))
    for i in range(4):
        pos.append((x0 + i * (w + gap), 196))
    for n, ((ttl, lines, col), (x, y)) in enumerate(zip(t["steps"], pos), start=1):
        numbered(s, x, y, w, h, C[col], n, ttl, lines)
    for i in range(4):
        x, y = pos[i]
        s.line(x + w + 2, y + h / 2, x + w + gap - 3, y + h / 2, C["grey"], width=1.6, arrow=True)
    for i in range(5, 8):
        x, y = pos[i]
        s.line(x + w + 2, y + h / 2, x + w + gap - 3, y + h / 2, C["grey"], width=1.6, arrow=True)
    x5, y5 = pos[4]
    x6, y6 = pos[5]
    s.path(f"M{x5 + w / 2:.0f},{y5 + h + 2} L{x5 + w / 2:.0f},{y5 + h + 34} L{x6 + w / 2:.0f},{y5 + h + 34} L{x6 + w / 2:.0f},{y6 - 3}",
           C["grey"], width=1.6, arrow=True)
    # 失败分支
    fx, fy = pos[5][0] + w / 2, pos[5][1] + h
    s.path(f"M{fx:.0f},{fy + 2} L{fx:.0f},{fy + 40}", C["red"], width=1.6, dash="5 4", arrow=True)
    s.rect(44, fy + 44, 952, 40, C["red"], fill=C["panel"], dash="5 4")
    s.text(60, fy + 69, t["fail"], color=C["red"], size=13)
    # 凭证与实测
    yy = fy + 112
    for i, (txt, col) in enumerate(t["cred"]):
        s.line(48, yy - 5 + 24 * i, 76, yy - 5 + 24 * i, C[col], width=3)
        s.text(88, yy + 24 * i, txt, color=C[col], size=13)
    s.text(44, yy + 64, t["measured"], color=C["grey"], size=13, italic=True)
    return s


def fig_read(lang):
    t = T["read"][lang]
    s = Svg(1040, 440, f"read-{lang}", t["title"])
    ys = [40, 166, 292]
    for (ttl, lines, col), y in zip(t["paths"], ys):
        box(s, 40, y, 330, C[col], ttl, lines)
    s.rect(430, 40, 120, 334, C["yellow"], fill=C["panel"])
    s.text(490, 190, "chunks", color=C["yellow"], size=15, anchor="middle")
    s.text(490, 212, "index" if lang == "en" else "索引", color=C["yellow"], size=13, anchor="middle")
    s.text(490, 236, "1536 · cos", color=C["grey"], size=12, anchor="middle", mono=True)
    for y, col in zip(ys, ("blue", "blue", "green")):
        s.line(372, y + 40, 426, y + 40, C[col], arrow=True)
    s.text(40, 410, t["same"], color=C["grey"], size=13, italic=True)
    # 右：点阵图。方块数 = min(topK, 索引里的向量数)：少于它才是近似检索少返回
    probe = results().get("topk_probe", {})
    res, total = probe.get("rows") or [], int(probe.get("index_vectors") or 3)
    cx0, cy0 = 600, 70
    s.text(cx0, 40, t["chart"], color=C["text"], size=16)
    s.text(cx0, 62, t["chart_sub"], color=C["grey"], size=12)
    lab_w, cell = 150, 50
    for k in range(1, 6):
        s.text(cx0 + lab_w + (k - 1) * cell + 16, cy0 + 34, f"k={k}", color=C["grey"], size=12, anchor="middle", mono=True)
    for r, row in enumerate(res[:3]):
        y = cy0 + 62 + r * 62
        s.text(cx0, y + 10, t["q"][r], color=C["text"], size=13)
        for k in range(1, 6):
            got, cap = int(row["returned"].get(str(k), 0)), min(k, total)
            bx = cx0 + lab_w + (k - 1) * cell
            for j in range(cap):
                s.rect(bx + j * 12, y, 9, 9, C["yellow"], fill=C["yellow"] if j < got else None, rx=2, width=1.2)
            if got < cap:
                s.text(bx + 16, y + 30, f"{got}/{cap}", color=C["red"], size=11.5, anchor="middle", mono=True)
    s.text(cx0, cy0 + 62 + 3 * 62 + 4, t["note"], color=C["red"], size=13)
    return s


def fig_creds(lang):
    t = T["creds"][lang]
    s = Svg(1040, 470, f"creds-{lang}", t["title"])
    box(s, 30, 90, 272, C["blue"], t["host"][0], t["host"][1])
    s.rect(340, 40, 344, 200, C["blue"], width=1.2, dash="6 5")
    s.text(356, 64, t["vm"], color=C["blue"], size=14.5)
    box(s, 356, 84, 312, C["blue"], t["tool"][0], t["tool"][1])
    box(s, 780, 40, 230, C["purple"], t["br"][0], t["br"][1])
    box(s, 780, 160, 230, C["yellow"], t["s3v"][0], t["s3v"][1])
    s.line(304, 140, 352, 140, C["brown"], arrow=True, width=2.2)
    s.text(328, 130, t["grant"], color=C["brown"], size=12, anchor="middle")
    s.line(670, 108, 776, 82, C["purple"], arrow=True, width=2.2)
    s.text(716, 84, t["role"], color=C["purple"], size=12, anchor="middle")
    s.line(670, 162, 776, 206, C["brown"], arrow=True, width=2.2)
    s.text(716, 224, t["k"], color=C["brown"], size=12, anchor="middle")
    s.rect(340, 262, 344, 60, C["red"], fill=C["panel"], dash="5 4")
    for i, ln in enumerate(t["deny"]):
        s.text(356, 286 + 21 * i, ln, color=C["red"], size=12.5)
    box(s, 30, 356, 340, C["blue"], t["conn"][0], t["conn"][1])
    s.path("M372,398 L895,398 L895,265", C["yellow"], width=2, arrow=True)
    s.text(630, 390, t["conn_arrow"], color=C["yellow"], size=12.5, anchor="middle", mono=True)
    return s


def fig_steps(lang):
    t = T["steps"][lang]
    s = Svg(1040, 330, f"steps-{lang}", t["title"])
    w, h, gap, x0 = 176, 84, 18, 44
    for i, (ttl, how, col) in enumerate(t["s"]):
        r, c = divmod(i, 5)
        x, y = x0 + c * (w + gap), 34 + r * 140
        numbered(s, x, y, w, h, C[col], i + 1, ttl, [(how, "grey")])
        if c < 4:
            s.line(x + w + 2, y + h / 2, x + w + gap - 3, y + h / 2, C["grey"], width=1.6, arrow=True)
    x4, x5 = x0 + 4 * (w + gap) + w / 2, x0 + w / 2
    s.path(f"M{x4:.0f},{34 + h + 2} L{x4:.0f},{34 + h + 28} L{x5:.0f},{34 + h + 28} L{x5:.0f},{174 - 3}", C["grey"], width=1.6, arrow=True)
    s.text(44, 306, t["total"], color=C["grey"], size=13, italic=True)
    return s


def fig_frontend(lang):
    t = T["frontend"][lang]
    s = Svg(1040, 500, f"frontend-{lang}", t["title"])
    box(s, 30, 170, 240, C["green"], t["app"][0], t["app"][1])
    s.rect(320, 30, 384, 300, C["blue"], width=1.2, dash="6 5")
    s.text(336, 56, t["nexus"], color=C["blue"], size=15)
    box(s, 342, 72, 340, C["blue"], t["kb"][0], t["kb"][1])
    box(s, 342, 206, 340, C["blue"], t["audit"][0], t["audit"][1])
    box(s, 790, 110, 220, C["yellow"], t["s3v"][0], t["s3v"][1])
    box(s, 790, 300, 220, C["purple"], t["br"][0], t["br"][1])
    # A：后端 → 知识库 Agent → S3 Vectors
    s.path("M272,196 L298,196 L298,112 L338,112", C["blue"], width=2.2, arrow=True)
    s.text(288, 150, t["a"], color=C["brown"], size=12.5, anchor="end")
    s.path("M684,112 L740,112 L740,140 L786,140", C["blue"], width=2.2, arrow=True)
    s.text(744, 104, t["kb2"], color=C["blue"], size=12)
    # C：后端 → 审核 Agent → 连接器只读
    s.path("M272,226 L298,226 L298,246 L338,246", C["blue"], width=2.2, arrow=True)
    s.text(162, 290, t["c"], color=C["brown"], size=12.5)
    s.path("M684,246 L752,246 L752,170 L786,170", C["yellow"], width=2, arrow=True, dash="6 4")
    # B：后端直连 S3 Vectors 与 Bedrock
    s.path("M150,252 L150,420 L766,420 L766,188 L786,188", C["brown"], width=2.2, arrow=True)
    s.path("M766,340 L786,340", C["purple"], width=1.8, arrow=True)
    s.text(758, 362, t["b2"], color=C["purple"], size=12, anchor="end")
    s.text(458, 446, t["b"], color=C["brown"], size=13, anchor="middle")
    return s


FIGURES = {"compare": fig_compare, "layout": fig_layout, "ingest": fig_ingest, "read": fig_read, "creds": fig_creds,
           "steps": fig_steps, "frontend": fig_frontend}


def svg(name, lang, background=True):
    return FIGURES[name](lang).render(background=background)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(HERE), "assets")
    os.makedirs(out, exist_ok=True)
    for name in FIGURES:
        for lang in ("zh", "en"):
            with open(os.path.join(out, f"fig-{name}.{lang}.svg"), "w", encoding="utf-8") as fh:
                fh.write(svg(name, lang))
    print("wrote", 2 * len(FIGURES), "figures to", out)


if __name__ == "__main__":
    main()
