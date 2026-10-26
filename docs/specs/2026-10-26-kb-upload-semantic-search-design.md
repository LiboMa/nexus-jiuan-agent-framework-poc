# 制度知识库：上传入库、历史与库内语义检索（设计，2026-10-26）

状态：**已确认（2026-10-26）**：复用现有 PG 容器、就地装 PL/Python；另加检索日志。下一步写实施计划，在测试台上做。接在今天并进来的知识库工具（`kb/`，PostgreSQL + pgvector → Nexus 数据连接器 → 审核 Agent）之后；10-24 / 10-25 那份独立知识服务的设计（FastAPI、Cohere、私网 443 检索工具）不再沿用。

## 0. 已定的事（2026-10-26，项目负责人）

| 问题 | 决定 |
|---|---|
| 页面放在哪 | 九安 v0.7.10（jiuan-v0710.tinyboat.blog）的「规则库」里加一页：顶上分「审核要点」（现有）和「制度知识库」（新） |
| 能上传什么 | 先只收**审批矩阵格式的 .docx**，复用 `kb/lib/parse_rules.py`：一行一条审批路径，规则编号和原文序号对应 |
| 审核 Agent 怎么用向量 | **库内语义检索**：PG 里加函数 `kb_search(问题)`，由 PG 调 Bedrock 把问题向量化；Agent 经现有的 Nexus 连接器一条 SQL 就能语义检索 |
| 顺序 | 先做这个功能，再写测试部署文档和给编码工具的 Guide |
| PG 容器 | **复用现在的 `nexus-pgvector`**，在容器里就地装 PL/Python（不重启、不停机），由知识库工具的 `db` 阶段幂等补装；不做自建镜像、不重建容器 |
| 检索日志 | 加：每次 `kb_search` 记下问题、命中和分数，页面上能看 Agent 查了什么 |

## 1. 要做成什么样

1. **上传**：管理员在「制度知识库」页拖进或选一份 .docx → 平台校验并解析，显示解析报告（每章多少条、重复编号、缺审批路径的行、文档名和版本）→ 管理员核对、可改文档名 / 版本说明 →「确认入库」→ 向量化、写进 PG → 页面显示结果（新增 / 只更新说明 / 重算向量 / 删除 / 不变各多少条、用时）。
2. **历史**：每次上传一行：时间、文件名、上传人、状态（已解析 / 入库中 / 已入库 / 失败 / 被新版本取代）、规则数、新增 / 更新 / 删除、用时；点开看解析报告、入库结果和这一版的规则清单。测试台的端到端重置不清历史。
3. **检索**：同一页有一个「按问题检索」框，走的就是 Agent 用的 `kb_search`，用来自己核对 Agent 能查到什么。
4. **Agent**：审核 Agent 的提示词改成先 `SELECT * FROM kb_search('<业务事项 板块 金额 事由>', 8)` 取候选，再按 `rule_id` 精确取原文、核对金额档和审批路径。经现有连接器 `conn-f0c7233959d9`，不加新工具。

## 2. 架构

```
浏览器（规则库 › 制度知识库）
   │ 同一登录、CSRF；管理员
   ▼
九安 v0.7.10 + 外壳 poc/app07（本机 4181）
   │ 上传：存文件、跑解析器、记历史        ┌───────────────────────────────┐
   │ 入库：起 Python 入库进程 ───────────────▶│ PG 容器 nexus-pgvector（同一实例）│
   │ 检索：SELECT kb_search(…)              │  approval_rules（规则 + 向量）    │
   ▼                                        │  kb_documents（上传历史）         │
/var/lib/jiuan07/kb-uploads/（原文件，0600） │  kb_embed() / kb_search()        │
                                            │   └─ plpython3u → Bedrock Titan v2│
Nexus 审核 Agent ── 数据连接器 ─────────────▶│      （实例角色，只许这一个模型）     │
                                            └───────────────────────────────┘
```

**向量只在 PG 里生成**：入库和检索都调同一个 `kb_embed(text)`（Titan v2，1024 维，`normalize: true`，和现有 102 行的参数一样），所以问题和规则的向量一定可比。外壳不需要 AWS 凭证（v0.7.10 的服务按设计屏蔽了 IMDS）；PG 容器经 IMDSv2（跳数 2，已是现状）用实例角色。

## 3. 各部分

### 3.1 PG 镜像与函数（`kb/`）

- **就地装语言，不换镜像**：`pgvector/pgvector:pg17` 自带 PGDG 的 apt 源但不带 PL/Python。`db` 阶段（`host/pgvector-up.sh`）在容器里查有没有 `plpython3u`，没有就 `apt-get install postgresql-plpython3-17 python3-boto3`（Debian 包，不用 pip）。PG 在 `CREATE EXTENSION plpython3u` 时才加载它，**不用重启、不停机**，数据卷、`.env`、端口绑定都不动。
- 装的东西在容器的可写层里：容器重启、主机重启都还在；容器被重建（换主机、升级镜像）就没了，下一次 `db` 阶段会自动补装，`verify` 核对 `kb_search` 能用。
- `kb/sql/kb_search.sql`（超级用户执行，幂等）：
  - `CREATE EXTENSION plpython3u`；
  - `kb_embed(text) RETURNS vector(1024)`：plpython3u，`SECURITY DEFINER`；输入超过 2000 字拒绝；按内容 sha256 查缓存表 `kb_embed_cache`，没有才调 Bedrock；每分钟最多 120 次（超了报错，不静默降级）；
  - `kb_search(question text, k int DEFAULT 8, segment text DEFAULT NULL)` 返回 `rule_id, rule_type, chapter, business_item, segment, amount_tier, approval_path_text, final_approver, scope_controls, score`：`ORDER BY embedding <=> kb_embed(question)`，可选按板块过滤，`k` 上限 20；
  - 检索日志 `kb_search_log`：每次 `kb_search` 记一行（时间、问题、`k`、板块、命中的 `rule_id` 和分数、用时、调用的数据库用户）；只追加，保留最近 90 天；
  - 连接器用户 `nexus` 只拿到这两个函数的 `EXECUTE`；`plpython3u` 是不受信语言，非超级用户建不了函数，连接器的 DDL 权限碰不到它。
- 知识库工具：`db` 阶段在镜像带 plpython3u 时执行 `kb_search.sql`；`verify` 加两项：`kb_search` 能用、`E2E_QUESTION` 的前 3 名里有 `E2E_EXPECT`。

### 3.2 入库进程（复用 `kb/lib/ingest_rules.py`）

- 加 `--embed sql`：不 import boto3，向量用 `kb_embed(content)` 在 SQL 里生成；其余（`record_sha256`、只更新说明不重算向量、`--prune`、owner 检查）不变。命令行的 `kb.sh ingest` 和页面走同一套逻辑，两边来回入库不会互相造成改动。
- 测试台上的运行环境：`/opt/andon-finance/kb-venv`（`python3 -m venv` + 钉版本的 `psycopg[binary]`），部署时建；`parse_rules.py` 只用标准库。
- 连库：`nexus` 用户，密码由 `bench07-configure.sh`（root）从 PG 主机的 `.env` 复制成 `/etc/andon-finance/jiuan07/kb_pg_password`（root:jiuan07 0640），不经 SSM 输出、不进日志。

### 3.3 历史（PG 表 `kb_documents`）

`id`、`file_name`、`sha256`、`size_bytes`、`uploaded_by`、`uploaded_at`、`status`、`source_tag`、`doc_title`、`source_version`、`report`（解析统计）、`result`（入库摘要）、`error`、`started_at`、`finished_at`。原文件存 `/var/lib/jiuan07/kb-uploads/<sha256>.docx`（0600），解析结果存同目录的 `<id>.rules.json`，用来在历史里看「这一版的规则」。同一 `source_tag` 新版入库后，旧的那条记成「被新版本取代」。

### 3.4 外壳接口（`poc/app07/kb-routes.mjs`，只给管理员）

| 接口 | 做什么 |
|---|---|
| `POST /api/analysis/v1/poc/kb/documents` | 请求体是 .docx 原文（`Content-Type` 和文件头都要对，≤ 20 MB，zip 条目和解压大小有上限）；存文件、跑解析器（子进程，限时 60 秒）、记历史；回解析报告 |
| `POST …/poc/kb/documents/<id>/ingest` | `{ docTitle, sourceVersion, sourceTag }`；起入库进程，先回 202；同一时间只跑一个 |
| `GET …/poc/kb/documents`、`…/<id>` | 历史列表、单条详情（报告、结果、这一版的规则） |
| `GET …/poc/kb/search?q=` | 调 `kb_search`，回前 8 条和分数 |
| `GET …/poc/kb/search-log` | 检索日志：最近 50 次 `kb_search`（谁查的：审核 Agent 经连接器 / 页面上的检索框），问题、命中、分数、用时 |

这些路径不在 `/platform` 下，九安不替它们读请求体，外壳自己读（和模拟来单一样）；CSRF 照九安的规则校验。

### 3.5 页面（补丁 0004，九安 v0.7.10）

- 「规则库」顶上加两个页签「审核要点」「制度知识库」（`#rules?view=kb`）；审核要点页原样不动。
- 新文件 `public/kb-page.js`（登记进九安的静态文件白名单），样式用九安的 `--ui-*` 变量，和「Agent 接入」页同一套卡片、表格、标签、按钮。
- 四块：上传与解析报告、入库结果；历史表（点开看详情）；按问题检索；检索日志（Agent 和页面查了什么、命中了哪些规则）。

### 3.6 IaC 与部署

- 模板：实例角色加 `bedrock:InvokeModel`，只许 `amazon.titan-embed-text-v2:0` 这一个模型（`KbEnabled` 时才有）。不换实例。
- `bench07-configure.sh`：建 `kb-uploads` 目录、复制 PG 密码文件、建 venv。
- 在容器里就地装包（第一次）之前要人确认；之后 `db` 阶段幂等。

### 3.7 审核 Agent

- 提示词第 9 条（`audit-agent/prompt.yaml`）和知识库工具管的第 8 条（`kb/agent/prompt-rules.txt`）都改成先用 `kb_search`，查库仍最多 3 次。改完 `kb.sh agent` → `apply.py`（重存发布的动态配置），每次写之前把改动给项目负责人看。
- 回归：九安 v0.7.10 端到端测试（四张对公付款单的结论不变、引用的规则编号都在库里）、`kb.sh verify --e2e`。

## 4. 测试

- 单元测试：外壳接口（假的入库进程和假的 PG）、上传校验（类型、大小、zip 炸弹）、页面组件（假 DOM，照「Agent 接入」页的写法）；`ingest_rules.py --embed sql` 的 SQL 生成；`kb_search.sql` 的语法在本机用 PG 容器跑（不调 Bedrock，`kb_embed` 换成桩）。
- 测试用的文档：另造一份**仿真审批矩阵** .docx（结构相同、内容虚构）放进仓库；真实制度只在本机和测试台上用。
- 测试台上：用真实制度走一遍上传 → 入库（应全部「不变」或「只更新说明」）→ 检索 `E2E_QUESTION` 前 3 名有 C03-1.2 → 历史里有这一条；再跑一遍九安 v0.7.10 端到端测试和 `kb.sh verify --e2e`。

## 5. 风险与取舍

- **PG 出网调 Bedrock**：安全面变大。限制：只许一个模型（IAM）、输入长度上限、每分钟次数上限、缓存；函数只读不写业务表（缓存表除外）。Titan v2 一次约 0.00002 美元，费用可以忽略。
- **任何能拿实例角色的进程都能调这个模型**（实例上的容器经 IMDS 都能拿到）：只给一个嵌入模型，风险可以接受；以后要收紧可以把 PG 挪到单独主机（知识库工具的 create 模式）。
- **就地装包**：装在容器可写层，重建容器会丢，由 `db` 阶段补装；装包要从容器连 Debian / PGDG 的 apt 源（测试台出网已开）。
- **只认审批矩阵格式**：别的结构的文档会被解析器拒收，页面上说清原因。

## 6. 我的判断（可以改）

- 上传和确认入库都是管理员，不做「录入人 ≠ 发布人」（规则库那套双人发布留给审核要点页）。
- 历史和原文件留在测试台上，不进构件桶；端到端重置不清。
- 检索框只给管理员。
