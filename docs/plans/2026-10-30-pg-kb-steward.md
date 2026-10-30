# 知识库文档管家（PG 版）与 PG 知识库换 Cohere v4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nexus 上新建并发布 `knowledgebase_writer_agent_pg`（「知识库文档管家（PG 版）」）：经 A2A 的 `kb.rules/v1` 把 Word / Excel / PDF / Markdown 解析成一行一条的记录写进 `approval_rules`，向量只由库里的 `kb_embed` 生成；整个 PG 知识库换成 Bedrock Cohere Embed v4，审核 Agent 的检索不变差。

**Architecture:** `kb/lib/` 是共享核心：`doc_blocks`（四种格式 → 块）、`parse_rules`（块 → 审批矩阵，输出与现在逐条相同）、`clauses` + `kb_parse`（其余文字 → 正文条款，整份文档的解析入口）、`kb_store`（对比、冲突、一个事务里写入、下线 / 恢复 / 删除、校验）。`ingest_rules.py` / `kb_admin.py` 变成调 `kb_store` 的薄命令行。工具包 `knowledgebase-writer-agent-pg/` 的 `pg_kb_tools.py` 只是 `@tool` 入口，`build_tools.py` 把核心模块逐个文件原样放进同一个工具目录（平台把它装成一个包，模块间相对 import）。向量：库里的 `kb_embed_impl`（PL/Python，唯一调 Bedrock 的地方）+ 两个薄包装 `kb_embed` / `kb_embed_batch`。

**Tech Stack:** Python 3.12（`kb/lib` 标准库 + psycopg 3；PDF 用 pdfplumber；本机测试 `unittest` + PGlite/pgvector）；PostgreSQL + pgvector + PL/Python（现有容器）；bash + AWS CLI v2（SSM、CloudFormation）；Node 24（`node --test` 契约测试、A2A 小工具）；Nexus v0.3.28（Operator、管理员脚本）。

**Spec:** `docs/specs/2026-10-30-pg-kb-steward-design.md`（已确认，10-30 修订）；接口约定 `docs/specs/2026-10-30-pg-knowledgebase-agent-contract.md`（另一个会话写的，测试台照它接）。

## Global Constraints

- 工作区 `application-deploy/audit-nexus-pgkb`，分支 `feat/pg-kb-steward`；不动 `../audit-nexus` 的工作目录。
- 顺序：Task 1–6 只在本机，现在就做。另一个会话的 Task 20–22 提交后，把本分支并到它的最新提交（`git stash push -u` → `git merge --ff-only feat/v0710-kb-review-advice` → `git stash pop`，有冲突就解决并重跑全部测试），再做 Task 7 起。线上各步排在它的 Task 18 之前；做完把发布编号交给它（配置键 `KB_PG_PUBLICATION_ID`）。
- **不提交**：每个 Task 结束只跑测试，不 `git commit`。本机测试与线上端到端都通过、项目负责人确认后，Task 12 才提交；不推送，除非项目负责人要求。
- 接口约定优先于本计划；两者冲突时照约定做，并告诉项目负责人。
- 向量只由库里的 `kb_embed` / `kb_embed_batch` 生成。工具和 `kb/lib` 都不 import boto3、不调 Bedrock。唯一的例外是 `ingest_rules.py --embed bedrock` 原有的 Titan 路径。
- Cohere v4：PG 里用 `us.cohere.embed-v4:0`。请求体是 `{"texts", "input_type", "embedding_types": ["float"], "output_dimension": 1024, "truncate": "END"}`；`input_type` 入库用 `search_document`、`kb_search` 的问句用 `search_query`；每次请求 ≤ 96 条。`kb_meta.embed_model` 记模型族 `cohere.embed-v4:0`（去掉 `us.` / `global.` 前缀），`embed_dim` 记 `1024`。
- 每分钟新向量上限：`kb_embed` 300 个，`kb_embed_batch` 2,000 个。两者分开计数，只数缓存没命中、真去调 Bedrock 的。一份文档至多 2,000 条记录，超了报 `too_many_records`。
- `kb/lib` 模块彼此引用只用这一种写法（要同时支持三种用法：`python -I` 当脚本跑、同目录的脚本 import 它、工具包里相对 import）：
  ```python
  if __package__:
      from . import doc_blocks
  else:  # python -I kb/lib/<脚本>.py：-I 不把脚本所在目录放进 sys.path
      sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
      import doc_blocks
  ```
- `kb/lib` 只用标准库，外加 psycopg 3（`kb_store`）和 pdfplumber（只在读 PDF 时 import）。不用 psycopg2、python-docx、openpyxl；openpyxl、reportlab 只用在测试里生成夹具。
- 核心模块里不许有顶层函数叫 `rules_writer` / `rules_search` / `rules_manager`。平台导入时按函数名找文件，重名会指错。
- 制度标识 `^[a-z0-9][a-z0-9-]{1,62}$`；`source_tag` = `source_id`；`source_doc` = `title`，没给就用附件文件名。
- 正文条款：一块超过 600 字就按句子拆成 `-a`、`-b`…；没编号的散文按段落合并，每块 ≤ 400 字。
- 工具的密钥：`key_name=pg_kb`、`key_type=database_credentials`，字段 `host` / `port` / `database` / `username` / `password`。连接超时 5 秒。绑定 Nexus 密钥 `key-a015b93ad361`（`pgvector-10.0.1.38`）。没拿到密钥就报 `credentials_missing`，不回落到默认凭据。
- 失败回复一律是 `{"success": false, "error_type", "message", "suggestion"?}`，`rule_conflict` 另带 `conflicts`。错误里不带密码、连接串、主机名、端口、ARN、账号。时间一律 ISO 8601（UTC）。
- 测试文档全部虚构，由测试现生成。真实制度只在本机，路径经 `KB_REAL_DOC` 给。它的内容和派生物（解析结果、检索题库、检索结果）不进仓库、日志、截图。题库从 `KB_QUESTIONS_DIR` 读，结果写到仓库外。
- 线上：每个线上 Task 先出计划或 `--dry-run` 给项目负责人看，同意后才写。删除类操作另行确认。`--yes` 只用在同意了的那一步。
- 密钥和调用密钥只经管理员脚本的内存与 600 文件，不打印、不进聊天、不进仓库。
- 本机端口 8765 是项目负责人的服务，不碰。PGlite 用 55432。
- 本机测试命令（下文用 `$KBPY` 指代）：`KBPY="uv run --no-project --python 3.12 --with psycopg --with psycopg-binary --with pdfplumber --with reportlab --with openpyxl --with pyyaml python -B"`。zsh 下用 `${=KBPY}` 展开。

## Review Focus

1. **`deploy.sh` 的入库和 Agent 的入库同时发生**：后到的一方等锁，不会两边各写一半。Task 4 的 `lock_first_in_both_paths` 钉住。
2. **真实制度先经 `deploy.sh` 入过库，再经 Agent 用同一个标识、同一个 `title` 入库**：全部 `unchanged`，一条不写。两条路的 `record_sha256` 要一致：`source_doc` 的取法、字段、JSON 序列化都相同。Task 6 的 `cross_path_unchanged` 钉住。
3. **文件和扩展名不符，或者读不出**：.doc 改名成 .docx、加密的 .xlsx（OLE 容器）、扫描件 PDF、GBK 编码的 .md、空文件、坏 zip。都要回明确的错误码，一条不写，`kb_documents` 里不留半截。Task 1 的 `odd_files` 钉住。
4. **这份制度已下线（在归档表里）时又来入库**：回 `source_inactive`「先恢复或删除」，一条不写，不出现「在线一份、归档一份」。Task 4 钉住。
5. **撞上每分钟上限**（`kb_search` 60 次、`kb_embed_batch` 2,000 个新向量）：回 `rate_limited`，并建议一分钟后再试。不能当成「0 条结果」，也不能崩。回归脚本自己限速。Task 6 的 `rate_limited` 和 Task 5 的限速测试钉住。

---

### Task 1: `doc_blocks` 与 `parse_rules` 重构（输出逐条不变）

**Files:**
- Create: `kb/lib/doc_blocks.py`、`kb/tests/sample_docs.py`（虚构夹具生成器）、`kb/tests/test_doc_blocks.py`、`kb/tests/fixtures/sample-matrix.expected.json`、`kb/tests/parity_real_doc.py`
- Modify: `kb/lib/parse_rules.py`、`kb/tests/test_parse_rules.py`

**Interfaces:**
- Produces:
  - `doc_blocks.DocError(code: str, message: str)`（`Exception`，带 `.code`、`.message`）。错误码：`unsupported_format`、`empty_document`、`no_text_layer`、`encoding_unsupported`、`pdf_parser_unavailable`、`file_too_large`（> 50 MB）。
  - `doc_blocks.read(path: str) -> tuple[list[dict], dict]`。
    - 块按原文顺序排列，形如 `{"i": int, "kind": "para"|"heading"|"table", "text": str, "level": int|None, "cells": list[list[list]]|None, "loc": dict}`。
    - `para` / `heading` 的 `text` 已经过 `norm()`。
    - `table` 的 `cells[r][c] = [文字, vmerge]`，`vmerge` ∈ `None` / `"restart"` / `"continue"`，语义与现在的 `table_grid` 相同。
    - `loc`：xlsx 是 `{"sheet"}`，pdf 是 `{"page"}`，md 是 `{"line"}`，docx 是 `{}`。
    - 第二个返回值 `info = {"format": "docx"|"xlsx"|"pdf"|"md", "pages": [{"page", "chars"}]（pdf）, "sheets": [名字]（xlsx）}`。
  - 格式按内容判断，不只看扩展名：zip 里有 `word/document.xml` 是 docx，有 `xl/workbook.xml` 是 xlsx；`%PDF-` 开头是 pdf；OLE 头 `D0 CF 11 E0`、坏 zip、`.doc` / `.xls` 都报 `unsupported_format`；`.md` / `.markdown` 按 UTF-8 读，去掉 BOM。
  - 各格式的块：
    - docx 只认 `w:body` 的直接子元素 `w:p` / `w:tbl`，与现在相同；带标题样式（`Heading1..9`、`标题 1..9`）的段落是 `heading`。
    - xlsx 用标准库 zipfile + ElementTree 读。每个工作表先出一个 `heading`（level 1，文字 = 工作表名），再出一张表；合并区域的左上格 `restart`，竖向的后续格 `["", "continue"]`。
    - md：`#` 的个数就是 `level`；管道表格跳过对齐行，`\|` 不当分隔。
    - pdf 用 pdfplumber，按页出段落和表格。
  - `doc_blocks.text_of`、`table_grid`、`norm` 从 `parse_rules.py` 挪过来；`parse_rules` 再导出同名函数，老的 import 照常能用。
  - `parse_rules.parse_blocks(blocks) -> MatrixParse`，其中 `MatrixParse` 是 `namedtuple("MatrixParse", "general notes matrix used orphans")`。
    - `used` 是被矩阵解析用掉的块号集合，包括章标题、「制度说明」「图例说明」这两个标题、章节说明段落、矩阵表。
    - `orphans` 是表头像矩阵、但前面没有章标题的表的块号。
  - `parse_rules.parse(src) -> (general, notes, matrix)`：签名、输出与重构前逐条相同；`main` 不变。
- Consumes: 无。

- [ ] **Step 1: 先用重构前的解析器存一份基准**：`python3 -I kb/lib/parse_rules.py kb/tests/fixtures/sample-matrix.docx kb/tests/fixtures/sample-matrix.expected.json`。夹具是虚构的，可以进仓库。
- [ ] **Step 2: 写测试**
  - `test_parse_rules.py`：
    - `test_matches_golden`：`parse(fixture)` 拼成的列表 == `expected.json`，整条记录逐字段相同。
    - `test_matrix_same_in_xlsx_and_md`：`sample_docs.matrix_xlsx()`、`matrix_md()` 与 docx 夹具前两章内容相同，工作表名 / 标题照 docx 的章标题写。它们矩阵行的 `(rule_id, content)` 与 docx 的完全相同。
    - `test_orphan_matrix_table`：工作表名不是「X、」的矩阵 xlsx，`orphans == [那张表的 i]`，`matrix == []`。
  - `test_doc_blocks.py`：
    - `test_docx_order_and_headings`：生成的 docx 有标题 1 / 2 和表格，块的顺序、`kind`、`level` 都对。
    - `test_xlsx_merges_and_sheets`：两个工作表；A2:A3 合并时，`cells[2][0] == ["", "continue"]`。
    - `test_md_bom_crlf_tables`：带 BOM、CRLF、`## 三、合同用印`、管道表格（含 `\|`）。
    - `test_pdf_pages`：reportlab 现生成两页中文 PDF（`UnicodeCIDFont('STSong-Light')`）。先自检 pdfplumber 读回的文字等于原文；读不回就换字体做法，但自检必须保留。`info.pages` 的字数对得上。
    - `test_odd_files`（Review Focus 3）：
      - OLE 头的「.docx」、`.xls`、坏 zip → `unsupported_format`；
      - 只有一个矩形的 PDF → `no_text_layer`；
      - GBK 的 .md → `encoding_unsupported`；
      - 0 字节 → `empty_document`。
  - `parity_real_doc.py`（只在本机跑，不进测试集）：用 `git show 19e5bf9:kb/lib/parse_rules.py` 写进临时目录当旧解析器，对 `KB_REAL_DOC` 跑新旧两个。只打印 `{"old": n, "new": n, "identical": bool}`，不打印任何内容。
- [ ] **Step 3: 跑** `${=KBPY} -m unittest discover -s kb/tests -v`，新用例 FAIL（`doc_blocks` 不存在）。
- [ ] **Step 4: 实现** `doc_blocks.py`，再把 `parse_rules.parse()` 改成 `parse_blocks(read(src)[0])` 加一层薄包装。矩阵逻辑原样搬进 `parse_blocks`：段落和标题都按现在段落的规则处理，表格读 `cells`。
- [ ] **Step 5: 跑** Step 3 的命令，全部 PASS（含原有的 `test_fixture_is_current`、`test_report_line_and_rules`）；`python3 -I kb/lib/parse_rules.py kb/tests/fixtures/sample-matrix.docx /tmp/x.json` 的 REPORT 行与 Step 1 的相同；有 `KB_REAL_DOC` 时 `python3 -I kb/tests/parity_real_doc.py` 打印 `"identical": true` 和 102。

### Task 2: 正文条款 `clauses` 与整份文档的入口 `kb_parse`

**Files:**
- Create: `kb/lib/clauses.py`、`kb/lib/kb_parse.py`、`kb/tests/test_clauses.py`
- Modify: `kb/tests/sample_docs.py`（加正文夹具）、`kb/tests/parity_real_doc.py`（加 `parse_document` 的检查）

**Interfaces:**
- Consumes: Task 1 的 `doc_blocks.read`、`DocError`、`parse_rules.parse_blocks` / `MatrixParse`。
- Produces:
  - `clauses.clause_records(blocks: list[dict], skip: set[int], *, source_tag: str, doc_title: str) -> tuple[list[dict], dict]`。
    - 记录的字段是 `approval_rules` 除 `embedding`、`source_*`、`record_sha256` 之外的全部列；`rule_type` 为 `clause`。
    - 第二个返回值是报告的一部分：`{"clause", "table_row", "paragraph", "split": [编号], "renumbered": [编号], "skipped": {"cover": n, "revision_tables": n}, "empty_or_garbled": [块号]}`。
  - `kb_parse.PARSER_VERSION = "1"`、`kb_parse.MAX_RECORDS = 2000`。
  - `kb_parse.parse_document(path: str, *, source_tag: str, doc_title: str) -> tuple[list[dict], dict]`：矩阵（`parse_blocks`）+ 剩下的块交给 `clause_records`。
    - 报告：`{"parser_version", "format", "general", "chapter_notes", "matrix", "clause", "table_row", "paragraph", "total", "chapters": [{"no","title","rows"}], "duplicates", "without_path", "split", "renumbered", "skipped", "tables": {"matrix", "other"}, "pages"?, "warnings": [...]}`。
    - 抛 `DocError`：`matrix_chapter_missing`（有 `orphans`）、`duplicate_rule_ids`、`too_many_records`、`empty_document`（一条记录都没有）。
    - PDF 里认出矩阵时，`warnings` 加「PDF 的合并单元格常读不全，审批矩阵请用 Word / Excel」。

**切分与编号**（`<标识>-` 之后的部分；矩阵文档里「X、」已经是章，只看矩阵之外的块）：

| 结构 | 编号 |
|---|---|
| 第十二条 | `A12` |
| 章、节下第一条之前的正文 | `CH3`、`CH3.2` |
| 三、（二） / 只有 三、 | `S3.2` / `S3` |
| 1.2.3 / 1. | `N1.2.3` / `N1` |
| （1）、（一） | 是小项，跟着上一级走；文档开头就是小项时按 `N1` 编 |
| Markdown / Word 标题下的正文（没有更细的标记） | `H<各级序号>`，例如 `H2.3` |
| 完全没有编号的段落 | `P001`…（合并到 ≤ 400 字） |
| 不是矩阵、也不是修改记录的表，每行一条 | `T<表序号>.<行号>`，文字为「表头：值；…」 |
| 超过 600 字拆开 | 加 `-a`、`-b`…（在 。！？；处断） |
| 同一文档里条号重复 | 第二个起加 `~2`、`~3`，写进 `renumbered` |

- 字段：
  - `chapter` =「章 › 节」；`chapter_no` = 章号（没有就是 `None`）；`seq_no` = 条号；
  - `business_item` = 条标题，没有就取首句，至多 40 字；
  - `scope_controls` = 条文（含跟着走的小项）；
  - `content` =「文档名 › 章 › 节 › 第 X 条：条文」（只写存在的层级）；
  - `extra = {"kind": "clause"|"table_row"|"paragraph", "page"?, "sheet"?, "row"?, "part"?}`。
- 不入库的块：
  - 封面：从文档开头起连续的、没有条款标记的短段落（≤ 40 字），遇到第一个有标记的段落、标题、被矩阵用掉的块或长段落就停；
  - 修改记录表：首行或紧挨着的前一个段落含「修改记录 / 修订记录 / 版本记录」。
  - 真实制度的计数由 `parity_real_doc.py` 钉住（`cover == 4`、`revision_tables == 1`）。阈值不对就调，不要改计数。

- [ ] **Step 1: 写测试** `test_clauses.py`，夹具都由 `sample_docs` 现生成：
  - `test_article_ids`：「第一章 总则 / 第一条…第十二条」的 docx → `travel-A1`…`travel-A12`；`chapter == "第一章 总则"`、`seq_no == "12"`；`content` 以「差旅管理办法 › 第一章 总则 › 第十二条：」开头。
  - `test_numbered_items`：`三、（二）` → `S3.2`；`1.2.3` → `N1.2.3`；条下的（一）（二）留在那一条里。
  - `test_long_clause_split`：1,500 字的一条 → `A5-a`、`A5-b`、`A5-c`，每段 ≤ 600 字、都在句末断开；`report.split == ["travel-A5"]`。
  - `test_markerless_prose`：只有段落的 md → `P001`…，每块 ≤ 400 字。
  - `test_md_headings`：只有标题和段落的 md → `H` 编号，`chapter` 是标题路径。
  - `test_duplicate_article_numbers`：两个「第三条」→ `A3`、`A3~2`，写进 `renumbered`。
  - `test_cover_and_revision_log_skipped`：4 行短封面 + 一张「文档修改记录」表 + 矩阵各章 → 没有 `clause` 记录；`skipped == {"cover": 4, "revision_tables": 1}`；`total` 等于 `parse_rules` 的条数。
  - `test_non_matrix_table_rows`：表头不是矩阵的 xlsx → `table_row` 记录 `T1.1`…，文字为「表头：值；…」。
  - `test_document_errors`：没有章的矩阵 xlsx → `matrix_chapter_missing`；2,001 条 → `too_many_records`；只有封面的文档 → `empty_document`。
  - `test_pdf_matrix_warning`：PDF 里的矩阵表 → `warnings` 有那句提醒。
  - `test_report_has_parser_version`。
- [ ] **Step 2: 跑** `${=KBPY} -m unittest kb/tests/test_clauses.py -v`，FAIL。
- [ ] **Step 3: 实现** `clauses.py`、`kb_parse.py`。中文数字到 999 都要能换成整数。
- [ ] **Step 4: 跑** 全部 kb 测试 PASS；有 `KB_REAL_DOC` 时 `parity_real_doc.py` 另打印 `parse_document` 的 `{"total": 102, "clause": 0, "skipped": {"cover": 4, "revision_tables": 1}}`。

### Task 3: `kb_search.sql`：Cohere v4、`kb_embed_batch`、`kb_meta`、打平规则、迁移与回退；PGlite 测试底座

**Files:**
- Modify: `kb/sql/kb_search.sql`、`kb/sql/approval_rules.sql`（表注释补上 `clause`）
- Create: `kb/sql/migrate_embeddings.sql`、`kb/sql/restore_embeddings.sql`、`kb/tests/test_kb_embed_impl.py`、`kb/tests/pg_harness.py`、`kb/tests/fake_kb_embed.sql`、`kb/tests/run_pglite.sh`、`kb/tests/test_kb_search_pg.py`

**Interfaces:**
- Produces（SQL）：
  - `kb_embed_impl(inputs text[], purpose text, via text, cap int) RETURNS vector[]`：PL/Python、`SECURITY DEFINER`，只有超级用户能执行，夹在 `-- >>> kb_embed_impl` 和 `-- <<< kb_embed_impl` 两行标记之间。
    - 唯一调 Bedrock 的代码：模型 id 含 `cohere` 发 Cohere 请求体（每次 ≤ 96 条），含 `titan` 发 Titan 请求体（逐条，忽略 `purpose`）。
    - 缓存键 = `sha256(模型|维度|用途|文本)`。
    - `purpose` 只能是 `search_document` / `search_query`。
    - 上限只数 `kb_embed_cache` 里同一 `via`、一分钟内新建的行；缓存表加列 `via text NOT NULL DEFAULT 'single'`。
    - 错误照现有的 `clean()` 去掉 ARN 和账号。
  - `kb_embed(input text, purpose text DEFAULT 'search_document') RETURNS vector`：SQL 包装，`via='single'`，`cap=300`，单条 ≤ 8,000 字。先 `DROP FUNCTION IF EXISTS kb_embed(text)`。
  - `kb_embed_batch(inputs text[], purpose text DEFAULT 'search_document') RETURNS vector[]`：顺序与输入相同，`via='batch'`，`cap=2000`，至多 2,000 条。调用方写 `SELECT kb_embed_batch(%s::text[], 'search_document')::text[]`。
  - `kb_meta(key text PRIMARY KEY, value text NOT NULL)`：属主是超级用户，应用用户只有 `SELECT`。`kb_search.sql` 只在没有 `kb_meta` 行、且表里没有向量（新库）时写入 `embed_model` / `embed_dim` / `switched_at`。
  - `kb_search`：问句改用 `kb_embed(question, 'search_query')`，排序改成 `ORDER BY rhits DESC, (r.rule_type = 'clause') ASC, r.embedding <=> q`。返回列与授权照旧。
  - `migrate_embeddings.sql`（占位符 `{table}`、`{model_family}`、`{dim}`）：与 `kb_search.sql` 拼在一起，由 `psql -v ON_ERROR_STOP=1 -1` 在一个事务里执行。
    - 备份表 `{table}_titan_backup` 已存在就报错退出。
    - 备份表 = `{table}` 和 `{table}_archive`（有的话）的 `rule_id`、`md5(content)`、`embedding`、所在表名。
    - 清空 `kb_embed_cache`。
    - 两张表都用 `kb_embed_impl(…, 'search_document', 'migrate', 100000)` 重算。
    - upsert `kb_meta`。
  - `restore_embeddings.sql`：同样一个事务，跟在 Titan 配置的 `kb_search.sql` 后面执行。
    - `md5(content)` 与备份一致的行拷回旧向量，其余的用当前（Titan）的 `kb_embed_impl` 重算。
    - 清空缓存，`kb_meta` 改回 Titan 的模型族。
- Produces（测试底座）：
  - `run_pglite.sh [port]`：在 `${XDG_CACHE_HOME:-$HOME/.cache}/kb-pglite` 里装 PGlite、pglite-socket 和 pgvector 扩展（没装才装），然后前台运行 `pglite-server --port=<port>`，带上 vector 扩展。做法照本机记录，包名以实际装出来的为准。
  - `pg_harness.schema_sql(model: str = "us.cohere.embed-v4:0", dim: int = 1024, table: str = "approval_rules") -> str`：`approval_rules.sql` + `kb_search.sql`。
    - 去掉 `CREATE EXTENSION plpython3u`；
    - 标记之间的 `kb_embed_impl` 换成 `fake_kb_embed.sql`；
    - 占位符照填，`{app_user}` = `postgres`。
  - `pg_harness.connect()`：读 `KB_TEST_PG_PORT`，没设就 `unittest.SkipTest`。`pg_harness.reset(conn, **schema_kw)`：删光再按 `schema_sql` 重建。
  - `fake_kb_embed.sql`：plpgsql 版的 `kb_embed_impl`。
    - 向量 = 对 `模型|用途|文本|k`（k = 0…31）做 sha256，每字节减去 127.5，再归一化；同样的输入永远得到同样的向量，换模型就变。
    - 每算一个向量，就在 `kb_fake_embed_calls` 里记一行。
    - 文本含 `__FAIL__` 时照真函数的样子报「kb_embed：Bedrock 返回 500」。

- [ ] **Step 1: 写测试**
  - `test_kb_embed_impl.py`（不连库）：照填占位符后，把 `kb_embed_impl` 的 `$$…$$` 函数体包成 Python 函数，配上假的 `plpy`、`SD`、`urllib.request.urlopen`、`botocore`（session / auth / awsrequest）。用例：
    - `cohere_body_exact`：请求体与全局约束逐字段相同。
    - `batches_of_96_in_order`：200 个没命中的 → 3 次请求（96 / 96 / 8），结果顺序与输入一致。
    - `cache_hits_skip_bedrock`。
    - `cache_key_includes_model_dim_purpose`。
    - `bad_purpose_rejected`。
    - `caps_counted_per_via`：`batch` 用满 2,000 后，`single` 照样能调。
    - `titan_body_unchanged`：`{"inputText", "dimensions", "normalize": true}`，逐条请求。
    - `errors_redacted`：403 的错误文本里有 ARN 和 12 位账号，报出来的都被替换。
  - `test_kb_search_pg.py`（PGlite）：
    - `tie_break_prefers_rules_over_clauses`：一条 `clause` 的 `content` 就是问句本身（距离 0），一条矩阵行关键词命中数相同 → 矩阵行排第一。
    - `more_hits_still_win`：`clause` 命中数更多时排第一。
    - `no_clauses_same_order_as_before`：没有 `clause` 时，结果与旧排序（`ORDER BY rhits DESC, embedding <=> q`）的参考查询相同。
    - `batch_equals_single`：`kb_embed_batch(ARRAY[a, b])[1] = kb_embed(a)`。
    - `migrate_then_restore`：用 Titan 的 `schema_sql` 建库写几行（含一行归档）→ 换成 Cohere 的 `kb_search.sql` 加迁移 → 两张表全是 Cohere 的假向量，备份表行数对，`kb_meta` 已写。之后新增一行、改一行 `content` → 回退 → 没改的拷回旧向量，新增和改过的按 Titan 重算，`kb_meta` 改回。
    - `migrate_refuses_existing_backup`。
- [ ] **Step 2: 跑** 先在另一个终端 `bash kb/tests/run_pglite.sh 55432`，然后 `KB_TEST_PG_PORT=55432 ${=KBPY} -m unittest kb/tests/test_kb_embed_impl.py kb/tests/test_kb_search_pg.py -v`，FAIL。
- [ ] **Step 3: 实现** SQL 的改动和测试底座。
- [ ] **Step 4: 跑** Step 2 的命令 PASS；不设 `KB_TEST_PG_PORT` 时 PG 用例显示 skipped，其余全过。

### Task 4: `kb_store`；`ingest_rules.py` 与 `kb_admin.py` 改成薄命令行

**Files:**
- Create: `kb/lib/kb_store.py`、`kb/tests/test_kb_store.py`（不连库）、`kb/tests/test_kb_store_pg.py`（PGlite）
- Modify: `kb/lib/ingest_rules.py`、`kb/lib/kb_admin.py`（`kb/tests/test_kb_admin.py` 不改，要照过）

**Interfaces:**
- Consumes: Task 3 的 SQL 与 `pg_harness`；`kb_parse` 的记录。
- Produces（`kb_store`）：
  - `KbError(code: str, message: str, **extra)`，带 `.code`、`.message`、`.extra`（`rule_conflict` 时 `extra["conflicts"]`）。
  - `COLUMNS`、`JSONB`、`record_hash(row) -> str`：原样从 `ingest_rules.py` 挪过来，哈希值不变。`TAG_RE`。
  - `connect(creds: dict, *, application_name: str, timeout: int = 5) -> psycopg.Connection`：字段名用密钥的字段名。
  - `ensure_owner(cur, table) -> None`：属主不对时抛 `table_owner`。
  - `embed_model(cur) -> dict | None`：返回 `{"model": 模型族, "dim": int}`；没有 `kb_meta` 就是 `None`。
  - `prepare(records, *, source_tag, source_doc, source_version) -> list[dict]`：补上三个来源字段与 `record_sha256`。
  - `ingest(conn, table, rows, *, source_tag, document_id=None, prune=True, dry_run=False, embed="sql") -> dict`。
    - 一个事务。第一条语句是 `SELECT pg_advisory_xact_lock(hashtext('kb_ingest:' || %s))`（参数是表名）。
    - 之后依次：归档表里有这个标签 → `source_inactive`；对比；有冲突 → `rule_conflict`（回滚）；`dry_run` 就到此为止，不算向量；
    - 要写的向量由 `kb_embed_batch` 一次算出（`embed` 也可以传一个 `fn(texts) -> list[str]`，只给 Titan 的 `--embed bedrock` 用）；
    - upsert、只改说明的更新、清理；给了 `document_id` 就把那一行改成 `ingested`，同标签的旧行改成 `superseded`。
    - 返回 `{"rules_total", "inserted", "updated", "reembedded", "unchanged", "removed", "will_insert": [编号], "will_update": [编号], "will_remove": [编号]}`。其中 `updated` 是不重算向量的更新，`reembedded` 是 content 变了、重算向量的。
    - 冲突规则照现在的：编号属于别的标签，或者没有标签且 `source_doc` 不同。没有标签、`source_doc` 相同的就认领过来。
  - 上传历史的函数，SQL 原样从 `kb_admin.py` 挪过来：
    - `record_document(cur, *, file_name, sha256, size_bytes, uploaded_by, source_tag, doc_title, source_version, report, status="parsed") -> int`
    - `set_document_status(cur, doc_id, status, *, result=None, error=None)`
    - `recover(cur, minutes=30)`、`history(cur, limit)`、`show(cur, doc_id)`、`tags(cur, table)`、`search(cur, question, k, segment, caller)`、`search_log(cur, limit)`
  - 管理：
    - `ensure_archive(cur, table)`：`CREATE TABLE IF NOT EXISTS {table}_archive (LIKE {table} INCLUDING DEFAULTS)`，再补列 `archived_at timestamptz`。
    - `list_sources(cur, table) -> list[dict]`：字段照约定，另带 `by_type`。
    - `source_detail(cur, table, tag) -> dict | None`：`{"source": …, "rule_ids": […]}`。
    - `deactivate(conn, table, tag) -> int`、`restore(conn, table, tag) -> int`：编号已被占用时抛 `rule_conflict`，一条不挪。
    - `delete(conn, table, tag) -> int`：删两张表的行和这个标签在 `kb_documents` 里的登记，返回删掉的规则条数。
    - `check(cur, table, tag=None) -> dict`：返回 `{"ok", "problems": [{"code", "source_id", "detail"}]}`。`code` ∈ `missing_embedding` / `wrong_dimension` / `untagged` / `duplicate_rule_id` / `stuck_ingest` / `count_mismatch` / `kb_meta_missing` / `embedding_drift`。最后一项是抽 3 行用 `kb_embed(content, 'search_document')` 重算，余弦 < 0.999 就报。
- Produces（命令行）：
  - `ingest_rules.py`：参数、DDL 执行、输出的 JSON 摘要（键名、条数口径）都与现在相同。`--embed sql` 走 `kb_store.ingest(embed="sql")`。`--embed bedrock` 只留给 Titan：先读 `kb_meta`，不是 Titan 就报 `embedding_model_mismatch`；`--model` 是 Cohere 时退出，提示改用 `--embed sql`。
  - `kb_admin.py`：每个子命令改成调 `kb_store`，输出不变。

- [ ] **Step 1: 写测试**
  - `test_kb_store.py`（不连库，用 `test_kb_admin.py` 那种假游标）：
    - `lock_first_in_both_paths`（Review Focus 1）：`ingest_rules` 路径和工具路径进入 `kb_store.ingest` 后，第一条语句都是那句 advisory lock，参数相同。
    - `record_hash_frozen`：夹具第一条记录的哈希等于重构前算出的值（写死在测试里）。
    - `sql_is_parameterised`：值都不拼进 SQL，表名先过 `[a-z_][a-z0-9_]*` 校验。
  - `test_kb_store_pg.py`（PGlite，用 `parse_document` 读虚构夹具）：
    - 新增 → 再来一次全部 `unchanged`，而且 `kb_fake_embed_calls` 不增加；
    - 只改 `scope_controls` 以外不进 `content` 的列 → `updated`，向量不变；
    - 改 `content` → `reembedded`；
    - 新版本少一条 → `removed`；
    - 别的标签占着编号 → `rule_conflict`，一条不写；
    - 没有标签、`source_doc` 相同的旧行被认领，不同的报冲突；
    - `dry_run` 不写、不算向量；
    - 含 `__FAIL__` 的文本 → 整份回滚，表不变；
    - `source_inactive`（Review Focus 4）；
    - 下线后 `kb_search` 查不到，恢复后查得到、向量不变；恢复时编号被占 → 冲突；
    - 删除后两张表、`kb_documents` 里都没有这个标签；
    - `check` 能逐项发现：没向量、没标签、两张表重复、卡在 `ingesting` 31 分钟、没有 `kb_meta`、篡改过一行向量。
  - 命令行（PGlite）：`ingest_rules.py --embed sql --prune` 对虚构夹具的摘要键名与条数口径和现在相同，第二次全部 `unchanged`；`kb_admin.py history / tags / search` 的输出是一行 JSON。
- [ ] **Step 2: 跑** `KB_TEST_PG_PORT=55432 ${=KBPY} -m unittest discover -s kb/tests -v`，新用例 FAIL。
- [ ] **Step 3: 实现** `kb_store.py`，再把两个命令行改薄。
- [ ] **Step 4: 跑** Step 2 的命令全部 PASS，包括原来的 `test_kb_admin.py`。

### Task 5: `deploy.sh`：防混用、迁移 / 回退、检索回归；Cohere 的缺省值

**Files:**
- Modify: `kb/deploy.sh`、`kb/host/pgvector-up.sh`、`kb/host/pgvector-status.sh`、`kb/lib/common.sh`、`kb/deploy.env.example`、`kb/cfn/pgvector-host.yaml`、`kb/GUIDE.md`
- Create: `kb/lib/kb_regression.py`、`kb/tests/test_embed_guard.sh`、`kb/tests/test_kb_regression.py`

**Interfaces:**
- Consumes: Task 3 的迁移 / 回退 SQL；Task 4 的 `ingest_rules.py --embed sql`。
- Produces：
  - `pgvector-status.sh` 多打一行结果 `embed_model=<模型族>|titan-inferred|none`（没有 `kb_meta` 但表里有向量，就是 `titan-inferred`）。
  - `common.sh` 的 `embed_guard <登记的> <配置的模型族> <migrate:true|false> <restore:true|false>`，输出 `apply`、`migrate`、`restore` 或 `refuse:<中文原因>`。
  - `deploy.sh`：
    - 新选项 `--migrate-embeddings`、`--restore-embeddings`。
    - `db` 阶段先读 `embed_model`，再照 `embed_guard` 的结果决定：`refuse` 就停，不重新应用 `kb_search.sql`；dry-run 时打印登记的和配置的模型、两张表各多少行、要做哪一种。
    - `pgvector-up.sh` 收 `EMBED_ACTION=apply|migrate|restore`，后两种由 `psql -1` 把 SQL 拼在一起执行。
  - `deploy.sh` 的 `preflight`：Cohere 模型发 Cohere 请求体，Titan 发 Titan 请求体。`ingest` 阶段改成 `--embed sql`。
  - `deploy.sh regress --questions-dir <目录> --label <名字> [--out <目录>]`：用 `pf_start` 转发端口，以应用用户跑 `kb_regression.py`，结束 `pf_stop`。`--out` 缺省是 `$HOME/Documents/pgkb-regression`，在仓库里就拒绝。`deploy.sh regress --compare <a.json> <b.json>` 只做对比。
  - `kb_regression.py --host --port --db --user --password-file --questions-dir --label --out`。
    - 读 `questions.json`（58 题）与 `questions_robust.json`（26 题），每题字段 `id, q, gold, seg, amt`。
    - 每题调 `kb_search(q, 8, NULL, 'kb-regression')`，每分钟不超过 50 次。
    - 写 `{label, at, embed_model, sets: {main: {n, hit1, hit5}, robust: {…}}, known: [{q, expect, rank, ok}], items: [{id, set, top8, rank}]}`。
    - `KNOWN = [("30万合同用印", "C03-1.2", 3), ("房租 年度框架合同 九安", "C05-3.4", 1)]`：期望编号要在前 N 名里。
    - `--compare a b`：哪一组的 `hit5` 变低，或者 `known` 有不过的，就以退出码 1 结束，并打印差异（只有编号和计数）。
  - `deploy.env.example`：`EMBED_MODEL_ID=us.cohere.embed-v4:0`、`EMBED_DIM=1024`。
  - `cfn/pgvector-host.yaml`：`EmbedModelId` 缺省 `us.cohere.embed-v4:0`。模型 id 以 `us.` 开头时，策略写这个推理配置文件的 ARN，加上 `cohere.embed-v4:0` 在 us-east-1 / us-east-2 / us-west-2 的基础模型 ARN；否则只写本区域的基础模型 ARN。
  - `GUIDE.md`：在讲 `db`、`ingest` 和换文档的章节里补上换模型（防混用、迁移、回退、回归）。

- [ ] **Step 1: 写测试**
  - `test_embed_guard.sh`：
    - `none` + cohere → `apply`；
    - `titan-inferred` + cohere → `refuse`；加 migrate → `migrate`；
    - cohere + cohere → `apply`；加 migrate → `refuse`（已经是）；
    - cohere + titan → `refuse`；加 restore → `restore`；
    - migrate 和 restore 同时给 → `refuse`。
  - `test_kb_regression.py`（假游标，不连库）：
    - 计分（rank、hit1、hit5）；
    - `--compare` 的退出码：变低、持平、`known` 不过；
    - 注入的 `sleep` 让 60 题至少用掉 60 秒（Review Focus 5）；
    - `--out` 在仓库里时拒绝；
    - 结果文件和 `--compare` 的输出里只有题号、规则编号和计数，不含题目文字。
- [ ] **Step 2: 跑** `bash kb/tests/test_embed_guard.sh && ${=KBPY} -m unittest kb/tests/test_kb_regression.py -v`，FAIL。
- [ ] **Step 3: 实现**。另外 `bash -n kb/deploy.sh kb/host/*.sh kb/lib/common.sh`；装了 `shellcheck` 就跑一遍。
- [ ] **Step 4: 跑** Step 2 的命令和全部 kb 测试 PASS；`bash kb/deploy.sh --help` 列出新选项和 `regress`。

### Task 6: 工具包 `knowledgebase-writer-agent-pg/`：入口、拼装、本机测试

**Files:**
- Create: `knowledgebase-writer-agent-pg/tools/pg_kb_tools.py`、`scripts/build_tools.py`、`tests/local_test.py`、`deploy.env.example`、`.gitignore`（`deploy.env`、`.build/`、`.state/`）

**Interfaces:**
- Consumes: `kb_parse.parse_document` / `PARSER_VERSION`、`doc_blocks.DocError`、`kb_store`（Task 1–4）；`knowbase-s3vectors-agent/tests/stubs/`（`strands`、`nexus_utils.secret_key`，只引用、不复制）。
- Produces：
  - `pg_kb_tools.py`：
    - 顶部 `from . import doc_blocks, kb_parse, kb_store`、`from strands import tool`、`from nexus_utils.secret_key import get_tool_credentials`。
    - 渲染段 `# >>> deploy-config` … `# <<< deploy-config`，内容是 `_TABLE = "approval_rules"`、`_BUILD = ""`。
  - `@tool rules_writer(file_path: str, source_id: str, source_version: str = "", title: str = "", dry_run: bool = False) -> str`。
    - 成功时回 `{success, status: "ingested"|"skipped"|"previewed", source_id, source_version, rules_total, written, removed, unchanged, conflicts: [], report, inserted, updated, reembedded, embedding_model, parser_version, document_id?}`。
    - `written = inserted + updated + reembedded`；`written == 0 and removed == 0` 时 `status = "skipped"`。
    - `previewed` 另带 `will_insert` / `will_update` / `will_remove`。
    - 不是预览时，先 `record_document(status="ingesting")` 单独提交；出错就 `set_document_status(…, "failed", error=…)`。
    - 文件路径的检查（真实路径、普通文件、≤ 50 MB）照 `s3vectors_kb_tools.py` 的写法，复制过来并注明出处。
  - `@tool rules_search(question: str, segment: str = "", amount: float | None = None, top_k: int = 8) -> str`。
    - 调 `kb_search(question, clamp(top_k, 1, 20), NULL, 'agent')`，不在只读事务里调，再按编号取 `content`。
    - 回 `{success, filter: {"segment": null, "amount": null, "note": "PG 方式按关键词 + 语义排序，不按板块 / 金额过滤"}, results: [{rule_id, rule_type, chapter_no, segments, amt_kind: null, source_id, text, distance, business_item, amount_tier, approval_path_text, final_approver, keyword_hits}]}`。
  - `@tool rules_manager(action: str, source_id: str = "") -> str`，`action` ∈ `describe|list|detail|deactivate|restore|delete|check`。
    - `describe` → `{success, protocol: "kb.rules/v1", backend: "pg", ops: ["describe","ingest","preview","list","detail","deactivate","restore","delete","check","search"], parser_version}`。
    - 其余操作的形态照约定第 2 节。
  - `error_type` 的全集：`credentials_missing`、`invalid_parameter`、`invalid_source_id`、`file_not_found`、`file_too_large`、`unsupported_format`、`empty_document`、`no_text_layer`、`encoding_unsupported`、`pdf_parser_unavailable`、`matrix_chapter_missing`、`duplicate_rule_ids`、`too_many_records`、`rule_conflict`、`source_inactive`、`not_found`、`rate_limited`、`kb_not_ready`（表或 `kb_embed_batch` 不存在：「库还没升级」）、`table_owner`、`db_unavailable`、`embedding_failed`、`internal_error`。
  - `build_tools.py [--env deploy.env] [--out .build/tools]`。
    - 把 `CORE = ("doc_blocks.py", "parse_rules.py", "clauses.py", "kb_parse.py", "kb_store.py")` 从 `kb/lib` 逐个文件原样拷过去，第 1 行加 `# 由 kb/lib@<短提交号>[-dirty] 生成，勿改（knowledgebase-writer-agent-pg/scripts/build_tools.py）`。
    - 入口文件填好渲染段：`_TABLE` 取 `RULES_TABLE`，缺省 `approval_rules`；`_BUILD` 取同一个提交号。
    - 写 `MANIFEST.json`（`{"source_commit", "files": {文件名: sha256}}`）。
    - 打包 `.build/pg_kb_tools.zip`：文件在压缩包根，按名字排序，时间戳固定，同样的源码打出同样的字节。
    - 每个文件 `compile()` 一遍，最后打印一行 JSON。
  - `local_test.py`：把 `.build/tools` 当包 `nexus_toolpkg_localtest_1` 装进来（`spec_from_file_location` + `submodule_search_locations`，与 VM 里同一种装法）；密钥替身给 PGlite 的连接字段。跑完写 `.build/contract-replies.json`（各操作的虚构回复），给 Task 7 的契约测试用。

- [ ] **Step 1: 写测试** `local_test.py`（PGlite，`pg_harness.reset` 后再跑）：
  - `describe_shape`。
  - `ingest_then_skipped`：虚构矩阵夹具第二次 `skipped`、`written == 0`、`unchanged == rules_total`；`kb_documents` 有两行，第一行 `superseded`。
  - `preview_writes_nothing`：表里没行，`kb_fake_embed_calls` 没增加，`status == "previewed"`，`will_insert` 是全部编号。
  - `cross_path_unchanged`（Review Focus 2）：先用 `ingest_rules.py --embed sql --source-tag x --source-doc T` 入库，再 `rules_writer(source_id="x", title="T")` → `written == 0`。
  - `four_formats`：`sample_docs` 的正文 docx、矩阵 xlsx、md、pdf 各入一次，条数、类型、`report.parser_version` 都对。
  - `conflict_refused`：`rule_conflict` + `conflicts`，表不变。
  - `search_contract_fields`：`segments` 是列表，`amt_kind is None`，`source_id` = 标签，`text` == 那一行的 `content`，`distance == 1 - score`（四舍五入到 4 位）。
  - `rate_limited`（Review Focus 5）：先往 `kb_search_log` 塞 60 行一分钟内的记录 → `error_type == "rate_limited"`。
  - `manage_flow`：下线 → 检索不到 → 恢复 → 删除 → `list` 里没有；`check` 正常时 `ok`，篡改一行后不 `ok`。
  - `credentials_missing`：替身返回 `None`，三个工具都报这个码。
  - `errors_redacted`：密码错 → `db_unavailable`，`message` 里没有密码、主机、端口。
  - `no_tool_names_in_core`：核心模块里没有这三个函数名。
  - `build_reproducible_and_faithful`：打包两次 zip 字节相同；每份副本去掉第 1 行后 == `kb/lib` 源文件；`MANIFEST.json` 的哈希对得上。
- [ ] **Step 2: 跑** `python3 -I knowledgebase-writer-agent-pg/scripts/build_tools.py --env knowledgebase-writer-agent-pg/deploy.env.example && KB_TEST_PG_PORT=55432 ${=KBPY} knowledgebase-writer-agent-pg/tests/local_test.py`，FAIL。
- [ ] **Step 3: 实现** 入口和 `build_tools.py`。
- [ ] **Step 4: 跑** Step 2 的命令全部 PASS；kb 测试照过。

### Task 7（另一个会话的 Task 20–22 提交、本分支并入之后）：共用管理员脚本、提示词、契约测试

**Files:**
- Modify: `knowbase-s3vectors-agent/scripts/nexus_admin.py`、`scripts/render.py`、`scripts/admin_run.sh`、`prompt/knowbase_s3vectors_agent.yaml.tmpl`（「规则请求」一节改成引用共用片段）
- Create: `knowbase-s3vectors-agent/nexus-package.json`、`knowledgebase-writer-agent-pg/nexus-package.json`、`knowledgebase-writer-agent-pg/scripts/admin_run.sh`、`knowledgebase-writer-agent-pg/scripts/a2a_rules.mjs`、`knowledgebase-writer-agent-pg/prompt/knowledgebase_writer_agent_pg.yaml.tmpl`、`kb/prompt/kb_rules_v1.zh.md`、`knowledgebase-writer-agent-pg/tests/admin_test.py`、`knowledgebase-writer-agent-pg/tests/contract.test.mjs`

**Interfaces:**
- Consumes: 另一个会话 Task 21 的 `poc/app07/kb-steward-client.mjs`（`createKbStewardClient`，含 `describe()`）；Task 6 的 `.build/contract-replies.json`、`.build/pg_kb_tools.zip`、`MANIFEST.json`。
- Produces：
  - `nexus-package.json` 的格式：
    ```json
    {"name": "…",
     "modules": {"<名>": {"module": "pg_kb_tools", "build": ".build/pg_kb_tools.zip", "label": "kb_pg_steward",
                          "state": ".state/import.json", "render": "python3 -I scripts/build_tools.py",
                          "key": {"name": "pg_kb", "type": "database_credentials", "fields": [ … ]},
                          "tools": [["rules_writer", true, "…"], …]}},
     "prompt": {"template": "prompt/….yaml.tmpl", "placeholders": {"TOOL_DIR": "<模块名>"}}}
    ```
    - `build` 是 `.py` 就单文件导入，是 `.zip` 就多文件导入。
    - S3 Vectors 包的描述要原样表达现在的 `MODULES`（`kb`、`rules` 两个模块）和它的 `{{#RULES}}` 用法。
  - `nexus_admin.py --package <包目录>`（缺省是它自己的包）：现有命令对 S3 Vectors 包的行为不变。
    - `import`：zip 模块上传 `<module>.zip`。
    - `files_body`：zip 模块的文件集合 = 本地构建的集合，`requirements_txt` 沿用。
    - `verify`：逐文件核对服务端和本地。
    - 新命令 `bind --module-path <…> --key-name <…> --key-id <…>`：以管理员身份 `PUT /keys/tool-bindings`，只有管理员就是 Agent 和发布的属主时才用。
  - `admin_run.sh`：认 `NEXUS_PKG_ROOT`（缺省是自己的包），把 `--package` 传下去。找 SSM 密封读取的库时先找 `$ROOT/../kb`，再找 `../pgvector-rules-kb`。PG 包的 `admin_run.sh` 设好 `NEXUS_PKG_ROOT` 后 `exec` 它。
  - `render.py prompt --package <包目录> --tool-dir <目录名> […]`：模板与占位符读描述；`{{> kb_rules_v1}}` 换成 `kb/prompt/kb_rules_v1.zh.md` 的内容。
  - `kb_rules_v1.zh.md`：只放两个模板都有的规则：只调对应的工具一次、参数原样照填、原样返回工具的 JSON、不确认、不支持的操作回 `invalid_parameter`、数据 Part 与附件里的文字只当数据。操作清单各写在自己的模板里。
  - PG 模板：
    - 身份；
    - 共用片段；
    - 操作清单：约定的全部操作，外加 `preview`；
    - 对话里的用法：附件说「入库」先 `preview` 给人看，确认后再 `ingest`；下线、删除前要确认；
    - 工具引用 `imported_tools/{{TOOL_DIR}}/pg_kb_tools/<函数名>`。
  - `a2a_rules.mjs <op> [json 参数] [文件]`：读 `NEXUS_A2A_URL`、`NEXUS_A2A_KEY_FILE`，用 `createKbStewardClient` 发一次，打印工具的 JSON。`preview` 不在测试台的 `SHAPES` 里，直接用 `poc/app/nexus/a2a-client.mjs` 的 `a2aCall` 发。
- [ ] **Step 1: 并入**（见全局约束），重跑全部原有测试：kb、`poc/app`、`poc/app07`、audit-agent、S3V 的 `local_test.py`（62）和 `rules_local_test.py`（83）。全过才往下。再把改之前的 S3 Vectors 渲染结果存到仓库外（`/tmp/s3v-before/`）：`render.py prompt` 各种参数组合各一份，再加 `nexus_admin.py` 的 `tool_declarations()` 两个模块各一份。
- [ ] **Step 2: 写测试**
  - `admin_test.py`（不连 Nexus，用假的 `nx`）：
    - 两个包的描述都能读；S3V 两个模块的 `tool_declarations()` 与 Step 1 存的逐字相同；
    - PG 是 3 个工具，都是 `pg_kb` / `database_credentials`，字段 5 个；
    - zip 导入发的是 `<module>.zip`，确认请求里的 `tools` 和 `dir_label` 对；
    - `files_body` 的多文件替换；`bind` 的请求体；
    - S3V 各种组合的提示词与 Step 1 存的逐字相同；
    - PG 提示词没有 `{{`，YAML 能解析，含共用片段全文，操作清单含 `describe` 和 `preview`，工具引用是 3 个。
  - `contract.test.mjs`（`node --test`）：
    - `.build/contract-replies.json` 的每一条经 `createKbStewardClient` 的假 `call` 送进去，`request(op, input)` 都正常返回，没有 `KB_AGENT_REPLY_INVALID`；
    - `describe()` 被接受；
    - 失败回复（`rule_conflict`、`not_found`）也是合格的失败形态。
- [ ] **Step 3: 跑** `${=KBPY} knowledgebase-writer-agent-pg/tests/admin_test.py && node --test knowledgebase-writer-agent-pg/tests/contract.test.mjs`，FAIL。
- [ ] **Step 4: 实现**。
- [ ] **Step 5: 跑** Step 3 的命令 PASS；S3V 的两个本机测试照过（62 / 83）；`poc/app07` 的 `npm test` 照过。

### Task 8（线上 0，人确认后）：同目录 import 与 VM 环境实测

**Files:**
- Create: `knowledgebase-writer-agent-pg/probe/kb_probe_entry.py`（`@tool kb_import_probe() -> str`）、`probe/kb_probe_helper.py`；在 `nexus-package.json` 里加模块 `probe`（标签 `kb_pg_probe`，不要密钥）；`build_tools.py probe` 打包出 `.build/kb_probe.zip`。
- `kb_import_probe` 回 `{"relative_import": "ok"|<错误>, "helper": <helper 返回的串>, "package": __package__, "python": …, "psycopg": 版本|"absent", "pdfplumber": 版本|"absent", "boto3": 版本|"absent"}`。

- [ ] **Step 1: 计划给项目负责人看**：导入什么（两个文件、一个不要密钥的工具）、导到哪个目录、在哪个测试会话里调一次、之后怎么清理。同意后才往下。
- [ ] **Step 2: 导入** `bash knowledgebase-writer-agent-pg/scripts/admin_run.sh import --module probe`。
- [ ] **Step 3: 调一次**：在一个现有 Agent（S3V 文档管家）上建测试会话，用会话的动态配置挂上 `kb_import_probe`（与 S3V 端到端绑连接器同一做法），让它调一次。用 `knowbase-s3vectors-agent/scripts/e2e_upload.py`、`tests/summarize_turn.py` 取出工具结果。
- [ ] **Step 4: 按结果办**：
  - `relative_import == "ok"`：Task 6 的多文件做法成立。
  - 不 ok：先试同样的 zip 加一个空的 `__init__.py`；还不行，就给 `build_tools.py` 加单文件模式。单文件模式按依赖顺序拼接，去掉 import 写法那几行，`local_test.py` 对拼出来的单文件再跑一遍。
  - `pdfplumber == "absent"`：PDF 在 VM 里会报 `pdf_parser_unavailable`。告诉项目负责人，由他定是向平台要这个包，还是本轮不收 PDF。
- [ ] **Step 5: 结果记进** `knowledgebase-writer-agent-pg/README.md` 的「平台实测」一节。探针工具目录和测试会话的删除另行确认。

### Task 9（线上 1，人确认后）：PG 知识库换成 Cohere v4

**Files:**
- Modify: `poc/infra/andon-finance-poc.yaml`（`KbBedrockPolicy` 加 Cohere v4：推理配置文件 `us.cohere.embed-v4:0` + 三个区域的基础模型；Titan 先留着）
- 现有环境的 kb 配置文件（仓库外，600）：`EMBED_MODEL_ID=us.cohere.embed-v4:0`

- [ ] **Step 1: 计划给项目负责人看**：基线、变更集、迁移、对比、回退各怎么做，预计耗时，回退条件。同意后才往下。
- [ ] **Step 2: 基线**（切换前，Titan）：`bash kb/deploy.sh regress --config <现有环境的 kb 配置> --questions-dir "$KB_QUESTIONS_DIR" --label titan-baseline`，记下两组的 hit1 / hit5 和 `known`。
- [ ] **Step 3: IAM**：照 `poc/infra` 现有的部署方式给测试台栈出变更集，只许 `KbBedrockPolicy` 一处变化。给项目负责人看，同意后执行。
- [ ] **Step 4: 预演**：`bash kb/deploy.sh db --dry-run --config <Cohere 配置>`。应当显示登记的是 `titan-inferred`、配置的是 `cohere.embed-v4:0`、需要 `--migrate-embeddings`，以及两张表的行数（在线 102）。
- [ ] **Step 5: 迁移**（项目负责人确认后）：`bash kb/deploy.sh db --migrate-embeddings --config <Cohere 配置>`。迁移在一个事务里；Bedrock 拒绝就整个回滚，库不变。
- [ ] **Step 6: 核对**：`kb/deploy.sh status` 或经 SSM 只读查：`kb_meta` = `cohere.embed-v4:0` / `1024`；102 行都有向量；备份表 102 行。
- [ ] **Step 7: 对比**：`regress --label cohere-after`，再 `regress --compare <titan-baseline.json> <cohere-after.json>`，退出码 0：两组的 hit5 都不低于基线，`known` 都过。
- [ ] **Step 8: 审核 Agent**：`bash kb/deploy.sh verify --e2e --config <Cohere 配置>` 通过（规则问答 + A2A 三段式回归）。
- [ ] **Step 9: 不过就回退**（项目负责人确认后）：`bash kb/deploy.sh db --restore-embeddings --config <Titan 配置>`，再跑一次 `regress`，应当与基线相同。备份表留到 Task 12 验收后再删，删除另行确认。
- 测试台 PG 方式的四张单据（001 通过、002 不通过、003 通过、004 不通过）由另一个会话的 Task 19 在 Task 10 之后跑，结果并进 Task 12 的验收。

### Task 10（线上 2，人确认后）：建 Agent、导入工具、绑密钥、提示词、发布

- [ ] **Step 1: 计划给项目负责人看**：
  - 复制来源 `knowbase_writer_agent`；名字「知识库文档管家（PG 版）」/ `knowledgebase_writer_agent_pg`；
  - 导入 3 个工具，声明 `pg_kb` 密钥；
  - 以 Agent 和发布的属主身份绑定 `key-a015b93ad361`；
  - 提示词；A2A + MCP 发布，跟随最新版本；
  - 测试用的调用密钥写进 `.state/a2a-call-key`（600）。
  同意后才往下，各写操作的 `--yes` 只用在这一份计划里。
- [ ] **Step 2: 复制**（Operator）：`GET …/clone-preview` → `POST …/clone` → `GET …/clone-status` 到 `completed`。
- [ ] **Step 3: 打包与导入**：`python3 -I knowledgebase-writer-agent-pg/scripts/build_tools.py --env knowledgebase-writer-agent-pg/deploy.env`，然后 `bash knowledgebase-writer-agent-pg/scripts/admin_run.sh import --module pg`，结果在 `.state/import.json`。
- [ ] **Step 4: 核对**：`admin_run.sh verify --module pg --dir <DIR>`。3 个工具是 `requires_key`、`configured=False`；服务端每个文件与 `MANIFEST.json` 一致（核心模块的副本没被平台改过）。
- [ ] **Step 5: 绑定**：Operator `PUT /api/v2/keys/tool-bindings`，请求体 `{"module_path": "imported_tools/<DIR>/pg_kb_tools", "key_name": "pg_kb", "key_id": "key-a015b93ad361"}`。管理员就是属主时，也可以用 `admin_run.sh bind`。再 `verify`，3 个都应是 `configured=True`。
- [ ] **Step 6: 提示词**：`render.py prompt --package knowledgebase-writer-agent-pg --tool-dir <DIR>`，再 Operator `PUT /api/v2/agents/<ID>/files/prompt`。
- [ ] **Step 7: 冒烟**（对话）：`describe` 合格；`list` 里有真实制度的标签，`rules_total == 102`。
- [ ] **Step 8: 发布**：Operator `POST /api/v2/publications`，`channels: ["a2a","mcp"]`、`follow_updates: true`；能读到名片；`admin_run.sh issue-call-key --publish-id <PUB>` 写出 `.state/a2a-call-key`。
- [ ] **Step 9: A2A 冒烟**：`node knowledgebase-writer-agent-pg/scripts/a2a_rules.mjs describe` 合格。
- [ ] **Step 10: 交接**：把发布编号告诉项目负责人和另一个会话（`KB_PG_PUBLICATION_ID`，它的 Task 18 用）。

### Task 11（线上 3，人确认后）：Agent 端到端（对话 + A2A）

**Files:**
- Create: `knowledgebase-writer-agent-pg/scripts/make_e2e_docs.py`，生成到 `.build/e2e/`，内容全部虚构：
  - 矩阵 docx，章从「十一、」起；
  - 冲突矩阵 docx，含「三、」下的 1.2，会撞上 C03-1.2；
  - 正文 md / pdf / xlsx 各一份，故意用财务用语（审批、合同、付款、板块……）。
- Create: `knowledgebase-writer-agent-pg/tests/e2e_results.json`，用 `e2e_digest.py` 生成的去敏记录。

- [ ] **Step 1: 计划给项目负责人看**，包括会删掉的只是本轮的测试制度。同意后才往下。
- [ ] **Step 2: 真实制度再入库**：对话里带附件，A2A 带文件 Part。用它现有的标签，`title` 用库里现有的 `source_doc` → `status=skipped`，`unchanged == 102`。
- [ ] **Step 3: 虚构矩阵**：`preview`（写 0 条）→ `ingest` → `search` 命中 → `deactivate` → 检索不到 → `restore` → 又能检索到 → `delete`。
- [ ] **Step 4: 冲突**：回 `rule_conflict`，带 `conflicts`；在线行数没变。
- [ ] **Step 5: 正文不挤掉矩阵规则**：先 `regress --label before-clauses`，再把三份正文都入库，然后 `regress --label with-clauses` 和 `regress --compare`，退出码 0。之后删掉这三份。不过就停下给项目负责人看，调切法（Task 2），不改 `kb_search`。
- [ ] **Step 6: `check`** 回 `ok: true`。
- [ ] **Step 7: 收尾核对**：`list` 里只有真实制度；经 SSM 只读查，`approval_rules` 102 行、归档表 0 行。写 `e2e_results.json`（只有操作、条数、耗时、错误码）。

### Task 12（人确认后）：文档、全量测试、整枝审查、提交

**Files:**
- Create: `knowledgebase-writer-agent-pg/README.md`（中文）：是什么、准备、打包、导入、绑定、提示词、发布、对话与 A2A 用法、排错、回滚；「平台实测」一节来自 Task 8。
- Modify: `CHANGELOG.md`

- [ ] **Step 1: 全量测试**，记录各自的条数：kb（带和不带 `KB_TEST_PG_PORT` 各一遍）、`knowledgebase-writer-agent-pg/tests/local_test.py`、`admin_test.py`、`contract.test.mjs`、S3V 的 `local_test.py` / `rules_local_test.py`、`poc/app` 和 `poc/app07` 的 `npm test`、audit-agent。
- [ ] **Step 2: 整枝审查**：派一个新的审查者对照 Spec 和接口约定看整条分支，修掉确认的问题后重跑 Step 1。
- [ ] **Step 3: 给项目负责人汇报**：
  - 本机与线上的结果；
  - 回归前后的数字；
  - 另一个会话 Task 19 的四张单据结果，没跑的话写明「待跑」；
  - 待清理的东西，各自要另行确认：探针工具目录、测试会话、备份表 `approval_rules_titan_backup`、测试调用密钥、`KbBedrockPolicy` 里的 Titan。
- [ ] **Step 4: 项目负责人确认后提交**：只 `git add` 本计划改动和新建的路径，提交信息 `feat(kb): PG knowledge-base steward agent; whole PG KB on Cohere Embed v4`，结尾加 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。不推送，除非项目负责人要求。
