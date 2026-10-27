# 制度知识库：上传入库、历史、库内语义检索 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 九安 v0.7.10「规则库 › 制度知识库」页上传审批矩阵 .docx，解析、预览、确认后向量化写进 PG；看上传历史和检索日志；审核 Agent 经现有 Nexus 连接器用 `kb_search(问题)` 做库内语义检索。

**Architecture:** 向量只在 PG 里生成：现有容器 `nexus-pgvector` 里就地装 PL/Python，`kb_embed()` 调 Bedrock Titan v2，入库和检索共用它。外壳 `poc/app07` 收文件、起 Python 子进程（`kb/lib` 的解析器、入库、管理命令），不碰 AWS 凭证。九安一侧只加补丁 0004（页签 + 页面模块）。

**Tech Stack:** Node 24（外壳、九安补丁），Python 3.9（测试台）/ 3.14（本机）+ psycopg 3.2.9，PostgreSQL 17 + pgvector 0.8.7 + plpython3u，Bedrock `amazon.titan-embed-text-v2:0`。

**Spec:** `docs/specs/2026-10-26-kb-upload-semantic-search-design.md`

## Global Constraints

- 制度原文（`docs/sample-docs/`、`kb-test-docs/` 里的真实 .docx）和从它派生的东西不进仓库、交付包、日志；单元测试只用仿真文档 `kb/tests/fixtures/sample-matrix.docx`。
- 向量：`amazon.titan-embed-text-v2:0`，`{"inputText", "dimensions": 1024, "normalize": true}`，区域 us-east-1；和现有 102 行一致。
- `kb_search(question text, k int DEFAULT 8, segment text DEFAULT NULL, caller text DEFAULT 'agent')`：`k` 夹在 1–20；问题 ≤ 2000 字；每分钟最多 60 次；返回 `rule_id, rule_type, chapter, business_item, segment, amount_tier, approval_path_text, final_approver, scope_controls, score`。
- 上传：只收 .docx（后缀、`Content-Type` 和 zip 文件头都要对），≤ 20 MB，zip 条目 ≤ 2000，解压后 ≤ 100 MB；只给管理员；同一时间只跑一个入库。
- 密码：PG 应用用户的密码只在 PG 主机 `.env` 和 `/etc/andon-finance/jiuan07/kb_pg_password`（root:jiuan07 0640）；不打印、不进 SSM 输出和日志。
- 页面用九安的 `--ui-*` 变量和「Agent 接入」页同一套卡片、表格、标签、按钮；页面文字面向财务管理员。
- 在容器里第一次装包、改 Nexus 上的提示词之前都要项目负责人确认；本地提交用 `--no-verify`，端到端测试通过并经项目负责人确认后才推送。

## Review Focus

1. 连接器若改成只读（只读事务）：`kb_search` 照样返回结果，缓存和日志写不进去也不报错（Task 2 的 SQL 用 `EXCEPTION WHEN read_only_sql_transaction`；Task 7 在测试台上用只读事务实测）。
2. 不是审批矩阵格式、损坏、zip 炸弹、改了后缀的文件：明确拒收，历史里记成「解析失败」并写原因，不留「入库中」（Task 4）。
3. 入库进程崩溃或服务重启：卡在「入库中」的记录在服务启动时改成「失败（服务重启中断）」；第二个入库请求回 409（Task 4）。
4. 换了 `source_tag` 上传：会在库里多出一套规则、旧的不删，Agent 会查到两份。确认入库前必须先看入库预览（`--dry-run` 的新增 / 删除数），标签默认取库里已有、同文档名的标签（Task 4、Task 6）。
5. 同一文件再传一次：允许，预览应是「不变 N」，历史多一条（Task 4）。

---

### Task 1: 仿真文档与解析器的机读报告

**Files:**
- Create: `kb/tests/make_sample_docx.py`、`kb/tests/fixtures/sample-matrix.docx`（脚本生成，提交）、`kb/tests/test_parse_rules.py`
- Modify: `kb/lib/parse_rules.py`（`main` 末尾多打一行 `REPORT <json>`）

**Interfaces:**
- Produces: `parse_rules.py <docx> <out.json>` 末行 `REPORT {"general":int,"chapter_notes":int,"matrix":int,"total":int,"chapters":[{"no":int,"title":str,"rows":int}],"duplicates":[str],"without_path":[str]}`；退出码 0 / 2（参数）/ 3（空或重复）不变。

- [ ] **Step 1:** 读 `parse_rules.py` 的 `parse()`（表格识别、章名「一、…」、图例、①②√▲），写 `make_sample_docx.py`：只用标准库 `zipfile` 拼最小 WordprocessingML，生成 3 章（「一、立项审批」4 行、「三、合同用印审批」3 行含一处纵向合并、「五、付款审批」5 行含「单笔 ＞1 万」和「不适用」）+ 制度说明 2 段 + 每章说明；业务事项、公司、金额全部虚构（板块用「甲板块」「乙板块」）。
- [ ] **Step 2:** 写 `test_parse_rules.py`（`python3 -B -m unittest`）：解析仿真文档 → `matrix == 12`、`duplicates == []`、`chapters` 的 `no` 是 `[1, 3, 5]`、`C05-` 开头的规则 5 条、合并单元格展开后每行都有 `business_item`、末行能 `json.loads`。
- [ ] **Step 3:** 跑，期望 FAIL（没有 `REPORT` 行）。
- [ ] **Step 4:** `parse_rules.py` 的 `main` 在原有输出后打印 `REPORT ` + 上面的 JSON（`ensure_ascii=False`）；`deploy.sh ingest` 把整段输出缩进打印，不受影响。
- [ ] **Step 5:** 跑测试 PASS；`bash kb/deploy.sh ingest --dry-run` 的输出里多一行 REPORT（不改它）。
- [ ] **Step 6:** 提交 `feat(kb): fictional approval-matrix fixture; machine-readable parse report`。

### Task 2: 库内语义检索的 SQL 与 db / verify 阶段

**Files:**
- Create: `kb/sql/kb_search.sql`
- Modify: `kb/host/pgvector-up.sh`（装 plpython3u、执行 SQL）、`kb/host/pgvector-status.sh`（报告 plpython、`kb_search`）、`kb/deploy.sh`（`phase_db` 传 SQL、`phase_verify` 加两项）
- Test: `poc/app/test/unit/kb-search-sql.test.mjs`

**Interfaces:**
- Produces（库里，应用用户 `nexus` 有 EXECUTE）：`kb_embed(input text) RETURNS vector`（`SECURITY DEFINER`，属主 postgres）；`kb_search(...)`（见 Global Constraints）；表 `kb_documents`、`kb_search_log`（属主应用用户）、`kb_embed_cache`（属主 postgres）。
- `kb_search.sql` 占位符：`{table}` `{dim}` `{model}` `{region}` `{app_user}`，由 `pgvector-up.sh` 替换（和 `approval_rules.sql` 的 `{table}` 同一做法）。

- [ ] **Step 1:** 写 `kb-search-sql.test.mjs`（读 SQL 文本、用 `{table}=approval_rules` 等渲染后检查）：有 `CREATE EXTENSION IF NOT EXISTS plpython3u`；`kb_embed` 是 `LANGUAGE plpython3u … SECURITY DEFINER SET search_path`、Bedrock 请求体含 `"dimensions": {dim}` 和 `"normalize": True`、超过 2000 字 `plpy.error`；`kb_search` 先把问题向量算进变量再 `ORDER BY embedding <=> q`（不能在 ORDER BY 里直接调易变函数）、`k` 用 `least(greatest(k,1),20)`、每分钟 60 次上限、缓存和日志写入包在 `EXCEPTION WHEN read_only_sql_transaction`；`REVOKE ALL ON FUNCTION kb_embed(text) FROM PUBLIC`、`GRANT EXECUTE … TO {app_user}`；`kb_documents` 列和设计 3.3 一致、`status` 只许 `parsed|ingesting|ingested|failed|superseded`；`kb_search_log` 列 `at, caller, db_user, question, k, segment, hits jsonb, took_ms`；`pgvector-up.sh` 在 `KB_SEARCH_SQL_B64` 非空时才装包和执行、装包用 `docker exec -u 0 … apt-get install -y --no-install-recommends postgresql-plpython3-17 python3-boto3`、装前先查 `pg_available_extensions` 有没有 plpython3u。
- [ ] **Step 2:** 跑，FAIL（文件不存在）。
- [ ] **Step 3:** 写 `kb_search.sql`：`kb_embed` 按设计 3.1（按内容 sha256 查 `kb_embed_cache`，boto3 客户端缓存在 `SD`）；`kb_search` 用 plpgsql，计时写 `took_ms`，`hits` 存 `[{rule_id, score}]`，`score = round((1 - (embedding <=> q))::numeric, 4)`，`segment` 非空时 `position(segment in coalesce(r.segment,'')) > 0`；`kb_search_log` 只留 90 天（每次写入时顺手删过期的）。
- [ ] **Step 4:** `pgvector-up.sh` 第 6 步之后加第 6b 步：查 / 装 plpython3u → `base64 -d` 出 SQL、替换占位符 → `psql -U postgres -d $PG_DB_NAME -v ON_ERROR_STOP=1`；输出 `RESULT plpython=installed|present`、`RESULT kb_search=ready`。`deploy.sh phase_db` 传 `KB_SEARCH_SQL_B64="$(base64 < "$PKG_DIR/sql/kb_search.sql" | tr -d '\n')"`、`EMBED_MODEL_ID`、`EMBED_DIM`、`AWS_REGION`；dry-run 时 `pgvector-status.sh` 报告 `plpython`、`kb_search` 是否存在，没有就 `plan "装 PL/Python 并建 kb_search（不重启）"`。
- [ ] **Step 5:** `phase_verify` 加：`[search] kb_search 可用`（`pgvector-status.sh` 在容器里以 postgres 跑 `SELECT count(*) FROM kb_search('ping',1,NULL,'verify')`，日志里 `caller=verify`）；`[search] E2E_QUESTION 前 3 名含 E2E_EXPECT`（同上，取 `rule_id`）。
- [ ] **Step 6:** 测试 PASS；`bash -n` 全部脚本；提交 `feat(kb): in-database semantic search (kb_embed/kb_search) with a search log`。

### Task 3: 入库用 SQL 生成向量；管理命令

**Files:**
- Modify: `kb/lib/ingest_rules.py`（`--embed bedrock|sql`，默认 `bedrock`；`sql` 时不 import boto3）
- Create: `kb/lib/kb_admin.py`、`kb/tests/test_kb_admin.py`

**Interfaces:**
- Produces：`kb_admin.py --host H --port P --db D --user U --password-file F <命令>`，每个命令只打印一行 JSON：
  - `record --name N --sha256 S --size B --by U --report FILE` → `{"id": int}`（status=parsed）
  - `status ID --status S [--result FILE] [--error TEXT] [--source-tag T --doc-title T --source-version V]` → `{"ok": true}`；`ingested` 时把同 `source_tag` 的旧 `ingested` 记成 `superseded`
  - `recover` → `{"recovered": int}`（`ingesting` → `failed`，error「服务重启，入库中断」）
  - `history [--limit 50]` → `{"items": [...]}`、`show ID` → `{"item": {...}}`
  - `tags` → `{"items": [{"source_tag", "source_doc", "rows"}]}`（`approval_rules` 里现有的标签）
  - `search Q [--k 8] [--segment S]` → `{"items": [...]}`（`caller='page'`）
  - `search-log [--limit 50]` → `{"items": [...]}`
- Consumes: Task 2 的表和函数。

- [ ] **Step 1:** `test_kb_admin.py`（`uv run --with psycopg[binary]==3.2.9 python -m unittest`）：用假连接（记录执行的 SQL 和参数）测每个命令的 SQL 是参数化的、`status ingested` 会更新同标签旧记录、`search` 传 `caller='page'`、输出是单行 JSON、密码只从文件读不出现在输出里；`ingest_rules.py --embed sql` 生成的 upsert 用 `kb_embed(%(content)s)` 且不 import boto3（`sys.modules` 里没有 boto3）。
- [ ] **Step 2:** 跑，FAIL。
- [ ] **Step 3:** 写 `kb_admin.py`（`argparse` 子命令，连接参数和 `ingest_rules.py` 相同）；`ingest_rules.py` 把 `embed()` 换成按 `--embed` 选的函数，`sql` 时 `row["embedding"]` 由 `SELECT kb_embed(%s)::text` 得到；`--smoke-question` 在 `sql` 时改用 `kb_search`。
- [ ] **Step 4:** 测试 PASS；提交 `feat(kb): sql embedding mode for ingest; kb_admin commands for history and search`。

### Task 4: 外壳接口 `kb-routes.mjs`

**Files:**
- Create: `poc/app07/kb-routes.mjs`、`poc/app07/kb-runner.mjs`、`poc/app07/test/unit/kb-routes.test.mjs`
- Modify: `poc/app07/settings.mjs`（`kb: { dir, python, pg: { host, port, db, user, passwordFile }, uploadsDir }`，来自 `POC07_KB_DIR`、`POC07_KB_PYTHON`、`POC07_KB_PG_HOST`、`POC07_KB_PG_PORT`（默认 5432）、`POC07_KB_DB`（nexus）、`POC07_KB_USER`（nexus）、`secretsDir/kb_pg_password`、`stateDir/kb-uploads`；没有 `POC07_KB_PG_HOST` 时 `kb: null`）、`poc/app07/server.mjs`（`kb` 不为空才挂路由，启动时跑 `recover`）

**Interfaces:**
- Consumes: Task 1 的 `REPORT` 行；Task 3 的 `kb_admin.py` 命令；`ingest_rules.py --embed sql --dry-run`。
- Produces（路径前缀 `/api/analysis/v1/poc/kb`，只给管理员，其他人 403）：
  - `POST /documents`（原始 .docx；`X-File-Name` 为 `encodeURIComponent` 后的文件名）→ 201 `{ id, fileName, report, preview: {inserted, updated, retagged, unchanged, pruned, pruned_ids}, suggestedTag, docTitle, sourceVersion }`；解析失败 → 422，历史里 `failed`
  - `POST /documents/<id>/ingest` `{ sourceTag, docTitle, sourceVersion }` → 202；正在入库 → 409
  - `GET /documents`、`GET /documents/<id>`、`GET /search?q=&k=&segment=`、`GET /search-log`
- `kb-runner.mjs`：`createKbRunner({ python, dir, pg })` → `{ parse(file), preview(rulesJson, meta), ingest(rulesJson, meta), admin(args) }`，每个都是 `execFile` 子进程（限时：解析 60 秒、预览 120 秒、入库 15 分钟），密码只以 `--password-file` 传。

- [ ] **Step 1:** `kb-routes.test.mjs`（假 runner）：
  - 非管理员 403；不是 zip 头 / 后缀不对 / 超 20 MB → 400 且不起子进程；
  - 解析成功 → 201，文件存成 `<sha256>.docx`（0600），`rules.json` 存成 `<id>.rules.json`，回解析报告和入库预览，`suggestedTag` 取 `tags` 里 `source_doc` 和这次文件名相同的那个标签，没有就是 `doc-<sha256 前 8 位>`；
  - 解析器退出码 3 → 422，`status failed`，`error` 是解析器的中文说明；
  - `ingest` → 202，runner 跑完写 `status ingested` + `result`；runner 抛错 → `failed`；第二个 `ingest` 在第一个没完时 → 409；
  - 启动时调一次 `recover`；`search` 透传 `q`（≤ 2000 字，空的 400）。
- [ ] **Step 2:** 跑，FAIL。
- [ ] **Step 3:** 写 `kb-runner.mjs`、`kb-routes.mjs`；读请求体自己读（流式，超 20 MB 立即 413 并断开）；zip 检查：前 4 字节 `PK\x03\x04`，用中央目录数条目和解压总大小（不解压，读 End of Central Directory 和各条目的 uncompressed size）。
- [ ] **Step 4:** 测试 PASS；`node --test poc/app07/test/unit/**/*.test.mjs` 全过；提交 `feat(app07): knowledge-base upload, preview, ingest, history and search routes`。

### Task 5: IaC 与测试台配置

**Files:**
- Modify: `poc/infra/andon-finance-poc.yaml`（新资源 `KbBedrockPolicy`：`AWS::IAM::Policy`，`Condition: KbEnabled`，`Roles: [!Ref InstanceRole]`，只许 `bedrock:InvokeModel` on `arn:aws:bedrock:${AWS::Region}::foundation-model/amazon.titan-embed-text-v2:0`）、`poc/infra/bench/bench07-configure.sh`（`kb_pg_password`、`POC07_KB_*`、`kb-uploads` 目录 0700 jiuan07、venv `/opt/andon-finance/kb-venv` 装 `psycopg[binary]==3.2.9`）、`poc/infra/deploy.sh`（构件里带 `kb/lib`、`kb/sql`）
- Test: `poc/app/test/unit/kb-infra.test.mjs`、`infra.test.mjs`、`bench07-infra.test.mjs`

**Interfaces:**
- Produces（实例上）：`/opt/andon-finance/current/kb/{lib,sql}`、`/opt/andon-finance/kb-venv/bin/python`、`/etc/andon-finance/jiuan07/kb_pg_password`、`/etc/andon-finance/jiuan07/env` 里的 `POC07_KB_*`。

- [ ] **Step 1:** 测试：`KbBedrockPolicy` 的条件、角色、动作、资源（只有这一个模型 ARN）；`InstanceRole` 块本身不变（两处守护测试只多剥掉 `KbBedrockPolicy` 这一块）；`bench07-configure.sh` 只在 PG 主机的 `.env` 存在时写 `kb_pg_password`、用 `sed -n 's/^NEXUS_DB_PASSWORD=//p'` 取值且不 `echo`、`POC07_KB_PG_HOST` 取 IMDS 的私网 IP、venv 钉 `psycopg[binary]==3.2.9`；`deploy.sh` 构件里有 `kb/lib`、`kb/sql`，没有 `kb/.state`、`kb/.build`、`*.docx`。
- [ ] **Step 2:** FAIL → 实现 → PASS；`aws cloudformation validate-template` 通过；做一个不执行的变更集，确认只有 `Add KbBedrockPolicy`。
- [ ] **Step 3:** 提交 `feat(infra): Bedrock embeddings for the knowledge base; bench config for the upload worker`。

### Task 6: 九安补丁 0004：「规则库」页签与「制度知识库」页

**Files:**
- Create: `patches/jiuan-v0.7.10/0004-rules-knowledge-base-page.patch`（工作目录 `/tmp/kbtools/patch12/{a,b}`：`a` 是打过 0001–0003 的副本）
- 补丁改：`public/route-model.js`（`rules: ['family', 'view']`）、`public/analysis.js`（`rules` 路由：顶上「审核要点」「制度知识库」两个页签，`view=kb` 时发 `kb-page:mount`，只有管理员看得到第二个页签）、`analysis-server.mjs`（`assets` 加 `/kb-page.js`）、`public/analysis.html`（加 `<script type="module" src="/kb-page.js">`）、新文件 `public/kb-page.js`、`public/platform-center.css`（`kb-` 前缀的样式）
- Test: `poc/app/test/unit/bench07-build.test.mjs`

**Interfaces:**
- Consumes: Task 4 的接口；`kb-page:mount` 的 `detail = { root, csrfToken, user }`（和 `elements-page:mount` 一样）。
- `kb-page.js` 导出 `mountKbPage({ root, csrfToken, fetcher = fetch })`，四块：上传（拖放 / 选文件 → 解析报告 + 入库预览 → 标签、文档名、版本可改 →「确认入库」→ 轮询结果）；历史表（点开看报告、结果、这一版的规则数）；按问题检索；检索日志（谁查的：审核 Agent / 页面 / verify）。

- [ ] **Step 1:** 渲染测试（照 0002 的假 DOM）：非管理员没有「制度知识库」页签；上传走 `POST /poc/kb/documents`（`X-File-Name`、`X-CSRF-Token`），回来后显示「新增 0 / 只更新说明 0 / 不变 12」和标签输入框（预填 `suggestedTag`），预览里有删除时用琥珀色提示「将删除 N 条」；「确认入库」发 `{ sourceTag, docTitle, sourceVersion }`，轮询到 `ingested` 显示结果并刷新历史；检索框空的不发；检索日志表把 `caller` 显示成「审核 Agent / 页面检索 / 部署核对」。
- [ ] **Step 2:** FAIL（构建出的副本里没有页签）→ 写补丁 → PASS；构件里 `node --check` 通过。
- [ ] **Step 3:** 提交 `feat(bench07): 规则库 › 制度知识库 page (patch 0004)`。

### Task 7: 测试台上落地与核对

**Files:** 无代码改动（发现问题回到对应 Task 修）。

- [ ] **Step 1:** 问项目负责人：在 `nexus-pgvector` 里装 `postgresql-plpython3-17 python3-boto3`（不重启）、栈加 `KbBedrockPolicy`；同意后 `bash poc/infra/deploy.sh`（非 `--code-only`，变更集只有 `KbBedrockPolicy`）。
- [ ] **Step 2:** `bash poc/infra/kb.sh db --dry-run`（期望 `~ 装 PL/Python 并建 kb_search`）→ `bash poc/infra/kb.sh db` → `bash poc/infra/kb.sh verify`（期望新增的两项 `[search]` ✓，`E2E_QUESTION` 前 3 名含 C03-1.2）。
- [ ] **Step 3:** 只读事务实测（Review Focus 1）：经 SSM 以应用用户 `BEGIN READ ONLY; SELECT rule_id FROM kb_search('…',3); ROLLBACK;` 能返回结果。
- [ ] **Step 4:** 页面上传真实制度（本机文件，不进仓库）：预览应是「不变」或「只更新说明」、删除 0；确认入库；历史多一条 `ingested`；检索「房租 年度框架合同 九安」前几名有 C05-3.4；检索日志里有这几次。截图只截仿真文档那一次（真实文档的页面不截图）。

### Task 8: 审核 Agent 改用 `kb_search`；回归

**Files:**
- Modify: `kb/agent/prompt-rules.txt`（第 8 条：先 `SELECT * FROM kb_search('<问题>', 8)`，再按需 ILIKE）、`audit-agent/prompt.yaml`（第 9 条 c ②：第 1 次改成 `SELECT rule_id, business_item, segment, amount_tier, final_approver, score FROM kb_search('<板块 业务事项 金额 事由要点>', 8)`，仍不超过 3 次；`agentVersion` 改成 `jiuan-audit-ai-kb-2026-10-26.1`）、`poc/app/test/e2e/jiuan07.e2e.mjs`（新用例：制度知识库页上传 `KB_E2E_DOCX` 指向的本机文件（没设就跳过）、预览删除 0、检索命中、检索日志有审核 Agent 的调用）

- [ ] **Step 1:** 把两处提示词的改动（diff）给项目负责人看，同意后：`bash poc/infra/kb.sh agent --dry-run` → `kb.sh agent` → `python3 audit-agent/apply.py --base <线上现版本存的底稿>`（重存发布的动态配置）。
- [ ] **Step 2:** `bash poc/infra/kb.sh verify --e2e`（规则问答命中、A2A 三段式回归纯 JSON、未写库）。
- [ ] **Step 3:** `KB_E2E_DOCX=<本机真实制度> bash poc/app/test/e2e/run07.sh`：原有 8 条加新用例全过；四张对公付款单结论不变；检索日志里出现 `caller=agent` 的调用。
- [ ] **Step 4:** 提交 `feat: audit Agent queries kb_search first; E2E covers the knowledge-base page`。

### Task 9: 文档

**Files:** `kb/GUIDE.md`（新增「库内语义检索」「页面上传」两节，排错补「plpython 装不上」「Bedrock 拒绝」）、`kb/README.md`、`poc/README.md`「九安 v0.7.10」一节、`docs/delivery/handover.md`（2.2 知识库一行）、`CHANGELOG.md`、本计划的执行记录。

- [ ] **Step 1:** 逐条对照代码写（固定规则：文档的每条流程说法都要和代码一致）；`docs/build-html.sh`。
- [ ] **Step 2:** 提交 `docs: knowledge-base upload and in-database semantic search`。

## 执行记录（2026-10-26，Native 内联执行）

| Task | 提交 | 结果 |
|---|---|---|
| 1 解析报告 + 仿真文档 | 20459df | `REPORT` 行；仿真矩阵 3 章 12 条 |
| 2 `kb_search.sql` + 装 PL/Python | 57b1d4d | 参数名改 `segment_filter`（与输出列冲突） |
| 3 `kb_admin.py`、`--embed sql` | de30ebd | |
| 4 外壳接口 | d5e07bb | 加了 `POST /documents/<id>/preview`（换标签重新预览） |
| 5 栈与测试台配置 | 50b5470 | `KbBedrockPolicy`；venv 钉 `psycopg[binary]==3.2.9` |
| 6 页面（补丁 0004） | 71b2da1 | |
| 7 测试台落地 | 8f9f680、657996e、712dd72 | 现场发现并修了四处：容器里 Debian 12 的 botocore 1.29 没有 `bedrock-runtime`（改为 SigV4 签名直接调）；纯语义排序区分度不够（改为关键词命中优先，加 `keyword_hits`）；接管的旧表没有 `source_tag`，上传一律 503（`tags` 容错）；仿真文档预览会覆盖 10 条真实规则（加编号冲突保护，页面红字、不能入库）。真实制度经页面入库：只更新说明 102、删除 0；「房租 年度框架合同 九安」第 1 名 C05-3.4 |
| 8 审核 Agent 改用 `kb_search` | 618f46b、37b09d5 | 项目负责人同意后 `apply.py` 下发；`kb.sh verify --e2e` 通过；九安 v0.7.10 端到端 9/9。另修 create 模式主机（实例角色可调嵌入模型、IMDS 跳数 2）、`verify` 显示 `kb_search` 的报错 |
| 9 文档 | 见本次提交 | `kb/GUIDE.md` 6.3、7.5、9.10 等；README、交接、交付包指南、CHANGELOG；导出时带上仿真文档 |

### 终审与修复（2026-10-27）

独立评审（Opus）：1 Critical、5 Important，其余为 Minor；一轮修复，每项先写失败的测试。修复后单元测试 poc/app 318 通过 / 11 跳过、app07 44/44、kb 12/12；`kb.sh verify --e2e` 通过；九安 v0.7.10 端到端 9/9（四张对公付款单都经 `kb_search` 查规则，结论不变）。

落地时又发现一处：`kb_log_search` 的参数名 `found` 被 plpgsql 的 FOUND 盖住，检索日志写不进去，09:02–09:08 之间审核 Agent 的 `kb_search` 都失败；已修，`kb_search.sql` 改为单事务执行。

**裁定**

- Task 2: Ruling: kb_search's parameter 'segment' collides with its output column 'segment' (PG: parameter name used more than once) — renamed the parameter to segment_filter; positional calls unchanged — cost if wrong: one rename in docs/prompt
- Task 4: Ruling: added POST /api/analysis/v1/poc/kb/documents/<id>/preview {sourceTag} (not in the plan's interface) — Review Focus 4 needs the dry-run preview for the tag the admin actually confirms, and the tag is editable on the page — cost if wrong: one extra endpoint
- Task 7: Ruling: kb_embed no longer calls boto3.client("bedrock-runtime") — the PG container's Debian 12 botocore 1.29.27 has no bedrock-runtime model (UnknownServiceError on the bench); it signs with botocore SigV4Auth + instance-role creds and posts via urllib — keeps the apt package, no pip — cost if wrong: our own request code to maintain (~15 lines).
- Task 7: Ruling: kb_search orders by keyword hits (terms split on spaces/punctuation, 2–20 chars, ≤8) then vector distance; adds keyword_hits column (DROP FUNCTION first) — measured on bench: pure semantic scores flat 0.20–0.26 and 「房租 年度框架合同 九安」 put C05-3.4 ~10th, which would endanger the spec's regression gate (four 对公付款单 unchanged) once the Agent queries kb_search first; now C05-3.4 is 1st, verify question still C03-1.2 first — cost if wrong: ranking explained as "keywords first", page shows 命中词数; revert = one ORDER BY line.
- Task 7: Ruling: ingest refuses rule_ids owned by another document (other tag, or untagged row with a different source_doc) — found on bench: the fixture preview planned to overwrite 10 real rules because rule_id is the PK and all matrices use C<chapter>-<seq> — cost if wrong: a second, different policy cannot be ingested into the same table until rule ids are namespaced (design change for later).
- Task 8: Ruling: kb create mode fixed in this branch (host role may invoke EmbedModelId only; HttpPutResponseHopLimit 2) — found while writing docs: a from-zero host could never run kb_search — cost if wrong: hop limit 2 lets any container on that host read instance-role creds (role = SSM core + one model).
- Task 8: Ruling: task-done gate uses kb.sh verify instead of re-running the 25-minute paid E2E — the E2E ran once in this task on the final prompt/code (9/9, log t8-e2e.log) — cost if wrong: none for code; the paid run is not repeated.
- Final: Ruling: reviewer's "declined to judge" items (prompt-built kb_search literal, no CLI/page shared lock, gridSpan memory, connector read-only mode semantics, generic-token ranking, 403 not in 九安 audit, docTitle unused by Agent, uploads never cleaned, untagged-no-doc rows adoptable) — all stand as-is for a PoC bench; connector read-only semantics to be checked once on the bench if read-only mode is ever turned on — cost if wrong: small, documented.

**遗留（Minor，未做）**

- page shows the grey 「这个标签下还没有规则：会新增一套」 hint under a conflict block; should hide when conflicts > 0.
- page sourceVersion defaults to '' instead of the version already stored for that tag; page and kb.sh ingest with different versions retag metadata back and forth (no re-embedding).
- two fixture uploads from the 503 attempts stay in history as 「已解析，待入库」 (ids 1, 2).
- startup recover runs once; rows stay 「入库中」 if PG not ready at boot.
- conflict preview doesn't name the owning tag/document; untagged legacy conflicts can't be fixed by changing the tag.
- 400-rejected uploads get no history row; non-3 parser exit codes show a raw Python line.
- startIngest doesn't check record status; rules files keyed by DB id survive a kb DB reset; .tmp files left if record fails.
- file names / questions starting with "-" break argparse → misleading 503.
- ~~kb_search.sql not applied with psql -1~~ — 已修（落地时半截执行导致检索中断，改为 psql -1）。
- no opt-out for in-database search in db/verify for deployments without apt egress or Bedrock.
- 413 response lost (socket destroyed before send).
- spec §4 local PG container test for SQL replaced by static tests + bench runs.
- shared 60/min limit (page can starve Agent); term subquery LIMIT 8 without ORDER BY.
