# 制度知识库加一种部署方式：S3 Vectors 文档管家；另加审核员自定义规则（设计，2026-10-28）

状态：**已确认（2026-10-28）**：本轮只跑 S3 Vectors 方式的端到端，现有环境停在 S3 Vectors；文档管家包复制过来直接用，原目录不动；调用密钥走「Agent 接入」页。接在 10-26 那份《制度知识库：上传入库、历史与库内语义检索》之后。知识库从此有**两种部署方式**，一个环境选一种：

- **PG 方式**（现有，保留）：`kb/`，PostgreSQL + pgvector，审核 Agent 经连接器用 `kb_search`；
- **S3 Vectors 方式**（新）：公司制度存 S3 Vectors，由「知识库文档管家（S3 Vectors 版）」经 A2A 写入和维护，审核 Agent 用一个按参数检索的工具读规则。

另加审核员自己的规则（两种方式都有），只随审核员手动发起的那一轮发给审核 Agent。下文第 3.1–3.4 节、3.7 节里讲的是 S3 Vectors 方式；PG 方式的行为不变，除了加上自定义规则。

标「实现方决定」的是讨论中由 Claude 定下、项目负责人没有逐条拍板的，可以改；其余是项目负责人定的。

## 0. 已定的事

| 问题 | 决定 |
|---|---|
| 两种部署方式 | **PG 方式和 S3 Vectors 方式都保留**，是两种不同的部署方式；部署指南里要先让部署的人选一种，再照那一种往下走。DEPLOY_ENV 加 `KB_MODE=pg\|s3vectors`；不写就是 `pg`，保证不给 DEPLOY_ENV 时行为不变（10-27 计划的总约束）。现有环境 `beine1013.env` 改成 `s3vectors` |
| 文档管家包 | 把 `nexus-customer-deploy/knowbase-s3vectors-agent/` **复制进交付包**（仓库根目录 `knowbase-s3vectors-agent/`，和当初复制 `kb/` 的做法一样：不带 `deploy.env`、`.state/`（里面有调用密钥）、`.build/`、`build/out/`、制度原文和 `__pycache__`）。部署指南的 S3 Vectors 方式**直接引用它的 GUIDE.zh.md**，不在指南里重写；包里现有的脚本、工具和 GUIDE 能直接用的就直接用，只加这次需要的（规则工具、`rules` 索引、提示词一节、GUIDE 第 10 章）；改动都在复制过来的这一份里做，原目录不动 |
| 调用密钥 | 测试台调文档管家用的调用密钥**走「Agent 接入」页**：人粘贴启用，外壳从九安的启用记录里取（3.4） |
| 顺序 | 先做本设计，再接着做 10-27 测试部署指南计划的 Task 5–9；指南的知识库部分写成两种方式二选一（实现方决定） |
| 公司制度存哪、谁写（S3 Vectors 方式） | 存 S3 Vectors（现有环境：向量桶 `knowbase-s3v-demo`，新建 `rules` 索引）；**由文档管家写**：「制度知识库」页经 A2A 调它的发布（现有环境 `pub_2a6d8020998b2a93`）入库和维护 |
| 怎么切 | **一行一条规则**：审批矩阵每行一个向量，复用 `kb/lib/parse_rules.py` 的解析；不用文档管家现有的通用分块 |
| 审核 Agent 怎么检索 | **板块 + 金额过滤由工具代码拼**（研究 P2 / E10 的做法），模型只填「问题、板块、金额、取几条」；不经连接器让模型自己写过滤 |
| 检索工具用什么凭证 | **复用文档管家的写入密钥**（DEPLOY_ENV 的 `KB_S3V_KEY_ID`；现有环境是 Nexus 密钥 `key-34360f081254`（`kb-s3vectors-writer`，IAM 用户 `knowbase-s3v-writer`，访问密钥 `****455C`））。项目负责人知道它能写能删，接受审核 Agent 带着这个权限 |
| 审核 Agent 的连接器 | S3 Vectors 方式下，PG 连接器从审核 Agent 发布的动态配置里解绑，提示词里没有 SQL；PG 方式下照旧绑连接器、用 SQL。现有环境切到 S3 Vectors 后，PG 容器保留不删（实现方决定） |
| 自定义规则是什么 | 审核员自己上传的 Markdown（.md）或 Word（.docx），**按审核员账号分开存**，不进任何知识库，不经文档管家 |
| 自定义规则什么时候用 | **自动初审不带任何人的自定义规则**。审核员在单据页点「运行一轮 AI 独立建议」时，测试台把**这位审核员**当前的全部自定义规则附在请求里；这一轮成为这张单的当前建议（所有人看同一份），建议里写明「含 poc-reviewer 的自定义规则」 |
| 页面上去掉什么 | S3 Vectors 方式的页面没有逐条规则的「入库预览」（新增 / 重算 / 删除 / 冲突红字）和「检索日志」（实现方决定，项目负责人在复述里认可），入库结果仍给条数；PG 方式的页面照旧 |
| 一个环境一套 | S3 Vectors 方式下，向量桶、`rules` 索引名、工具目录、密钥 ID、文档管家发布都进 DEPLOY_ENV（`KB_S3V_BUCKET`、`KB_S3V_RULES_INDEX`、`RULES_TOOL_DIR`、`KB_S3V_KEY_ID`、`KB_S3V_PUBLICATION_ID`），代码和提示词里不写死。工具模块按环境 render（桶名、索引名写进去），所以每个环境各导入一份、各绑一次密钥。本轮只做现有环境 `beine1013.env`；`rehearsal.env` 是用完即删的演练，不在本轮（实现方决定） |
| 自定义规则改了以后 | 已有的建议**不标过期**：建议里已写明「含 poc-reviewer 的自定义规则」，审核员改完规则自己再发起一轮。不为此改九安的过期判断（实现方决定） |

## 1. 为什么做，做成什么算成

- **为什么**：往后的方向是「文档管家写规则，审核 Agent 读规则」，知识库可以不依赖一台常开的 PG；PG 方式保留给想用 PG 的部署。研究（2026-10-26，55 题，Opus 5.5 作答）里，同一份制度：通用分块约 62% 答对规则编号；一行一块纯向量 92.7%；一行一块 + 代码拼的板块 / 金额过滤 100%（改写题库 96.2% / 审批人 100%）。所以 S3 Vectors 方式的切法和过滤都按最后一种做。
- **成功**：
  1. S3 Vectors 方式：管理员在「制度知识库」页上传《财务事项审批及授权管理办法》.docx，经文档管家入库后，页面列出这份制度和规则条数，检索框按问题能查到预期规则；
  2. S3 Vectors 方式的端到端测试里，4 张对公付款单的自动初审结论照旧（001 pass、002 fail、003 pass、004 fail），引用的规则编号都在 `rules` 索引里；
  3. 审核员上传一条自定义规则后手动发起，结论按这条规则变了、依据里写明是自定义规则；删掉规则再发起，结论恢复；
  4. PG 方式不坏：现有单元测试照过，`pg` 渲染的提示词与线上逐字一致（只多自定义规则一段）；本轮不跑 PG 方式的端到端；
  5. 部署指南让部署的人先选方式，S3 Vectors 方式照复制进来的文档管家包的 GUIDE.zh.md 部署。
- **非目标**：散文类文档在这一页入库（文档管家的 `chunks` 索引照旧可在对话里用，这一页只管审批矩阵，实现方决定）；一个环境同时用两种方式；按审核员分开存建议；自动初审带自定义规则；章节过滤（E10 里加章节过滤反而降低前 5 命中）。
- **反目标**（做到了也算失败）：S3 Vectors 方式下审核 Agent 还会去查 PG（或反过来）；不给 DEPLOY_ENV 时现有行为变了；自定义规则进了公司知识库，或出现在自动初审的请求里；A 审核员的规则被附进 B 审核员发起的那一轮。

## 2. 架构（S3 Vectors 方式）

PG 方式的架构见 10-26 的设计第 2 节，不变；两种方式只在「公司制度」怎么存、审核 Agent 怎么查上不同，「我的规则」和手动发起时附规则是同一套。

```
浏览器（规则库 › 制度知识库）
  ├ 公司制度（只给管理员）── 上传 / 清单 / 下线 / 恢复 / 检索
  └ 我的规则（管理员、分析员）── 上传 / 查看 / 删除，只看得到自己的
        │ 同一登录、CSRF
        ▼
九安 v0.7.10 + 外壳 poc/app07
  ├ S3 Vectors 方式的公司制度接口（新）── A2A（调用密钥：「Agent 接入」页的启用记录）──▶ Nexus：文档管家 pub_2a6d8020998b2a93
  │                                                          └ 工具模块 s3vectors_rules_tools（新）
  ├ custom-rules（新）── /var/lib/jiuan07/custom-rules/<账号>/                │ key-34360f081254
  └ review_advice 组装器的外壳（新）                                           ▼
        人手动发起：附 input.customRules ──A2A──▶ Nexus：审核 Agent  ──rules_search──▶ S3 Vectors
        自动初审：不附                              pub_5c53e70d8dc7ddea              knowbase-s3v-demo / rules
```

- 两个 Agent 都在 nxs-beine1013 上，发布的属主都是 admin（`f04a02c4-…`），也就是 `key-34360f081254` 的属主；A2A 会话落在发布者名下，用的是发布者的密钥绑定（文档管家交付说明第 6 章实测过）。
- 向量：Cohere Embed v4，1536 维，规则用 `search_document`、问句用 `search_query`（与文档管家现有工具一致）；Bedrock 走隔离环境的运行角色，密钥只管 S3 Vectors。

## 3. 各部分

3.1–3.4 只在 S3 Vectors 方式下用；文档管家包指复制进仓库的 `knowbase-s3vectors-agent/`（3.9）。

### 3.1 AWS：`rules` 索引（文档管家包 `infra/aws_setup.sh`）

- 在同一个向量桶里加索引 `rules`：1536 维、余弦、`float32`，**不可过滤键只有 `text`**（规则全文）。用管理员的 AWS 身份建（写入密钥没有 `CreateIndex`）；写入密钥的策略已经覆盖 `bucket/knowbase-s3v-demo/index/*`，不用改。
- 每条规则一个向量，**键 = 规则编号**（如 `C05-3.4`、`G-02`、`C05-NOTE`），可过滤元数据照 E10 的 `metadata_for()`（`nexus-customer-deploy/kb-options-comparison/experiments/e10_s3vectors.py:62`），再加来源和状态：

```json
{"source_id": "fin-approval", "source_version": "V4.0", "rule_type": "matrix", "chapter_no": 5,
 "segments": ["九安", "柯顿"], "amt_kind": "range", "lo": 200000, "lo_incl": false, "hi": 500000, "hi_incl": true,
 "active": true, "ingested_at": 1761630000, "text": "（不可过滤：规则全文，与 parse_rules 的 content 相同）"}
```

- 金额档转区间用研究里的 `tiers.py` 的 `tier_interval()`（`~/Documents/Word_KB_Vectorization_DeepResearch_20261026/experiments/tiers.py`，60 行，我们自己的代码），搬进工具模块；`mixed` / `any` / 非金额条件一律 `amt_kind: "other"`，不按金额过滤。可过滤元数据要在 2 KB 以内。
- 一份制度的登记（来源标识、版本、文件哈希、规则条数、状态、时间）放在哪由实现方定：单独一个小索引 `rule-sources`，或沿用 `docs` 索引加 `kind` 区分。要求是清单、下线、恢复都能做，且不影响文档管家现有的 `s3vectors_statistics` 统计。写、删操作照现有做法记进 `audit` 索引。

### 3.2 文档管家：新工具模块 `s3vectors_rules_tools.py`

- **单独一个模块**，按现有 `scripts/nexus_admin.py import` 的流程导入成新的工具目录，确认请求里给需要密钥的工具声明 `key_name=s3vectors_kb`、`key_type=aws_credentials`，再把这个模块路径绑到 `KB_S3V_KEY_ID`（现有环境 `key-34360f081254`；`PUT /api/v2/keys/tool-bindings`）。不往已验证的 `s3vectors_kb_tools.py` 里加函数（实现方决定：发布新版本时新函数会不会带上「需要密钥」标记没验证过，单独导入最稳）。共用的代码（凭证、客户端、嵌入、`_fetch_k` 多取再截断、错误映射）可以复制过去，或者 render 时拼进来。
- 工具（名字可调，参数和返回是约定）：
  - `rules_writer(file_path, source_id, source_version, title)`：解析附件里的审批矩阵 .docx（搬 `parse_rules.py` 的逻辑，只用标准库）→ 算元数据 → 嵌入 → `PutVectors`（每批 ≤ 500）→ 删掉这个 `source_id` 旧版本里有、新版本没有的键 → 更新登记。**规则编号已属于另一个 `source_id` 时整份拒绝**，列出冲突编号（沿用现在 PG 版的保护）。返回 `success, source_id, source_version, rules_total, written, removed, unchanged, conflicts, report`（`report` 是 `parse_rules` 的 REPORT：各类条数、各章行数、重复编号、缺审批路径的行）。重复上传同一文件内容时不重写，直接返回现状。
  - `rules_search(question, segment="", amount=None, top_k=8)`：嵌入问句；过滤 = `active=true` 且（给了板块时）板块命中或全板块，且（给了金额时）金额落在区间里或非金额条件。拼法与 E10 的 `s3v_filter(f, use_seg=True, use_amt=True, use_ch=False)` 同义（`e10_s3vectors.py:75-91`）。返回每条规则的 `rule_id, rule_type, chapter_no, segments, amt_kind, source_id, text, distance`，按距离排序；`text` 就是 `parse_rules` 的 `content`，里面已经有章名、业务事项、板块、金额档、审批路径、最终审批人、控制要点（业务事项、审批路径这些长字段不另存成可过滤元数据，免得超 2 KB）；也返回实际用的过滤条件，方便排错。
  - `rules_manager(action, source_id, ...)`：`list`、`detail`（带这份制度的规则编号清单）、`deactivate`（软下线：规则 `active=false`）、`restore`、`delete`（硬删除这份制度的全部键和登记）、`check`（登记条数与索引里的键一致）。
- 本机测试照 `tests/local_test.py` 用内存替身：解析结果与 `kb/lib/parse_rules.py` 对同一 fixture 逐条一致；`tier_interval` 与研究的结果一致；过滤语义与 E10 的 `keep()` 一致；新版本替换、冲突拒绝、软下线后检索不到。

### 3.3 文档管家：提示词与 A2A 约定

- 提示词（`prompt/knowbase_s3vectors_agent.yaml.tmpl`）`tools_dependencies` 加新模块的三个工具；加一节「规则请求」：文字以 `kb.rules/v1 · <操作>` 开头、带一个数据 Part `{"op": …, …}` 时，**只调对应的工具一次，原样返回工具的 JSON**，不加文字。附件路径照现有的附件目录规则找。
- 操作：`ingest`（带 .docx 文件 Part 与 `source_id, source_version, title`）、`list`、`detail`、`deactivate`、`restore`、`delete`、`search`（`question, segment, amount, top_k`）、`check`。
- 测试台收到后去掉偶尔的 ```json 围栏，`JSON.parse`，按操作校验字段形态；不合格当失败，页面说「文档管家的回复不合格」，不重试写操作。

### 3.4 测试台：S3 Vectors 方式的「公司制度」（新的路由模块，与 PG 方式的 `kb-routes.mjs` / `kb-runner.mjs` 并存）

- 外壳按 `POC07_KB_MODE`（由 DEPLOY_ENV 的 `KB_MODE` 经 `bench07-configure.sh` 写入）挂其中一套：`pg` 挂现有的 `kb-routes.mjs`（行为不变），`s3vectors` 挂新的这套；两套不同时挂。页面用一个只读接口（或现有会话 / 功能信息里加一个字段）知道当前是哪种方式。
- 接口挂在同一个前缀 `/api/analysis/v1/poc/kb/` 下，只给管理员：上传（存原文件 `<uploadsDir>/<sha256>.docx`，0600）→ 后台经 A2A `ingest`，先回 202、页面轮询；同一时间只跑一个入库；清单、详情、下线、恢复、硬删除、检索都是同步的 A2A 调用（每次 10–20 秒，页面显示「正在处理」）。
- 上传时填「制度标识」（沿用现在的标签规则 `^[a-z0-9][a-z0-9-]{1,62}$`，按文件名预填）、版本说明、文档名。**同一标识再上传 = 新版本**：旧版本里有、新版本没有的规则下线删除。
- A2A 用 `poc/app/nexus/a2a-client.mjs` 的 `a2aCall`（已支持文件 Part 和数据 Part），超时：入库 5 分钟，其余 2 分钟。
- 调用密钥**走「Agent 接入」页**：给文档管家的发布签发一把调用密钥（Nexus 网页「互联中心 › 对外发布」，或包里的 `scripts/nexus_admin.py issue-call-key`），由人在九安「平台 › Agent 接入」页找到「知识库文档管家（S3 Vectors 版）」，粘贴启用。补丁 0003 之后任何名片都能启用，启用即「就绪」、供前端工作流调用；它不是审批 Agent，不进审批流。外壳调用时用 `agentEnablement.credentialFor(publishId)` 取钥匙，和「Agent 接入」页的测试 `callRaw`（`poc/app07/server.mjs:162-167`）同一做法；Nexus 回 401 / `credential_invalid` 时照现有做法 `markInvalid`。密钥不进 `secrets.env`、配置文件和日志。
- 发布编号由 DEPLOY_ENV 的 `KB_S3V_PUBLICATION_ID` 经 `bench07-configure.sh` 写成 `POC07_KB_S3V_PUBLICATION_ID`，地址是 `<nexusOrigin>/a2a/<publishId>`。`settings.mjs`：`pg` 方式照旧看 `POC07_KB_PG_HOST`；`s3vectors` 方式要求配了发布编号。这个发布还没在「Agent 接入」页启用（或钥匙失效）时，页面的「公司制度」块直接说「先在『Agent 接入』页启用知识库文档管家」，不发调用。
- 页面上一次上传历史（时间、文件名、上传人、制度标识、版本、状态、条数、用时）由外壳自己记（文件或九安库，实现方定）；清单以文档管家返回的为准。

### 3.5 测试台：「我的规则」（新 `poc/app07/custom-rules.mjs`，两种方式都有）

- 接口 `/api/analysis/v1/poc/custom-rules`：列表、上传、查看全文、删除，**只操作当前登录账号自己的**；管理员、分析员都能用（`policy_reviewer` 不能发起 AI 独立建议，不开放）。
- 存放：`/var/lib/jiuan07/custom-rules/<账号>/<id>.json`（0600，目录 0700）：`{id, title(文件名), format, chars, sha256, uploadedAt, text}`。端到端重置不清（测试自己清自己的）。
- 转文本：.md 按 UTF-8 读（去 BOM）；.docx 在隔离子进程里（`python3 -I`，只用标准库，所以不依赖只有 PG 方式才建的 kb-venv）抽正文段落与表格行（每行单元格用「 | 」连起来），不执行任何宏或外部引用。
- 上限（实现方决定）：每人最多 10 份；单个文件 2 MB；**每人全部规则合计 20,000 字**，超了拒绝上传并说明还剩多少。上传后页面显示转出来的文本，让审核员核对。

### 3.6 测试台：手动发起时附上自定义规则

- **在哪接**：包一层 `agentAssemblers['review_advice@1']`（`poc/app07/server.mjs:142`），九安每轮都按这个表找组装器（`agent-task-service.mjs:103`）。不改九安。
- **怎么知道是谁发起的**：九安把发起人记成 `requestedBy = actor.principal`（`agent-task-service.mjs:231`，如 `account:poc-reviewer`），但不传给 `assemble()`。外壳在单据页的发起入口 `reviewAdvice.start`（`server.mjs:194`）外面用 `AsyncLocalStorage.run({actor})` 包一层，组装器外壳从里面读。**这条传递链是读代码推断的，先写一个单元测试证明能拿到**；拿不到就做一个最小的九安补丁把 actor 传进 `assemble`。
- **附什么**：只有 actor 是人（不是 `system:pipeline`）且这个账号有自定义规则时，往 `request.input` 加：

```json
"customRules": {"owner": "poc-reviewer", "items": [{"title": "房租付款补充要求.md", "text": "…"}]}
```

  `input` 根和信封都没有 `additionalProperties: false`，合同校验允许（`src/agent-contract/schema.mjs:183-190`）。
- **大小**：整份请求不超过 `maxRequestChars` 87,442 字（`tasks/review_advice/v1/task.json:52`）。九安的组装器在外壳之前已经裁过原件；外壳加上规则后再按九安 `fit()` 的办法从原件末尾逐页去掉（`review-advice.mjs:134-144`），**不裁自定义规则**；去完仍超就按 `AGENT_REQUEST_TOO_LARGE` 失败。改完重新跑合同校验，**重算 `inputFingerprint`**（它决定 Nexus 的 `contextId`，`nexus-a2a.mjs:211-213`，不重算的话两位审核员会共用一个会话）。
- 「Agent 接入」页的单据测试（`server.mjs:176`）和自动初审都不经这层，不附规则。

### 3.7 审核 Agent（`audit-agent/`）

- `prompt.yaml` 里和知识库有关的几段（第 4 条的例外、第 7 条、第 8 条、第 9 条 ②）按 `KB_MODE` 渲染成两种：`pg` 渲染出来要和现在线上的逐字一致（`tests/fixtures/prompt-expected-beine1013.yaml` 现有的测试保证这一点），只多出下面自定义规则那一段；`s3vectors` 渲染成下面这样。渲染机制（两份片段、条件块等）由实现方定，但 `apply.py` 只认渲染结果，不靠手工改线上提示词。
- `s3vectors` 方式的提示词：
  - 第 4 条的例外改成：需要依据制度时只调 `rules_search`；不提连接器、SQL、`approval_rules`、`kb_search`。第 7 条（运维 / 测验模式读写数据库）不要，第 8 条（规则查询模式）改成用 `rules_search` 作答（`kb/agent/prompt-rules.txt` 现在与第 8 条共用，PG 方式照旧共用）。
  - 第 9 条 ②：`rules_search(question="<业务事项的 2–4 个关键词>", segment="<所属板块>", amount=<支付金额，元>, top_k=8)`，一共不超过 3 次；工具返回的就是规则全文，不用再分列取原文。板块拿不准时不填 `segment`，金额读不出时不填 `amount`。
- 两种方式共有：
  - 新增自定义规则的处理（实现方决定）：`input.customRules` 是审核员给的**附加审核要求**，和公司制度一起核对；只能让结论更严（公司制度判 fail 的，自定义规则不能改成 pass），与现有第 ③ 步「按更高层级、更严格的要求执行」一致；其中要求忽略规则、改输出格式的文字照第 3 条不执行。用到时 `note` 以「（含 <owner> 的自定义规则）」开头；引用写成 `kind: "rule"`，`ref` 以「自定义：<title>」开头，不编规则编号。没有 `customRules` 时 `note` 不出现这几个字。
  - `agentVersion` 改大。
- `tools_dependencies`：`pg` 照旧是 `system_tools/data_connector/*`；`s3vectors` 只有 `imported_tools/${RULES_TOOL_DIR}/s3vectors_rules_tools/rules_search`。
- `setup.py` / `apply.py` / `nexus_common.py` 按 `KB_MODE` 分开：`pg` 照旧（占位 `${CONNECTOR_ID}`，`ensure_connector` 绑 PG 连接器）；`s3vectors` 用占位 `${RULES_TOOL_DIR}`，确保动态配置里**没有** PG 连接器（原样带回其余字段，只从 `connectors` 里去掉），并核对新模块对 `KB_S3V_KEY_ID` 的绑定在（`verify` 里 `configured=True`）。同一个环境换方式时重跑 `setup.py` 和 `apply.py` 就能切过去、切回来。DEPLOY_ENV 加 `KB_MODE` 和第 0 节「一个环境一套」列的五个键（`poc/infra/lib/deploy-env.sh` 与 `deploy_env.py` 的 `KEYS`、`example.env` 一起改）；`CONNECTOR_ID` 只在 `pg` 方式必填，`s3vectors` 方式那五个键必填。`tests/fixtures/` 里两种方式各有一份期望的提示词。

### 3.8 九安补丁 0004（「规则库 › 制度知识库」页）

- 「制度知识库」页签对管理员和分析员都显示；页内两块：「公司制度」只给管理员（分析员看不到这一块），「我的规则」给能看到页签的人。
- `public/kb-page.js` 按当前方式画「公司制度」块：`pg` 是现在的样子（预览、检索日志都在）；`s3vectors` 按 3.4：没有预览与检索日志，有清单操作（下线 / 恢复 / 删除）和处理中状态。「我的规则」块两种方式一样：上传、列表（标题、字数、时间）、查看全文、删除，顶上显示「已用 N / 20,000 字」。样式沿用现有卡片、表格、按钮。

### 3.9 交付包与部署指南

- **复制文档管家包**：`nexus-customer-deploy/knowbase-s3vectors-agent/` → 仓库根目录 `knowbase-s3vectors-agent/`，排除项见第 0 节。复制前先检查要带的文件里没有密钥、调用密钥、环境 ID 以外的敏感内容（例如 `tests/e2e_results.json`、`.build/` 生成物）；包自己的 `.gitignore` 照带。在包里记一笔来源（从哪个目录、哪天复制的）。`docs/delivery/make-package.sh` 把它带进交付包，同 `kb/` 一样只带可提交的文件。
- **包里要改的**：3.1–3.3 的东西；`render.py` 能渲染新模块和 `rules` 索引名；GUIDE.zh.md 第 10 章（「接 audit-nexus」，现在写的是 A / B / C 三种接法的建议）改成照实写这次做成的样子：页面经 A2A、审核 Agent 用 `rules_search`、自定义规则在测试台；DELIVERY.zh.md 相应补一节。包里的 `deploy.env` 与 audit-nexus 的 DEPLOY_ENV 怎么对上（例如导入后 `.state/import.json` 的目录名回填成 `RULES_TOOL_DIR`）要在 GUIDE 里写清，具体由实现方定。
- **部署指南**（10-27 计划的 Task 6，本设计做完再做）：知识库一节开头先让人选方式，并写明两者的差别（要不要一台常开的 PG、谁写规则、审核 Agent 怎么查、要哪些凭证）。`pg` 照 `kb/GUIDE.md` 和 `poc/infra/kb.sh`；`s3vectors` 直接引用 `knowbase-s3vectors-agent/GUIDE.zh.md`，指南里只写选这种方式时 DEPLOY_ENV 要填哪几个键、按什么顺序跑。10-27 的设计和计划里说知识库是「PG + pgvector → 连接器」的地方，到时一起改成二选一。

## 4. 端到端验证（`poc/app/test/e2e/jiuan07.e2e.mjs`、`run07.sh`）

本轮**只跑 S3 Vectors 方式**：现有环境直接切到 `s3vectors`（`setup.py`、`apply.py`、`deploy.sh` 按新配置跑），跑通后停在 `s3vectors`。PG 方式这一轮不跑端到端，由单元测试保证不坏（现有测试照过；`pg` 渲染的提示词与线上逐字一致，只多自定义规则一段）。测试代码仍按 `KB_MODE` 选第 2、4 步的做法，`pg` 那一支保留现有用例，以后 PG 方式的环境照样能跑。

前提（人做，测试不碰钥匙）：文档管家的发布已在「Agent 接入」页启用、是「就绪」。测试开头核对这一点，没有就失败并说明。

顺序要改：知识库要在 AI 独立建议之前就有规则。

1. 登录、Agent 接入两条照旧；Agent 接入那条另核对文档管家是「就绪」、不是审批 Agent。
2. **公司制度**（`s3vectors`：挪到建议之前）：给了 `KB_E2E_DOCX` 时，管理员在页面上传 → 入库完成，清单里这份制度是「有效」、条数与解析报告一致、没有冲突；检索「房租 年度框架合同 九安」前 3 名有 `KB_E2E_EXPECT`（缺省 `C05-3.4`）。没给时，先确认 `rules` 索引里已有 `KB_E2E_EXPECT` 且有效，没有就直接失败并说明要先入库。
3. **清场**：确认 poc-reviewer 没有自定义规则（有就删掉并记一笔），因为下面第 4 步可能手动发起。
4. **四张对公付款单**：结论照 `EXPECT`；引用的规则编号都在该方式的知识库里（`pg` 照旧经 SSM 查 `approval_rules`；`s3vectors` 用本机 AWS 凭证对 `rules` 索引 `GetVectors`，只读）；这几轮的请求里没有 `customRules`（实现方找一个能看到请求内容的地方核对，例如调用记录或 Nexus 会话）。
5. **自定义规则**（新）：poc-reviewer 在「我的规则」上传一份虚构的 .md，内容让 DGZF-F07-001（九安房租，合同、发票齐）不通过，例如「九安板块的房租对公付款须附出租方的房产证明」→ 在单据页手动发起 → 结论 `fail`，`note` 以「（含 poc-reviewer 的自定义规则）」开头，依据里有 `ref` 以「自定义：」开头的一条 → 删掉这份规则 → 再发起 → 结论回到 `pass`，`note` 里没有「自定义规则」。用例结束时不留规则。
6. 调用记录、两档结论、没有回写、模拟来单（自动初审 pass）、出网与写回照旧；`s3vectors` 方式下没有「检索日志里有审核 Agent 的调用」这一条断言。

另外两项检查（本机跑，不进端到端）：

- **检索回归**：用 E10 的主题库 58 题、改写题库 26 题和 Haiku 抽出的板块 / 金额，对 `rules_writer` 写出的索引跑 `rules_search`，前 5 名命中不低于 E10 的推荐配置（两套题库都是 100%）。题库和真实制度都在本机，不进仓库。
- **单元测试**：外壳（按方式挂对路由；A2A 假实现下的 S3 Vectors 公司制度接口；PG 方式现有测试照过；我的规则接口；组装器外壳：人 / 系统、裁原件不裁规则、指纹重算、超限失败）；配置读取（`KB_MODE` 缺省是 `pg`、各方式的必填键）；提示词两种方式的渲染结果；文档管家的本机离线测试（3.2 末）；补丁 0004 的渲染测试（两种方式的公司制度块；分析员只看到「我的规则」）。

## 5. 风险，先验证再铺开

1. **新模块的密钥注入**：导入 → 绑定 `key-34360f081254` → 审核 Agent 的提示词引用 `rules_search` → 经审核 Agent 的 A2A 发布调一次，确认工具拿到了密钥（不是 `credentials_missing`）。这一步不通，后面都要换做法，所以最先做。
2. **发起人传递**：`AsyncLocalStorage` 能否从 `reviewAdvice.start` 传到组装器（3.6），先用单元测试证明。
3. **模型照做**：`note` 前缀、`自定义：` 引用都靠提示词，没有程序校验；端到端第 5 步就是验证这个。
4. **Nexus 侧的请求上限**：加 2 万字规则后整份请求接近 87,442 字，Nexus 的 A2A 有没有更小的上限没确认；端到端第 5 步用接近上限的规则试一次。
5. **写入密钥的权限**：审核 Agent 带着能写能删的密钥，工具代码里只有查询。项目负责人已接受；交付文档里写明。
6. **现有环境切方式**：`pg` → `s3vectors` 要换掉审核 Agent 的提示词、工具、连接器绑定和测试台的配置；任何一步没换完，审核 Agent 就可能用错知识库。`setup.py` / `apply.py` 先 `--dry-run` 给项目负责人看，写完后核对线上的提示词、工具和动态配置都和这个方式的期望一致。切回 `pg` 本轮不做，但代码要支持。

## 6. 留给实现者的

- 3.1 的登记放哪、上传历史存哪、`.docx` 转文本的具体写法、页面细节；
- 工具和接口的确切命名、错误码与中文提示；
- 文档管家包里 `render.py`、`admin_run.sh`、GUIDE / DELIVERY 改动的具体写法，包的 `deploy.env` 与 DEPLOY_ENV 怎么对上；
- 提示词两种方式的渲染机制；
- 端到端第 4 步核对「请求里没有 `customRules`」的具体办法。

改动都在 `audit-nexus` 里：测试台、补丁、审核 Agent、端到端，加上复制进来的 `knowbase-s3vectors-agent/`（工具、提示词、AWS 脚本）。`nexus-customer-deploy/knowbase-s3vectors-agent/` 原目录不动。按项目负责人的规矩：端到端测试通过、项目负责人确认之后再提交、推送。

## 7. 补充（2026-10-29，项目负责人）：最终用 PG；S3 Vectors 只做代码

项目负责人在执行中改了几项，以本节为准；和前文冲突的地方按本节。

| 问题 | 决定 |
|---|---|
| 最终方式与测试 | 现有环境**最后停在 PG**（`KB_MODE` 不写）；本轮**只跑 PG 方式的端到端**（含自定义规则）。S3 Vectors 方式只做代码和单元测试，**任务 4（S3 Vectors 上线）这轮不做**，也不跑它的检索回归 |
| 审核 Agent | **照原设计（3.7）**：提示词按 `KB_MODE` 渲染两种。`pg` 和现在线上的逐字一致，只多自定义规则一段，仍经连接器 `conn-f0c7233959d9` 用 SQL 和 `kb_search`；`s3vectors` 用 `rules_search`。PG 方式不解绑连接器 |
| 方案 B（一个 `rules_search`、PG 和 S3 Vectors 两种后端） | 讨论过，**撤回**，不做 PG 版 `rules_search`。撤回前做过一次 PG 连通实测（经项目负责人同意，已清理）：导入的工具在隔离环境里拿到了数据库密钥 `key-a015b93ad361` 的 host / port / database / username / password，用 psycopg 3.3.4 连上 10.0.1.38:5432，`kb_search` 回了 3 条 `C05-` 规则，连接 332 ms、总共 767 ms；只读事务里 `kb_search` 不写检索日志。留作以后要做方案 B 时的依据 |

## 8. 补充（2026-10-30，项目负责人）：PG 的连接放到 Agent 侧

**为什么**：九安的前端和 PostgreSQL 不在同一台主机，测试台不能再直连 PG（现在的 `kb-runner.mjs` 在本机起 Python 连库）。

| 问题 | 决定 |
|---|---|
| 「制度知识库」页的 PG 方式 | 照 S3 Vectors 方式：页面 → 测试台后端 → A2A → Nexus 上的 PG 知识库 Agent（项目负责人正在重建 `knowledgebase_agent`）→ 它的工具 → PG。接口约定见 `docs/specs/2026-10-30-pg-knowledgebase-agent-contract.md`（与 S3 Vectors 版同一套 `kb.rules/v1`，多一个 `describe`） |
| 测试台的接口和页面 | 两种方式共用一套「经 Agent 管理公司制度」的接口和页面块；页面按 `describe` 返回的 `ops` 显示按钮（例如没有下线 / 恢复就不显示）；PG 方式的发布编号是新配置键 `KB_PG_PUBLICATION_ID` |
| 直连 PG 的旧路径 | **删掉**：`kb-routes.mjs`、`kb-runner.mjs` 和页面里 0004 的 PG 块（入库预览、检索日志）不再用；`bench07-configure.sh` 不再拷数据库密码、不再建 kb-venv，并删掉实例上留下的 `kb_pg_password`。「不给 DEPLOY_ENV 时行为不变」这一条对「制度知识库」页不再适用（项目负责人同意） |
| 审核 Agent | 不变：PG 方式下照旧经连接器 `conn-f0c7233959d9` 查 `approval_rules`、调 `kb_search`（连接本来就在 Nexus 那一侧）。前提是新 Agent 按约定写同一套表、用 `kb_embed()` 生成向量 |
| 端到端测试 | PG 方式的「制度知识库」用例经新 Agent 上传、入库、检索；「审核 Agent 查过知识库」改为经 SSM 只读查 `kb_search_log` |

## 9. 补充（2026-10-30，项目负责人）：「我的规则」合计上限

2026-10-30：上限从 20,000 降到 5,000 字（实测 2 万字一轮超过九安合同的 120 秒超时：`review_advice@1` 的 `limits.timeoutMs = 120000`，九安到时取消、记 `AI_UNAVAILABLE`；九安的合同不改）。份数（10）和单个文件（2 MB）不变；端到端接近上限的那一轮改用 4,900 字并记下用时。上文的 20,000 字是当时的设计，按本节为准。
