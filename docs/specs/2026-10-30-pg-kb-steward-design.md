# 知识库文档管家（PG 版）：PG 知识库也走「文档管家」那条路；整个 PG 知识库换成 Cohere v4（设计，2026-10-30）

状态：**已确认（2026-10-30）**（审读后已补：共享核心、独立边缘与逐文件放入工具目录；判断类型逐块、命中率口径、两种模型都支持与防混用、`preview` 为 PG 版独有、Markdown 已核实、`kb_search` 打平规则已同意）。**同日修订**：对齐另一个会话写的接口约定 `docs/specs/2026-10-30-pg-knowledgebase-agent-contract.md`（测试台照它接这个 Agent）；向量改由库里的 `kb_embed` 生成（项目负责人 10-30 选定），工具不再在 VM 里调 Bedrock。接在 2026-10-28《制度知识库加一种部署方式：S3 Vectors 文档管家》（含 10-29 补充：最终用 PG；10-30 第 8 节：测试台不再直连 PG）之后。

本设计只做 **Agent 这一侧**：Nexus 上的新 Agent、它的工具、PG 知识库换成 Cohere v4、发布。测试台的接口和页面（九安前端经 A2A 调这个 Agent）是**下一份设计**，本轮不做。

标「实现方决定」的，是讨论中由 Claude 定下、项目负责人没有逐条拍板的，可以改；其余是项目负责人定的。

## 0. 已定的事

| 问题 | 决定 |
|---|---|
| 做什么 | **新建** Nexus Agent `knowledgebase_writer_agent_pg`，中文名「知识库文档管家（PG 版）」。Nexus 上已有的 `knowledge_base_manager`（10-24 构建工作流生成）不改、不复用：它的嵌入走 Cohere 官方 API、存储用 VM 里没有的 psycopg2、写的是审核 Agent 查不到的表、四把密钥都没配，从没真正入库过 |
| 流程 | 提交文档 → A2A → 文档管家（PG 版）→ 解析 → 向量化 → PostgreSQL。和 S3 Vectors 文档管家**同样的逻辑**：A2A 请求约定、一个工具一次做完、模型不搬运数据、原样返回工具的 JSON |
| 「分析」指什么 | **只要准确解释、准确入库**：解析报告（每类、每章各多少条，拆分、重复、冲突、读不出文字等），不另做 AI 分析或总结 |
| 接收格式 | **Word、PDF、Excel、Markdown** |
| 正文怎么切 | **一条一块**（按条 / 节切，不按固定字数），以准确度为准 |
| 入库的内容给谁用 | **主要给审核 Agent 审单时查**；其他用途以后定 |
| 向量模型 | **Bedrock 上的 Cohere Embed v4**。**整个 PG 知识库一起换**：库里的 `kb_embed`、审核 Agent 和页面用的 `kb_search`、现有 102 条规则全部重算 |
| 向量在哪里算 | **只在库里**（项目负责人 10-30 选定，与接口约定第 3 节一致）：工具不算向量、不调 Bedrock，写入时调库里的 `kb_embed` / `kb_embed_batch`；`kb_embed` 本身换成 Cohere v4（3.6）。页面、`deploy.sh`、本 Agent、审核 Agent 的检索都经这一处，不可能混用两种模型 |
| 对接约定 | 测试台照 `docs/specs/2026-10-30-pg-knowledgebase-agent-contract.md` 接这个 Agent（另一个会话写的，项目负责人定的）。本设计与它冲突的地方以约定为准；本设计多出的（三种格式、正文条款、`preview`、下线 / 恢复）是约定的超集 |
| 复用 | **尽量复用已有逻辑，不重复写代码**：`kb/`（原 pgvector-rules-kb）的库、解析器、入库规则；`knowbase-writer-agent`（PG 版文档管家）的 PG 连接；`knowbase-s3vectors-agent` 的骨架（导入工具并声明密钥、管理员脚本、`kb.rules/v1`） |
| 顺序 | 先做 Agent 这一侧，前端设计和交互之后做。另一个会话（`feat/v0710-kb-review-advice`，计划 2026-10-28 的 Task 18 / 19 / 13）这一轮提交之后，才切换模型、动测试台、上线 |
| 普通用户 | 以后普通用户不直连 Nexus：调用密钥只由管理员在「Agent 接入」页启用一次（下一份设计） |
| `kb_search` 排序 | **这次就改**：关键词命中数相同时，矩阵 / 制度说明 / 章节说明排在正文条款（`clause`）前面，再按语义距离。命中数更多的照样靠前。库里没有条款时排序与现在完全一样；随 Cohere v4 切换一起上线（3.6） |

## 1. 为什么做，做成什么算成

**为什么**：
- PG 方式原来的入库是外壳直连 PG（`kb-runner.mjs` → `ingest_rules.py`），只收审批矩阵 .docx。九安的前端和 PG 不在同一台主机，另一个会话已决定删掉这条直连路径（10-28 设计第 8 节）。S3 Vectors 方式已经是「页面 → A2A → 文档管家 → 存储」，PG 也走这条路后，两种方式的写入接口相同，前端只需要一套。
- Cohere v4 比 Titan v2 准。选型实测 E10，同一份制度、同样的板块 + 金额过滤下：

  | 模型 | 前 1 命中 | 前 5 命中 |
  |---|---|---|
  | Cohere v4（1024 维） | 87.9% | 100% |
  | Titan v2 | 79.3% | 91.4% |

  纯向量时 Titan 的前 1 只有 58.6%。审核 Agent 的 `kb_search` 先按关键词、再按语义排，语义一侧直接受益。

**做成什么算成**：
1. **四种格式都能经这个 Agent 入库**，经对话或 A2A 的 `kb.rules/v1` 都可以：
   - 审批矩阵（Word / Excel / Markdown 里的矩阵表）按一行一条进 `approval_rules`。Word 的解析结果与 `kb/lib/parse_rules.py` **逐条完全相同**：真实制度 102 条，编号、字段、`content` 都一样。
   - 其余正文（PDF、Markdown、没有矩阵的 Word，Excel 里不是矩阵的表）按一条一块进同一张表，类型 `clause`。
2. **入库规则与现在相同**：
   - 同一份文件再入库：一条都不写（`unchanged` 等于总数）；
   - 新版本：只改变了的，并删掉旧版本有、新版本没有的编号；
   - 编号属于另一份制度：整份拒绝，一条不写，列出冲突。
   - 「预览」只对比、不写库、不调 Bedrock。
3. **换成 Cohere v4 后审核 Agent 不变差**：
   - 已知问题照样命中：「30 万合同用印」前 3 名有 C03-1.2，「房租 年度框架合同 九安」前 2 名是 C05-3.3 与 C05-3.4。
     - 原来要求 C05-3.4 第 1 名。10-30 实测：换成 Cohere v4 后第 1 名是 C05-3.3，C05-3.4 第 2。
     - 两条是同一事项、同一板块，只差金额档（单笔 ≤ 1 万 / ＞ 1 万）；问题里没有金额，两条都对，审核 Agent 按单据金额取档。
     - 项目负责人确认保留 Cohere v4，这一条改成两条都在前 2 名。
   - 研究题库（主题 58 题、改写 26 题）经 `kb_search` 的前 5 命中不低于切换前用 Titan 测的基线。
   - 测试台 PG 方式的端到端照样通过：四张对公付款单 001 通过、002 不通过、003 通过、004 不通过，引用的编号都在库里。
4. **Agent 已发布**（A2A + MCP）。它对 `kb.rules/v1` 各操作（约定里的 `describe` / `ingest` / `list` / `detail` / `delete` / `check` / `search`，加上 `deactivate` / `restore`）的回复符合接口约定，能通过测试台客户端（`kb-s3v-client.mjs`，另一个会话正改名为 `kb-steward-client.mjs` 并加上 `describe`）里同一套形态校验（`SHAPES` / `failedShape`）。新增的 `preview` 是 PG 版独有的操作，回复形态在本包的测试里定义，测试台的校验由下一份设计扩展（实现方决定）。
5. **入库的正文不挤掉矩阵规则**（实现方决定怎么算）：入库一份正文测试文档前后各跑一次第 3 条的检索题，**命中率不降**：
   - 已知问题照样命中；
   - 研究题库的前 5 命中率不低于入库前。

   不要求前 8 名逐条相同。正文测试文档故意用财务用语写（审批、合同、付款、板块……），这样才是真测。
6. **代码只有一份**：解析、入库规则各自只在 `kb/lib/` 里实现一次；向量只由库里的 `kb_embed` / `kb_embed_batch`（`kb/sql/kb_search.sql`）生成。Agent 的工具文件由脚本从这些源码拼装，`deploy.sh` 的入库（`ingest_rules.py`）也调同一份。

**非目标**（本轮不做）：
- 测试台的接口和页面（下一份设计）；
- 改审核 Agent 的提示词。审核 Agent 怎么引用 `clause` 行，留到下一份设计，与另一个会话协调；
- 扫描件 PDF 的 OCR；老的 .doc / .xls；
- 给 `kb_search` 加金额过滤或改排序；
- 多个独立知识库；
- 改 S3 Vectors 文档管家的行为。

**反目标**（做到了也算失败）：
- 审核 Agent 的检索变差，或在切换途中查到一半 Titan、一半 Cohere 的向量；
- 一张表里混着两种模型的向量；
- 入库悄悄改了别的制度的规则；
- 写到一半失败却没有痕迹；
- 任何地方出现数据库密码、访问密钥、调用密钥的明文；
- 在另一个会话这一轮提交之前，改动它的工作目录或测试台。

## 2. 架构

```
九安「规则库 › 制度知识库」（下一份设计）  /  Nexus 对话（本轮验证用）
   │  A2A：kb.rules/v1 · <op>  + 数据 Part {op, …} + 文件 Part
   ▼
Nexus：知识库文档管家（PG 版）的发布 ── 隔离环境 VM
   │  工具模块 pg_kb_tools.py（由 kb/lib 拼装；不调 Bedrock）
   └─ PostgreSQL（10.0.1.38:5432，库 nexus）：平台注入的数据库密钥（pgvector-10.0.1.38），psycopg 3
         approval_rules（矩阵 + 制度说明 + 章节说明 + clause）、approval_rules_archive（下线的）、kb_documents（上传历史）、kb_meta（向量模型）
         kb_embed_batch(正文[], 'search_document') ── PG 用实例角色调 Bedrock Cohere Embed v4（1024 维，每次 96 条）
                                   ▲
审核 Agent ── 连接器 conn-f0c7233959d9 ── SQL：kb_search(问题, 8) → kb_embed(问题, 'search_query')（同一个模型）
```

## 3. 各部分

### 3.1 共享源码（`kb/lib/`，一份代码多处用）

**共享核心、独立边缘**（项目负责人已同意，2026-10-30）：
- **只共享必须一致的东西**：解析（四种格式 → 记录：矩阵 + 条款）、入库规则（哈希、对比、冲突、清理）。同一份制度不管经 `deploy.sh`、PG 文档管家还是以后的 S3 Vectors 文档管家入库，都要得到同样的编号和检索全文；实现一分叉，数据就会悄悄不一致。向量的一致由「只在库里算」保证（第 0 节）。
- **存储适配和工具入口留在各包里**：PG 与 S3 Vectors 各写各的存储；`@tool` 入口、提示词也各自独立。

| 模块 | 内容 | 谁用 |
|---|---|---|
| `doc_blocks.py`（新） | docx / xlsx / pdf / md → 按原文顺序的块：标题（级别）、段落、表格（合并单元格已展开的二维表）。docx 读法从 `parse_rules.py` 的 `text_of` / `table_grid` 挪过来 | 下面三个 |
| `parse_rules.py`（重构） | 块 → 审批矩阵规则（matrix / general / chapter_note）。`parse(src)` 的接口和对 .docx 的输出**不变**，测试钉住重构前后逐条相同；矩阵表头识别（`FIXED_COLS` 等）对 xlsx / md / pdf 的表同样适用 | 工具、`ingest_rules.py` |
| `clauses.py`（新） | 块 → 正文条款记录（3.3） | 工具 |
| `kb_store.py`（新） | 从 `ingest_rules.py` / `kb_admin.py` 抽出的 PG 写入逻辑：`COLUMNS`、`record_hash`、对比（新增 / 只改说明 / 重算 / 不变 / 删除 / 冲突）、一个事务里 upsert + 清理 + 上传历史、下线 / 恢复 / 删除、清单、校验、`kb_meta` 读取。向量由库里的 `kb_embed_batch` 生成 | 工具、`ingest_rules.py`、`kb_admin.py` |

原来设想的 `embed_cohere.py`（VM 里调 Cohere v4）不做了：向量只在库里算。

**`ingest_rules.py` 与 `kb_admin.py`**：
- 改成调 `kb_store` 的薄命令行，命令行参数和输出不变；
- `--embed sql` 改用 `kb_embed_batch`；`deploy.sh` 的 `ingest` 阶段改用 `--embed sql`；`--embed bedrock`（本机调 Bedrock）只留给 Titan，配置的是 Cohere 时报错并提示用 `--embed sql`；
- 测试台的 `kb-runner.mjs` 由另一个会话删掉（10-28 设计第 8 节），不再是它的调用方；
- `kb/tests` 现有测试照过。

**工具目录怎么来**（不做文本拼接）：
- `scripts/build_tools.py` 把共享核心的模块**逐个文件原样**放进工具目录，与 `@tool` 入口 `pg_kb_tools.py` 并列。
  - 每个文件头部加一行「由 `kb/lib@<提交号>` 生成，勿改」；
  - 测试核对工具目录里的副本与 `kb/lib` 源码的哈希一致。
- **平台源码已读（v0.3.28，10-30）**：
  - 导入接口收 .zip（`api/v2/routers/agent_tools.py` 的 `import_upload`），压缩包里的文件全部复制进工具目录；只给声明了的函数加 `@tool`，没有工具函数的辅助模块原样保存（`tool_import/converter.py`）。
  - VM 里一个版本的工具目录装成一个包 `nexus_toolpkg_<目录>_<版本>`，清单里的模块都能用**相对 import**（`from . import doc_blocks`）取到；普通的 `import doc_blocks` 取不到（`tool_versions/loader.py` 的 `_VerifiedFinder`）。
  - 所以 `kb/lib` 的模块彼此按「在包里就相对 import，作为脚本运行就把本目录放进 `sys.path`」的固定写法引用。
- **仍要实测一次**：本机部分做完后，先用一个只有两个文件的最小工具（.zip）在 Nexus 上导入、对话里调一次，顺带看 VM 里有没有 `pdfplumber`。
  - 行得通：就按上面放成多个文件。
  - 行不通：退回成由脚本把核心模块拼进一个文件，去掉相互之间的 import。同样由脚本生成、测试核对，不手改。
- **核心带版本号**：解析器版本写进 `kb_documents` 的解析报告与工具的回复（`parser_version`），排查「这批规则是哪个版本的解析器入的」有据可查。

**以后**：S3 Vectors 的规则工具里现在抄着一份 `parse_rules`，可以改成同样拼装，去掉抄件。这不在本轮做，因为要改另一个会话的代码；记进第 6 节。

### 3.2 工具（一个模块 `pg_kb_tools.py`，导入成一个工具目录）

工具名与 S3 Vectors 的规则工具相同，`kb.rules/v1` 的操作 → 工具的对应关系也相同（接口约定第 2 节）：

| 工具 | 操作 | 做什么 |
|---|---|---|
| `rules_writer(file_path, source_id, source_version="", title="", dry_run=False)` | `ingest`；新增 `preview`（`dry_run=True`） | 读附件 → 判断格式 → 解析成记录 → 对比 → 一个事务里由库里的 `kb_embed_batch` 算要写的向量并写入 → 返回结果与解析报告 |
| `rules_search(question, segment="", amount=None, top_k=8)` | `search` | 照约定调 `kb_search(question, top_k, NULL, 'agent')`，与审核 Agent 用的是同一个函数，再按编号取 `content`。`segment`、`amount` 收下但不用（PG 的板块过滤会漏掉「全板块」行），`filter` 里写明 |
| `rules_manager(action, source_id="")` | `describe` / `list` / `detail` / `deactivate` / `restore` / `delete` / `check` | 见 3.5；`describe` 照约定回 `{protocol: "kb.rules/v1", backend: "pg", ops}`，`ops` 含 `deactivate`、`restore`、`preview` |

- **回复形态**：字段名、类型照接口约定（与 `s3vectors_rules_tools.py` 相同），能过测试台客户端的 `SHAPES` / `failedShape`：
  - `ingest`：`status`（`ingested` / `skipped`）、`source_id`、`source_version`、`rules_total`、`written`、`removed`、`unchanged`、`conflicts`、`report`。
  - PG 多出的字段可以加：`inserted`、`updated`、`reembedded`、各类型条数、`embedding_model`、`parser_version`。
  - `search` 的每条：`rule_id`、`rule_type`、`chapter_no`、`segments`（`[segment]`，没有就空列表）、`amt_kind`（PG 不解析金额档，`null`）、`source_id`（= `source_tag`）、`text`（= `content`）、`distance`（= 1 − 语义分）；可另带 `business_item`、`amount_tier`、`approval_path_text`、`final_approver`、`keyword_hits`。
  - `preview` 回 `status=previewed`，计数字段与 `ingest` 相同，另带将新增 / 更新 / 删除的编号。它是 PG 版独有的操作：提示词共用片段里的操作清单按模板分开写，S3 Vectors 版不出现 `preview`。
  - 不认识的 `op` 不调工具，照约定回 `invalid_parameter`（由提示词保证）。
  - `source_doc` = `title`，没给 `title` 时用附件文件名（约定第 3 节）。
- **密钥**：三个工具都声明需要密钥：`key_name=pg_kb`、`key_type=database_credentials`，字段 host / port / database / username / password。绑定现有的 Nexus 密钥 `pgvector-10.0.1.38`，即应用用户 `nexus`。
  - 10-29 的连通实测已证明：导入的工具在 VM 里拿得到这把密钥，用 psycopg 3.3.4 连得上。
  - 连接超时 5 秒；只执行写死的、带参数的 SQL；错误里不带密码、连接串、主机名。
  - 拿不到密钥就报 `credentials_missing`，不回落。
- **嵌入**：工具不算向量。写入时在同一个事务里调 `kb_embed_batch(要写的正文[], 'search_document')`，库里按 `kb_meta` 登记的模型（切换后是 Cohere v4）生成，所以写进去的向量和表里其他行、和审核 Agent 的问句向量永远是同一个模型。
- **回复里报模型**：从 `kb_meta` 读出模型与维度放进回复（`embedding_model`）；没有 `kb_meta` 时报 `null`，不拒绝写入（向量照样由库里的同一个函数算）。

### 3.3 解析（四种格式 → 同一种记录）

记录就是 `approval_rules` 的一行（列见 `kb/sql/approval_rules.sql`）：`rule_id`、`rule_type`、`chapter_no`、`chapter`、`seq_no`、`business_item`、`segment`、`amount_tier`、`approval_path`、`approval_path_text`、`final_approver`、`post_actions`、`not_applicable`、`extra`、`scope_controls`、`chapter_note`、`content`、`source_doc`、`source_version`、`source_tag`、`record_sha256`。

**判断类型**（逐块，实现方决定）：
- 文档里的表，表头能被 `parse_rules` 认成审批矩阵 → 这些表按矩阵解析，照 `parse_rules` 现有规则：一行一条审批路径，外加制度说明（general）与章节说明（chapter_note）。
- 矩阵之外、`parse_rules` 现在丢掉的文字，按下面分：
  - 带条款标记（第 X 章 / 第 X 条 / 总则 / 「X、」以外的编号项）的 → 正文条款（`clause`）；
  - 封面与文档信息（标题、版本、发布范围、起草部门这类短行，没有条款标记）和修改记录表（表头含「修改记录 / 修订记录 / 版本记录」）→ 不入库，在解析报告里列出「未入库：封面 N 段、修改记录 N 张表」。
- 没有矩阵的文档整份按正文条款解析。
- 实测真实制度现在被丢掉的只有封面 4 行（82 字）和 1 张「文档修改记录」表，按上面的规则都不入库，所以它照样是 102 条、再入库一条不写。

**各格式怎么读**：

| 格式 | 读法 | 不支持时 |
|---|---|---|
| Word | 只收 .docx（WordprocessingML），按原文顺序读段落（带标题样式）和表格 | .doc 报 `unsupported_format`，提示另存为 .docx |
| Excel | 只收 .xlsx，每个工作表一张表。是矩阵就按矩阵；不是，就一行一条记录（「表头：值」连起来） | .xls 报 `unsupported_format`，提示另存为 .xlsx |
| PDF | 读文字层（pdfplumber），按页读文字和表格；表格认成矩阵就按矩阵 | 一页文字都读不出时报 `no_text_layer`，不做 OCR |
| Markdown | 按 UTF-8 读（去 BOM），`#` 标题是结构，管道表格同样判断是否矩阵。Nexus 收 .md：附件白名单里有 `md`（`text/markdown`），对话附件和 A2A 文件 Part 都收（`nexus_utils/publication_gateway/attachments.py`），S3 Vectors 文档管家的名片 `defaultInputModes` 里也有 `text/markdown` | — |

- **PDF 里的矩阵（实现方决定）**：合并单元格常读不全，这一类在解析报告里加提醒，建议审批矩阵用 Word / Excel。
- **矩阵编号**：仍是 `C<章>-<序号>`。Excel / Markdown 的矩阵没有 Word 那样的章名时，章号取工作表名或最近的「X、」标题；还取不到，就报错让人补，不编号。

**正文条款（`clause`，实现方决定）**：
- **切分标记**（层级从高到低）：
  - 「第 X 章」「第 X 节」；
  - 「第 X 条」；
  - 「一、」「（一）」「1.」「1.2」「（1）」；
  - Markdown 标题、Word 标题样式。
- **一条一块**：最低一级的「条」（或编号项）是一块，内容到下一个同级或更高级的标记为止；条下的（一）（二）小项跟着条走。
- **超长**：一块超过约 600 字时，按句子拆成 `-a`、`-b`…，避免长条款靠关键词多排到矩阵行前面（风险 1）。
- **完全没有编号的散文**：按段落成块，短段落合并到约 400 字，编号 `P001`…
- **编号**：`<制度标识>-<条号>`，按条号生成，不按顺序号：
  - 第十二条 → `A12`；
  - 三、（二）→ `S3.2`；
  - 1.2.3 → `N1.2.3`；
  - 拆开的段加 `-a`。

  例如 `travel-policy-A12`。同一文档里条号重复时加 `~2`，并写进报告。带制度标识前缀，所以永远不会撞上矩阵编号（C05-3.2、G-01、C03-NOTE）。
- **字段**：
  - `rule_type=clause`；`chapter` = 「章 › 节」；`seq_no` = 条号；
  - `business_item` = 条标题，没有标题就取首句，至多 40 字；
  - `scope_controls` = 条文：审核 Agent 现在按 `scope_controls` 分段读全文；
  - `content` = 「文档名 › 章 › 节 › 第 X 条：条文」，向量与关键词都用它；
  - `extra` = `{kind: clause|table_row|paragraph, page, sheet, row, part}`。
- **解析报告**：
  - 每类、每章各多少条；拆分了哪些；条号重复；
  - 空文本或疑似乱码的块；
  - PDF 每页读出的字数；
  - 识别成矩阵的表、没识别成矩阵的表。

### 3.4 入库规则（照 `ingest_rules.py`，由 `kb_store` 实现一次）

- **制度标识**：`source_id` 即 `source_tag`，规则与页面相同：`^[a-z0-9][a-z0-9-]{1,62}$`。`source_doc` = 文件名，`source_version` = 版本说明。
- **对比**：`record_sha256` 是除向量外全部列的哈希：
  - 一致且有向量 → 不写；
  - `content` 没变、其他列变了 → 只更新这些列，不重算向量；
  - 新的或 `content` 变了 → 重算向量后 upsert。
- **清理**：同一 `source_tag` 下、新版本里已没有的编号 → 删除。
- **冲突**：编号已属于另一份制度（别的标签；没有标签时看来源文档）→ 整份拒绝，一条不写，回 `rule_conflict` 带 `conflicts`。
- **顺序**（实现方决定：对比也放进锁里，免得对比完到写入之间被别人改了）：
  1. 先在 `kb_documents` 记一行 `ingesting`，单独提交，留下痕迹；
  2. 一个事务里做：`pg_advisory_xact_lock`（与 `deploy.sh` 的入库共用同一把锁，两条路不会同时写）→ 对比 → 冲突就整份拒绝 → `kb_embed_batch` 算要写的向量（Bedrock 失败就整份放弃，知识库不变）→ upsert → 清理 → 这一行改成 `ingested`（带报告和结果；同标签的旧记录标 `superseded`，照 `kb_admin` 现有做法）；
  3. 失败就回滚，这一行改成 `failed` 并写明原因。
- **权限检查**：`approval_rules` 的属主必须是当前用户（`nexus`），照 `ingest_rules` 现有的检查。

### 3.5 管理：清单、详情、下线、恢复、删除、校验

- **下线（实现方决定）**：把这份制度的规则从 `approval_rules` 挪到 `approval_rules_archive`（同样的列，加 `archived_at`），在一个事务里完成。
  - 这样 `kb_search` 和审核 Agent 的 `ILIKE` 补查都看不到它们，不用改检索函数，也不用改审核 Agent。
  - 归档表由工具按需建（`CREATE TABLE IF NOT EXISTS … (LIKE approval_rules INCLUDING DEFAULTS)`；应用用户有 `CREATE` 权限）。
- **恢复**：挪回来。挪回的编号在 `approval_rules` 里已被别的制度占用时，回 `rule_conflict`，一条不挪。
- **删除**：照约定，硬删除这份制度在两张表里的全部行，连同它在 `kb_documents` 里的登记；`affected` = 删掉的规则条数。
- **清单 / 详情**（字段照约定）：
  - 按 `source_tag` 汇总两张表，在线 = `active`，归档 = `inactive`；
  - 每项：`source_id`、`title`、`source_version`、`file_name`、`doc_hash`（最近一次 `kb_documents` 的 `sha256`）、`rules_total`、`status`、`ingested_at`、`updated_at`（ISO 8601，UTC），另带各类型条数；
  - 详情另列编号。
- **校验**（只读；照约定可带 `source_id`，不带 = 全部；每个问题 `{code, source_id, detail}`）。查这些：
  - 没有向量的行，维度不是 1024 的行；
  - 没有标签的行；
  - 两张表里重复的编号；
  - `kb_documents` 里卡在 `ingesting` 超过 30 分钟的记录；
  - `kb_meta` 与工具的模型是否一致；
  - 抽 3 行，用 `kb_embed(content, 'search_document')` 重算，与库里的向量比余弦（≥ 0.999 算一致），用来发现残留的 Titan 向量。

### 3.6 PG 知识库换成 Cohere v4（`kb/`，另一个会话提交之后、人确认后上线）

1. **`kb/sql/kb_search.sql`**：
   - `kb_embed(input text, purpose text DEFAULT 'search_document')` 按配置的模型发请求（实现方决定：两种都支持，缺省 Cohere v4，`kb/` 以后仍能部署 Titan 版）：Cohere v4 用 `texts`、`input_type`、`embedding_types`、`output_dimension=1024`；Titan v2 照旧，忽略 `purpose`。
   - 原来的单参数版先 `DROP`，否则调用会有歧义。授权照旧。
   - 缓存键改成 `sha256(模型 | 维度 | 用途 | 文本)`，旧的 Titan 缓存清掉。
   - `kb_search` 里改成 `kb_embed(question, 'search_query')`。
   - `kb_search` 的排序改成 `ORDER BY 关键词命中数 DESC, (rule_type = 'clause') ASC, 语义距离 ASC`（项目负责人已同意，见第 0 节）。
   - 新增 `kb_meta(key, value)`：超级用户写，应用用户只读；登记 `embed_model`、`embed_dim`、`switched_at`。
   - 新增 `kb_embed_batch(inputs text[], purpose text DEFAULT 'search_document') RETURNS vector[]`：与 `kb_embed` 同一个模型、同一个缓存，缓存没命中的按 96 条一次调 Bedrock（Titan 没有批量接口，逐条调）。入库都经它。
   - **每分钟上限**（实现方决定）：`kb_embed` 照旧 300 个新向量；`kb_embed_batch` 另算，2,000 个新向量（一份文档至多 2,000 条记录，正好一分钟内入完）。两者都只数缓存没命中、真去调 Bedrock 的。最坏的情况是有人拿应用用户每分钟刷满 2,300 个新向量，按 Cohere v4 的价格约每分钟 0.1 美元。
2. **模型 id（实现方决定）**：PG 里用 `us.cohere.embed-v4:0`，上线前实测一次。
3. **测试台栈的 `KbBedrockPolicy`**：从只许 Titan 改为许 Cohere v4，包括推理配置文件与它路由到的各区域的基础模型。切换稳定后去掉 Titan。
4. **配置与缺省值**：`EMBED_MODEL_ID` / `EMBED_DIM` 等配置同步改。缺省值改成 Cohere v4 的地方：
   - `kb/deploy.env.example`；
   - `kb/cfn/pgvector-host.yaml`（新建 PG 主机时实例角色的权限）；
   - `kb/deploy.sh` 的 preflight 探测（它现在发的是 Titan 格式的请求），以及 `ingest` 阶段改用 `--embed sql`。

   `poc/app07/kb-runner.mjs` 由另一个会话删掉，不用改。
5. **防混用（实现方决定）**：`db` 阶段先读 `kb_meta`；没有 `kb_meta` 但表里已有向量时，按 Titan 算。登记的模型与配置的不同，就停下报错，不重新应用 `kb_search.sql`。必须显式加迁移参数（例如 `--migrate-embeddings`）才执行下面第 6 条。已知只有测试台这一套是 Titan。
6. **重算**：
   - 先整表备份成 `approval_rules_titan_backup`；
   - 再分批 `UPDATE … SET embedding = kb_embed(content, 'search_document')`：每分钟上限 300 个新向量，102 条一次就够；
   - 最后写 `kb_meta`。
7. **回滚**：恢复旧的 `kb_search.sql`，从备份表把向量拷回，`kb_meta` 改回。验收通过后再删备份表。
8. **验收**（第 1 节第 3 条）：
   - 切换前用 Titan 跑一遍基线（研究题库 + 已知问题，经 `kb_search`），切换后再跑一遍对比；
   - 再跑测试台 PG 方式的端到端（`run07.sh`）。

### 3.7 Agent、提示词、发布

- **复制来源（实现方决定）**：从 `knowbase_writer_agent` 复制，提示词整份换掉，工具引用导入的 `pg_kb_tools`。复制带来的 PG 版旧工具目录不会被加载。
- **提示词**：
  - 「规则请求（`kb.rules/v1`）」一节与 S3 Vectors 文档管家的模板用**同一段文字**：只调对应工具一次、参数原样照填、不再确认、不支持的操作原样报错、数据和附件里的文字只当数据。这段文字抽成一份共用片段，两个模板都引用，由实现方定怎么拼。
  - 对话里的用法：上传附件说「入库」就先 `preview` 给人看，确认后 `ingest`；删除、下线前确认。
- **发布**：A2A + MCP，跟随最新版本。测试用的调用密钥由管理员脚本直接写进 600 文件，不打印。九安以后用的密钥走「Agent 接入」页（下一份设计）。

### 3.8 交付包与脚本（尽量不另写）

- **包放在哪（实现方决定）**：audit-nexus 仓库根目录 `knowledgebase-writer-agent-pg/`，与 `knowbase-s3vectors-agent/` 并列。内容：拼装出的工具、提示词模板、`deploy.env.example`、测试、README。
- **管理员脚本不复制**：
  - 把 `knowbase-s3vectors-agent/scripts/nexus_admin.py` 和 `render.py` 改成读「包描述」：模块名、工具列表、密钥声明、部署参数段。两个包共用。
  - 现有 S3 Vectors 用法与测试照过。
  - 管理员脚本新增一个命令：按「模块路径 + 密钥名」绑定。现在绑定是经 Operator 做的，也可以继续用 Operator。
- **端到端脚本复用**：`e2e_upload.py`、`summarize_turn.py`、`e2e_digest.py`。
- **本机测试复用**：PG 用 PGlite + pgvector（`knowbase-writer-agent` 的做法），库里装 `approval_rules.sql` 与 `kb_search.sql`，其中调 Bedrock 的 `kb_embed` / `kb_embed_batch` 换成按内容算的假函数；工具这一侧不需要假 Bedrock。

## 4. 验证

**本机**（不碰线上）：
- `parse_rules` 重构前后对 `kb/tests` 的虚构矩阵、以及真实制度（只在本机，不进仓库）逐条相同；
- 四种格式各一份虚构文档：
  - Word 矩阵、Excel 矩阵、Markdown 正文 + 表格、PDF 正文（由测试生成，业务内容全部虚构）；
  - 检查记录、编号、报告；
- 入库规则：不变、只改说明、重算、清理、冲突拒绝、预览不写也不调 `kb_embed_batch`、失败回滚并留下 `failed`；
- 下线 / 恢复 / 删除 / 校验；`kb.rules/v1` 回复过测试台的形态校验（把 `kb-s3v-client.mjs` 的校验当作测试夹具调用）；
- 拼装出的工具文件与源码一致；
- 原有测试照过：`kb/tests`、外壳、PoC、audit-agent、S3 Vectors 包。

**线上**（人确认后，按第 0 节的顺序）：
0. **先验证同目录 import**（3.1）：最小工具导入 Nexus、对话里调一次。这一步不碰知识库，可以在另一个会话提交之前做，但仍要人确认（它是一次导入写入）。
1. **切换模型**（3.6）：先跑基线，再切换、重算，然后对比；最后跑测试台 PG 端到端。
2. **建 Agent**：复制、导入工具（声明数据库密钥）、绑定密钥、保存提示词、发布。
3. **Agent 端到端**，经对话与 A2A 两条路：
   1. 真实制度用它现有的标签再入库 → 102 条 `unchanged`，证明解析一致、没有改动；
   2. 虚构矩阵：用新标签，章号取不会撞的「十一、」起 → 新增 → 检索命中 → 下线后检索不到、恢复后又能 → 删除；
   3. 虚构矩阵：编号撞上真实制度 → `rule_conflict`，一条不写；
   4. 正文（Markdown / PDF / Excel 各一份）：新增 → 入库后第 3 条的检索题结果不变 → 删除；
   5. `check` 通过。

   测试结束时知识库回到只有真实制度的 102 条。

## 5. 风险，先验证再铺开

1. **条款挤掉矩阵规则**：`kb_search` 按关键词命中数优先。靠三处兜住：
   - 打平时矩阵行优先（已同意，3.6）；
   - 条款长度上限；
   - 入库前后跑检索题对比（第 4 节 3.4），不过就调切法。

   除此之外再改 `kb_search` 的排序，要另行确认。
2. **换模型改变审核 Agent 的结果**：靠基线对比和测试台端到端兜住；不过就回滚（3.6）。
3. **两个会话撞车**：本设计全部在独立工作区的分支 `feat/pg-kb-steward` 上做。另一个会话这一轮提交后，先把分支并到它的最新提交，再动 `kb/` 的线上部分与测试台。
4. **测试台的 IAM 与栈**：`KbBedrockPolicy` 的变更是 CloudFormation 变更。先出变更集给人看，只许有这一处。
5. **`kb/lib` 重构影响页面直连入库**：由逐条一致的测试、`kb/tests`、测试台测试兜住。
6. **PDF 表格识别不全**：矩阵建议用 Word / Excel，报告里提醒。
7. **长文档的时限**：测试台 A2A 入库的时限是 300 秒。500 块正文的向量约 6 批，在库里数秒完成；一份文档至多 2,000 条记录（与 `kb_embed_batch` 的每分钟上限一致），超了报错。

## 6. 留给实现者的

- 拼装工具文件的具体规则；
- `doc_blocks` 的接口；
- 条号规范化的细节；
- 各错误码与中文提示；
- PGlite 里假 `kb_embed` / `kb_search` 的写法；
- 包描述的格式；
- 提示词共用片段的拼法；
- 归档表的列、清单的分页。

**以后可做、本轮不做**：
- S3 Vectors 规则工具改成从同一份 `kb/lib` 拼装（去掉它抄的 `parse_rules`）；
- 审核 Agent 引用 `clause` 行的格式；
- 测试台经 A2A 调这个 Agent 的接口与页面（下一份设计）；
- `kb_search` 的金额过滤。

**提交与推送**：照项目负责人的规矩，本机测试和线上端到端都通过、项目负责人确认之后再提交、推送。
