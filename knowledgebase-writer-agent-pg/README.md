# 知识库文档管家（PG 版）：创建、使用与维护

**照着做就能在你的环境里建好**：Nexus 上的「知识库文档管家（PG 版）」（`knowledgebase_writer_agent_pg`），把制度文档写进审核 Agent 共用的 PostgreSQL 规则库，并发布成 A2A / MCP，给九安测试台的「制度知识库」页调用。

适用 Nexus v0.3.28 · us-east-1 · 2026-10-30 · 接口约定：[`docs/kb-rules-v1.md`](../docs/kb-rules-v1.md)

## 一页看懂

**它是什么**：Nexus 上的一个 Agent，只经三个工具做事：

- `rules_writer`：把制度文档解析成规则，写进审核 Agent 审单时查的那张表 `approval_rules`；`dry_run=true` 只预览；
- `rules_search`：检索；
- `rules_manager`：支持哪些操作、制度清单、详情、下线、恢复、删除、一致性校验。

每个工具一次做完：模型不读附件内容、不搬运规则、不算向量。九安测试台经 A2A 发规则请求（`kb.rules/v1`）调它（页面是下一份设计）；人也可以在 Nexus 对话里直接用。

```
九安测试台「制度知识库」页（下一份设计）  /  Nexus 对话
   │  A2A：「kb.rules/v1 · <op>」＋ 数据 Part {"op", …} ＋（ingest / preview）文件 Part
   ▼
知识库文档管家（PG 版）的发布（A2A + MCP）── Nexus 隔离环境（VM）
   │  工具目录 kb_pg_steward_<hash>：入口 pg_kb_tools.py ＋ kb/lib 的 5 个核心模块（不调 Bedrock）
   │  数据库凭证：平台注入的 Nexus 密钥 pg_kb（database_credentials），psycopg 3，私网直连
   ▼
PostgreSQL + pgvector（kb/ 部署的那一套）
   approval_rules（矩阵 · 制度说明 · 章节说明 · 正文条款）  approval_rules_archive（下线的）
   kb_documents（每次入库一行上传记录）  kb_meta（向量模型）
   kb_embed_batch(正文[], 'search_document') ── PG 主机的实例角色 → Bedrock Cohere Embed v4（1024 维）
   ▲
审核 Agent ── 它的 PG 连接器 ── kb_search(问题, 8) → kb_embed(问题, 'search_query')（同一个模型）
```

| 项 | 说明 |
|---|---|
| 收什么 | Word（.docx）、Excel（.xlsx）、PDF（有文字层）、Markdown（UTF-8）。单个文件 ≤ 50 MB，一份文档 ≤ 2,000 条记录 |
| 怎么切 | **一条一块**。审批矩阵一行一条（编号 `C05-3.4`，制度说明 `G-01`，章节说明 `C05-NOTE`），与 `kb/deploy.sh ingest` 逐条相同；其余正文按条 / 节一块（`rule_type=clause`，编号带制度标识前缀，如 `travel-policy-A12`，见第 11 节） |
| 向量 | **只在库里算**：写入时调库里的 `kb_embed_batch`，模型是 `kb_meta` 登记的那个（Cohere Embed v4，1024 维）。工具不调 Bedrock，所以写进去的向量和表里其他行、和审核 Agent 的问句永远是同一个模型 |
| 写到哪 | `approval_rules`（在线）、`approval_rules_archive`（下线的）、`kb_documents`（上传记录） |
| 谁读 | **审核 Agent**：经它的 PG 连接器调 `kb_search`（与本 Agent 的 `rules_search` 同一个函数）和 `ILIKE` 补查，不用改；**测试台的「制度知识库」页**：经 A2A 调本 Agent |
| 入库规则 | 同一份内容再传：一条不写（`skipped`）。新版本：只写变了的，删掉旧版本有、新版本没有的编号。编号已属于另一份制度：整份拒绝（`rule_conflict`），一条不写。`preview`：只对比，不写库、不算向量 |

**先读这五条：**

1. **导入工具只能用脚本**（第 4 步）：网页导入填不了密钥名和类型，工具会被登记成「不需要密钥」，调用时报 `credentials_missing`。
2. **数据库密钥由 Agent 和发布的属主来绑**（第 5 步）：绑定是按人的，经 A2A 的调用用的是发布者本人的绑定。
3. **已有的制度再入库，用它原来的制度标识，文档名也要与库里的一字不差**：每条规则的 `source_doc` 取 `title`，不传就取附件文件名。附件用原来的文件名且不传 `title`，或把 `title` 填成库里的那个（`list` / `detail` 里的 `title`，可能带 `.docx`）。否则每一行都会记成「只改说明」的更新（不重算向量），结果是 `ingested` 而不是 `skipped`。
4. **含正文的制度只经本 Agent 入库**，不要再用 `kb/deploy.sh ingest`：两条路会互相清掉对方的正文条款（第 16 节第 4 条）。
5. **第二份审批矩阵制度要用不同的章号，也不要带「制度说明」**：矩阵编号不带制度标识，撞号整份拒绝（第 16 节第 1 条）。

| 步骤 | 做什么 | 用什么 | 大约 |
|---|---|---|---|
| 1 | 填 `deploy.env` | 文本编辑器 | 2 分钟 |
| 2 | 本机测试 | PGlite、uv、Node | 5 分钟 |
| 3 | 复制一个 Agent | Operator | 2 分钟 |
| 4 | 打包、导入工具（声明密钥）、核对 | `build_tools.py`、管理员脚本 | 3 分钟 |
| 5 | 绑定数据库密钥 | Operator 或管理员脚本 | 1 分钟 |
| 6 | 保存提示词 | `render.py`、Operator | 2 分钟 |
| 7 | 对话冒烟 | Nexus 对话 | 5 分钟 |
| 8 | 发布 A2A / MCP，发调用密钥，A2A 自测 | Operator、管理员脚本、`a2a_rules.mjs` | 5 分钟 |
| 9 | 交给测试台 | 告诉测试台发布编号 | — |

## 0　准备

| 需要 | 说明 |
|---|---|
| Nexus v0.3.28 管理员账号 | 导入工具、发布工具新版本在本版本只对管理员开放 |
| Nexus Operator | 本仓库的 `skills/nexus-ai-operator`：`python3 -I skills/nexus-ai-operator/scripts/nexus.py --profile <名字> whoami` 能看到你的平台和用户 |
| 本机工具 | `python3`（`build_tools.py`、`render.py` 只用标准库）、`git`（打包时记提交号）、[uv](https://docs.astral.sh/uv/)（管理员脚本用它临时装 boto3；本机测试装 psycopg 等）、Node 18.17+（A2A 自测与契约测试；客户端用到 `AbortSignal.any`） |
| 同仓库的 `kb/` | 核心模块的源码（`kb/lib`）、提示词共用片段（`kb/prompt/kb_rules_v1.zh.md`）、本机测试的 PGlite 底座（`kb/tests`）。管理员密码走 SSM 时，借它的密封读取（`kb/lib/common.sh`、`kb/host/read-admin-password.sh`），SSM 命令历史里只有密文 |
| 同仓库的 `knowbase-s3vectors-agent/` | 两个文档管家共用的管理员脚本（`scripts/admin_run.sh`、`nexus_admin.py`、`render.py`、`nexus_package.py`），本机测试的替身（`tests/stubs`） |
| 同仓库的 `poc/` | `a2a_rules.mjs` 用测试台的 A2A 客户端：`poc/app/lib/a2a-client.mjs`、`poc/app/kb-steward-client.mjs` |
| PG 知识库 | 已按 `kb/GUIDE.md` 部署，审核 Agent 的 PG 连接器能用（Sandbox 出站已放行 PG 所在网段，`kb/GUIDE.md` 5.5）。库里要是新版 `kb_search.sql`（有 `kb_embed_batch`、`kb_meta`），并且**已经换成 Cohere v4**：还是 Titan 的库先照 `kb/GUIDE.md` 7.6 换（基线 → 改实例角色权限 → `db --migrate-embeddings` → 对比）。没升级的库，工具报 `kb_not_ready` |
| Nexus 数据库密钥 | 「数据库凭证」（`database_credentials`）类型，字段 `host` / `port` / `database` / `username` / `password`，用应用用户：就是审核 Agent 的 PG 连接器用的那把（`kb/deploy.sh connector` 建的）。记下它的密钥 ID `<KEY_ID>` |
| 复制来源 | PG 版的 `knowbase_writer_agent`；没有的话，任何一个用标准入口生成的 Agent 都行 |

**下文的命令都在仓库根目录执行**（`knowledgebase-writer-agent-pg/` 的上一级）。

为了少打字，把 Operator 设成一个别名；本机 shell 是 zsh 时，用 `${=OP}` 展开它：

```bash
OP="python3 -I skills/nexus-ai-operator/scripts/nexus.py --profile <你的 profile>"
```

**写操作先看再做。** 下文 `call POST` / `PUT` 的命令都没有写 `--yes`：照原样跑，Operator 只打印将要发的请求、不发（退出码 9）；看过、确认这一条之后，再在末尾加 `--yes` 重跑。删除类操作还要 `--confirm-destructive`，每一项单独确认。编码工具照部署手册 `pg-kb-steward-deploy` 第 0 节做（交付 zip 里的 `repo/skills/pg-kb-steward-deploy/SKILL.md`），不替人加 `--yes`。

## 1　填 deploy.env

```bash
cp knowledgebase-writer-agent-pg/deploy.env.example knowledgebase-writer-agent-pg/deploy.env
chmod 600 knowledgebase-writer-agent-pg/deploy.env
```

| 字段 | 填什么 |
|---|---|
| `RULES_TABLE` | 规则表名，与 `kb/deploy.env` 的 `RULES_TABLE` 相同（缺省 `approval_rules`）。打包时写进工具 |
| `NEXUS_URL` | `https://<env>.<domain>` |
| `NEXUS_ADMIN_USER` | 管理员用户名 |
| `NEXUS_PASSWORD_FILE` | 存管理员密码的本地 600 文件（推荐） |
| `NEXUS_ADMIN_PASSWORD_SSM` | 不用密码文件时填 `<deployer 实例 ID>:<deploy.yaml 绝对路径>`：经 SSM 读部署机上的 `auth_password` |
| `AWS_REGION` | SSM 方式所在的区域 |

数据库的连接字段**不写在这里**：它们由 Nexus 密钥注入给工具（第 5 步）。`deploy.env`、`.build/`、`.state/` 都在 `.gitignore` 里，不会进仓库。

## 2　本机测试（上线前，不连任何服务）

```bash
KBPY="uv run --no-project --python 3.12 --with psycopg --with psycopg-binary --with pdfplumber --with reportlab --with openpyxl --with pyyaml python -B"
python3 -I knowledgebase-writer-agent-pg/scripts/build_tools.py --env knowledgebase-writer-agent-pg/deploy.env.example
bash kb/tests/run_pglite.sh 55432          # 另开一个终端：本机的 PGlite + pgvector，前台运行，Ctrl-C 停
KB_TEST_PG_PORT=55432 ${=KBPY} knowledgebase-writer-agent-pg/tests/local_test.py
${=KBPY} knowledgebase-writer-agent-pg/tests/admin_test.py
node --test knowledgebase-writer-agent-pg/tests/contract.test.mjs
```

`${=KBPY}` 是 zsh 的写法，bash 里写 `$KBPY`。契约测试读 `local_test.py` 写出的 `.build/contract-replies.json`，所以按上面的顺序跑。这里用样例参数打包，第 4 步上线前会按 `deploy.env` 重新打包。

| 测试 | 钉住什么 |
|---|---|
| `local_test.py` | 把拼装出的工具目录照 VM 的装法装成一个包（只能相对 import），三个工具在 PGlite 上逐个跑：四种格式入库、同一份再传 `skipped`、预览不写也不算向量、冲突拒绝、坏文件一条不写、向量失败记 `failed`、库没升级报 `kb_not_ready`、下线 / 恢复 / 删除、校验、限流回 `rate_limited`、正忙回 `db_unavailable`、每个连接都设了时限、密钥缺失、错误里不带密码和主机；先经 `ingest_rules.py`（`deploy.sh` 的入库）入过的，再经工具入库一条不写；打包可重复且与 `kb/lib` 源码一致。库里的 `kb_embed` 是按内容算的假函数，不调 Bedrock。没设 `KB_TEST_PG_PORT` 时连库的用例跳过 |
| `admin_test.py` | 共用管理员脚本读本包的描述：3 个工具都声明 `pg_kb` / `database_credentials`（5 个字段）；.zip 导入、整目录发布、逐文件核对、`bind` 的请求对；提示词能解析、含共用片段全文、操作清单含 `describe` 和 `preview`；S3 Vectors 版的输出与改动之前逐字相同；探针的相对 import |
| `contract.test.mjs` | `local_test.py` 跑出的真实回复（写在 `.build/contract-replies.json`，内容虚构）经测试台的客户端 `createKbStewardClient` 送一遍：每一条都被收下，失败回复也是合格的失败形态，`preview` 测试台不收；`a2a_rules.mjs` 的用法与退出码 |

改了 `kb/lib` 时，另跑一遍知识库自己的测试：`KB_TEST_PG_PORT=55432 ${=KBPY} -m unittest discover -s kb/tests`（不设端口时连库的用例跳过）。

## 3　复制一个 Agent

Nexus v0.3.28 没有「空白建 Agent」的接口，复制一个最省事：

```bash
${=OP} call GET "/api/v2/agents/<源 AGENT_ID>/clone-preview"        # 看会复制什么、有没有阻止项
${=OP} call POST "/api/v2/agents/<源 AGENT_ID>/clone" --data '{"name_cn":"知识库文档管家（PG 版）","name_en":"knowledgebase_writer_agent_pg","locale":"zh-CN","description":"把制度文档写进审核 Agent 共用的 PG 规则库，并提供检索与管理"}'
${=OP} call GET "/api/v2/agents/<新 AGENT_ID>/clone-status"          # status=completed
```

- 下文的 `<AGENT_ID>` 就是新 Agent 的 ID。提示词在第 6 步整份替换。
- 源 Agent 的工具目录也会复制一份：提示词不引用它就不会被加载。网页上它可能显示「需要密钥、未配置」，删不删另行确认。

## 4　打包与导入工具

```bash
python3 -I knowledgebase-writer-agent-pg/scripts/build_tools.py                     # 读 deploy.env 的 RULES_TABLE
bash knowledgebase-writer-agent-pg/scripts/admin_run.sh import --module pg
bash knowledgebase-writer-agent-pg/scripts/admin_run.sh verify --module pg --dir <DIR_NAME>   # DIR_NAME 见 .state/import.json
```

**打包做了什么**（`build_tools.py`，最后打印一行 JSON）：

- 把 `kb/lib` 的 5 个核心模块（`doc_blocks`、`parse_rules`、`clauses`、`kb_parse`、`kb_store`）**逐个文件原样**拷进 `.build/tools/`，只在第 1 行加「由 `kb/lib@<提交号>` 生成，勿改」；入口 `tools/pg_kb_tools.py` 只改渲染段（`_TABLE`、`_BUILD`）。
- 写 `.build/MANIFEST.json`（每个文件的 sha256），打成 `.build/pg_kb_tools.zip`：文件在压缩包根、按名字排序、时间戳固定，同样的源码打出同样的字节。
- 提交号后面带 `-dirty`，说明拷的源文件有没提交的改动。正式上线前从提交过的代码打包。

**导入做了什么**（管理员脚本）：

- 先查压缩包：每个 `.py` 编译得过、每个工具恰好在一个文件里有 `@tool`、与 `MANIFEST.json` 一致。
- 上传 .zip，平台把 6 个文件原样放进同一个工具目录（目录名 `kb_pg_steward_<8 位十六进制>`），这是 v1。
- 确认时声明 3 个工具都要密钥：`key_name=pg_kb`、`key_type=database_credentials`、5 个字段。
- 结果写进 `.state/import.json`：`dir_name`、`module_path`（`imported_tools/<DIR_NAME>/pg_kb_tools`）、每个工具的 `tool_id`。这个文件已在时拒绝再导入一份（要更新代码用第 10 节的 `publish`；确实要再导一份加 `--again`）。

**`verify` 应当看到**：3 个工具 `key_name=pg_kb key_type=database_credentials configured=False`；6 个文件逐个「一致」，最后一行 `服务端与本地逐个文件一致: True`。

## 5　绑定数据库密钥

用 Agent 和发布的**属主**身份做（Operator 的 profile 就是属主时）：

```bash
${=OP} call PUT /api/v2/keys/tool-bindings --data '{"module_path":"imported_tools/<DIR_NAME>/pg_kb_tools","key_name":"pg_kb","key_id":"<KEY_ID>"}'
bash knowledgebase-writer-agent-pg/scripts/admin_run.sh verify --module pg --dir <DIR_NAME>      # 3 个都应是 configured=True
```

- 管理员本人就是 Agent 和发布的属主时，也可以用脚本绑：`bash knowledgebase-writer-agent-pg/scripts/admin_run.sh bind --key-id <KEY_ID>`（模块路径取 `.state/import.json`）。
- 一个绑定覆盖模块里的 3 个工具。
- 绑定是按人的：只对绑定的人自己的 Agent 生效。经 A2A 的调用用的是**发布者本人**的绑定，所以发布者自己要绑。

## 6　保存提示词

```bash
${=OP} call GET "/api/v2/agents/<AGENT_ID>/files/prompt" > <仓库外的目录>/prompt-before.json      # 先存一份现在的，回滚用
python3 -I knowbase-s3vectors-agent/scripts/render.py prompt --package knowledgebase-writer-agent-pg --tool-dir <DIR_NAME>
${=OP} call PUT "/api/v2/agents/<AGENT_ID>/files/prompt" --data-file knowledgebase-writer-agent-pg/.build/prompt-body.json
```

- `render.py` 只写本地：`knowledgebase-writer-agent-pg/.build/prompt.yaml` 与 `prompt-body.json`（PUT 的请求体）。它打印一行 JSON，`tools` 应是 `3`（引用了 3 个工具）。
- 模板是 `prompt/knowledgebase_writer_agent_pg.yaml.tmpl`。「规则请求（`kb.rules/v1`）」一节的通用规则来自共用片段 `kb/prompt/kb_rules_v1.zh.md`（与 S3 Vectors 版共用）；本包的操作清单（含 `preview`）、附件路径、「规则请求不确认」的例外写在模板里。
- 工具引用：`imported_tools/<DIR_NAME>/pg_kb_tools/rules_writer`、`rules_search`、`rules_manager`。

## 7　对话冒烟

在 Nexus 网页打开新 Agent：

| 说什么 | 应当看到 |
|---|---|
| 「这个 Agent 支持哪些规则请求？」 | 调 `rules_manager(action="describe")`：`protocol=kb.rules/v1`、`backend=pg`、10 个操作 |
| 「列出知识库里的制度」 | 调 `rules_manager(action="list")`：已有的制度和它的条数（参考环境 1 份、102 条：matrix 89 / general 9 / chapter_note 4） |
| 「检索：合同用印 审批」 | 调 `rules_search`：按关键词命中数、再按语义距离排的规则 |

能列出制度，就说明工具在 VM 里拿到了注入的密钥、连上了 PG。报 `credentials_missing` 回第 5 步；报 `db_unavailable` 查第 15 节。

## 8　发布成 A2A / MCP，发调用密钥，A2A 自测

```bash
${=OP} call POST /api/v2/publications --data '{"agent_id":"<AGENT_ID>","channels":["a2a","mcp"],"follow_updates":true,"display_name":"知识库文档管家（PG 版）","description":"把制度文档（Word / Excel / PDF / Markdown）写进审核 Agent 共用的 PG 规则库；kb.rules/v1"}'
curl -s https://<env>.<domain>/a2a/<PUBLISH_ID>/.well-known/agent-card.json | head -c 400      # 公开名片
bash knowledgebase-writer-agent-pg/scripts/admin_run.sh issue-call-key --publish-id <PUBLISH_ID>  # → .state/a2a-call-key（600）
```

- `follow_updates: true`：发布跟着 Agent 的最新版本走，以后重存提示词不用重新发布。
- 调用密钥（`nxa_…`）由脚本直接写进 600 文件，不打印，只输出 `credential_id`。也可以在网页的发布详情里新建，复制后存进本机 600 文件。

**A2A 自测**（发的请求与测试台的「制度知识库」页相同，回复按测试台客户端的同一套形态校验）：

```bash
export NEXUS_A2A_URL=https://<env>.<domain>/a2a/<PUBLISH_ID>
node knowledgebase-writer-agent-pg/scripts/a2a_rules.mjs describe
node knowledgebase-writer-agent-pg/scripts/a2a_rules.mjs list
node knowledgebase-writer-agent-pg/scripts/a2a_rules.mjs search '{"question": "合同用印 审批", "top_k": 3}'
```

- 调用密钥缺省从本包的 `.state/a2a-call-key` 读；别处的用 `NEXUS_A2A_KEY_FILE=<600 文件>`。密钥只从文件读进内存，不打印、不进命令行。
- stdout 是工具回的那个 JSON；测试台认的操作、校验没过的原因写到 stderr。
- 退出码：`0` 工具回 `success=true`；`1` 工具回 `success=false`（JSON 照样打印）；`2` 用法或配置不对；`3` 调用失败或回复没过校验。
- 带文件的操作：`a2a_rules.mjs preview '{"source_id": "…", "title": "…"}' <文件>`、`ingest` 同样；附件的类型按扩展名定（.docx / .xlsx / .pdf / .md）。

## 9　交给测试台

- 把发布编号 `<PUBLISH_ID>` 告诉测试台（配置键 `KB_PG_PUBLICATION_ID`）。
- 测试台用的调用密钥由管理员在九安「平台 › Agent 接入」页粘贴启用：它是「就绪」、供前端工作流调用、不进审批流，不是审批 Agent。
- `.state/a2a-call-key` 那把只给自测用，不要拿去给测试台。

## 10　以后：更新工具代码、重存提示词

本节和第 17 节的命令都在本包（`knowledgebase-writer-agent-pg/`）的上一级目录执行：开发仓库的根目录，也就是交付 zip 里的 `repo/`。Operator 写成数组，bash 和 zsh 都能用（第 0 节的 `${=OP}` 只有 zsh 认）：

```bash
OP=(python3 -I skills/nexus-ai-operator/scripts/nexus.py --profile '<你的 profile>')   # 引号里换成你的 profile 名
```

**更新工具代码**（改了 `knowledgebase-writer-agent-pg/tools/pg_kb_tools.py` 或 `kb/lib` 的核心模块）：

```bash
# 1. 跑第 2 节的本机测试（改了 kb/lib 时连同 kb/tests）
python3 -I knowledgebase-writer-agent-pg/scripts/build_tools.py
bash knowledgebase-writer-agent-pg/scripts/admin_run.sh check   --module pg --tool-id <TOOL_ID> --expect-version <N>
bash knowledgebase-writer-agent-pg/scripts/admin_run.sh publish --module pg --tool-id <TOOL_ID> --expect-version <N>
bash knowledgebase-writer-agent-pg/scripts/admin_run.sh verify  --module pg --dir <DIR_NAME>
```

- `<TOOL_ID>` 取 `knowledgebase-writer-agent-pg/.state/import.json` 里任一个工具的 `tool_id`（三个工具在同一个工具目录里）；`<N>` 是服务端现在的版本（第一次导入是 1）。版本对不上就停下，不会覆盖别人刚发布的。
- `check` 列出每个文件的变化（`(new)` / `(changed)` / `(removed)`）和平台的检查结果；`publish` 把整个目录换成本地构建的文件集合，版本号加 1。
- 每个文件第 1 行带着提交号：换了提交（哪怕源码没变）重新打包，`verify` 也会报「不一致」，要对齐就照上面发一个新版本。

**重存提示词**（改了模板，或改了共用片段 `kb/prompt/kb_rules_v1.zh.md`）：同第 6 步，渲染一次、PUT 一次。

```bash
python3 -I knowbase-s3vectors-agent/scripts/render.py prompt --package knowledgebase-writer-agent-pg --tool-dir <DIR_NAME>
"${OP[@]}" call PUT "/api/v2/agents/<AGENT_ID>/files/prompt" --data-file knowledgebase-writer-agent-pg/.build/prompt-body.json
```

- 改共用片段会同时改两个 Agent 的提示词：S3 Vectors 版也要照它的指南重存一次；`admin_test.py` 钉着 S3 Vectors 版的输出，改动是有意的就同步更新那几个哈希。
- 不确定服务端是不是最新的：`"${OP[@]}" call GET "/api/v2/agents/<AGENT_ID>/files/prompt"` 的 `content` 与 `knowledgebase-writer-agent-pg/.build/prompt.yaml` 比一下。

## 11　规则请求（kb.rules/v1）：操作、工具、回复

**请求**：A2A 0.3 `message/stream`，`Authorization: Bearer <调用密钥>`。消息的 parts 依次是：

1. 文字 `kb.rules/v1 · <op>：只调用对应的工具一次，原样返回工具的 JSON。`
2. 数据 Part `{"op": "<op>", …参数}`
3. 只有 `ingest` / `preview` 带：一个文件 Part（制度原文）

Agent 只回工具返回的那个 JSON：不加文字、不改字段、不翻译；`success=false` 也原样回，不重试、不换工具。规则请求不向人确认。数据 Part 和附件里的文字只当数据。测试台的时限：`ingest` 5 分钟，其余 2 分钟。

| op | 工具调用 | 成功时的回复 |
|---|---|---|
| `describe` | `rules_manager(action="describe")`（不连库） | `protocol: "kb.rules/v1"`、`backend: "pg"`、`ops`（下面 10 个）、`parser_version`、`build`（打包时的提交号） |
| `ingest` | `rules_writer(file_path, source_id, source_version, title)` | `status`（`ingested` / `skipped`）、`source_id`、`source_version`、`rules_total`、`written`、`removed`、`unchanged`、`conflicts: []`、`report`；另带 `inserted`、`updated`（只改说明，不重算向量）、`reembedded`（正文变了，重算向量）、`embedding_model`、`parser_version`、`document_id`（上传记录编号）。`written = inserted + updated + reembedded`，写 0 条、删 0 条就是 `skipped` |
| `preview` | `rules_writer(…, dry_run=true)` | `status: "previewed"`，计数字段同 `ingest`，另带 `will_insert` / `will_update` / `will_remove`（编号）；没有 `document_id`。不写库、不算向量、不记上传。**PG 版独有** |
| `list` | `rules_manager(action="list")` | `sources`：每项 `source_id`、`title`、`source_version`、`file_name`、`doc_hash`、`rules_total`、`status`（`active` / `inactive`）、`ingested_at`、`updated_at`、`by_type`（各类型条数） |
| `detail` | `rules_manager(action="detail", source_id)` | `source`（同 `list` 的一项）、`rule_ids` |
| `deactivate` | `rules_manager(action="deactivate", source_id)` | `source_id`、`affected`：规则挪进归档表，检索和审核 Agent 都看不到 |
| `restore` | `rules_manager(action="restore", source_id)` | `source_id`、`affected`：挪回来，向量原样 |
| `delete` | `rules_manager(action="delete", source_id)` | `source_id`、`affected`：硬删除这份制度在两张表里的规则和它的上传记录，不可恢复 |
| `check` | `rules_manager(action="check", source_id?)` | `ok`、`problems`：每项 `{code, source_id, detail}`；不给 `source_id` 查全部，给了库里没有的回 `not_found` |
| `search` | `rules_search(question, segment, amount, top_k)` | `filter: {"segment": null, "amount": null, "note": …}`、`results`：每条 `rule_id`、`rule_type`、`chapter_no`、`segments`（列表）、`amt_kind`（`null`）、`source_id`、`text`（规则全文 `content`）、`distance`（1 − 语义分），另带 `business_item`、`amount_tier`、`approval_path_text`、`final_approver`、`keyword_hits` |
| 其他 | 不调工具 | `{"success": false, "error_type": "invalid_parameter", "message": "不支持的规则请求：<op>"}` |

`describe` 的 `ops`：`describe`、`ingest`、`preview`、`list`、`detail`、`deactivate`、`restore`、`delete`、`check`、`search`。测试台的客户端只认接口约定里的 9 个（`preview` 在它的校验里还没有，由下一份设计扩展）；`a2a_rules.mjs` 发 `preview` 时直接用 A2A，只查回复是不是 `previewed`。

- **参数**：`source_id` 即制度标识，`^[a-z0-9][a-z0-9-]{1,62}$`（例如 `fin-approval`），同一份制度的新版本用同一个；它就是表里的 `source_tag`。`title` 写进每条规则的 `source_doc`，不给就用附件文件名。`source_version` ≤ 64 字、`title` ≤ 200 字。`question` ≤ 2,000 字，`top_k` 1–20（缺省 8）。
- **`search` 不按板块、金额过滤**：`segment`、`amount` 收下但不用（PG 的板块过滤会漏掉「全板块」的行），`filter.note` 里写明。排序与审核 Agent 相同：问题里的词在规则全文里命中得多的在前；命中数相同时矩阵 / 制度说明 / 章节说明排在正文条款前面，再按语义距离。
- **失败**一律 `{"success": false, "error_type", "message", "suggestion"?}`；`rule_conflict` 另带 `conflicts`（编号）。错误里不带密码、连接串、主机名、端口。码见第 15 节。
- **时间**一律 ISO 8601（UTC）。

**解析报告**（`report`，也存进 `kb_documents`）：`parser_version`、`format`、各类条数（`matrix`、`general`、`chapter_notes`、`clause`、`table_row`、`paragraph`、`total`）、`chapters`（各章行数）、`duplicates`（重复编号）、`without_path`（缺审批路径的行）、`split`（拆开的长条款）、`renumbered`（条号重复加了 `~2` 的）、`skipped`（不入库的封面段数、修改记录表数）、`tables`（认成矩阵的表、没认成的表）、`pages`（只有 PDF：每页读出的字数）、`warnings`（给人看的提醒，如 PDF 矩阵的合并单元格）。

**正文条款怎么编号**（`<制度标识>-<条号>`，带前缀所以不会撞上矩阵编号）：

| 原文 | 编号 |
|---|---|
| 第十二条 | `A12` |
| 三、（二） / 只有 三、 | `S3.2` / `S3` |
| 1.2.3 / 1. | `N1.2.3` / `N1` |
| 章、节下第一条之前的正文 | `CH3`、`CH3.2` |
| 标题下的正文 | `H2.3`（各级序号） |
| 没有任何编号的段落 | `P001`…（短段落合并到约 400 字） |
| 不是矩阵的表格，每行一条 | `T<表序号>.<行号>`，文字「表头：值；…」 |

- 一块超过约 600 字，在句末（。！？；）拆成 `-a`、`-b`…；同一文档里条号重复，第二个起加 `~2`、`~3`，写进报告。
- 条下的（一）（二）、（1）、① 等小项跟着条走。
- 封面（文档开头的短行：标题、版本、发布范围……）和修改记录表不入库，在报告的 `skipped` 里计数。

## 12　对话里怎么用

人在对话里直接找它（不是 `kb.rules/v1` 规则请求）时：

1. **入库先预览，确认后再写**：上传附件，说「入库」（或「导入」「更新这份制度」）。
   - 它先定制度标识：同一份制度的新版本沿用原来的（不确定时先查清单）；你没给、又查不到时，它按文档名建议一个，请你确认。
   - 然后 `preview`，把将新增 / 更新 / 删除的条数和编号、解析报告给你看。
   - 你确认（例如「确认写入」）后，它用同样的参数写入一次，再报告结果。没确认就不写。
2. **检索**：「查一下：九安 房租 对公付款」。传空格隔开的关键词（板块、业务事项、金额）比整句问话准。
3. **清单、详情、校验**：只读，直接做。
4. **下线、删除前它会先确认**：说清楚是哪一份制度（标识、文档名、条数）和后果，你明确同意后才调用。下线可以恢复；删除不可恢复。恢复直接做。
5. **工具报错**时，它把原因（`message`）和建议（`suggestion`）告诉你，不换工具绕过，也不换一个制度标识重试。

## 13　平台实测（2026-10-30，参考环境）

**平台源码已读**（v0.3.28）：

- 工具导入接口收 .zip，压缩包里的文件全部放进同一个工具目录；只给声明了的函数加 `@tool`，没有工具函数的辅助模块原样保存。
- VM 里一个版本的工具目录装成一个包 `nexus_toolpkg_<目录名>_<版本>`：目录里的模块用相对 import（`from . import doc_blocks`）取得到，普通的 `import doc_blocks` 取不到。所以 `kb/lib` 的模块彼此用固定写法：在包里就相对 import，当脚本运行就把本目录放进 `sys.path`。
- 附件白名单里有 Markdown（`md` / `text/markdown`），对话附件和 A2A 文件 Part 都收。

**探针实测**（两个文件、不要密钥的探针工具 `kb_import_probe`，导入后在一个测试会话里用会话级动态配置挂上、调一次，没有改任何 Agent）：

| 项 | 结果 |
|---|---|
| 同目录相对 import | 成立：helper 以 `nexus_toolpkg_kb_pg_probe_<hash>_1.kb_probe_helper` 装上 |
| Python | 3.13.15 |
| psycopg | 3.3.4（10-29 的连通实测另查过：VM 里没有 psycopg2，所以工具用 `import psycopg`） |
| pdfplumber | 0.11.9：VM 里能读 PDF |
| boto3 | 1.43.85（只作对照：工具不用它） |

**正式导入**：

- 6 个文件经 .zip 导入，服务端每个文件与本地 `MANIFEST.json` **逐字节一致**：平台没有改动辅助模块。
- 3 个工具声明 `pg_kb` 密钥；绑定后 `configured=True` ×3；对话里 `list` 连上了 PG。
- 经 A2A 预览一次真实制度（102 条）用了 17 秒，主要花在模型那一轮。
- 端到端期间重存过两次提示词（服务端与本地一致），没有重新发布。

## 14　验证结果（2026-10-30，参考环境）

### 14.1　整个 PG 知识库换成 Cohere v4

- IAM：测试台栈的变更集只有 `KbBedrockPolicy` 一处（修改，不替换）。
- 迁移：一个事务里重算 102 条（规则表 102、归档表 0），旧向量备份 102 行，`kb_meta` 登记 `cohere.embed-v4:0` / `1024`。
- 策略更新后约 9 分钟内，Bedrock 间歇返回 403（IAM 生效延迟）：第一次切换后的回归在中途停下，没有写结果文件；生效后重跑通过。
- 检索回归（研究题库，经 `kb_search`，切换前用 Titan 测基线）：

| 题库 | 题数 | 前 1 命中：Titan → Cohere | 前 5 命中：Titan → Cohere |
|---|---|---|---|
| 主题 | 58 | 31（53.4%）→ 33（56.9%） | 46（79.3%）→ 49（84.5%） |
| 改写 | 26 | 10（38.5%）→ 10（38.5%） | 20（76.9%）→ 22（84.6%） |

逐题看，名次变好的 22 题、变差的 14 题；两套题的前 5 命中都没降。

| 已知问题 | 要求 | Titan | Cohere |
|---|---|---|---|
| 「30 万合同用印」 | C03-1.2 在前 3 | 第 3 | 第 2 ✓ |
| 「房租 年度框架合同 九安」 | C05-3.3 与 C05-3.4 都在前 2 | — | 第 1 C05-3.3、第 2 C05-3.4 ✓ |

第二题原来要求 C05-3.4 第 1。两条只差金额档，问题里没有金额，两条都对，审核 Agent 按单据金额取档。项目负责人确认保留 Cohere v4，这一条改成两条都在前 2。

- 审核 Agent `kb/deploy.sh verify --e2e`：规则问答命中 C03-1.2（48 秒）；A2A 三段式回归纯 JSON、没有写库。

### 14.2　文档管家端到端（对话 + A2A）

测试文档除真实制度外全部虚构（`scripts/make_e2e_docs.py` 生成：矩阵章号从「十一、」起，正文故意用审批、合同、付款、板块等财务用语）。

| 路 | 操作 | 结果 |
|---|---|---|
| 对话 | describe | `kb.rules/v1`、`backend=pg`、10 个操作 |
| 对话 | list | 1 份制度，102 条（matrix 89 / general 9 / chapter_note 4） |
| A2A | describe | 合格（测试台客户端校验通过） |
| A2A | preview 真实制度（原标识、原 `source_doc`） | `previewed`，`unchanged` 102，将新增 / 更新 / 删除 0（17 秒） |
| A2A | ingest 真实制度 | `skipped`，`unchanged` 102，`written` 0：解析与 `deploy.sh` 逐条一致 |
| 对话 | 上传虚构矩阵，说「入库」 | 先 `previewed`：将新增 7 条，等人确认 |
| 对话 | 「确认写入」 | `ingested`，`inserted` 7 |
| A2A | search | 第 1 名 C11-1.2（关键词命中 3） |
| A2A | deactivate | `affected` 7；再检索查不到 C11 / C12 |
| A2A | restore | `affected` 7；检索结果和距离与下线前完全相同 |
| A2A | delete 虚构矩阵 | `affected` 7 |
| A2A | ingest 虚构冲突矩阵 | `rule_conflict`，`conflicts` [C03-1.2, C03-NOTE]，一条不写 |
| A2A | ingest 正文 md / pdf / xlsx | `ingested`：7 条 clause / 7 条 clause / 3 条 table_row |
| 本机 | 检索回归：正文入库前 → 后 | 主题前 5 49 → 49，改写前 5 22 → 22，逐题变好 0、变差 0，已知问题都过 |
| A2A | delete 正文三份 | `affected` 7 / 7 / 3 |
| A2A | check | `ok: true`，`problems: []` |
| A2A | list | 只剩真实制度，102 条 |

**收尾状态**：`approval_rules` 102 行、都有向量；归档表 0 行；`kb_meta` = `cohere.embed-v4:0` / `1024`。回归脚本留在检索日志里的问题共 356 行，已以超级用户删掉。逐步记录（去敏）：`tests/e2e_results.json`。

### 14.3　还没验证的

- 测试台 PG 方式的四张对公付款单端到端（001 通过、002 不通过、003 通过、004 不通过，引用的编号都在库里）：由另一个会话跑，写本文时**待跑**。

## 15　错误码 → 怎么办

| `error_type` | 什么时候 | 怎么办 |
|---|---|---|
| `credentials_missing` | 平台没注入数据库密钥（没绑定，或经网页导入、没声明密钥），或密钥缺字段、`port` 不是数字 | 第 5 步绑定，`verify` 看 `configured=True`；经网页导入的照第 4 步用脚本重导 |
| `invalid_parameter` | 缺 `source_id` / `file_path` / `question`，`top_k` 不是整数，`action` 不认识，版本说明 > 64 字、文档名 > 200 字、问题 > 2,000 字，附件路径在禁止的目录；规则请求的 `op` 不认识 | 按 `message` 改参数 |
| `invalid_source_id` | 制度标识不合 `^[a-z0-9][a-z0-9-]{1,62}$` | 2–63 位小写字母、数字或连字符，以字母或数字开头，如 `fin-approval` |
| `file_not_found` | 附件不在给的路径 | 附件在 `.cache/<agent_id>/<session_id>/nexus_ai_internal_attachments_temp/` 下；重新上传 |
| `file_too_large` | 文件 > 50 MB，或压缩包里的一部分解压后过大、工作表展开后格子过多 | 拆成几份，各用自己的制度标识入库 |
| `unsupported_format` | 不是 .docx / .xlsx / .pdf / .md；.doc / .xls 老格式；加了密码；文件损坏；PDF 打不开 | 去掉密码、用 Office 另存为 .docx / .xlsx 再传 |
| `empty_document` | 0 字节；读不出文字；除了封面和修改记录没有可入库的内容 | 确认传的是制度原文 |
| `no_text_layer` | PDF 一页文字都读不出（扫描件） | 不做 OCR：改传 Word / Excel，或带文字层的 PDF |
| `encoding_unsupported` | Markdown 不是 UTF-8 | 另存为 UTF-8 |
| `pdf_parser_unavailable` | 运行环境里没有 pdfplumber（实测 VM 里有） | 改传 Word / Excel |
| `matrix_chapter_missing` | 审批矩阵表前面没有章标题 | 每张矩阵表前加章标题（如「一、立项审批」；Excel 可把工作表改名为章标题） |
| `duplicate_rule_ids` | 同一份文档里规则编号重复 | 同一章的矩阵序号不能重复，改好再传 |
| `too_many_records` | 一份文档解析出 > 2,000 条 | 拆成几份，各用自己的制度标识 |
| `rule_conflict` | 编号已属于库里另一份制度（入库、恢复），或归档表里已有同编号（下线）；`conflicts` 列出编号，一条没写 | 同一份制度就用它原来的制度标识；不是同一份，就换章号（第 16 节第 1 条），或先下线 / 删除那一份 |
| `source_inactive` | 这份制度已下线（在归档表里）又来入库 | 先 `restore` 或 `delete`，再入库 |
| `not_found` | 知识库里没有这个制度标识（详情、下线、恢复、删除、只校验这一份） | `list` 查已有的；不带 `source_id` 的 `check` 校验全部 |
| `rate_limited` | 撞上全库的每分钟上限：`kb_search` 60 次；新向量 `kb_embed` 300 个、`kb_embed_batch` 2,000 个 | 一分钟后再试。这**不是**「没查到」 |
| `kb_not_ready` | 规则表不存在，或库里没有 `kb_embed_batch` 等新函数（旧版 `kb_search.sql`） | 管理员跑 `kb/deploy.sh db`（还是 Titan 的库按 `kb/GUIDE.md` 7.6） |
| `table_owner` | 规则表的属主不是工具连库用的应用用户 | 以 postgres 执行 `message` 里给的 `ALTER TABLE … OWNER TO …` |
| `db_unavailable` | 连不上库（密码不对、库不存在、主机名解析不了、5 秒没响应、连接被拒绝，`message` 说明是哪一种）；「知识库正忙」：等入库锁超过 30 秒（另一项入库或换模型正在进行）；「这次操作超时」：一句超过 240 秒（入库或检索太慢）。超时的事务都已整份回滚 | 正忙就过一两分钟再试；超时的过几分钟再试，文档很大就拆成几份、各用自己的制度标识入库；连不上查 PG 是否在运行、安全组和 `vm_egress.allow_cidrs`、密钥 `pg_kb` 的字段（`kb/GUIDE.md` 9.1、9.2） |
| `embedding_failed` | 库里的 `kb_embed` / `kb_embed_batch` 报错（Bedrock 拒绝、限流重试后仍失败），或向量没算全；整份没有写库 | 稍后重试；一直失败查 PG 主机实例角色调 Cohere v4 的权限（`kb/GUIDE.md` 9.10）。刚改过 IAM 策略的，等几分钟生效 |
| `internal_error` | 其他（数据库的其他报错、运行环境里没有 psycopg、工具的表名配置不合规……） | 按 `message` 处理；问题持续查平台日志，必要时重新打包发布 |

- 入库失败时，上传记录改成 `failed` 并写明原因，回复里带它的 `document_id`。连接中途断了改不成的，这一行留在 `ingesting`，`check` 30 分钟后报 `stuck_ingest`。
- 回复是 `success=false` 时规则没有改动：入库、下线、恢复、删除各是一个事务，失败整份回滚（只有上传记录会记成 `failed`）。

**`check` 的问题码**（`problems[].code`）：

| `code` | 含义 | 怎么办 |
|---|---|---|
| `missing_embedding` | 有行没有向量（语义检索查不到） | 重新入库这份制度可补上 |
| `wrong_dimension` | 向量维度与 `kb_meta` 登记的不同 | 查是谁写的；重新入库这份制度 |
| `untagged` | 有行没有 `source_tag`（手工写入或更早的入库），不属于任何制度、不会被清理 | 确认来源后补标签或删掉 |
| `duplicate_rule_id` | 同一编号同时在规则表和归档表 | 恢复归档的那份会冲突：先删掉其中一份 |
| `stuck_ingest` | 上传记录卡在「入库中」超过 30 分钟 | 入库进程多半已中断：重新上传 |
| `count_mismatch` | 最近一次入库登记的条数与表里的不同 | 多半是之后别的路径改过这份制度（第 16 节第 7 条）；重新入库一次 |
| `kb_meta_missing` | `kb_meta` 没登记向量模型 | 按 `kb/GUIDE.md` 7.6 处理（老库按 Titan 算） |
| `embedding_drift` | 抽 3 行用现在的模型重算，余弦 < 0.999 | 可能残留了旧模型的向量：重新入库这份制度 |

## 16　已知限制

1. **矩阵编号不带制度标识。** 审批矩阵的编号照 `parse_rules`：`C<章>-<序号>`、制度说明 `G-xx`、章节说明 `Cxx-NOTE`，都不带前缀。两份矩阵制度章号重叠，或都带「制度说明」，就会撞号，入库整份拒绝（`rule_conflict`）。要放第二份矩阵制度：用不重叠的章号（例如从「十一、」起），不写「制度说明」。正文条款的编号带前缀，不受影响。
2. **Word 的自动编号认不出。** 用 Word 列表自动编号（`w:numPr`）生成的「第X条」，文字里没有这几个字，不当条款标记，退回按标题 / 段落成块，条款切分会粗一些。
3. **PDF 里的矩阵可能少读合并单元格。** 解析报告里有提醒；审批矩阵请用 Word / Excel。扫描件不做 OCR；不收 .doc / .xls。
4. **`kb/deploy.sh ingest` 与本 Agent 不要混用于含正文的制度。** `deploy.sh ingest` 用 `parse_rules`（只出矩阵）并带 `--prune`；本 Agent 用 `kb_parse`（矩阵 + 正文）。同一份含正文的制度两边轮流入库，会互相清掉对方没有的正文条款。纯矩阵的制度（参考环境的真实制度正文条款为 0）两边结果相同，不受影响。含正文的制度只经本 Agent 入库。
5. **IAM 策略改了要等几分钟。** 实测改 `KbBedrockPolicy` 后约 9 分钟内 Bedrock 间歇 403。改完先等，或用几次直接调用确认稳定了再迁移、回归。
6. **回归的问题会进检索日志。** `kb/deploy.sh regress` 以 `caller='kb-regression'` 调 `kb_search`，问题记进 `kb_search_log`（保留 90 天）。题库由真实制度派生：每次跑完以超级用户删掉 `DELETE FROM kb_search_log WHERE caller = 'kb-regression'`。
7. **`deploy.sh` 的入库不写上传记录。** 经 `deploy.sh ingest` 入库后，`list` 里这份制度的 `file_name` / `doc_hash` 是空的（或停在本 Agent 上一次入库的值），`check` 可能报 `count_mismatch`。
8. **经模型一轮，慢而且要校验。** 一次 A2A 规则请求约 17 秒（模型那一轮）；回复由模型照抄工具的 JSON，调用方要校验形态（测试台客户端、`a2a_rules.mjs` 都校验）。
9. **`search` 不按板块、金额过滤**（第 11 节）；审核 Agent 按单据金额取档。
10. **测试台还不认 `preview`。** 测试台客户端的形态校验里没有 `preview`，页面要用它得等下一份设计；`a2a_rules.mjs` 可以发。
11. **审核 Agent 还不会专门引用正文条款。** 它照旧经 `kb_search` 查，正文条款可能出现在结果里（命中数相同时排在矩阵行后面）；怎么引用 `clause` 行留给下一份设计。

## 17　回滚与清理

由轻到重。**删除类操作各自单独确认。** 命令在本包的上一级目录执行（开发仓库的根目录，即交付 zip 里的 `repo/`），`OP` 照第 10 节定义。

1. **提示词**：把第 6 步存下的那一份 PUT 回去。请求体是 `{"content": "<prompt-before.json 里的 content>", "file_type": "prompt"}`，先存成仓库外的一个文件：
   ```bash
   "${OP[@]}" call PUT "/api/v2/agents/<AGENT_ID>/files/prompt" --data-file <仓库外的目录>/prompt-rollback.json
   ```
2. **工具代码**：回到第 N 版（`--profile` 要是管理员的）：`"${OP[@]}" call POST "/api/v2/tools/registered/<TOOL_ID>/versions/<N>/activate"`（看过请求、确认后加 `--yes`）；或从旧的提交重新打包，照第 10 节发布。
3. **一份制度的数据**：`deactivate` 先下线（可恢复）；要回到旧版本，就用同一个制度标识再入库旧版文件。`delete` 不可恢复。
4. **向量模型**（换模型后对比或端到端不过）：照 `kb/GUIDE.md` 7.6 第 4 步回退到 Titan：`kb/deploy.env` 里 `EMBED_MODEL_ID` 改回 Titan，`kb/deploy.sh db --dry-run --restore-embeddings` 看过再 `kb/deploy.sh db --restore-embeddings`。要用备份表 `approval_rules_titan_backup`。本 Agent 不用改：向量始终由库里登记的模型算。
5. **待清理的东西**（参考环境，各自另行确认）：
   - 测试用的调用密钥：在网页的发布详情里停用。经 Operator 调 `DELETE /api/v2/publications/<PUBLISH_ID>/keys/<CREDENTIAL_ID>` 多半会被拒（连接档位「搭建」不含删除，退出码 4），所以用网页。停用后再删本机的 `knowledgebase-writer-agent-pg/.state/a2a-call-key`。
   - 探针工具目录 `kb_pg_probe_<hash>`，调它的测试会话和那份会话级动态配置；对话端到端在本 Agent 上建的测试会话。
   - 复制 Agent 时带来的旧工具目录。
   - 备份表 `approval_rules_titan_backup`：**留到项目负责人决定**。删了就不能回退到 Titan；不删就不能再迁移一次。删时以 postgres 在 PG 主机上 `DROP TABLE approval_rules_titan_backup`。
   - 测试台栈 `KbBedrockPolicy` 里的 Titan：切换稳定、确认不再回退后去掉，同样先出变更集，只许这一处。
   - 检索日志里回归留下的行（第 16 节第 6 条）。
6. **整个撤掉**（各自确认）：删除 A2A 发布 → 删除密钥绑定 → 删除导入的工具目录 `kb_pg_steward_<hash>` → 删除复制出的 Agent。PG 里的数据不随之删除：要删某份制度，先用 `delete`。

## 附录 A　文件清单

**本包**（`knowledgebase-writer-agent-pg/`）

| 文件 | 做什么 |
|---|---|
| `README.md` | 本文 |
| `nexus-package.json` | 包描述：模块 `pg`（`pg_kb_tools`，.zip 多文件导入，标签 `kb_pg_steward`，密钥 `pg_kb`，3 个工具）与 `probe`（探针，不要密钥）；提示词模板与占位符。共用管理员脚本按它办事 |
| `deploy.env.example` | 部署参数样例（规则表名、Nexus 地址、管理员密码来源）；复制成 `deploy.env` |
| `.gitignore` | 挡住 `deploy.env`、`.build/`、`.state/`、`__pycache__/` |
| `tools/pg_kb_tools.py` | 三个 `@tool` 的入口：参数检查、取注入的密钥、连库与会话时限、错误去敏与映射、回复形态 |
| `scripts/build_tools.py` | 拼装工具目录（入口 + `kb/lib` 的 5 个核心模块）、`MANIFEST.json`、可重复的 .zip；`probe` 打包探针 |
| `scripts/admin_run.sh` | 管理员操作：设好 `NEXUS_PKG_ROOT` 后交给共用的 `knowbase-s3vectors-agent/scripts/admin_run.sh` |
| `scripts/a2a_rules.mjs` | 经 A2A 发一次规则请求、打印工具的 JSON（自测与端到端用；约定的操作经测试台客户端发） |
| `scripts/make_e2e_docs.py` | 生成端到端用的虚构文档到 `.build/e2e/`（矩阵、冲突矩阵、正文 md / pdf / xlsx） |
| `prompt/knowledgebase_writer_agent_pg.yaml.tmpl` | 提示词模板：引用共用片段 `kb_rules_v1`，填本包的操作清单 |
| `probe/kb_probe_entry.py`、`kb_probe_helper.py` | 探针工具：同目录相对 import、VM 里的 Python 与包版本 |
| `tests/local_test.py`、`admin_test.py`、`contract.test.mjs` | 本机测试（第 2 节） |
| `tests/e2e_results.json` | 2026-10-30 线上端到端的去敏记录 |

**生成物**（不进仓库）：`.build/tools/`（拼装出的 6 个文件）、`.build/MANIFEST.json`、`.build/pg_kb_tools.zip`、`.build/probe/`、`.build/kb_probe.zip`、`.build/prompt.yaml`、`.build/prompt-body.json`、`.build/contract-replies.json`、`.build/e2e/`；`.state/import.json`、`.state/import-probe.json`（导入结果）、`.state/a2a-call-key`（调用密钥，600）。

**本包用到的同仓库文件**

| 文件 | 做什么 |
|---|---|
| `kb/lib/doc_blocks.py`、`parse_rules.py`、`clauses.py`、`kb_parse.py`、`kb_store.py` | 共享核心（一份代码多处用）：四种格式 → 块、审批矩阵、正文条款、整份文档 → 记录与报告、入库与管理。原样拷进工具目录；`deploy.sh` 的入库也用它们 |
| `kb/sql/kb_search.sql` | 库里的 `kb_embed` / `kb_embed_batch` / `kb_search` / `kb_meta` / `kb_documents`（`kb/deploy.sh db` 装） |
| `kb/prompt/kb_rules_v1.zh.md` | 两个文档管家共用的「规则请求」通用规则 |
| `kb/tests/`（`run_pglite.sh`、`pg_harness.py`、`fake_kb_embed.sql`、`sample_docs.py`） | 本机测试的 PGlite 底座、假的向量函数、虚构文档生成器 |
| `kb/lib/common.sh`、`kb/host/read-admin-password.sh` | SSM 方式读管理员密码（密封读取） |
| `knowbase-s3vectors-agent/scripts/admin_run.sh`、`nexus_admin.py`、`render.py`、`nexus_package.py` | 共用管理员脚本：导入、核对、发布、绑定、发调用密钥；渲染提示词；读包描述 |
| `knowbase-s3vectors-agent/tests/stubs/` | 本机测试里 `strands`、`nexus_utils.secret_key` 的替身 |
| `poc/app/lib/a2a-client.mjs`、`poc/app/kb-steward-client.mjs` | A2A 客户端与测试台的规则请求客户端（`a2a_rules.mjs`、契约测试用） |
| `kb/GUIDE.md` | PG 知识库本身：部署、`kb_search`、换向量模型（7.6）、排错 |

## 附录 B　用到的 Nexus API 与权限

| API | 用途 | 谁调 |
|---|---|---|
| `GET /api/v2/agents/{id}/clone-preview`、`POST …/clone`、`GET …/clone-status` | 复制 Agent | Operator |
| `GET /api/v2/keys/schemas`、`POST /api/v2/tools/import/upload`、`POST /api/v2/tools/import/confirm` | 导入工具并声明密钥（只对管理员开放） | 管理员脚本 |
| `GET /api/v2/keys/tools-requiring-key`、`GET /api/v2/tools/registered/{id}/files` | 核对密钥绑定与服务端文件 | 管理员脚本 |
| `POST /api/v2/tools/registered/{id}/publish-check`、`PUT …/files` | 发布工具新版本（只对管理员开放） | 管理员脚本 |
| `POST /api/v2/tools/registered/{id}/versions/{n}/activate` | 回到某个版本 | 管理员 |
| `PUT /api/v2/keys/tool-bindings` | 按人绑定密钥 | Operator（属主）或 `admin_run.sh bind` |
| `GET` / `PUT /api/v2/agents/{id}/files/prompt` | 读、存提示词（PUT 体 `{"content", "file_type": "prompt"}`） | Operator |
| `POST /api/v2/publications` | 建 A2A + MCP 发布 | Operator |
| `POST /api/v2/publications/{id}/keys`、`DELETE …/keys/{credential_id}` | 发、停调用密钥 | 管理员脚本、网页 |

| 身份 | 要什么 |
|---|---|
| Nexus 管理员 | 导入工具、发布工具新版本（第 4、10 步） |
| Nexus Operator（editor，Agent 与发布的属主） | 复制 Agent、绑定密钥、保存提示词、建发布、对话（第 3、5、6、7、8 步） |
| 数据库应用用户（Nexus 密钥 `pg_kb`） | 规则表的属主；建归档表；执行 `kb_embed` / `kb_embed_batch` / `kb_search` |
| PG 主机的实例角色 | `bedrock:InvokeModel` 调 Cohere Embed v4（`us.` 推理配置文件与它路由到的三个区域的基础模型）；测试台由栈的 `KbBedrockPolicy` 给 |
