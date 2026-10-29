# 制度知识库的 S3 Vectors 方式与审核员自定义规则 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 知识库多一种部署方式（S3 Vectors：文档管家经 A2A 写一行一条的规则，审核 Agent 用代码拼过滤的 `rules_search` 读），两种方式都另有审核员自定义规则（只随审核员手动发起的那一轮发给审核 Agent）；现有环境切到 S3 Vectors 并跑通端到端。

**Architecture:** 文档管家包复制进仓库（`knowbase-s3vectors-agent/`），加一个单独导入的工具模块 `s3vectors_rules_tools.py`（`rules_writer` / `rules_search` / `rules_manager`），复用写入密钥。测试台外壳按 `POC07_KB_MODE` 挂 PG 或 S3 Vectors 的「公司制度」接口；「我的规则」存在测试台本机；`review_advice@1` 组装器外面包一层，人手动发起时附 `input.customRules`。审核 Agent 的提示词按 `KB_MODE` 渲染两种。

**Tech Stack:** Node 24（外壳、补丁、`node --test`、Playwright 端到端）；Python 3（工具模块只用标准库 + boto3，本机测试用 `fake_aws.py`；`audit-agent/` 标准库 + `unittest`）；bash + AWS CLI v2（`s3vectors`、SSM）；Nexus v0.3.28（nexus-ai-operator、管理员脚本）。

**Spec:** `docs/specs/2026-10-28-s3vectors-rules-and-custom-rules-design.md`

## Global Constraints

- `KB_MODE=pg|s3vectors`，不写就是 `pg`；不给 `DEPLOY_ENV` 时每个脚本、外壳、提示词的行为和现在逐字一致。
- S3 Vectors 方式的五个配置键：`KB_S3V_BUCKET`、`KB_S3V_RULES_INDEX`、`RULES_TOOL_DIR`、`KB_S3V_KEY_ID`、`KB_S3V_PUBLICATION_ID`（现有环境：`knowbase-s3v-demo`、`rules`、导入后回填、`key-34360f081254`、`pub_2a6d8020998b2a93`）；代码和提示词里不写死这些值。
- `rules` 索引：1536 维、`cosine`、`float32`，不可过滤键只有 `["text"]`；键 = 规则编号；向量 Cohere Embed v4（规则 `search_document`，问句 `search_query`）。
- 过滤：`active=true` 且板块（命中或 `*`）且金额（落在区间或 `amt_kind != "range"`），语义与 E10 `s3v_filter(f, use_seg=True, use_amt=True, use_ch=False)` 相同；不用章节过滤。
- 自定义规则：`.md` / `.docx`；每人 ≤ 10 份、单个文件 ≤ 2 MB、合计 ≤ 20,000 字；只在人从单据页发起（`reviewAdvice.start`，actor 不是 `system:pipeline`）时附 `input.customRules = {owner, items: [{title, text}]}`；`note` 以「（含 <owner> 的自定义规则）」开头，依据 `ref` 以「自定义：」开头。
- 整份请求 ≤ `maxRequestChars` 87,442 字：先裁原件（从末尾逐页），不裁自定义规则；改完重新校验并重算 `inputFingerprint`。
- 文档管家的调用密钥只经「Agent 接入」页启用，外壳用 `agentEnablement.credentialFor(publishId)` 取；不进 `secrets.env`、配置文件、日志；测试不碰钥匙。
- 制度原文和从它派生的东西（规则全文、解析结果、检索回归的题库与结果）不进仓库、交付包、日志、截图。
- 改 Nexus 或 AWS 上的东西之前先 `--dry-run` / 计划输出，给项目负责人看，同意后才写。
- `nexus-customer-deploy/knowbase-s3vectors-agent/` 原目录不动。
- 本轮只跑 S3 Vectors 方式的端到端，现有环境最后停在 `s3vectors`。
- 每个 Task 本地提交（`--no-verify`）；端到端测试通过并经项目负责人确认后才推送。

## Review Focus

1. **文档管家的回复不合格**（不是 JSON、带说明文字、字段是另一种操作的、`success` 缺失）：页面说「文档管家的回复不合格」，写操作不重试，入库记录标失败。Task 6 的测试钉住。
2. **金额正好在档位边界、板块写「全板块」或没有板块、金额读不出**：过滤与 E10 的 `keep()` 逐条一致（例如 200,000 落在「>20 万」之外、「≤20 万」之内）；不给板块 / 金额时不加那一项过滤。Task 2 的测试钉住。
3. **两位审核员同时手动发起**（A 有规则、B 没有，各发一张单）：A 那一轮只带 A 的规则，B 那一轮不带任何规则，`inputFingerprint` 各不相同。Task 8 的测试钉住。
4. **自定义规则文件不规整**（.md 带 BOM / CRLF、.docx 只有表格、空文件、不是 zip 的 .docx、合计正好 20,000 字和 20,001 字）：能抽的抽出纯文本，抽不出或超限在上传时就拒绝并说明，不等到发起时才失败。Task 7 的测试钉住。
5. **文档管家没在「Agent 接入」页启用，或钥匙被 Nexus 拒绝（401 / `credential_invalid`）**：页面直接说「先在『Agent 接入』页启用知识库文档管家」，不发调用；401 时 `markInvalid` 一次，不反复重试。Task 6 的测试钉住。

---

### Task 1: 把文档管家包复制进仓库

**Files:**
- Create: `knowbase-s3vectors-agent/`（从 `/Users/malibo/MyDev/LLM/Nexus-AI-strands/nexus-customer-deploy/knowbase-s3vectors-agent/` 复制）、`knowbase-s3vectors-agent/SOURCE.md`
- Modify: `docs/delivery/make-package.sh`、`.gitignore`（如需）
- Test: `poc/app/test/unit/package.test.mjs`

**Interfaces:**
- Produces: 仓库里的包路径 `knowbase-s3vectors-agent/{tools,scripts,infra,prompt,frontend,tests,assets,build}`；后续 Task 只改这一份。

- [ ] **Step 1: 写测试** `package.test.mjs` 加一条「交付包带 knowbase-s3vectors-agent，不带 deploy.env、.state、.build、build/out、*.docx（tests/fixtures 除外）、__pycache__」：跑 `make-package.sh` 到临时目录，断言 `knowbase-s3vectors-agent/GUIDE.zh.md` 在、上面这些都不在。
- [ ] **Step 2: 跑** `cd poc/app && node --test test/unit/package.test.mjs`，FAIL。
- [ ] **Step 3: 复制**：`rsync -a --exclude deploy.env --exclude .state --exclude .build --exclude 'build/out' --exclude __pycache__ --exclude '*.docx' --include 'tests/fixtures/*.docx' <源>/ knowbase-s3vectors-agent/`。复制后逐个看 `tests/e2e_results.json`、`tests/*.json`、`assets/`：只能有环境 ID（会话、文档 ID），不能有任何密钥、调用密钥或制度原文；有就去掉那一项并在 `SOURCE.md` 记下。`SOURCE.md` 写：来源目录、复制日期 2026-10-28、排除了什么、之后改动只在这一份。`make-package.sh` 照 `kb/` 的写法带上它。
- [ ] **Step 4: 核对**：`cd poc/app && node --test test/unit/package.test.mjs` PASS；`uv run --no-project --with boto3 --with python-docx --with openpyxl --with pdfplumber python -I knowbase-s3vectors-agent/tests/local_test.py` 仍是 62 项全过；`git status` 里没有 `.state`、`deploy.env`。
- [ ] **Step 5: 提交** `feat(kb-s3v): bring the S3 Vectors knowledge-base agent package in`

### Task 2: 规则工具模块 `s3vectors_rules_tools.py`

**Files:**
- Create: `knowbase-s3vectors-agent/tools/s3vectors_rules_tools.py`、`knowbase-s3vectors-agent/tests/rules_local_test.py`
- Modify: `knowbase-s3vectors-agent/tests/fake_aws.py`（只在缺什么时补）
- Test: `knowbase-s3vectors-agent/tests/rules_local_test.py`

**Interfaces:**
- Consumes: `fake_aws.FakeS3Vectors` / `FakeBedrock`；`kb/tests/fixtures/sample-matrix.docx`（虚构）；`kb/lib/parse_rules.py`（只在测试里作对照）。
- Produces（`@tool`，都返回 JSON 字符串，失败时 `success=false, error_type, message, suggestion`）：
  - `rules_writer(file_path: str, source_id: str, source_version: str = "", title: str = "") -> str`：`{success, status: "ingested"|"skipped", source_id, source_version, rules_total, written, removed, unchanged, conflicts: [rule_id], report}`
  - `rules_search(question: str, segment: str = "", amount: float | None = None, top_k: int = 8) -> str`：`{success, filter, results: [{rule_id, rule_type, chapter_no, segments, amt_kind, source_id, text, distance}]}`
  - `rules_manager(action: str, source_id: str = "") -> str`，`action ∈ list|detail|deactivate|restore|delete|check`：`list → {success, sources: [{source_id, title, source_version, file_name, doc_hash, rules_total, status: "active"|"inactive", ingested_at, updated_at}]}`；`detail → {success, source, rule_ids}`；`check → {success, ok, problems: [...]}`；其余 `{success, source_id, affected}`
  - 渲染段（`# >>> deploy-config` … `# <<< deploy-config`，与 `s3vectors_kb_tools.py` 同一写法）：`_REGION`、`_VECTOR_BUCKET`、`_RULES_INDEX`、`_SOURCES_INDEX = "rule-sources"`、`_AUDIT_INDEX = "audit"`
  - 模块级纯函数（测试直接调）：`parse_matrix(path) -> (records, report)`、`tier_interval(text) -> (lo, lo_incl, hi, hi_incl, kind)`、`rule_metadata(rule, source) -> dict`、`build_filter(segment, amount) -> dict`

- [ ] **Step 1: 写测试** `rules_local_test.py`（照 `local_test.py` 的写法：stubs + 假 AWS + 假密钥注入），至少这些用例：
  - `parse_matches_kb`：`parse_matrix(fixture)` 的每条 `rule_id, rule_type, content` 与 `kb/lib/parse_rules.py` 对同一文件的输出逐条相同，`report` 的各类条数相同。
  - `tiers_match_research`：`tier_interval` 对「≤20万」「>20万且≤50万」「不论金额」「升级事项（四类）…」「研发项目」给出 `(None,False,200000.0,True,'range')`、`(200000.0,False,500000.0,True,'range')`、`'any'`、`'mixed'`、`None`（照研究 `tiers.py` 的语义）。
  - `filter_matches_keep`（Review Focus 2）：在 fixture 规则上，对板块 `九安` / `全板块` / 空、金额 `200000` / `200000.01` / `None` 的每种组合，`build_filter` 交给假 S3 Vectors 选出的规则集合，等于照 E10 `keep(rule, f, True, True, False)` 在本机算出的集合，并且都只有 `active=true` 的。
  - `writer_ingests_and_reingests`：第一次 `written == rules_total`；同一文件再来 `status == "skipped"`；改一行再来 `written == 1, unchanged == rules_total-1`；删一行再来 `removed == 1`，被删的键不在索引里。
  - `writer_refuses_conflict`：另一个 `source_id` 已有 `C01-1.1` 时整份拒绝，`conflicts` 列出编号，索引里原来那份不变。
  - `metadata_fits`：每条规则的可过滤元数据（除 `text`）序列化后 ≤ 2048 字节。
  - `deactivate_restore_delete`：`deactivate` 后 `rules_search` 查不到这份制度的规则，`restore` 后又能查到且距离不变，`delete` 后键和登记都没了；`check` 发现登记条数与键数不一致时 `ok=false`。
  - `credentials_missing`：没注入密钥时三个工具都返回 `error_type == "credentials_missing"`，不回落默认凭证链。
- [ ] **Step 2: 跑** `uv run --no-project --with boto3 --with python-docx --with openpyxl --with pdfplumber python -I knowbase-s3vectors-agent/tests/rules_local_test.py`，FAIL（模块不存在）。
- [ ] **Step 3: 实现** `s3vectors_rules_tools.py`：解析照搬 `kb/lib/parse_rules.py` 的 `parse()`（标准库）；`tier_interval` 照搬研究的 `tiers.py`；元数据照 E10 `metadata_for()` 再加 `source_id, source_version, active, ingested_at, rule_sha`（`rule_sha` = 正文与元数据的 sha256 前 16 位，用来算 `unchanged`）；凭证、客户端、嵌入、`_fetch_k` 多取再截断、错误映射照 `s3vectors_kb_tools.py` 复制（不 import 它）。登记写 `rule-sources` 索引（1 维，向量 `[1.0]`，键 = `source_id`）；写、删照现有做法记 `audit`。`PutVectors` 每批 ≤ 500，嵌入每批 ≤ 96 条。
- [ ] **Step 4: 跑** 同 Step 2，全部 PASS；`local_test.py` 仍 62 项全过。
- [ ] **Step 5: 提交** `feat(kb-s3v): rules tools — one vector per rule, filters built in code`

### Task 3: 包里的 AWS、渲染、导入与提示词

**Files:**
- Modify: `knowbase-s3vectors-agent/infra/aws_setup.sh`、`deploy.env.example`、`scripts/render.py`、`scripts/nexus_admin.py`、`prompt/knowbase_s3vectors_agent.yaml.tmpl`
- Test: `knowbase-s3vectors-agent/tests/rules_local_test.py`（渲染与提示词两条）、`bash -n`

**Interfaces:**
- Consumes: Task 2 的模块与渲染段。
- Produces：
  - `deploy.env` 新键 `RULES_INDEX`（缺省 `rules`）；`aws_setup.sh` 建 `ensure_index "$RULES_INDEX" 1536 '["text"]'` 与 `ensure_index rule-sources 1 '["title","file_name","doc_hash"]'`。
  - `render.py rules-tools` → `.build/s3vectors_rules_tools.py`；`render.py prompt --tool-dir <DIR> --rules-tool-dir <RULES_DIR>`。
  - `nexus_admin.py import --module rules`：导入 `.build/s3vectors_rules_tools.py`，三个工具都 `requires_key=true, key_name=s3vectors_kb, key_type=aws_credentials`，结果写 `.state/import-rules.json`（`dir_name`、`module_path`、`tools`）；`check/publish/verify` 同样接 `--module rules`。
  - 提示词新增一节「规则请求」：文字以 `kb.rules/v1 · <op>` 开头并带数据 Part 时只调对应工具一次、原样返回工具 JSON；`op → 工具`：`ingest → rules_writer(file_path=<附件路径>, source_id, source_version, title)`，`list|detail|deactivate|restore|delete|check → rules_manager(action=op, source_id)`，`search → rules_search(question, segment, amount, top_k)`。`tools_dependencies` 加三个规则工具。

- [ ] **Step 1: 写测试**：`render_rules_tools`（给假 deploy.env，渲染结果能 `compile`，渲染段里是那个桶名和 `RULES_INDEX`）；`prompt_has_rules_section`（渲染出的提示词 YAML 能解析，`tools_dependencies` 含 `imported_tools/<RULES_DIR>/s3vectors_rules_tools/rules_search`，正文含 `kb.rules/v1`）。
- [ ] **Step 2: 跑**，FAIL。
- [ ] **Step 3: 实现** 上面的 Produces；`nexus_admin.py` 的 `TOOLS` / `MODULE` / `STATE` 按 `--module` 选，缺省行为不变。
- [ ] **Step 4: 跑** 测试 PASS；`bash -n infra/aws_setup.sh scripts/admin_run.sh`；`bash infra/aws_setup.sh`（不加 `--apply`）在现有环境的 `deploy.env` 下只打印「创建索引 rules」「创建索引 rule-sources」两项计划。
- [ ] **Step 5: 提交** `feat(kb-s3v): rules index, render and import for the rules module; rules requests in the prompt`

### Task 4: 在 nxs-beine1013 上落地规则工具（人确认后写）

**Files:** 无代码改动（发现问题回到 Task 2、3 修）；包的 `deploy.env`（本机、不进仓库，可从原目录复制再加 `RULES_INDEX=rules`）。

- [ ] **Step 1:** 把 Task 3 Step 4 的计划给项目负责人看；同意后 `bash infra/aws_setup.sh --apply`，再跑一次应全是「已存在」。
- [ ] **Step 2:** `python3 -I scripts/render.py rules-tools` → `bash scripts/admin_run.sh import --module rules` → `PUT /api/v2/keys/tool-bindings`（`module_path` = `.state/import-rules.json` 的值，`key_name=s3vectors_kb`，`key_id=key-34360f081254`，Operator 先不加 `--yes` 看请求）→ `bash scripts/admin_run.sh verify --dir <RULES_DIR>`：三个工具 `configured=True`。
- [ ] **Step 3:** `render.py prompt --tool-dir <原 DIR> --rules-tool-dir <RULES_DIR>`，给项目负责人看与线上提示词的 diff，同意后 `PUT /api/v2/agents/agent_a5ba9263b3514fcc94221f3f0bac2263/files/prompt`。
- [ ] **Step 4（Spec 风险 1）:** 用包里的 `frontend/a2a_kb_client.mjs`（或一次性脚本，同一协议）经 `pub_2a6d8020998b2a93` 发 `kb.rules/v1 · ingest`（附 `kb/tests/fixtures/sample-matrix.docx`，`source_id=e2e-sample`）→ `list` → `search`（「立项」，板块、金额各给一次）→ `delete`：每一步都拿到合格 JSON、`success=true`，没有 `credentials_missing`；本机 `aws s3vectors list-vectors --index-name rules` 核对写入后有键、删除后为空。结果记进本计划的执行记录。

### Task 5: 配置键与测试台配置按方式走

**Files:**
- Modify: `poc/infra/lib/deploy-env.sh`（`DEPLOY_ENV_KEYS`）、`audit-agent/deploy_env.py`（`KEYS`）、`poc/infra/env/example.env`、`poc/infra/deploy.sh`（调 `bench07-configure.sh` 那一行）、`poc/infra/bench/bench07-configure.sh`、`poc/app07/settings.mjs`
- Test: `poc/app/test/unit/deploy-env.test.mjs`、`audit-agent/tests/test_deploy_env.py`、`poc/app/test/unit/bench07-infra.test.mjs`、`poc/app07/test/unit/settings-guard.test.mjs`

**Interfaces:**
- Produces：
  - 配置键 `KB_MODE`（只能是 `pg` / `s3vectors`，别的值报错带行号）和五个 S3 Vectors 键；`KB_MODE=s3vectors` 时五个键都要有，缺了报错列出缺哪个。
  - `bench07-configure.sh <站点主机名> <Nexus 地址> [<kb 方式> [<文档管家发布编号>]]`：写 `POC07_KB_MODE=<方式>`（缺省 `pg`），`s3vectors` 时写 `POC07_KB_S3V_PUBLICATION_ID=<pub_…>`、建 `/var/lib/jiuan07/kb-uploads` 与 `/var/lib/jiuan07/custom-rules`（jiuan07 0700），不写 `kb_pg_password` 之外的任何密钥文件；`pg` 时 `KB_LINES` 照旧。两种方式都建 `custom-rules` 目录。
  - `deploy.sh` 把 `${KB_MODE:-pg}` 和 `${KB_S3V_PUBLICATION_ID:-}` 作为第 3、4 个参数传过去。
  - `settings.mjs` 的 `kb`：`{ mode: 'pg', …现有字段 }` 或 `{ mode: 's3vectors', publishId, uploadsDir }`；`customRulesDir` 单独一项（`<stateDir>/custom-rules`）。`s3vectors` 时 `publishId` 必须形如 `^pub_[0-9a-f]{16}$`，不合格就启动失败。

- [ ] **Step 1: 写测试**：`deploy-env` 两边各加：`KB_MODE=s3vectors` 缺 `KB_S3V_KEY_ID` 报错；`KB_MODE=mongo` 报错带行号；不写 `KB_MODE` 时读出来没有这个键（调用方当 `pg`）。`bench07-infra`：`deploy.sh` 传了第 3、4 个参数；`bench07-configure.sh` 在 `s3vectors` 时写 `POC07_KB_MODE=s3vectors`、`POC07_KB_S3V_PUBLICATION_ID`，不读 `KB_ENV`、不写 `kb_pg_password`；两种方式都建 `custom-rules`。`settings-guard`：两种方式各解析一次，非法发布编号抛错。
- [ ] **Step 2: 跑** `cd poc/app && node --test test/unit/deploy-env.test.mjs test/unit/bench07-infra.test.mjs`、`cd poc/app07 && node --test test/unit/settings-guard.test.mjs`、`python3 -B -m unittest discover -s audit-agent/tests`，FAIL。
- [ ] **Step 3: 实现** 上面的 Produces。
- [ ] **Step 4: 跑** 同 Step 2，PASS；不给 `DEPLOY_ENV` 时 `bash poc/infra/deploy.sh --dry-run`（或现有的等价检查）输出与改动前一致。
- [ ] **Step 5: 提交** `feat(infra): KB_MODE picks the knowledge-base deployment (pg | s3vectors)`

### Task 6: 外壳：S3 Vectors 方式的「公司制度」接口

**Files:**
- Create: `poc/app07/kb-s3v-client.mjs`、`poc/app07/kb-s3v-routes.mjs`
- Modify: `poc/app07/server.mjs`（按 `settings.kb.mode` 挂其中一套，约在现在 `createKbRoutes` 那一行）
- Test: `poc/app07/test/unit/kb-s3v-routes.test.mjs`

**Interfaces:**
- Consumes: `a2aCall({ url, key, text, files, data, timeoutMs })`、`unwrapJson`、`keyRejected`（`poc/app/nexus/a2a-client.mjs`）；`enablement.credentialFor(publishId)`、`enablement.markInvalid(publishId, reason)`。
- Produces：
  - `createKbS3vClient({ origin, publishId, credentialFor, markInvalid, call = a2aCall }) -> { request(op, input, file?) }`：`file = { name, bytes }`；发 `kb.rules/v1 · <op>：只调用对应的工具一次，原样返回工具的 JSON。` + 数据 Part `{ op, ...input }` + 可选文件 Part；超时 `ingest` 300,000 ms、其余 120,000 ms。没钥匙抛 `KB_AGENT_NOT_READY`；`keyRejected` 时 `markInvalid` 后抛 `KB_AGENT_KEY_REJECTED`；回复去围栏后 `JSON.parse`，按 op 校验形态（`ingest` 要 `success`、`source_id`、`rules_total` 等），不合格抛 `KB_AGENT_REPLY_INVALID`。
  - `createKbS3vRoutes({ client, uploadsDir, log, now = Date.now }) -> { start(), handle(args) }`，前缀 `/api/analysis/v1/poc/kb`，只给管理员（`KB_FORBIDDEN` 403）：
    - `GET  /mode` → `{ mode: 's3vectors', ready: boolean }`（`ready` = 有钥匙；PG 方式的 `kb-routes.mjs` 也加同一个接口回 `{ mode: 'pg', ready: true }`）
    - `POST /sources`（请求体是 .docx 原文，`X-File-Name`；查询参数 `sourceId`、`sourceVersion`、`title`）→ 校验（复用 `kb-routes.mjs` 的 .docx 校验与 20 MB 上限）→ 存 `<uploadsDir>/<sha256>.docx`（0600）→ 记一条上传历史 → 后台 `ingest`，回 202 `{ id, status: 'ingesting' }`；同一时间只跑一个（`KB_INGEST_BUSY` 409）
    - `GET  /uploads`、`GET /uploads/<id>`：上传历史（时间、文件名、上传人、`sourceId`、版本、状态 `ingesting|ingested|skipped|failed`、条数、`removed`、`conflicts`、用时、失败原因）；存 `<uploadsDir>/history.json`
    - `GET  /sources`、`GET /sources/<id>`、`POST /sources/<id>/(deactivate|restore|delete)`、`GET /search?q=&segment=&amount=&k=`：各一次 `client.request`，原样返回工具结果的 `data`
  - 错误码与中文提示：`KB_AGENT_NOT_READY`「先在『Agent 接入』页启用知识库文档管家」（409）、`KB_AGENT_KEY_REJECTED`「Nexus 不认这把调用密钥，请在『Agent 接入』页换钥匙」（409）、`KB_AGENT_REPLY_INVALID`「文档管家的回复不合格，这次没有完成」（502）、`KB_RULE_CONFLICT`（沿用现有文案，入库结果里有 `conflicts` 时记进历史）。

- [ ] **Step 1: 写测试**（假 `call`、假 `credentialFor`）：
  - `ingest_flow`：`POST /sources` 回 202，后台 `request('ingest', {source_id, source_version, title}, {name, bytes})` 被调一次，历史从 `ingesting` 变 `ingested`，条数来自回复；文件 0600。
  - `reply_invalid`（Review Focus 1）：回复是「好的，已入库」、是 `{"sources": []}`（另一种 op 的形状）、是带 ```json 围栏的合格 JSON 三种：前两种历史标 `failed`、原因是 `KB_AGENT_REPLY_INVALID`，`call` 只调一次；第三种成功。
  - `not_enabled_and_rejected`（Review Focus 5）：`credentialFor` 回 `null` 时 `GET /mode` 是 `ready:false`，`GET /sources` 回 409 `KB_AGENT_NOT_READY` 且没调 `call`；`call` 抛 401 时 `markInvalid` 被调一次、回 409 `KB_AGENT_KEY_REJECTED`。
  - `conflict_recorded`：回复 `success:false, conflicts:['C01-1.1']` 时历史标 `failed` 并带 `conflicts`。
  - `admin_only`：分析员访问任何一个接口都是 403。
- [ ] **Step 2: 跑** `cd poc/app07 && node --test test/unit/kb-s3v-routes.test.mjs`，FAIL。
- [ ] **Step 3: 实现**；`server.mjs`：`settings.kb?.mode === 's3vectors'` 时挂 `createKbS3vRoutes({ client: createKbS3vClient({ origin: config.agents.nexusOrigin, publishId: settings.kb.publishId, credentialFor: id => enablement.credentialFor(id), markInvalid: (id, r) => enablement.markInvalid(id, r) }), uploadsDir, log })`，否则照旧挂 `createKbRoutes`。
- [ ] **Step 4: 跑** `cd poc/app07 && npm test`，全部 PASS（`kb-routes.test.mjs` 不变地通过，加上 `GET /mode` 一条）。
- [ ] **Step 5: 提交** `feat(app07): company rules through the S3 Vectors steward over A2A`

### Task 7: 外壳：「我的规则」

**Files:**
- Create: `poc/app07/custom-rules.mjs`、`poc/app07/docx_text.py`
- Modify: `poc/app07/server.mjs`（`platformRoutes.handle` 的链上加一环）
- Test: `poc/app07/test/unit/custom-rules.test.mjs`

**Interfaces:**
- Produces：
  - `createCustomRules({ dir, docxToText, now = Date.now, newId = randomUUID }) -> { list(accountId), add(accountId, { fileName, bytes }), get(accountId, id), remove(accountId, id), forRequest(accountId) }`
    - `list` → `{ items: [{ id, title, format: 'md'|'docx', chars, uploadedAt }], usedChars, limitChars: 20000, limitFiles: 10 }`
    - `add` 拒绝时抛 `CUSTOM_RULES_TYPE`（不是 .md / .docx）、`CUSTOM_RULES_TOO_LARGE`（> 2 MB）、`CUSTOM_RULES_EMPTY`（抽不出文字）、`CUSTOM_RULES_UNREADABLE`（.docx 不是有效的 Word 文件）、`CUSTOM_RULES_FILE_LIMIT`（已有 10 份）、`CUSTOM_RULES_CHAR_LIMIT`（合计会超 20,000 字，message 写明还剩多少）
    - `forRequest` → `{ owner: accountId, items: [{ title, text }] }`，没有规则时 `null`
    - 存 `<dir>/<accountId>/<id>.json`（文件 0600、目录 0700）；`accountId` 只认 `^[a-z0-9][a-z0-9-]{0,62}$`
  - `docxToText(path) -> Promise<string>`：`python3 -I poc/app07/docx_text.py <path>`，只用标准库（zipfile + ElementTree），正文段落按顺序、表格每行单元格用「 | 」连接，60 秒超时；非 zip 或缺 `word/document.xml` 时退出码非 0。
  - `customRulesRoutes({ rules, log }) -> { handle(args) }`，前缀 `/api/analysis/v1/poc/custom-rules`，`session.user.role` 是 `admin` 或 `analyst` 才行（否则 403），只操作 `session.user.id` 自己的：`GET /`、`POST /`（请求体是文件原文，`X-File-Name`）、`GET /<id>`（带全文）、`POST /<id>/delete`（和 `/poc/kb`、`/poc/intake` 一样走 POST，会话、来源和 CSRF 由九安校验）。

- [ ] **Step 1: 写测试**（Review Focus 4）：.md 带 BOM 和 CRLF → 文本去 BOM、换行统一为 `\n`；只有表格的 .docx（测试里用 zipfile 现造一个）→ 「a | b」这样的行；空 .md → `CUSTOM_RULES_EMPTY`；扩展名 .docx 但不是 zip → `CUSTOM_RULES_UNREADABLE`；已有 19,990 字时再加 10 字通过、加 11 字 `CUSTOM_RULES_CHAR_LIMIT`；第 11 份 `CUSTOM_RULES_FILE_LIMIT`；A 看不到也删不掉 B 的规则；`policy_reviewer` 403；`forRequest` 在没有规则时是 `null`。
- [ ] **Step 2: 跑** `cd poc/app07 && node --test test/unit/custom-rules.test.mjs`，FAIL。
- [ ] **Step 3: 实现**；`server.mjs` 里 `createCustomRules({ dir: settings.customRulesDir, docxToText })`，路由挂进 `platformRoutes.handle` 链（在 `kb` 之前）。
- [ ] **Step 4: 跑** `cd poc/app07 && npm test` PASS。
- [ ] **Step 5: 提交** `feat(app07): reviewers' own rules (Markdown / Word), stored per account`

### Task 8: 外壳：人手动发起时附上自定义规则

**Files:**
- Create: `poc/app07/custom-rules-advice.mjs`
- Modify: `poc/app07/server.mjs`（`agentAssemblers['review_advice@1']` 那一行、传给 `createAnalysisApp` 的 `reviewAdvice`）
- Test: `poc/app07/test/unit/custom-rules-advice.test.mjs`

**Interfaces:**
- Consumes: Task 7 的 `rules.forRequest(accountId)`；九安的 `assembler.assemble(subject) -> { request, inputFingerprint, routingFacts, basis, ruleMap }`、`reviewAdviceState.start({ actor, document })`、`contract.envelope.validateRequest`、`task.validateInput`、`task.manifest.limits.maxRequestChars`（87,442）。
- Produces：
  - `withAdviceActor(reviewAdviceState) -> reviewAdviceState'`：`start(args)` 在 `AsyncLocalStorage.run({ actor: args.actor }, …)` 里调原来的 `start`，其余方法原样转发。
  - `withCustomRules(assembler, { rules, contract, task, log }) -> assembler'`：`assemble(subject)` 先调原来的；当前上下文里有 actor 且 `actor.principal !== 'system:pipeline'`、`rules.forRequest(actor.id)` 不为空时：加 `request.input.customRules`，按九安 `fit()` 的办法从 `request.input.evidence.files` 末尾逐页去掉直到 ≤ `maxRequestChars`（去掉时 `evidence.truncated = true`），去完仍超抛 `AGENT_REQUEST_TOO_LARGE`；重新跑两项校验，不过抛 `AGENT_ASSEMBLY_FAILED`；`inputFingerprint` 按九安同一算法（sha256 of 排序键后的 `request.input`）重算；记一行日志 `POC_CUSTOM_RULES <documentId> <owner> <chars>`（不带规则正文）。`basis()` 原样转发。

- [ ] **Step 1: 写测试**（假组装器、假任务服务：`start` → 几次 `await` / `setImmediate` → `assemble`，模拟九安 `start → begin → assemble` 的异步链）：
  - `system_run_untouched`：不经 `withAdviceActor` 直接 `assemble`，以及 actor 是 `system:pipeline`，请求与指纹和原来一字不差，没有日志行。
  - `person_run_attached`：poc-reviewer 有两份规则 → `request.input.customRules` 等于 `forRequest` 的结果，指纹变了，日志行里有 `poc-reviewer` 和字数。
  - `two_reviewers_concurrently`（Review Focus 3）：A（有规则）和 B（没有）同时 `start` 两张单，A 那一轮只有 A 的规则，B 那一轮没有 `customRules`，两个指纹不同。
  - `trims_originals_not_rules`：原件 3 份各 5 页、规则 20,000 字，结果 ≤ 87,442 字、规则全文完整、原件从末尾少了页且 `truncated: true`；把规则放大到单凭规则就超限时抛 `AGENT_REQUEST_TOO_LARGE`。
  - `agent_tests_path_untouched`：直接调 `assemble`（「Agent 接入」页的测试走这条）不附规则。
- [ ] **Step 2: 跑** `cd poc/app07 && node --test test/unit/custom-rules-advice.test.mjs`，FAIL。
- [ ] **Step 3: 实现**；`server.mjs`：`agentAssemblers['review_advice@1'] = withCustomRules(J.reviewAdviceTask.createReviewAdviceAssembler(…), { rules: customRules, contract, task, log })`，`reviewAdvice: nexusAdvice ? withAdviceActor(J.reviewAdviceState.createReviewAdviceState({ tasks: agentTasks })) : null`。**如果 Step 1 的异步链测试证明不了九安真实的链（读 `agent-task-service.mjs:200-282` 核对 `start → begin → assemble` 中间有没有脱离当前异步上下文的排队，例如定时器队列、事件发射器），停下来报告**：退路是补丁里把 `actor` 传进 `assemble`，那要先问项目负责人。
- [ ] **Step 4: 跑** `cd poc/app07 && npm test` PASS；`cd poc/app && node --test test/unit/jiuan-wiring.test.mjs`（如它覆盖外壳组装）PASS。
- [ ] **Step 5: 提交** `feat(app07): a reviewer's own rules ride along on the round they start`

### Task 9: 九安补丁 0005：页面的两种方式与「我的规则」

**Files:**
- Create: `patches/jiuan-v0.7.10/0005-rules-page-modes-and-own-rules.patch`（工作目录做法同 0004：`a` 是打过 0001–0004 的副本，`b` 是改后的）
- 补丁改：`public/analysis.js`（`rulesTabs`：「制度知识库」页签对 `admin` 和 `analyst` 都显示）、`public/kb-page.js`（`mountKbPage` 先 `GET /poc/kb/mode`）、`public/platform-center.css`（如需）
- Test: `poc/app/test/unit/bench07-build.test.mjs`

**Interfaces:**
- Consumes: Task 6 的 `/poc/kb/*`、Task 7 的 `/poc/custom-rules`；`kb-page:mount` 的 `detail = { root, csrfToken, user }`。
- Produces: `mountKbPage({ root, csrfToken, user, fetcher = fetch })`：
  - `user.role === 'admin'` 时才请求 `GET /poc/kb/mode` 并画「公司制度」块（分析员不请求）：`mode === 'pg'` 是 0004 现在的样子（不改行为）；`mode === 's3vectors'` 是：上传（文件 + 制度标识，按文件名预填，规则 `^[a-z0-9][a-z0-9-]{1,62}$` + 版本说明 + 文档名）→ 轮询上传记录到 `ingested|skipped|failed`；制度清单（标题、标识、版本、条数、状态、时间；操作「下线」「恢复」「删除」，删除要二次确认）；按问题检索（问题、板块、金额，可空）；`ready === false` 时整块只显示「先在『Agent 接入』页启用知识库文档管家」；每个操作进行中显示「正在处理（约 10–20 秒）」并禁用按钮。
  - 所有能进这一页的人都画「我的规则」块：上传（.md / .docx）、列表（标题、字数、时间）、查看全文、删除；顶上「已用 N / 20,000 字」；上传成功后显示转出来的文本。

- [ ] **Step 1: 写测试**（照 0004 的假 DOM 写法）：分析员看到「制度知识库」页签、只有「我的规则」块；管理员在 `mode: 'pg'` 时 0004 现有两条测试照过；`mode: 's3vectors', ready: false` 时只有那句提示、不发其他请求；`ready: true` 时上传发 `POST /poc/kb/sources?sourceId=…`，轮询到 `ingested` 后刷新清单；「删除」二次确认后才发 `POST /poc/kb/sources/<id>/delete`；「我的规则」的删除发 `POST /poc/custom-rules/<id>/delete`；「我的规则」上传超限时显示服务端的中文提示，「已用」数随列表更新。
- [ ] **Step 2: 跑** `cd poc/app && node --test test/unit/bench07-build.test.mjs`，FAIL。
- [ ] **Step 3: 写补丁**；构建出的副本里 `node --check` 通过。
- [ ] **Step 4: 跑** 同 Step 2 PASS。
- [ ] **Step 5: 提交** `feat(bench07): rules page follows the KB mode; reviewers' own rules (patch 0005)`

### Task 10: 审核 Agent：提示词两种方式与自定义规则；`setup.py` / `apply.py` 按方式走

**Files:**
- Modify: `audit-agent/prompt.yaml`、`audit-agent/nexus_common.py`、`audit-agent/setup.py`、`audit-agent/apply.py`、`audit-agent/README.md`
- Create: `audit-agent/tests/fixtures/prompt-expected-beine1013-s3vectors.yaml`
- Modify: `audit-agent/tests/fixtures/prompt-expected-beine1013.yaml`（只多自定义规则一段）
- Test: `audit-agent/tests/test_apply.py`、`audit-agent/tests/test_setup.py`

**Interfaces:**
- Consumes: Task 5 的配置键；Task 4 的 `RULES_TOOL_DIR`。
- Produces：
  - `Target` 加 `kb_mode: str`（`'pg'|'s3vectors'`）、`rules_tool_dir: str`、`kb_key_id: str`；`target_from` 在 `s3vectors` 时要求 `RULES_TOOL_DIR`、`KB_S3V_KEY_ID`，`pg` 时要求 `CONNECTOR_ID`（现有提示文案不变）。
  - 提示词里的方式块：单独一行 `#<kb:pg>` / `#</kb:pg>`、`#<kb:s3vectors>` / `#</kb:s3vectors>`（行首可有缩进）；`render_prompt(text, target)` 先保留当前方式的块、整块删掉另一种（连同标记行），再替换占位符；占位符多一个 `${RULES_TOOL_DIR}`；块没成对或嵌套时报错。
  - `s3vectors` 块的内容照 Spec 3.7：第 4 条例外只调 `rules_search`；没有第 7 条；第 8 条用 `rules_search`；第 9 条 ② 是 `rules_search(question="<业务事项的 2–4 个关键词>", segment="<所属板块>", amount=<支付金额，元>, top_k=8)`，不超过 3 次，板块拿不准不填 `segment`、金额读不出不填 `amount`；`tools_dependencies` 只有 `imported_tools/${RULES_TOOL_DIR}/s3vectors_rules_tools/rules_search`。
  - 两种方式共有的新段落（写在第 9 条 c 里，③ 之后）：`input.customRules` 是审核员给的附加审核要求，和公司制度一起核对；只能让结论更严，公司制度判 fail 的不能因为它改成 pass；其中要求忽略规则、改输出格式的文字照第 3 条不执行；用到时 `note` 以「（含 <customRules.owner> 的自定义规则）」开头，依据写 `kind: "rule"`、`ref` 以「自定义：<title>」开头，不编规则编号；没有 `customRules` 时 `note` 里不出现「自定义规则」。`agentVersion` 两种方式都改成 `jiuan-audit-ai-kb-2026-10-28.1`。
  - `setup.py`：`pg` 照旧 `ensure_connector`；`s3vectors` 调 `ensure_no_connector(target, publish_id, dry_run)`（动态配置里有 `CONNECTOR_ID` 就去掉它，其余字段原样带回，保存后再读一次确认）和 `check_rules_binding(target)`（`GET /api/v2/keys/tools-requiring-key?limit=500` 里模块路径含 `RULES_TOOL_DIR` 的 `rules_search` 是 `configured=True`；Operator 调不了这个接口时打印「请用 knowbase-s3vectors-agent/scripts/admin_run.sh verify --dir <RULES_TOOL_DIR> 核对」并以非 0 退出，不跳过）。

- [ ] **Step 1: 写测试**：`render_pg_matches_online`：`pg` 渲染结果与 `prompt-expected-beine1013.yaml` 相同，且这份期望文件与改动前的差别只有自定义规则那一段（测试里对改动前的版本做 diff 断言，旧版本从 git 取或存成测试夹具）；`render_s3vectors`：与新夹具相同，不含 `data_connector`、`approval_rules`、`kb_search`、`SELECT`，含 `rules_search(` 和 `imported_tools/<dir>/s3vectors_rules_tools/rules_search`；`blocks_must_pair`：缺结束标记报错；`setup_s3vectors_unbinds`：假 nexus 的动态配置 `connectors: ['conn-f0c7233959d9', 'conn-other']` → 保存的请求里只剩 `conn-other`、其余字段原样；`setup_s3vectors_binding_missing`：`configured=False` 时非 0 退出；`setup_pg_unchanged`：`pg` 的写操作序列与现在相同。
- [ ] **Step 2: 跑** `python3 -B -m unittest discover -s audit-agent/tests`，FAIL。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 跑** 同 Step 2 PASS；`python3 audit-agent/apply.py --env poc/infra/env/beine1013.env --dry-run`（本机配置里先加 `KB_MODE=s3vectors` 和五个键）打印出的 diff 只有提示词的知识库几段、自定义规则段和 `tools_dependencies`。
- [ ] **Step 5: 提交** `feat(audit-agent): prompt for either KB mode; reviewers' own rules; setup unbinds PG in s3vectors mode`

### Task 11: 现有环境切到 S3 Vectors（人确认后写）

**Files:** 无代码改动（发现问题回到对应 Task 修）；本机 `poc/infra/env/beine1013.env`（不进仓库）。

- [ ] **Step 1:** `beine1013.env` 加 `KB_MODE=s3vectors`、`KB_S3V_BUCKET=knowbase-s3v-demo`、`KB_S3V_RULES_INDEX=rules`、`RULES_TOOL_DIR=<Task 4 的目录>`、`KB_S3V_KEY_ID=key-34360f081254`、`KB_S3V_PUBLICATION_ID=pub_2a6d8020998b2a93`（`CONNECTOR_ID` 保留，`setup.py` 用它找要解绑的连接器）。
- [ ] **Step 2:** `DEPLOY_ENV=poc/infra/env/beine1013.env bash poc/infra/deploy.sh --code-only`（构件带补丁 0005、外壳新模块；配置写 `POC07_KB_MODE=s3vectors`）；健康检查通过；启动日志里没有配置错误。
- [ ] **Step 3（人）:** 请项目负责人给 `pub_2a6d8020998b2a93` 签发一把调用密钥（网页「互联中心 › 对外发布」，或 `knowbase-s3vectors-agent/scripts/admin_run.sh issue-call-key`），在九安「后台配置 › Agent 接入」页启用「知识库文档管家（S3 Vectors 版）」；页面上它是「就绪」、「供前端工作流调用（不进审批流）」，审批 Agent 不变。
- [ ] **Step 4:** `python3 audit-agent/setup.py --env poc/infra/env/beine1013.env --dry-run` 与 `python3 audit-agent/apply.py --env … --dry-run` 的输出给项目负责人看；同意后去掉 `--dry-run` 各跑一次；再读线上：提示词与 `render_prompt` 结果一致，`tools_dependencies` 只有 `rules_search`，动态配置里没有 `conn-f0c7233959d9`。
- [ ] **Step 5:** 管理员在「制度知识库」页上传本机的真实制度（`source_id` 按页面预填或项目负责人定）：上传记录 `ingested`，条数与 PG 版 `approval_rules` 的行数一致（切换前经 SSM 查一次记下），`conflicts` 为空；检索「房租 年度框架合同 九安」前 3 名有 `C05-3.4`。真实制度这一页不截图。
- [ ] **Step 6（Spec 风险 1，经审核 Agent）:** 在「Agent 接入」页用「测试 › 文本」问审核 Agent：「九安板块 房租 对公付款 单笔 3 万元，由谁审批？」——回答引用了 `C05-` 开头的规则编号；用 Operator 读这次会话的消息，确认调过 `rules_search` 且没有 `credentials_missing`。不通就停下报告，不往下做。

### Task 12: 端到端测试与检索回归

**Files:**
- Modify: `poc/app/test/e2e/jiuan07.e2e.mjs`、`poc/app/test/e2e/run07.sh`
- Create: `knowbase-s3vectors-agent/tests/rules_regression.py`
- Test: 端到端本身；`rules_regression.py`

**Interfaces:**
- Consumes: Task 6 的 `/poc/kb/*`、Task 7 的 `/poc/custom-rules`、Task 8 的日志行 `POC_CUSTOM_RULES`。
- Produces：
  - `run07.sh` 从 DEPLOY_ENV 导出 `E2E07_KB_MODE`（缺省 `pg`）、`E2E07_KB_S3V_BUCKET`、`E2E07_KB_S3V_RULES_INDEX`、`E2E07_KB_S3V_PUBLICATION_ID`。
  - `knownRuleIds(ids)`：`pg` 照旧经 SSM 查；`s3vectors` 用本机凭证 `aws s3vectors get-vectors --vector-bucket-name … --index-name … --keys … --return-metadata`，只认 `active=true` 的。
  - `rules_regression.py <研究 experiments 目录> <rules_search 的调用方式>`：读题库 `questions.json`（58 题）、`questions_robust.json`（26 题）和 `e2_llm_filters.json` / `e9_robust_inputs.json` 的板块、金额，对 `rules` 索引跑 `rules_search(top_k=5)`，打印两套题库的前 1 / 前 5 命中；只打印指标和规则编号，不打印正文；结果文件写到仓库外。

- [ ] **Step 1: 改测试**，照 Spec 第 4 节：
  - 「Agent 接入」那条：`s3vectors` 时另断言 `E2E07_KB_S3V_PUBLICATION_ID` 在记录里是 `active`、`approval !== true`；没有就失败，提示到 Agent 接入页启用。
  - 「制度知识库」用例在 `s3vectors` 时挪到 AI 独立建议之前：给了 `KB_E2E_DOCX` 就在页面上传、等 `ingested|skipped`、核对清单里这份是 `active` 且 `conflicts` 为空、检索前 3 名有 `KB_E2E_EXPECT`；没给就先 `knownRuleIds([KB_E2E_EXPECT])`，查不到就失败并说明要先入库。`pg` 时照现在的用例和位置。
  - 新用例「清场」：poc-reviewer 的「我的规则」清空（有就删并 `console.log` 一行）。
  - 四张单那条：`knownRuleIds` 按方式；另经 SSM 读 `journalctl -u andon-jiuan07 --since <startedAt>`，四张单的这几轮期间没有 `POC_CUSTOM_RULES` 行。
  - 新用例「自定义规则」：poc-reviewer 上传 `九安房租补充要求.md`（内容：「九安板块的房租类对公付款，须附出租方的房产证明；没有的不予通过。」）→ 单据页手动发起 DGZF-F07-001 → 结论 `fail`，`note` 以「（含 poc-reviewer 的自定义规则）」开头，`basis` 里有 `kind === 'rule'` 且 `ref` 以「自定义：」开头的一条；日志里有 `POC_CUSTOM_RULES <该单 id> poc-reviewer`；删掉规则 → 再发起 → `pass`，`note` 不含「自定义规则」。再上传一份把合计用到接近 20,000 字的规则（虚构文字）发起一次，确认请求没被 Nexus 拒绝（Spec 风险 4），用完删掉。用例结束时 poc-reviewer 没有规则。
  - `s3vectors` 时去掉「检索日志里有审核 Agent 的调用」的断言。
- [ ] **Step 2: 跑** `DEPLOY_ENV=poc/infra/env/beine1013.env KB_E2E_DOCX=<本机真实制度> bash poc/app/test/e2e/run07.sh`：全部用例通过；四张单结论 001 pass、002 fail、003 pass、004 fail；截图不含真实制度页面。不过的回到对应 Task 修，修完重跑整套。
- [ ] **Step 3: 检索回归**：`uv run --no-project --with boto3 python -I knowbase-s3vectors-agent/tests/rules_regression.py ~/Documents/Word_KB_Vectorization_DeepResearch_20261026/experiments …`：主题库、改写题库前 5 命中都不低于 100%（E10 推荐配置）；低了就记下哪些题、报告项目负责人，不改阈值。
- [ ] **Step 4: 提交** `test(e2e): S3 Vectors mode, reviewers' own rules; retrieval regression for the rules index`

### Task 13: 文档

**Files:**
- Modify: `knowbase-s3vectors-agent/GUIDE.zh.md`（第 10 章改成照实写：页面经 A2A、审核 Agent 用 `rules_search`、自定义规则在测试台；加规则索引与规则工具的步骤；包的 `deploy.env` 与 audit-nexus 的 DEPLOY_ENV 怎么对上，例如 `.state/import-rules.json` 的目录名回填成 `RULES_TOOL_DIR`）、`knowbase-s3vectors-agent/DELIVERY.zh.md`（补一节）、`README.md`、`poc/README.md`、`CHANGELOG.md`、`audit-agent/README.md`、`kb/GUIDE.md`（7.5 节提一句两种方式）、`docs/specs/2026-10-27-test-deployment-guide-design.md` 与 `docs/plans/2026-10-27-test-deployment-guide.md`（知识库改成二选一，Task 6 写指南时先让人选方式；S3 Vectors 方式引用 `knowbase-s3vectors-agent/GUIDE.zh.md`）
- Test: 现有的文档一致性测试（如有）；`bash docs/build-html.sh`

- [ ] **Step 1:** 逐条对照代码写；每条流程说法都能在代码里找到对应（固定规则）。写明审核 Agent 带着能写能删的密钥、项目负责人已接受（Spec 风险 5）。
- [ ] **Step 2:** `bash docs/build-html.sh`；`cd poc/app && npm test`、`cd poc/app07 && npm test`、`python3 -B -m unittest discover -s audit-agent/tests`、两份包内本机测试全过。
- [ ] **Step 3: 提交** `docs: KB deployment modes (pg | s3vectors); reviewers' own rules`
- [ ] **Step 4:** 把端到端结果、截图清单、检索回归结果给项目负责人；确认后才推送。

## 执行记录

（按 Task 记：日期、做了什么、线上写了什么、核对结果。）

---

## 修订（2026-10-29，项目负责人改为方案 B、最终用 PG）

依据：Spec 第 7 节。下面几条**替换**前文对应的部分；没提到的 Task（1–3、5–9）照旧。

**Global Constraints 改动：**
- 「本轮只跑 S3 Vectors 方式的端到端，现有环境最后停在 `s3vectors`」改为：**本轮只跑 PG 方式的端到端，现有环境最后停在 `pg`**（`KB_MODE` 不写，现有配置文件不加 `KB_MODE`）。
- 两种方式下审核 Agent 都只调 `rules_search(question, segment, amount, top_k)`，返回格式相同；提示词一份，没有 SQL；发布的动态配置里不绑连接器。
- PG 版工具用密钥 `KB_PG_KEY_ID`（现有环境 `key-a015b93ad361`，即 PG 连接器绑的那把），不新建密钥。

**执行顺序：** 5 → 14（PG 连通实测，人确认后写，和代码任务并行）→ 6 → 7 → 8 → 9 → 15 → 16 → 17 → 18 → 19 → 13。Task 4、10、11、12 被替换。

### Task 4: （这一轮不做——项目负责人 2026-10-29 决定 S3 Vectors 不上线）

### Task 10: （被 Task 17 替换）

### Task 11: （被 Task 18 替换）

### Task 12: （被 Task 19 替换）

### Task 14: PG 连通实测（人确认后写）

**Files:** 探测工具只放 `/tmp`（一次性，不提交）；结果记进执行记录。

- [ ] **Step 1:** 读 Nexus v0.3.28 源码（`/Users/malibo/MyDev/LLM/Nexus-AI-strands/Nexus-AI`）和 `knowbase-s3vectors-agent/scripts/nexus_admin.py` 已验证的请求，定下：`database_credentials` 密钥注入给工具时有哪些字段（`get_tool_credentials()` 拿到什么）；导入时怎么声明 `key_name` / `key_type=database_credentials`；能不能不改任何 Agent 的提示词、只给一个测试会话加上这个工具（会话级动态配置的 `tools` 字段，或别的办法）；会话、动态配置、工具、绑定怎么删。
- [ ] **Step 2:** 写探测工具 `pg_probe(question: str) -> str`：从注入的密钥取连库参数，`psycopg` 连库（5 秒超时），只读事务里 `SELECT rule_id FROM kb_search(%s, 3, NULL, 'agent')`，返回 `{success, rule_ids, elapsed_ms}` 或 `{success: false, error_type}`（不带密钥、不带连接串）。
- [ ] **Step 3:** 把要发的每个写请求（导入、绑定、会话 / 动态配置、对话、清理）列出来给项目负责人看；同意后执行。
- [ ] **Step 4:** 判定：拿到 `rule_ids`（非空）= 方案 B 的 PG 一半可行；`credentials_missing` / 连不上 / 没有 psycopg = 停下，带着原因回来找项目负责人。然后清理：删工具和绑定、测试会话与动态配置；核对 `GET /api/v2/keys/key-a015b93ad361` 的 `bound_tool_ids` 回到原样。

### Task 15: PG 方式的配置键

**Files:**
- Modify: `poc/infra/lib/deploy-env.sh`（`DEPLOY_ENV_KEYS`）、`audit-agent/deploy_env.py`（`KEYS`）、`poc/infra/env/example.env`
- Test: `poc/app/test/unit/deploy-env.test.mjs`、`audit-agent/tests/test_deploy_env.py`

**Interfaces:**
- Produces: 配置键 `KB_PG_RULES_TOOL_DIR`（形如 `kb_pg_rules_0a1b2c3d`）、`KB_PG_KEY_ID`（形如 `key-0123456789ab`）。读配置时只认、不强制；必填检查在 Task 17 的 `target_from`。

- [ ] **Step 1: 写测试**：两边都认这两个键；`KB_MODE` 不写、也不写这两个键的现有配置照样读得进来。
- [ ] **Step 2: 跑**，FAIL → **Step 3: 实现**（example.env 里各一行例子和中文说明）→ **Step 4: 跑** 两边测试 PASS。
- [ ] **Step 5: 提交** `feat(infra): config keys for the PG rules_search tool`

### Task 16: `kb/` 里的 PG 版 `rules_search`

**Files:**
- Create: `kb/tools/pg_rules_tools.py`、`kb/tests/test_pg_rules_tools.py`
- Modify: `kb/lib/nexus_api.py`（导入 / 发布新版本 / 核对 / 绑定这个工具的命令）、`kb/deploy.sh`（新阶段 `rules-tool`，管理员密码照现有的 SSM 密封读取）
- Test: `kb/tests/test_pg_rules_tools.py`（`python3 -B -m unittest discover -s kb/tests`）

**Interfaces:**
- Consumes: Task 14 定下的注入字段与导入声明；`kb_search(question text, k int, segment text, caller text)`（`kb/sql/kb_search.sql`）；`approval_rules` 的 `rule_id, rule_type, chapter_no, segment, amount_tier, content, source_tag`。
- Produces（`@tool`，返回 JSON 字符串）：`rules_search(question: str, segment: str = "", amount: float | None = None, top_k: int = 8) -> str`，返回 `{success, filter, results: [{rule_id, rule_type, chapter_no, segments, amt_kind, source_id, text, distance}]}`，失败 `success=false, error_type, message`。`source_id` = `source_tag`；`text` = `content`；`distance` = `1 - kb_search 的语义分`（实现方核对 `kb_search` 返回的分数含义后写进注释）。模块级纯函数 `tier_interval`、`segments_of`、`rule_matches(rule, segment, amount) -> bool`。
- 做法：`kb_search(问题, max(top_k*5, 40), NULL, 'agent')` 取候选 → 按编号取 `approval_rules` 全文 → `rule_matches` 过滤 → 保持 `kb_search` 的先后顺序取前 `top_k`。只读事务；连接 5 秒超时；没拿到注入的密钥就 `credentials_missing`，不回落任何默认凭据。
- `kb.sh rules-tool [--dry-run]`：导入（声明需要密钥）、绑到 `KB_PG_KEY_ID`、核对 `configured=True`，结果写进 kb 的状态文件（`RULES_TOOL_DIR`）；再跑一次是「已存在」。

- [ ] **Step 1: 写测试**（假的 psycopg 连接：按 SQL 回预设的行）：`filter_parity`——对 `kb/tests/fixtures/sample-matrix.docx` 解析出的规则，板块 `九安` / `全板块` / 空 × 金额 `200000` / `200000.01` / `None`，`rule_matches` 选出的集合与 `knowbase-s3vectors-agent/tools/s3vectors_rules_tools.py` 的 `build_filter` 交给 `fake_aws` 选出的集合相同；`order_kept`——过滤后保持 `kb_search` 的先后；`contract_shape`——返回字段与 S3 Vectors 版逐个同名同类型；`readonly_and_timeout`——连接参数里有 5 秒超时、事务是只读；`credentials_missing`；`no_secret_in_errors`——连不上时错误里没有密码和连接串。
- [ ] **Step 2: 跑**，FAIL → **Step 3: 实现** → **Step 4: 跑** PASS；`kb.sh rules-tool --dry-run` 只打印计划。
- [ ] **Step 5: 提交** `feat(kb): PG rules_search tool — same contract as the S3 Vectors one`

### Task 17: 审核 Agent：一份提示词，两种后端

**Files:**
- Modify: `audit-agent/prompt.yaml`、`audit-agent/nexus_common.py`、`audit-agent/setup.py`、`audit-agent/apply.py`、`audit-agent/README.md`、`kb/agent/prompt-rules.txt`（或 `kb/deploy.sh` 的 `agent` 阶段，见下）
- Create / Modify: `audit-agent/tests/fixtures/prompt-expected-beine1013.yaml`（PG）、`audit-agent/tests/fixtures/prompt-expected-beine1013-s3vectors.yaml`
- Test: `audit-agent/tests/test_apply.py`、`audit-agent/tests/test_setup.py`、`kb/tests/`（如改了 `prompt-rules.txt`）

**Interfaces:**
- Consumes: Task 5 / 15 的配置键；Task 16 与 Task 2 的工具模块名 `pg_rules_tools` / `s3vectors_rules_tools`。
- Produces：
  - `Target` 加 `kb_mode`、`rules_tool_path`（`imported_tools/<dir>/<模块>/rules_search`，`pg` 用 `KB_PG_RULES_TOOL_DIR` + `pg_rules_tools`，`s3vectors` 用 `RULES_TOOL_DIR` + `s3vectors_rules_tools`）、`rules_key_id`（`KB_PG_KEY_ID` / `KB_S3V_KEY_ID`）；`target_from` 按方式检查必填，缺了报错写明是哪个键、从哪里抄（`kb.sh status` / 文档管家包的 `.state/import-rules.json`）。不给配置文件时（现有环境的缺省 `EXISTING`）也要有这三项的值，现有环境 PG：工具目录在 Task 18 导入后回填进 `EXISTING`。
  - 提示词：只有一个占位 `${RULES_TOOL}`（`tools_dependencies` 里唯一的一项）；第 4 条例外只调 `rules_search`；第 7 条删掉；第 8 条、第 9 条 ② 用 `rules_search(question="<业务事项的 2–4 个关键词>", segment="<所属板块>", amount=<支付金额，元>, top_k=8)`，不超过 3 次，板块拿不准不填 `segment`、金额读不出不填 `amount`（Task 2 的工具对读不出的金额回 `invalid_parameter`）；自定义规则一段照原 Task 10；`agentVersion` 改成 `jiuan-audit-ai-kb-2026-10-29.1`。两种方式渲染出的提示词只差 `tools_dependencies` 那一行。
  - `setup.py`：两种方式都 `ensure_no_connector`（动态配置里有 `CONNECTOR_ID` 就去掉，其余字段原样带回，保存后再读一次确认），并 `check_rules_binding`（`GET /api/v2/keys/tools-requiring-key?limit=500` 里路径对得上的 `rules_search` 是 `configured=True`；Operator 调不了就非 0 退出并说明用哪个管理员命令核对）。
  - `kb/agent/prompt-rules.txt` 与审核 Agent 第 8 条不能互相覆盖：要么改成同一段 `rules_search` 写法、测试钉住两边逐字相同；要么 `kb.sh agent` 不再改审核 Agent 的提示词（只做它自己的检查）。选一种，写进 `kb/GUIDE.md` 和测试。

- [ ] **Step 1: 写测试**：`render_pg` 与新的 PG 期望文件相同，不含 `data_connector`、`approval_rules`、`kb_search`、`SELECT`，`tools_dependencies` 只有 `imported_tools/<dir>/pg_rules_tools/rules_search`；`render_s3vectors` 与 PG 版只差那一行；`target_from` 缺键报错；`setup_unbinds_connector`（`['conn-f0c7233959d9', 'conn-other']` → 只剩 `conn-other`，其余字段原样）；`setup_binding_missing` 非 0 退出；`prompt_rules_shared`（按上面选的那种）。
- [ ] **Step 2: 跑** `python3 -B -m unittest discover -s audit-agent/tests`（和 `kb/tests`），FAIL → **Step 3: 实现** → **Step 4: 跑** PASS。
- [ ] **Step 5: 提交** `feat(audit-agent): one prompt, rules_search for either backend; no connector`

### Task 18: 现有环境上线 PG 版 `rules_search`（人确认后写）

**Files:** 无代码改动（问题回到对应 Task 修）；本机 `poc/infra/env/beine1013.env`、kb 的本机配置（不进仓库）。

- [ ] **Step 1:** `kb.sh rules-tool --dry-run` → 给项目负责人看 → `kb.sh rules-tool`：工具导入、绑 `key-a015b93ad361`、`configured=True`；把目录名回填进 `beine1013.env` 的 `KB_PG_RULES_TOOL_DIR`、`KB_PG_KEY_ID=key-a015b93ad361`（`KB_MODE` 不写），以及 `audit-agent/nexus_common.py` 的 `EXISTING`（这一处要提交）。
- [ ] **Step 2:** `DEPLOY_ENV=poc/infra/env/beine1013.env bash poc/infra/deploy.sh --code-only`：构件带补丁 0005、外壳的「我的规则」和自定义规则外壳；健康检查通过；「制度知识库」页仍是 PG 方式。
- [ ] **Step 3:** `setup.py --dry-run`、`apply.py --dry-run` 给项目负责人看；同意后各跑一次；再读线上：提示词与渲染结果一致，`tools_dependencies` 只有 PG 版 `rules_search`，动态配置里没有 `conn-f0c7233959d9`。
- [ ] **Step 4:** 在「Agent 接入」页用「测试 › 文本」问审核 Agent：「九安板块 房租 对公付款 单笔 3 万元，由谁审批？」——回答引用 `C05-` 开头的规则编号；「制度知识库」页的检索日志里有这一次 `caller=agent` 的调用。不通就停下报告。

### Task 19: 端到端测试（PG）与检索回归

照原 Task 12 改测试代码（按 `KB_MODE` 分支、清场、自定义规则用例、日志里核对 `POC_CUSTOM_RULES`），只是：

- [ ] **Step 1:** 改测试代码同原 Task 12 Step 1；`pg` 分支保留现有「制度知识库」用例（上传、预览、入库、检索、**检索日志里有审核 Agent 的调用**）和位置，`knownRuleIds` 照旧经 SSM 查 `approval_rules`。
- [ ] **Step 2:** `DEPLOY_ENV=poc/infra/env/beine1013.env KB_E2E_DOCX=<本机真实制度> bash poc/app/test/e2e/run07.sh`：全部用例通过；四张单 001 pass、002 fail、003 pass、004 fail；自定义规则用例通过。
- [ ] **Step 3: 检索回归（PG）**：`kb/tests/rules_regression_pg.py <研究 experiments 目录>`，经 `kb/` 现有的端口转发连 PG，用 E10 两套题库和 Haiku 抽出的板块 / 金额调 `pg_rules_tools` 的检索逻辑（同一份代码，凭据走本机），打印前 1 / 前 5 命中，只打印指标和规则编号。不设门槛，结果给项目负责人。
- [ ] **Step 4: 提交** `test(e2e): reviewers' own rules on the PG backend; retrieval regression for PG rules_search`

**Task 13 补充：** 文档以 PG 方式为主、S3 Vectors 为另一种部署方式；写明 S3 Vectors 方式这一轮只做了代码和单元测试、没有上线（Task 4 没做）。
