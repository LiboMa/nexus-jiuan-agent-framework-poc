# 测试台升级实现计划：现在这台实例原地升级，跑九安的真实运行时

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal**：线上那台 PoC 实例原地升级成测试台：t3.large，本机 MySQL 8.0，服务改成「九安开发包副本 + mysql2 + PoC 组合根」。九安的 MySQL 存储、平台存储、连接器、调用中间件、流水线运行器、平台中心都真的在跑；现有功能（审批流、我的 Nexus、调用测试、模拟来单）照常可用。这是第二份计划（初审 MVP 补丁 0001–0006）的地基。

**Architecture**：
- **九安代码**：不再直接用 `source/` 下的开发包，改用构建出来的副本 `.build/jiuan/`。副本 = 开发包 + 补丁目录里的补丁（本计划里还没有补丁）+ 我们锁定版本的 `mysql2`。
- **组合根**：PoC 加一个开关 `POC_STORE`，取值 `memory`（现在的做法，单元测试照旧）或 `mysql`（测试台）。
  - `mysql` 模式下，存储换成九安的 MySQL 存储，再接上九安的平台存储、连接器、调用中间件、运行器和平台接口，和 PoC 的插件串在同一个 `platformRoutes` 钩子上。
  - 种子单据和「模拟来单」都经九安自己的写入路径（`createBatch` → `upsertPage` → `updateBatch`）进库。
- **MySQL**：在实例上用 Docker 跑 `mysql:8.0`，只听 127.0.0.1，参数和九安自己的测试编排一致。

**Tech Stack**：Node 24（`node:test`），九安 v0.5.3，`mysql2` 3.14.3（纯 JS），MySQL 8.0（Docker 镜像 `mysql:8.0`），Amazon Linux 2023，CloudFormation，SSM Run Command，Playwright（端到端测试）。

**Spec**：`audit-nexus/docs/specs/2026-10-19-agent-framework-design.md` 第 7.1 节第 4 条（下文简称「设计」）。调查依据：`docs/delivery/agent-framework.md` 第 7.2 节；本计划开头的两份调查结论已写进各任务。

## Global Constraints

**九安开发包**
- `source/审核平台-测试环境开发包-v0.5.3/` 只读，永远不改；补丁和依赖只进副本 `audit-nexus/.build/jiuan/`。
- 不在开发包目录里跑 `npm`、`pnpm` 或它自带的脚本。依赖由我们自己的 `poc/bench/package.json` 锁定版本，安装时一律带 `--ignore-scripts`。
- `mysql2` 版本和九安的 `package.json:20-23` 一致：**3.14.3**。

**MySQL**
- 镜像 `mysql:8.0`；参数 `--character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci --skip-log-bin`；环境 `TZ=Asia/Shanghai`（照九安 `deploy/gitea/compose.test.yaml:4-15`）。
- 库 `jiuan_analysis`，用户 `jiuan_app`，对这个库有全部权限；只听 `127.0.0.1:3306`。
- 数据目录 `/var/lib/jiuan-mysql`（宿主机），不放在 `/var/lib/andon-finance/` 下面。

**密钥（开发测试阶段：给出的密钥一直用到过期，不轮换）**
- 新增三项，都写在本机 `poc/infra/secrets.env` 里，**缺了才补，已有的永远不改**：
  - `BENCH_MYSQL_ROOT_PASSWORD`、`BENCH_MYSQL_APP_PASSWORD`：32 位随机字母数字；
  - `BENCH_DATA_KEY`：32 字节随机数的 base64，必须匹配 `^[A-Za-z0-9+/]{43}=$`。九安会用它核对库里的连接行，**换了它，整个库就打不开了**。
- 实例上落成文件：`/etc/andon-finance/bench/mysql_app_password`、`/etc/andon-finance/bench/analysis_data_key`，属主 `root:andon`，权限 0640。
- 日志和返回里不出现任何密码或密钥。

**运行时**
- 九安配置对象由 PoC 组合根在代码里拼，不经九安的配置加载器：
  - `instance: 'test'`、`environment: 'prod'`、`connectionId: 'poc-bench'`；
  - `scope: { tenantId: 'poc-tenant', companyId: <第一家公司>, allCompaniesInTenant: true }`；
  - 账号仍是 `mode: 'local_owner'`，登录仍是 PoC 的口令登录，签发票据后用 `auth.exchange(ticket, { loopback: true })`（照现在 `poc-app.mjs` 的做法）。
- 汇联易和钉钉都不接。会调汇联易的流水线一站（`hly.list-sync`、`hly.report-detail`）一律换成九安的 `createPausedAdapter()`。
- 原件照旧走 PoC 的桩（`sourceClient`、`evidenceFetch`、`extractor`）。

**部署**
- 实例只能**停机再开**，不能被替换：模板里只改 `InstanceType` 的 `AllowedValues`，不改 `ImageId`、`BlockDeviceMappings`、`NetworkInterfaces`、`UserData`。
- 升级前必须先做根卷快照，并在实例上打包 `/var/lib/andon-finance/{users,nexus}`。
- 执行变更集、停机换型、部署到线上，每一步动手前都要项目负责人当场同意。

**流程**
- 仓库不在 Git 里，不做 commit。每个任务结束跑一遍全部单元测试，并在 `progress.json` 里更新对应模块。
- 端到端测试完成、项目负责人确认之后，才更新交付包。

## Review Focus

1. **服务重启后（不是重置）**：单据还在；下一张模拟来单的编号接着往下排，不会撞上已有的 `FYBX-SIM-001`（`POC_DOCUMENT_EXISTS`）。→ Task 4 的测试 `intake sequence survives restart`。
2. **开机时 MySQL 容器还没起来**：服务应当等它，健康检查回 503「starting」，不能崩溃重启（每次重启都会重新下载构件，覆盖回滚点，评审 I2）。→ Task 4 的测试 `waits for database`。
3. **`secrets.env` 被重新生成或改动**：`BENCH_DATA_KEY` 一旦存在就不能被换，否则库打不开。→ Task 6 的测试 `bench secrets are append-only`。
4. **种子重复写入**：每次启动都会再写一遍 8 张种子单据，不能多出版本或事件。→ Task 2 的测试 `seeding twice is a no-op`。
5. **重启之后再读模拟来单的原件**：九安按单据号取原文；模拟来单的原文要从库里取，不能只放在内存里。→ Task 2 的测试 `arrived raw is readable after reopen`。

---

## 文件结构

| 文件 | 新增 / 修改 | 做什么 |
|---|---|---|
| `poc/bench/package.json`、`poc/bench/package-lock.json` | 新增 | 锁定 `mysql2@3.14.3` |
| `poc/bench/build-jiuan.sh` | 新增 | 构建副本 `.build/jiuan/`：复制开发包、打补丁、装依赖 |
| `poc/app/test/unit/bench-build.test.mjs` | 新增 | 构建脚本的测试 |
| `poc/app/test/unit/helpers/mysql.mjs` | 新增 | MySQL 测试的公共部分：没有 `MYSQL_TEST_URL` 就跳过；清库 |
| `poc/app/jiuan-mysql.mjs` | 新增 | 九安里要用到 mysql2 的模块，只在 `mysql` 模式下动态导入 |
| `poc/app/bench/store.mjs` | 新增 | 打开九安 MySQL 存储；写入原文；种子；原文和来单编号的持久化 |
| `poc/app/bench/platform.mjs` | 新增 | 平台存储、连接器、调用中间件、运行器、调度、平台接口 |
| `poc/app/test/unit/bench-store.test.mjs`、`bench-platform.test.mjs`、`bench-server.test.mjs` | 新增 | 对应的测试（要 MySQL） |
| `poc/app/config.mjs` | 修改 | 读 `POC_STORE` 和测试台的设置 |
| `poc/app/poc-app.mjs` | 修改 | 接受注入的存储、平台接口、写单据与取原文的函数 |
| `poc/app/server.mjs` | 修改 | `mysql` 模式的组装、等库、迁移、种子、关闭 |
| `poc/app/approval/routes.mjs` | 修改 | 模拟来单改用 `ctx.writeDocument`，编号持久化 |
| `poc/app/seed.mjs` | 修改 | 原文查找改为可注入 |
| `poc/infra/bench/mysql-install.sh`、`bench-reset.sh`、`andon-finance-bench.conf` | 新增 | 实例上装 MySQL、重置库、systemd 补充配置 |
| `poc/infra/backup.sh`、`poc/infra/upgrade-instance.sh` | 新增 | 升级前备份；带「不替换」检查的换型 |
| `poc/infra/andon-finance-poc.yaml`、`poc/infra/deploy.sh` | 修改 | 允许 t3.large；测试台密钥；构件里带副本和脚本；部署步骤 |
| `poc/app/test/unit/infra.test.mjs` | 修改 | 模板与部署脚本的新断言 |
| `poc/app/test/e2e/run.sh`、`poc/app/test/e2e/poc.e2e.mjs` | 修改 | 用重置脚本代替重启；平台中心冒烟测试 |
| `docs/delivery/operations.md`、`deploy-iteration.md`、`handover.md`、`docs/architecture.md`、`poc/infra/README.md`、`progress.json` | 修改 | 文档与进度 |

---

### Task 1：构建九安副本与锁定的 mysql2

**Files:**
- Create: `poc/bench/package.json`、`poc/bench/package-lock.json`、`poc/bench/build-jiuan.sh`
- Test: `poc/app/test/unit/bench-build.test.mjs`

**Interfaces:**
- Produces:
  - `poc/bench/build-jiuan.sh [--out <目录>] [--patches <目录>]`：默认输出 `audit-nexus/.build/jiuan/`，补丁目录默认 `audit-nexus/patches/jiuan-v0.5.3/`（不存在或为空就跳过）。成功时最后一行打印 `JIUAN_BUILD_OK <副本目录>`。
  - 副本里：九安 `code/` 下的全部文件，不含 `tests/`、`deploy/`、`node_modules/`；再加 `node_modules/mysql2`（3.14.3）和它的依赖。

- [ ] **Step 1: 写测试 `bench-build.test.mjs`**
  - `builds a copy with mysql2 3.14.3`：在临时目录跑脚本（`--out <tmp>`），断言：
    - `<tmp>/analysis-server.mjs` 存在；
    - `<tmp>/node_modules/mysql2/package.json` 的 `version === '3.14.3'`；
    - `<tmp>/tests` 不存在；
    - 输出最后一行是 `JIUAN_BUILD_OK <tmp>`。
  - `leaves source untouched`：跑脚本前后，对 `source/…/code` 下所有文件算一遍 sha256 清单，两次相等。
  - `applies patches in order`：建一个临时补丁目录，放 `0001-a.patch`（新建 `hello.txt`，内容 `1`）和 `0002-b.patch`（把它改成 `2`）；跑脚本后断言副本里 `hello.txt` 的内容是 `2`。
- [ ] **Step 2: 跑测试，确认失败**
  Run: `cd poc/app && node --test test/unit/bench-build.test.mjs`
  Expected: FAIL，脚本不存在。
- [ ] **Step 3: 写 `poc/bench/package.json`，生成锁文件**
  - 内容：`{ "private": true, "dependencies": { "mysql2": "3.14.3" } }`
  - 生成锁文件：`cd poc/bench && npm install --package-lock-only --ignore-scripts`
- [ ] **Step 4: 写 `build-jiuan.sh`**
  1. `set -euo pipefail`；
  2. `rsync -a --delete --exclude tests --exclude deploy --exclude node_modules --exclude .DS_Store <开发包 code/>/ <out>/`；
  3. 补丁按文件名排序，逐个 `patch -p1 --forward --batch -d <out> < <补丁>`，任何一个打不上就退出非零；
  4. `npm ci --ignore-scripts --omit=dev --prefix poc/bench`，再 `rsync -a poc/bench/node_modules/ <out>/node_modules/`；
  5. 打印 `JIUAN_BUILD_OK <out>`。
- [ ] **Step 5: 跑测试，确认通过**
  Run: `cd poc/app && node --test test/unit/bench-build.test.mjs`
  Expected: 3 个用例通过。
- [ ] **Step 6: 跑全部单元测试**
  Run: `cd poc/app && node --test "test/unit/**/*.test.mjs"`
  Expected: 全部通过。

### Task 2：九安 MySQL 存储、原文写入与种子

**Files:**
- Create: `poc/app/jiuan-mysql.mjs`、`poc/app/bench/store.mjs`、`poc/app/test/unit/helpers/mysql.mjs`、`poc/app/test/unit/bench-store.test.mjs`
- Modify: `poc/app/seed.mjs`（`rawForNumber` 旁边加可注入的查找）

**Interfaces:**
- Consumes：Task 1 的副本 `.build/jiuan/`。测试用 `JIUAN_CODE_DIR=<副本>` 和 `MYSQL_TEST_URL=mysql://root:<密码>@127.0.0.1:3307/jiuan_bench_test`。
- Produces:
  - `jiuan-mysql.mjs` 导出：`createAnalysisDatabase`（`src/analysis-database.mjs`）、`createPlatformStore`（`src/platform/platform-store.mjs`）、`createConnectorRegistry`（`src/platform/connectors.mjs`）、`createSecretSource`（`src/platform/secret-source.mjs`）、`createCallGateway`（`src/platform/call-middleware.mjs`）、`createAgentRunner`（`src/platform/agent-runner.mjs`）、`createPausedAdapter`（`src/platform/adapters/catalog.mjs`）、`createDetailProjectionAdapter`（`src/platform/adapters/detail-projection.mjs`）、`createScheduler`（`src/platform/scheduler.mjs`）、`createPipelineProgress`（`src/platform/pipeline-progress.mjs`）、`createPlatformRoutes`（`src/platform/platform-routes.mjs`）。九安路径一律经 `jiuan-path.mjs`。
  - `bench/store.mjs`：
    - `openBenchStore({ database, password, dataKey, connectionId }) → Promise<{ store, pool, health(), close() }>`：`database` 是 `{ host, port, database, user }`；内部用 `createAnalysisDatabase({ config: { database: { engine: 'mysql', ...database } }, secrets: { databasePassword: password } })`，然后 `open({ key: Buffer.from(dataKey, 'base64'), connectionId })`、`store.migrate()`。
    - `writeRaws(store, { tenantId, companyId, raws, collectedAt }) → Promise<void>`：按公司分组；每组 `createBatch({ scope, query: { source: 'poc-bench' } })` → 每 100 条 `upsertPage({ scope, reports, batchId, collectedAt })` → `updateBatch(id, { status: 'completed', finishedAt, pages, reportCount })`。
    - `seedBench(store, { tenantId, raws }) → Promise<void>`：对 `SEED_RAWS` 调 `writeRaws`。
    - `rememberRaw(store, raw)` / `lookupRaw(store, number) → Promise<object|null>`：键 `poc-raw:<单据号>`，经 `writeState` / `readState`。
    - `nextIntakeSequence(store) → Promise<number>`：键 `poc-intake-sequence`，用 `compareAndWriteState` 加一，冲突（409）就重读再试，最多 5 次。
  - `seed.mjs`：`createRawLookup({ arrived }) → number => Promise<object|null>`：先查 `SEED_RAWS`，再调 `arrived(number)`。`rawForNumber` 改成它在内存模式下的一种用法，行为不变。

- [ ] **Step 1: 写 `helpers/mysql.mjs`**
  - `mysqlTestUrl()`：返回 `process.env.MYSQL_TEST_URL`；没有就返回 `null`。
  - `resetTestDatabase(url)`：库名必须以 `_test` 结尾（照九安 `tests/mysql-analysis-store-versions.integration.test.mjs:39-40`）；关掉外键检查，删掉全部表。
  - 每个要 MySQL 的测试文件都用 `test(name, { skip: !mysqlTestUrl() && '需要 MYSQL_TEST_URL' }, …)`。
- [ ] **Step 2: 写测试 `bench-store.test.mjs`**
  - `seeds 8 documents`：`seedBench` 之后，`store.listDocuments({ companyIds: 两家公司 })` 一共 8 张，单据号集合等于 `SEED_RAWS` 的单据号集合。
  - `seeding twice is a no-op`：连跑两次 `seedBench`，第二次前后每张单据的 `version` 不变；`analysis_document_versions` 表的行数不变。
  - `arrived raw is readable after reopen`：
    1. `simulateArrival({ template: 'FYBX-POC-001', sequence: 1 })` 得到 `raw`；
    2. `writeRaws` 写入，`rememberRaw` 记下原文；
    3. 关掉、重新 `openBenchStore`；
    4. `lookupRaw(store, 'FYBX-SIM-001')` 深等于 `raw`。
  - `intake sequence is monotonic`：并发调 5 次 `nextIntakeSequence`，结果排序后是 `[1, 2, 3, 4, 5]`。
  - `wrong data key is refused`：用另一把 `dataKey` 打开同一个库，`openBenchStore` 抛错（九安会核对连接行，`mysql-analysis-store.mjs:156-161`）。
- [ ] **Step 3: 起本机测试库，跑测试，确认失败**
  - 起库：`docker run -d --rm --name jiuan-bench-test -p 127.0.0.1:3307:3306 -e MYSQL_ROOT_PASSWORD=test -e MYSQL_DATABASE=jiuan_bench_test -e TZ=Asia/Shanghai mysql:8.0 --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci --skip-log-bin`。本机 Docker 没在跑时，先问项目负责人能不能启动 Docker Desktop。
  - 运行：`cd poc/app && JIUAN_CODE_DIR=../../.build/jiuan MYSQL_TEST_URL=mysql://root:test@127.0.0.1:3307/jiuan_bench_test node --test test/unit/bench-store.test.mjs`
  - Expected：FAIL，`bench/store.mjs` 不存在。
- [ ] **Step 4: 实现 `jiuan-mysql.mjs`、`bench/store.mjs`、`createRawLookup`**
  - `writeRaws` 的 `collectedAt` 用 ISO 时间。
  - `nextIntakeSequence` 的值存成 `{ revision, value }`。
- [ ] **Step 5: 跑测试，确认通过**
  - 运行：同 Step 3。
  - Expected：5 个用例通过。
  - 不设 `MYSQL_TEST_URL` 时再跑一次全部单元测试：这 5 个跳过，其余全部通过。

### Task 3：九安的平台部分（平台存储、连接器、调用中间件、运行器、平台接口）

**Files:**
- Create: `poc/app/bench/platform.mjs`、`poc/app/test/unit/bench-platform.test.mjs`

**Interfaces:**
- Consumes：Task 2 的 `jiuan-mysql.mjs`；`openBenchStore` 返回的 `{ store, pool }`。
- Produces：`createBenchPlatform({ pool, store, config }) → { platformRoutes, runner, scheduler, gateway, close() }`。
  - `secretSource` 用 `createSecretSource({ config: { ...config, protectedSecrets: {} }, env: {} })`：什么都不绑定，汇联易和钉钉都是 unbound。
  - `registry = createConnectorRegistry({ secretSource, transports: {}, huilianyiSource: config })`。
  - `gateway = createCallGateway({ store: platformStore, registry, lockPool: pool, processTag: 'poc-bench' })`。**不调** `gateway.acquire`：它会长期占用连接池 5 条里的 2 条（`call-middleware.mjs:477-505`）。
  - 流水线：
    - `hly.list-sync`、`hly.report-detail`、`hly.attachment-fetch`、`local.attachment-extract`、`audit.ai-advice`、`audit.draft-evidence`、`audit.published-rule-trial`、`finance.expense-type-agents` → `createPausedAdapter()`；
    - `hly.detail-projection` → `createDetailProjectionAdapter({ pool, key })`。
  - `scheduler = createScheduler({ runner, platformStore, getConfig: () => config, scope: config.scope, lanes: ['corporate', 'employee'], mode: 'incremental', chain: false })`；`config.automaticSync` 是 `false`，所以不会起定时器。
  - `platformRoutes = createPlatformRoutes({ pool, store, platformStore, pipelineProgress, scheduler, getConfig: () => config, gateway, connectors: registry, runner })`。

- [ ] **Step 1: 写测试 `bench-platform.test.mjs`**（要 MySQL；用 Task 2 的帮助函数）
  - `exposes jiuan platform routes`：
    1. `createBenchPlatform` 之后，用 `createAnalysisApp` 起一个服务（`store`、`auth`、`platformRoutes`）；
    2. 用 admin 会话 `GET /api/analysis/v1/platform/agents`，回 200；
    3. 返回里有卡片 `hly.list-sync`，状态是暂停或未绑定（不是运行中）。
  - `hly stays offline`：`registry.secretPresence('hly') === 'unbound'`；`POST /api/analysis/v1/platform/connectors/hly/probe` 不发出任何网络请求：测试把 `globalThis.fetch` 换成一个一被调用就失败的函数。
  - `close releases the pool`：`close()` 之后 `scheduler.status().active === false`，进程能正常退出（测试结束时没有挂着的句柄）。
- [ ] **Step 2: 跑测试，确认失败**
  Run：`cd poc/app && JIUAN_CODE_DIR=../../.build/jiuan MYSQL_TEST_URL=… node --test test/unit/bench-platform.test.mjs`
  Expected：FAIL，`bench/platform.mjs` 不存在。
- [ ] **Step 3: 实现 `createBenchPlatform`**：按 Interfaces 组装。`close()` 依次关 `scheduler`、`runner`、`gateway`。
- [ ] **Step 4: 跑测试，确认通过**
  Expected：3 个用例通过；不设 `MYSQL_TEST_URL` 时全部单元测试通过。

### Task 4：组合根的 `mysql` 模式

**Files:**
- Modify: `poc/app/config.mjs`、`poc/app/poc-app.mjs`、`poc/app/server.mjs`、`poc/app/approval/routes.mjs`
- Test: `poc/app/test/unit/bench-server.test.mjs`；现有的 `server.test.mjs`、`poc-app.test.mjs`、`approval-flow.test.mjs` 必须照旧通过

**Interfaces:**
- Consumes：Task 2 的 `openBenchStore`、`writeRaws`、`seedBench`、`rememberRaw`、`lookupRaw`、`nextIntakeSequence`、`createRawLookup`；Task 3 的 `createBenchPlatform`。
- Produces:
  - `readEnvConfig(env)` 多返回 `store`：
    - `{ kind: 'memory' }`：默认；
    - `{ kind: 'mysql', database: { host, port, database, user }, passwordFile, dataKeyFile }`。

    读的环境变量：`POC_STORE`（`memory` | `mysql`）、`BENCH_MYSQL_HOST`（默认 `127.0.0.1`）、`BENCH_MYSQL_PORT`（默认 `3306`）、`BENCH_MYSQL_DATABASE`（默认 `jiuan_analysis`）、`BENCH_MYSQL_USER`（默认 `jiuan_app`）、`BENCH_SECRETS_DIR`（默认 `/etc/andon-finance/bench`；文件名 `mysql_app_password`、`analysis_data_key`）。取值不合法就报 `POC_CONFIG_INVALID`。
  - `createPocApp` 多接受四个可选参数：
    - `store`：不给就用内存存储；
    - `jiuanPlatformRoutes`：九安的平台接口；
    - `writeDocument({ raw }) → Promise<{ document }>`：内存模式下是现在的 `addDocument` 加原文登记；`mysql` 模式下依次 `writeRaws`、`rememberRaw`，再按单据号 `store.listDocuments({ companyIds: [raw.docCompanyOID], q: raw.businessCode, limit: 1 })` 找到编号、`store.getDocument` 取回九安存好的单据（编号和版本由九安算，PoC 不自己算）；
    - `rawLookup(number) → Promise<object|null>`。

    插件上下文 `ctx` 多 `writeDocument` 和 `nextIntakeSequence`。`platformRoutes` 改成 `{ ...jiuanPlatformRoutes, async handle(args) }`：先轮 PoC 插件，都不认就交给 `jiuanPlatformRoutes.handle`。`recordAuth`、`recordAccessDenied`、`recordPreAuthDenied`、`auditStatus` 原样透传（`platform-routes.mjs:1216-1222`）。
  - `main()` 在 `mysql` 模式下的顺序：
    1. 读两个密钥文件；
    2. 等库：`openBenchStore` 失败就每 2 秒重试，最多 90 秒；这期间健康检查回 503 `starting`；
    3. `seedBench`；
    4. `createBenchPlatform`；
    5. `createPocApp`（注入上面四样）；
    6. 监听；
    7. 读一遍原件（warmUp）。

    `stop()` 依次关 PoC 应用、平台部分、存储。
  - 模拟来单：编号来自 `ctx.nextIntakeSequence()`；写入用 `ctx.writeDocument({ raw })`。审批流仍在内存里（第二份计划再搬进库）。

- [ ] **Step 1: 写测试 `bench-server.test.mjs`**（要 MySQL）
  - `boots in mysql mode`：
    1. 临时的密钥目录（两个文件）、`POC_STORE=mysql`，调 `main()`；
    2. 用审核员口令登录；
    3. `GET /api/analysis/v1/documents` 一共 8 张；
    4. `GET /api/analysis/v1/platform/agents`：审核员（九安 admin）和复核人（analyst）都回 200；复核人 `PUT /api/analysis/v1/platform/agents/hly.list-sync/settings` 回 403（`platform-routes.mjs:417-418、617`）；
    5. `GET /api/analysis/v1/poc/nexus/me` 用审核员会话回 200（「我的 Nexus」照常可用，账号目录用临时目录）。
  - `intake sequence survives restart`：
    1. `POST /api/analysis/v1/poc/intake {template:'FYBX-POC-001'}` 回 201，单据号 `FYBX-SIM-001`；
    2. `stop()`，再 `main()`；
    3. 再来一单是 `FYBX-SIM-002`；
    4. 单据池一共 10 张。
  - `evidence of an arrived document after restart`：重启后对 `FYBX-SIM-001` 读原件（`POST /documents/:id/evidence/read`），结果不是 `failed`。
  - `waits for database`：先把 `BENCH_MYSQL_PORT` 指到一个没有服务的端口启动 `main()`；500 毫秒内 `/poc/healthz` 回 503 `starting`，进程不退出；把配置改回正确端口后（测试用可注入的 `openStore` 桩模拟「先失败两次再成功」），健康检查变成 200。
  - `memory mode unchanged`：不设 `POC_STORE` 时，`main()` 的行为与现在相同（现有 `server.test.mjs` 全部通过，不用改）。
- [ ] **Step 2: 跑测试，确认失败**
  Run：`cd poc/app && JIUAN_CODE_DIR=../../.build/jiuan MYSQL_TEST_URL=… node --test test/unit/bench-server.test.mjs`
  Expected：FAIL，`mysql` 模式还不存在。
- [ ] **Step 3: 实现**
  - 改 `config.mjs`、`poc-app.mjs`、`server.mjs`、`approval/routes.mjs`。
  - `main()` 多一个可注入参数 `openStore = openBenchStore`，给「等库」的测试用。
  - 测试台的九安配置对象在 `server.mjs` 里拼，取值见 Global Constraints「运行时」。
- [ ] **Step 4: 跑测试，确认通过**
  - Expected：`bench-server.test.mjs` 5 个用例通过。
  - 不设 `MYSQL_TEST_URL` 时，全部单元测试通过（原有的 240 个不变）。

### Task 5：实例上的脚本：装 MySQL、重置库、systemd 补充配置

**Files:**
- Create: `poc/infra/bench/mysql-install.sh`、`poc/infra/bench/bench-reset.sh`、`poc/infra/bench/andon-finance-bench.conf`
- Test: `poc/app/test/unit/infra.test.mjs`（加用例）

**Interfaces:**
- Produces（都以 root 运行，在构件里的路径是 `/opt/andon-finance/current/bench/`）：
  - `mysql-install.sh`，幂等：
    1. 没装 docker 就 `dnf install -y docker`，然后 `systemctl enable --now docker`；
    2. 没有容器 `jiuan-mysql` 就创建：`docker run -d --name jiuan-mysql --restart unless-stopped -p 127.0.0.1:3306:3306 -v /var/lib/jiuan-mysql:/var/lib/mysql`，加上 Global Constraints 里的镜像、参数和环境；root 和应用用户的密码分别用 `MYSQL_ROOT_PASSWORD_FILE`、`MYSQL_PASSWORD_FILE` 指向 `/etc/andon-finance/bench/` 下的文件；
    3. 等到 `docker exec jiuan-mysql mysqladmin ping` 成功，最多 120 秒；
    4. 把 `andon-finance-bench.conf` 装到 `/etc/systemd/system/andon-finance-poc.service.d/`，然后 `systemctl daemon-reload`。
  - `andon-finance-bench.conf`：`[Unit] After=docker.service` 和 `Wants=docker.service`；`[Service] EnvironmentFile=-/etc/andon-finance/bench.env`。
  - `bench-reset.sh`：
    1. `systemctl stop andon-finance-poc`；
    2. 在容器里 `DROP DATABASE IF EXISTS jiuan_analysis; CREATE DATABASE jiuan_analysis CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; GRANT ALL ON jiuan_analysis.* TO 'jiuan_app'@'%';`；
    3. `systemctl start andon-finance-poc`。

    只动这个库，不碰 `/var/lib/andon-finance/`。

- [ ] **Step 1: 在 `infra.test.mjs` 加用例**
  - `bench scripts parse`：三个 shell 脚本 `bash -n` 通过。
  - `mysql pinned and local only`：`mysql-install.sh` 包含 `mysql:8.0`、`127.0.0.1:3306:3306`、`--skip-log-bin`、`utf8mb4_unicode_ci`、`TZ=Asia/Shanghai`；不包含 `0.0.0.0`。
  - `reset touches only the database`：`bench-reset.sh` 不包含 `/var/lib/andon-finance`、`rm -rf`；包含 `DROP DATABASE IF EXISTS jiuan_analysis`。
  - `no secrets in scripts`：三个文件里都没有形如 `PASSWORD=<非空值>` 的字面量（只能是 `_FILE=` 路径）。
- [ ] **Step 2: 跑测试，确认失败**
  Run：`cd poc/app && node --test test/unit/infra.test.mjs`
  Expected：新用例 FAIL，文件不存在。
- [ ] **Step 3: 写三个文件**
- [ ] **Step 4: 跑测试，确认通过**
  Expected：`infra.test.mjs` 全部通过；全部单元测试通过。

### Task 6：模板、部署脚本、备份与换型

**Files:**
- Modify: `poc/infra/andon-finance-poc.yaml`（`InstanceType` 的 `AllowedValues`）、`poc/infra/deploy.sh`
- Create: `poc/infra/backup.sh`、`poc/infra/upgrade-instance.sh`
- Test: `poc/app/test/unit/infra.test.mjs`（加用例）

**Interfaces:**
- Consumes：Task 1 的 `build-jiuan.sh`；Task 5 的三个文件。
- Produces:
  - **模板**：`AllowedValues: [t3.small, t3.medium, t3.large]`。除此之外不改。
  - **`deploy.sh`**：
    - 打包前先跑 `poc/bench/build-jiuan.sh`；构件里的 `jiuan/` 改成取副本，并且**保留** `node_modules`。
    - 构件里加 `bench/`（Task 5 的三个文件）。
    - `secrets.env` 缺 `BENCH_MYSQL_ROOT_PASSWORD`、`BENCH_MYSQL_APP_PASSWORD`、`BENCH_DATA_KEY` 时补上，**已有的不改**（照 `REGISTRY_KEY` 的写法，`deploy.sh:69-72`）。
    - SSM 部署命令在重启之前依次：
      1. 把三项写成 `/etc/andon-finance/bench/` 下的文件（`mysql_root_password`、`mysql_app_password`、`analysis_data_key`），属主 `root:andon`，权限 0640；
      2. 写 `/etc/andon-finance/bench.env`（`POC_STORE=mysql`，加上 `BENCH_MYSQL_*` 的默认值）；
      3. 运行 `bench/mysql-install.sh`。
    - **检查 SSM 结果**：状态不是 `Success` 就打印输出并退出非零（补上评审 I1 的这一处）。
    - 其余步骤不变；`--code-only` 照旧。
  - **`backup.sh`**：
    1. 查出实例的根卷，`aws ec2 create-snapshot`（带标签 `andon-finance-poc-backup`），等它完成，打印快照编号；
    2. 经 SSM 在实例上 `tar -czf /root/andon-backup-<时间>.tgz -C /var/lib/andon-finance users nexus`（0600），检查 SSM 结果为 `Success`。
  - **`upgrade-instance.sh <实例类型>`**：
    1. 用 `aws cloudformation create-change-set` 建变更集，参数 `InstanceType=<类型>`，其余参数 `UsePreviousValue=true`；
    2. 读出变更集里实例这一项的 `Replacement`，不是 `False` 就删掉变更集并退出非零；
    3. 打印变更内容，要求输入栈名确认；
    4. `execute-change-set` 并等待完成，再检查健康。

- [ ] **Step 1: 在 `infra.test.mjs` 加用例**
  - `allows t3.large without other instance changes`：模板的 `InstanceType` 允许值包含 `t3.large`。和改动前的模板相比，实例资源的 `ImageId`、`BlockDeviceMappings`、`NetworkInterfaces`、`UserData` 一字不差：测试里存一份这几项的 sha256 期望值。
  - `bench secrets are append-only`：在临时目录放一份已有 `BENCH_DATA_KEY=<值>` 的 `secrets.env`，只抽出 `deploy.sh` 里补密钥的那一段运行，之后值不变；另外两项补上了，`BENCH_DATA_KEY` 的格式匹配 `^[A-Za-z0-9+/]{43}=$`。
  - `release keeps jiuan node_modules`：`deploy.sh` 打包 `jiuan/` 的那一行不再排除 `node_modules`，并且取的是 `.build/jiuan`。
  - `deploy checks ssm status`：`deploy.sh` 里 SSM 那一步不再以 `|| true` 结尾，而是读 `Status` 并在不是 `Success` 时退出。
  - `upgrade refuses replacement`：`upgrade-instance.sh` 读 `Replacement`，在不是 `False` 时删掉变更集并退出。
  - `scripts parse`：`backup.sh`、`upgrade-instance.sh` 用 `bash -n` 检查通过。
- [ ] **Step 2: 跑测试，确认失败**
  Run：`cd poc/app && node --test test/unit/infra.test.mjs`
  Expected：新用例 FAIL。
- [ ] **Step 3: 改模板和 `deploy.sh`，写 `backup.sh`、`upgrade-instance.sh`**
- [ ] **Step 4: 跑测试，确认通过；本地演练**
  - `infra.test.mjs` 全部通过；全部单元测试通过。
  - `aws cloudformation validate-template --template-body file://poc/infra/andon-finance-poc.yaml` 通过（只读）。

### Task 7：端到端测试改用重置脚本，加平台中心冒烟测试

**Files:**
- Modify: `poc/app/test/e2e/run.sh`、`poc/app/test/e2e/poc.e2e.mjs`

**Interfaces:**
- Consumes：Task 5 的 `bench-reset.sh`（实例上 `/opt/andon-finance/current/bench/bench-reset.sh`）。
- Produces:
  - `run.sh` 用 SSM 跑 `bench-reset.sh`，代替现在的 `systemctl restart`。实例上没有这个脚本时（还没升级），退回到 `systemctl restart`。
  - `poc.e2e.mjs` 新用例 `0. 平台中心能打开（九安真实运行时）`：复核人登录后进「平台运行」，看到流水线卡片「汇联易列表同步」，状态不是「运行中」。

- [ ] **Step 1: 改 `run.sh`、加用例**
- [ ] **Step 2: 本地检查**
  Run：`bash -n poc/app/test/e2e/run.sh && node --check poc/app/test/e2e/poc.e2e.mjs`
  Expected：没有输出，退出码 0。端到端测试本身在 Task 8 跑。

### Task 8：线上升级（每一步动手前都问项目负责人）

**Files:** 无代码改动；结果记进 `evidence/bench/2026-10-19-upgrade.md`。

- [ ] **Step 1: 备份**（先问项目负责人）
  - Run：`poc/infra/backup.sh`
  - Expected：打印快照编号，状态 `completed`；实例上 `/root/andon-backup-*.tgz` 存在。
- [ ] **Step 2: 换型**（先问项目负责人；会停机几分钟）
  - Run：`poc/infra/upgrade-instance.sh t3.large`
  - Expected：变更集里实例的 `Replacement` 是 `False`；执行完成；`describe-instances` 显示 `t3.large`；弹性 IP 没变。
- [ ] **Step 3: 部署**（先问项目负责人）
  - Run：`poc/infra/deploy.sh --code-only`
  - Expected：SSM 状态 `Success`；`docker ps` 里有 `jiuan-mysql`；`curl -fsS https://andon-finance.tinyboat.blog/api/health` 回 200。
- [ ] **Step 4: 检查每个账号的数据还在**
  - Run：经 SSM `ls /var/lib/andon-finance/users`
  - Expected：和备份前一样。页面上审核员的「我的 Agent」显示原来启用的两个 Agent。
- [ ] **Step 5: 端到端测试**（先告诉项目负责人：会重置库、产生约 0.4 美元的调用费用）
  - Run：`poc/app/test/e2e/run.sh`
  - Expected：全部通过，按设计跳过的除外；`evidence/e2e/last-run.jsonl` 有记录。
- [ ] **Step 6: 记录结果，请项目负责人确认**
  在 `evidence/bench/2026-10-19-upgrade.md` 里记下快照编号、实例类型、测试结果和截图路径，然后请项目负责人确认。

回滚：
- 代码问题：把构件桶里上一份归档拷回 `releases/current.tgz`，再 `deploy.sh --code-only`；`bench.env` 里改成 `POC_STORE=memory` 就回到旧的做法。
- 实例问题：用 Step 1 的快照恢复根卷。

### Task 9：文档与进度

**Files:**
- Modify: `docs/delivery/operations.md`、`docs/delivery/deploy-iteration.md`、`docs/delivery/handover.md`、`docs/architecture.md`、`poc/infra/README.md`、`progress.json`

- [ ] **Step 1: 改文档**
  - `operations.md`：MySQL 容器的日常检查（`docker ps`、`mysqladmin ping`），重置（`bench-reset.sh`），备份（`backup.sh`），日志位置。
  - `deploy-iteration.md`：新的构件内容（副本、`node_modules`、`bench/`），三项测试台密钥只能补、不能换，SSM 结果检查。
  - `handover.md`：资产清单加 MySQL 容器、`/var/lib/jiuan-mysql`、`/etc/andon-finance/bench/`；密钥清单加三项（只写名字和位置）；`/var/lib/andon-finance/users/` 的备份方法。
  - `architecture.md`：组件图加 MySQL 和九安的平台部分；第 6、10 节改成「单据和平台状态存在 MySQL 里，审批流状态仍在内存里」。
  - `infra/README.md`：实例类型 t3.large；`upgrade-instance.sh`、`backup.sh` 的用法。
- [ ] **Step 2: 更新 `progress.json`**
  - 加模块 `ops.bench`（测试台：t3.large、MySQL、九安真实运行时），证据写 Task 8 的结果。
  - `fr.bench` 的说明改成「地基已完成，等第二份计划」。
- [ ] **Step 3: 生成 HTML、检查**
  - Run：`docs/build-html.sh && docs/build-html.sh --check && node tools/progress/check.mjs && node tools/progress/snapshot.mjs`
  - Expected：「图和 HTML 都是最新的」；「progress.json 没问题」。
