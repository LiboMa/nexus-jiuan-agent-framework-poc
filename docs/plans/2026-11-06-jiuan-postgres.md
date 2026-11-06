# 九安 v0.7.10 测试台换成 PostgreSQL：实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 九安 v0.7.10 副本和测试台外壳只用 PostgreSQL，测试台上的数据一条不丢地从 MySQL 搬过去，切换后一切照常。

**Architecture:** 九安的源码不动，改动做成补丁 0008 起：先加一个和 mysql2 用法一样的 `pg` 适配层，再建 PostgreSQL 的基线表结构，然后按模块把 MySQL 专有的 SQL 改掉；外壳和实例上的脚本跟着改；一个一次性的搬迁工具逐表复制、逐表核对；在远端实例上测试、演练，全过就直接切换。

**Tech Stack:** Node 24、`pg` 8.16.3、`mysql2` 3.14.3（只给搬迁工具和 MySQL 基线测试）、PostgreSQL 17（`postgres:17`，arm64）、bash、`node --test`。

**Spec:** `docs/specs/2026-11-05-jiuan-postgres-design.md`（必须一起读；本计划里「设计第 N 节」都指它）

## Global Constraints

- 九安开发包 `source/` 只读；改动只进补丁：代码补丁放 `patches/jiuan-v0.7.10/00NN-<名>.patch`，九安自带测试的改动放 `patches/jiuan-v0.7.10/tests/00NN-<名>.patch`（普通构建不打它，`--with-tests` 才打）；补丁打不上就停。
- 补丁格式：`git diff` 的 `a/` `b/` 前缀，`patch -p1 -N` 能打；每个补丁开头写一段说明（改了哪类写法、为什么）。
- PostgreSQL 17；容器 `jiuan-pg`，只绑 `127.0.0.1:5433`，数据目录 `/var/lib/jiuan-pg`，`TZ=Asia/Shanghai`；库 `jiuan`（`UTF8`、`C` 排序，`ALTER DATABASE jiuan SET timezone = 'Asia/Shanghai'`），属主 `jiuan_app`，`REVOKE CONNECT ON DATABASE jiuan FROM PUBLIC`。
- 读出来的值和 mysql2 一样：`bigint` / `count(*)` → number（超 2^53 报错）；`numeric` → string；`timestamp` 的墙上时间按 UTC 解析成 `Date`；`Date` 参数序列化成不带时区的 UTC 墙上时间 `YYYY-MM-DD HH:MM:SS.mmm`；`jsonb` → 对象；`bytea` → `Buffer`；MySQL 的 `BOOLEAN` / `TINYINT` 列在 PG 里是 `smallint`。
- SQL 里继续用 `?` 占位符；不许用 jsonb 的 `?` / `?|` / `?&` 运算符（用 `jsonb_exists` 等函数）。
- 新密钥 `BENCH_PG_SUPERUSER_PASSWORD`、`JIUAN_PG_APP_PASSWORD`：缺了才补、已有的永不改；`JIUAN_DATA_KEY` 不变；旧的两个 MySQL 口令留在 `secrets.env` 里。
- 不打印密钥；搬迁和测试的输出只有表名、行数、校验值、测试名，不打印数据内容；制度原文不进日志。
- 线上（AWS、Nexus、实例）的写操作先演练；项目负责人 2026-11-06 定：测试和演练全过就直接切换。推送要端到端通过、项目负责人确认。
- 测试都在远端实例上跑（不在本机用 Docker）；本机只跑不需要数据库的测试。
- 九安自带测试的及格线：MySQL 基线里过的，PG 上必须还过；基线里不过的列出来、不修。集成测试只改连接、建表、清理，不改断言；要改断言的单独列出理由。

## Review Focus

1. **`Date` 参数在和 `CURRENT_TIMESTAMP` 比较或写进 `timestamp` 列时不能差 8 小时**（会话时区是上海）：Task 2 加测试「`Date('2026-11-05T08:00:00.000Z')` 写进 `timestamp(3)` 再读出来毫秒不差」「`SELECT ?::timestamp` 原样」「`CURRENT_TIMESTAMP::timestamp(3)` 是上海墙上时间（比 `Date.now()` 的 UTC 墙上时间快 8 小时 ± 1 秒）」。
2. **字符串、带引号的标识符、注释、`::` 类型转换里的 `?` / `:` 不能被换成占位符**：Task 2 的占位符测试逐类覆盖。
3. **`ON CONFLICT` 冲突目标选错**：MySQL 碰上任何唯一键都会更新，PG 只认写明的那个：Task 4 输出「有多个唯一键的表」清单，Task 5–10 里每个改到这些表的 upsert 各加一条「按第二个唯一键冲突」的集成测试。
4. **`affectedRows` 和布尔表达式的值变了**：MySQL upsert 是 1 / 2 / 0，PG 是 1；MySQL 里 `SELECT a > b AS flag` 是 1 / 0，PG 是 `true` / `false`：Task 2 测 OkPacket；Task 5–10 每个用 `.affectedRows` 判断「插入还是更新」的地方、每个读布尔表达式的地方各有测试（布尔表达式统一写 `::int`）。
5. **原来不分大小写的比较变成分大小写**（MySQL 库是 `utf8mb4_unicode_ci`）：Task 9（单据检索在那里）把 `LIKE` 改成 `ILIKE` 并测「大小写不同也能搜到」；Task 11 跑一遍「按文字查的列」清单（账号、公司编号、单据编号、邮箱），确实依赖不分大小写的用 `lower()` 并各加一条测试。

---

## 文件地图

| 文件 | 新建 / 改 | 管什么 |
|---|---|---|
| `poc/bench/build-jiuan.sh` | 改 | 加 `--with-tests`：多复制 `tests/`，再打 `patches/jiuan-v0.7.10/tests/*.patch`；依赖装 `pg`（和搬迁工具用的 `mysql2`） |
| `poc/bench/package.json`、`package-lock.json` | 改 | `pg` 8.16.3、`mysql2` 3.14.3，都钉死 |
| `poc/infra/lib/bench-secrets.sh` | 新 | `ensure_bench_secrets <secrets 文件>`：从 `deploy.sh` 搬出来的「缺了才补」，加两项 PG 密钥 |
| `poc/infra/bench/pg-install.sh` | 新 | 实例上起 / 确认容器 `jiuan-pg` |
| `poc/infra/bench/test-databases.sh` | 新 | 实例上建 / 删测试库：PG 和 MySQL 各一个 `jiuan_test` |
| `poc/infra/remote-jiuan-tests.sh` | 新 | 本机运行：构建带测试的副本、传到实例、跑、取回结果 JSON、清理 |
| `poc/infra/pg-prepare.sh` | 新 | 本机运行：补密钥、把 `pg-install.sh` 和超级用户口令送到实例、起 `jiuan-pg`、建测试库 |
| `patches/jiuan-v0.7.10/0008…0017` 和 `tests/0008…0017` | 新 | 见 Task 2–11 |
| `poc/app/settings.mjs`、`reviews.mjs`、`kb-cache.mjs`、`server.mjs` | 改 | 外壳用 PG |
| `poc/infra/bench/bench-configure.sh`、`bench-reset.sh`、`deploy.sh`、`migrate-data.sh`、`backup.sh`、`upgrade-instance.sh`、`andon-finance-poc.yaml`（注释） | 改 | 实例上的脚本用 PG |
| `poc/infra/bench/mysql-install.sh` | 删 | 切换完成后（Task 16） |
| `poc/bench/mysql-to-pg.mjs` | 新 | 一次性搬迁：复制、核对 |
| `poc/infra/migrate-mysql-to-pg.sh` | 新 | 本机运行：经 SSH 在实例上跑搬迁工具 |
| `poc/app/test/unit/*`、`poc/infra/test/*` | 改 / 新 | 跟着改 |

---

### Task 1: 远端测试环境和 MySQL 基线

**Files:**
- Create: `poc/infra/lib/bench-secrets.sh`、`poc/infra/bench/pg-install.sh`、`poc/infra/bench/test-databases.sh`、`poc/infra/pg-prepare.sh`、`poc/infra/remote-jiuan-tests.sh`
- Modify: `poc/bench/build-jiuan.sh`、`poc/bench/package.json`、`poc/bench/package-lock.json`、`poc/infra/deploy.sh`（bench-secrets 段改成调 `ensure_bench_secrets`）
- Test: `poc/infra/test/bench-infra.test.mjs`、`poc/infra/test/infra.test.mjs`、`poc/infra/test/bench-build.test.mjs`
- Output (commit): `poc/bench/pg-port/baseline-mysql.json`

**Interfaces:**
- Produces: `ensure_bench_secrets <file>`（bash；补 `BENCH_MYSQL_ROOT_PASSWORD`、`JIUAN_MYSQL_APP_PASSWORD`、`JIUAN_DATA_KEY`、`BENCH_PG_SUPERUSER_PASSWORD`（`openssl rand -hex 16`）、`JIUAN_PG_APP_PASSWORD`（同）；已有的不改；旧名字 `JIUAN07_*` 原地改名的逻辑一起搬过来）
- Produces: `build-jiuan.sh [--out <目录>] [--patches <目录>] [--with-tests]`
- Produces: `pg-install.sh`（root，在实例上；读 `/etc/andon-finance/bench/pg_superuser_password`；输出最后一行 `BENCH_PG_READY`）
- Produces: `test-databases.sh create|drop`（root；口令写在 `/etc/andon-finance/test/pg_test_password`、`mysql_test_password`，root 0600，没有就生成；`create` 先删再建，保证干净；输出 `TEST_DATABASES_READY` / `TEST_DATABASES_DROPPED`）
- Produces: `DEPLOY_ENV=… remote-jiuan-tests.sh --engine mysql|pg [--only '<glob>'] [--patches <目录>] --out <结果.json>`；结果 JSON 形如 `{ "tests/x.test.mjs": { "<测试名>": "pass"|"fail"|"skip" } }`；退出码 0 只表示跑完了（及格与否由比较决定）
- Produces: `node poc/infra/test/compare-jiuan-results.mjs <基线.json> <这次.json>`：基线里 pass 的这次不是 pass 就列出来、退出 1

- [ ] **Step 1: 测试先行**：`bench-infra.test.mjs` 加：`pg-install.sh` 绑 `127.0.0.1:5433`、`TZ=Asia/Shanghai`、数据目录 `/var/lib/jiuan-pg`、超级用户口令只从文件读（`POSTGRES_PASSWORD_FILE`）、镜像 `postgres:17`、容器在且参数对就不重建；`test-databases.sh` 的库名都以 `_test` 结尾、`create` 先 drop、PG 那边 `ALTER DATABASE jiuan_test SET timezone = 'Asia/Shanghai'`。`infra.test.mjs` 的 bench-secrets 测试改成测 `ensure_bench_secrets`，加两项 PG 密钥（32 位十六进制、只补不换）。`bench-build.test.mjs` 加：`--with-tests` 时有 `tests/`、打了 `tests/*.patch`，不带时没有 `tests/`；`seeds/` 两种情况都不带。
- [ ] **Step 2:** 跑 `cd poc/infra && node --test "test/**/*.test.mjs"`，新加的失败。
- [ ] **Step 3:** 实现上面五个脚本和 `build-jiuan.sh --with-tests`；`remote-jiuan-tests.sh` 复用 `lib/deploy-env.sh`、`lib/remote.sh`（`ssh_setup`、`remote_root`），用 `rsync -e "ssh ${SSH_OPTS[*]}"` 传到实例上的 `/var/tmp/jiuan-pgtest.XXXXXX`（属主 root，0700），在实例上拼测试库的 URL（口令从实例上的文件读，不经本机），`node --test --test-concurrency=1 --test-timeout=180000 --test-reporter=tap`，TAP 取回本机转成 JSON，最后删远端目录。
- [ ] **Step 4:** 本机测试全过：`cd poc/infra && node --test "test/**/*.test.mjs"`。
- [ ] **Step 5（线上，只在实例上加东西，不动服务）：** `DEPLOY_ENV=poc/infra/env/m7g.env bash poc/infra/pg-prepare.sh`，看到 `BENCH_PG_READY`、`TEST_DATABASES_READY`；`docker ps` 里有 `jiuan-pg`，`andon-jiuan` 照常在跑（`/poc/healthz` 回 `ok`）。
- [ ] **Step 6: 基线**：`remote-jiuan-tests.sh --engine mysql --out poc/bench/pg-port/baseline-mysql.json`（只有补丁 0001–0007）。记下 pass / fail / skip 的个数。
- [ ] **Step 7: 提交**：`git add` 上面的文件和 `baseline-mysql.json`；`git commit -m "pg-port: remote test harness, jiuan-pg container, MySQL baseline of Jiuan's tests"`。

### Task 2: 补丁 0008：`pg` 适配层

**Files:**
- Create（在补丁里）：`src/pg-database.mjs`；测试 `tests/pg-database.test.mjs`（在 `tests/0008-pg-adapter.patch` 里）
- Patch files: `patches/jiuan-v0.7.10/0008-pg-adapter.patch`、`patches/jiuan-v0.7.10/tests/0008-pg-adapter.patch`

**Interfaces（`src/pg-database.mjs` 导出，后面的任务都靠它）:**
```js
export function parsePgUrl(url)                       // → { host, port, user, password, database, ssl }；协议只认 postgres:// 和 postgresql://
export function createPgPool({ url, connectionLimit = 10, connectTimeout = 10000, acquireTimeoutMs = 0, queryTimeoutMs = 0, ssl } = {})
// pool.query(sqlOrOptions, params)    sqlOrOptions: string | { sql, timeout }
//   SELECT / RETURNING → [rows, fields]；其余 → [{ affectedRows, insertId, changedRows }, []]
// pool.execute(...) 同 query
// pool.getConnection() → { query, execute, beginTransaction, commit, rollback, release, destroy }
// pool.end()
export function toPgPlaceholders(sql)                 // → { text, count }
export function pgErrorToMysqlShape(error)            // → 带 code / errno / sqlState / cause 的 Error
export const PG_ERROR_CODES                           // { CONFIGURATION: 'PG_CONFIGURATION', MIGRATION_LOCKED: 'PG_MIGRATION_LOCKED', MIGRATION_DRIFT: 'PG_MIGRATION_DRIFT' }
```
- 连接池参数的取值范围和报错照 `createMySqlPool`（`connectionLimit` 1–100 等）。
- 每个新连接：`SET TIME ZONE 'Asia/Shanghai'`，`SET statement_timeout`（有 `queryTimeoutMs` 时）。
- 类型解析器按 Global Constraints；`insertId`：结果有行时取第一行第一列，否则 0；`changedRows` = `affectedRows`。
- 错误码：`23505` → `ER_DUP_ENTRY`（errno 1062）、`40P01` → `ER_LOCK_DEADLOCK`（1213）、`55P03` → `ER_LOCK_WAIT_TIMEOUT`（1205）、`57014` → 实现前 `grep` 九安里查询超时时调用方检查的码，照它给；其余保留 PG 的 `code`。

- [ ] **Step 1: 开发树**：`bash poc/bench/build-jiuan.sh --with-tests --out .build/jiuan-dev`，在里面 `git init && git add -A && git commit -qm base`（之后每个补丁都这样从「前面补丁都打上」的状态开始）。
- [ ] **Step 2: 写测试** `tests/pg-database.test.mjs`（`skip: !process.env.PG_TEST_URL`），至少这些：
  - 占位符：`SELECT ? AS a, '?' AS b, "x?" AS c -- ?\n /* ? */ , ?::int AS d` 换出 `$1`、`$2` 各一次，字符串、标识符、注释里的不动，`::` 不动；`count` 等于参数个数，参数个数不对就报错；
  - 返回形状：`INSERT … RETURNING id` 的 `insertId`；`UPDATE` 的 `affectedRows`；`SELECT` 是 `[rows, fields]`；
  - 类型：`SELECT 9007199254740993::bigint` 报错，`count(*)` 是 number，`1.50::numeric` 是 `'1.50'`，`'{"a":1}'::jsonb` 是对象，`'\\x00ff'::bytea` 是两字节的 Buffer，`1::smallint` 是 1；
  - 时间（Review Focus 1）：上面三条；
  - 错误：重复主键 → `code === 'ER_DUP_ENTRY'`、`errno === 1062`；`{ sql: 'SELECT pg_sleep(2)', timeout: 200 }` 超时报设计里定的那个码；
  - 拿连接超时：`connectionLimit: 1`、`acquireTimeoutMs: 200`，一个连接不还，第二个 200 毫秒左右报错；
  - 事务：`beginTransaction` / `rollback` 之后数据没写进去。
- [ ] **Step 3:** `remote-jiuan-tests.sh --engine pg --only 'tests/pg-database.test.mjs' --patches <开发树的补丁目录>`，失败（模块不存在）。
- [ ] **Step 4:** 实现 `src/pg-database.mjs`（占位符转换按 SQL 词法走一遍：单引号字符串（含 `''` 转义）、`E'…'`、`$tag$…$tag$`、双引号标识符、`--` 和 `/* */` 注释里不换）。
- [ ] **Step 5:** 同一条命令，全过。
- [ ] **Step 6:** 生成补丁：`git -C .build/jiuan-dev diff -- src providers public analysis-server.mjs package.json > patches/jiuan-v0.7.10/0008-pg-adapter.patch`，`git -C .build/jiuan-dev diff -- tests > patches/jiuan-v0.7.10/tests/0008-pg-adapter.patch`，补丁头加说明；`bash poc/bench/build-jiuan.sh` 和 `--with-tests` 都能打上。
- [ ] **Step 7: 提交** `git commit -m "pg-port 0008: pg adapter with mysql2-shaped results, types and error codes"`。

### Task 3: 补丁 0009：命名锁

**Files:** `patches/jiuan-v0.7.10/0009-pg-named-locks.patch`（改 `src/pg-database.mjs`）、`tests/0009-pg-named-locks.patch`（`tests/pg-named-locks.test.mjs`）

**Interfaces:**
```js
export function namedLockKey(name)                         // → BigInt：sha256(name) 前 8 字节按有符号 64 位
export async function acquireNamedLock(conn, name, seconds) // → true（拿到）/ false（超时），对应 GET_LOCK 的 1 / 0；seconds = 0 时只试一次
export async function releaseNamedLock(conn, name)          // → true（释放了）/ false（不是本连接占着），对应 RELEASE_LOCK 的 1 / 0
export async function isNamedLockUsed(conn, name)           // → 占着它的后端 pid（number）或 null，对应 IS_USED_LOCK
```
- 等锁：`SET lock_timeout = '<seconds>s'` → `SELECT pg_advisory_lock($1)`，`55P03` 时回 false；完了把 `lock_timeout` 恢复成 0。`seconds = 0`：`pg_try_advisory_lock`。

- [ ] **Step 1: 测试**：两个连接抢同一把锁（第二个在 1 秒上限里拿不到 → false）；第一个释放后第二个拿到；`releaseNamedLock` 在不占锁的连接上 → false；`isNamedLockUsed` 回占锁连接的 pid（`SELECT pg_backend_pid()` 对得上），没人占 → null；连接断开锁自动释放；`namedLockKey('jiuan:pg:schema')` 每次一样、和 `namedLockKey('jiuan:pg:schemb')` 不一样。
- [ ] **Step 2:** 远端跑，失败。**Step 3:** 实现。**Step 4:** 远端全过。**Step 5:** 生成两个补丁（同 Task 2 Step 6）。**Step 6: 提交** `"pg-port 0009: named locks on advisory locks"`。

### Task 4: 补丁 0010：基线表结构、迁移、表结构核对

**Files:** `patches/jiuan-v0.7.10/0010-pg-baseline-schema.patch`（新 `src/pg-schema.mjs`；改 `src/pg-database.mjs`、`src/mysql-analysis-store.mjs` 第 206 行一带改调 `migratePg`、`src/platform/platform-routes.mjs` 第 7、339–345 行改用 PG 的迁移清单）、`tests/0010-pg-baseline-schema.patch`

**Interfaces:**
```js
// src/pg-schema.mjs
export const PG_BASELINE_SCHEMA           // 一段 DDL：MySQL 第 1–19 个迁移跑完后的 73 张表、索引、外键、CHECK 的 PG 写法
export const PG_SCHEMA_FINGERPRINT        // { sha256, listing }：新建库跑完迁移后从系统目录读出的规范清单
export function readSchemaListing(conn)   // → 规范清单文字：表、列（类型、可空、缺省）、索引定义、约束定义，按名字排序
// src/pg-database.mjs
export const PG_MIGRATIONS                // [{ version: 19, name: 'postgres-baseline', sql: PG_BASELINE_SCHEMA }]，以后的迁移从 20 起
export function migrationChecksum(migration)
export function classifyMigrationVersions(appliedRecords, knownMigrations = PG_MIGRATIONS)
export function splitSqlStatements(sql)
export async function migratePg(pool, { migrations = PG_MIGRATIONS, lockName = 'jiuan:pg:schema', lockTimeout = 30 } = {})
export async function pgHealth(pool)
```
- 类型对照（Global Constraints 之外）：`DATETIME(n)` → `timestamp(n)`；`DEFAULT CURRENT_TIMESTAMP(n)` → `DEFAULT LOCALTIMESTAMP(n)`（会话是上海时区，结果和 MySQL 一样）；`ON UPDATE CURRENT_TIMESTAMP` 的 10 列：在 PG 里写成一个通用触发器函数 `jiuan_touch_updated_at()`，每张这样的表挂一个 `BEFORE UPDATE` 触发器（统一用触发器，调用方不用改）；`INT UNSIGNED` → `bigint CHECK (col >= 0)`；`BIGINT UNSIGNED` → `numeric(20,0)` 还是 `bigint`：实现时看真实取值（自增主键用 `bigint GENERATED BY DEFAULT AS IDENTITY`）；`JSON` → `jsonb`；`LONGBLOB` / `BLOB` → `bytea`；`TEXT` / `LONGTEXT` → `text`；`VARCHAR(n)` 照旧；`BOOLEAN` / `TINYINT(1)` → `smallint CHECK (col IN (0,1))`；`ENGINE=`、`CHARSET`、`COLLATE` 去掉。
- `migratePg`：拿锁（Task 3），建 `schema_migrations`（列照 MySQL 的那张），没执行过就在一个事务里执行，登记版本和 checksum；之后读 `readSchemaListing`，和 `PG_SCHEMA_FINGERPRINT.sha256` 不一样就报 `PG_MIGRATION_DRIFT`（报错里带上和期望清单的前几行差异）。
- 同时输出「有多个唯一键（含主键）的表」清单，写进补丁说明（Review Focus 3 用）。

- [ ] **Step 1: 测试**：空库 `migratePg` 后 73 张表都在（表名清单和 MySQL 那边 `information_schema.tables` 的一致，清单写进测试）；再跑一次是空操作；两个连接同时 `migratePg` 只执行一次；手工 `ALTER TABLE … ADD COLUMN x int` 后再启动 → `PG_MIGRATION_DRIFT`；`PG_SCHEMA_FINGERPRINT.sha256` 等于新库读出来的；带 `ON UPDATE CURRENT_TIMESTAMP` 的表 UPDATE 后 `updated_at` 变了、是上海墙上时间；`platform-routes` 的迁移状态接口在新库上报「已是最新」。
- [ ] **Step 2–4:** 远端失败 → 实现 → 远端全过（`--only` 跑本任务的测试 + `tests/pg-database.test.mjs`、`tests/pg-named-locks.test.mjs`）。
- [ ] **Step 5:** 生成两个补丁，提交 `"pg-port 0010: PostgreSQL baseline schema, migration and drift check"`。

### Task 5–10: 补丁 0011–0016：按模块改查询

每个任务同一个做法；文件分组照下表。**每个任务**：

**Files:** 下表那几个 `src/` 文件；它们对应的集成测试（`grep -l` 这些模块名的 `tests/*.integration.test.mjs`）；补丁 `0011-…` 到 `0016-…` 各一对。

**Interfaces:** Consumes Task 2–4 的全部导出。调用方原来拼 `GET_LOCK` / `RELEASE_LOCK` / `IS_USED_LOCK` 的地方改调 `acquireNamedLock` / `releaseNamedLock` / `isNamedLockUsed`。

| 任务 | 补丁 | 文件 |
|---|---|---|
| 5 | 0011-pg-analysis-store | `src/mysql-analysis-store.mjs`、`src/analysis-store.mjs`、`src/agent-reference-store.mjs`、`src/full-sync-lock.mjs` |
| 6 | 0012-pg-attachments | `src/mysql-attachment-store.mjs`、`src/analysis-documents-admin.mjs` |
| 7 | 0013-pg-report-detail | `src/report-detail-queue.mjs`、`src/report-detail-projection.mjs` |
| 8 | 0014-pg-platform | `src/platform/platform-store.mjs`、`platform-routes.mjs`、`agent-runner.mjs`、`call-middleware.mjs`、`pipeline-progress.mjs`、`adapters/ai-advice.mjs`、`adapters/element-check.mjs` |
| 9 | 0015-pg-elements-search | `src/element-store.mjs`、`src/element-registry.mjs`、`src/scan/scan-engine.mjs`、`src/scan/scan-context.mjs`，以及单据检索（`document-search` 相关的查询，Review Focus 5：`LIKE` → `ILIKE`） |
| 10 | 0016-pg-approval-sap-source | `src/approval-writeback.mjs`、`src/sap-payment-store.mjs`、`src/sap-payment-refresh.mjs`、`src/mysql-source-foundation.mjs`、`src/sap-supplier-analysis-service.mjs`、`server.mjs` 里那一条（如果在副本里） |

改写规则（设计第 6.2 节，逐条照做）：反引号 → 双引号；`ON DUPLICATE KEY UPDATE c = VALUES(c)` → `ON CONFLICT (<唯一键>) DO UPDATE SET c = EXCLUDED.c`；`INSERT IGNORE` → `ON CONFLICT DO NOTHING`（先确认没依赖它吞别的错）；`JSON_EXTRACT(c,'$.a')` → `c->'a'`、`JSON_UNQUOTE(JSON_EXTRACT(…))` → `c->>'a'`、`JSON_OBJECT` → `jsonb_build_object`、`JSON_ARRAY` → `jsonb_build_array`；`IFNULL` → `COALESCE`；`IF(a,b,c)` → `CASE WHEN a THEN b ELSE c END`；`UTC_TIMESTAMP(n)` → `(now() AT TIME ZONE 'UTC')::timestamp(n)`；`CURRENT_TIMESTAMP(n)` / `NOW(n)` 写进 `timestamp` 列 → `LOCALTIMESTAMP(n)`；`DATE_SUB(x, INTERVAL ? SECOND)` → `x - make_interval(secs => ?)`（其他单位同理）；`TIMESTAMPDIFF(SECOND,a,b)` → `EXTRACT(EPOCH FROM (b - a))`；`LIMIT ?, ?` → `LIMIT ? OFFSET ?`（注意参数顺序对调）；`REGEXP` → `~`；`SELECT … FOR UPDATE SKIP LOCKED` 照旧；布尔表达式出现在 SELECT 列表里的加 `::int`；`WHERE smallint_col` → `WHERE smallint_col = 1`；`INSERT` 后用到 `insertId` 的加 `RETURNING <自增列>`；用 `.affectedRows` 区分插入 / 更新 / 没变的，改成 `RETURNING (xmax = 0)::int AS inserted` 或比较前后值。

- [ ] **Step 1: 测试先行**：把这组的集成测试改成 PG（`MYSQL_TEST_URL` → `PG_TEST_URL`，`createMySqlPool` → `createPgPool`，`migrateMySql` → `migratePg`，`parseMySqlUrl` → `parsePgUrl`，`'../src/mysql-database.mjs'` → `'../src/pg-database.mjs'`，测试自己的建表、清理 SQL 照上面的规则改；断言不动）；再加 Review Focus 3、4 要的测试（本组改到的多唯一键表的 upsert、`affectedRows` 判断、布尔列）。
- [ ] **Step 2:** `remote-jiuan-tests.sh --engine pg --only '<本组的测试文件>'`，失败。
- [ ] **Step 3:** 照规则改本组文件的 SQL。
- [ ] **Step 4:** 同一条命令，本组测试和基线比（`compare-jiuan-results.mjs`）：基线里 pass 的都 pass；Task 2–4 的测试也还过。
- [ ] **Step 5:** 生成两个补丁（补丁头列出本组改了哪几类写法、动了哪些断言和为什么），提交 `"pg-port 00NN: <组名> on PostgreSQL"`。

### Task 11: 补丁 0017：引擎切到 PostgreSQL、去掉 MySQL、全量回归

**Files:** `patches/jiuan-v0.7.10/0017-pg-engine.patch`：`src/analysis-database.mjs`（`analysisDatabaseEngine` 只认 `'postgres'`；`createAnalysisDatabase` 用 `createPgPool`；URL 覆盖用 `ANALYSIS_DATABASE_URL`；端口缺省 5432；错误文案「正式分析仅支持 PostgreSQL 数据库。」）、`src/analysis-config.mjs`（`postgres` 的配置校验照原来 MySQL 那条的规则写，去掉 `127.0.0.1:55432` / `jiuan_analysis` 的旧特例；`ecs-docker` 要求 `engine === 'postgres'`，文案「ECS 配置必须使用 PostgreSQL、挂载密钥及已核验的钉钉账号。」）、删除 `src/mysql-database.mjs`、`src/mysql-sync-database.mjs`、`src/mysql-sync-worker.mjs`，`src/db.mjs` 去掉 `mysql://` 那一支和它的 import，`package.json` 的 `dependencies` 去掉 `mysql2`；`tests/0017-pg-engine.patch`：约 10 个专测 MySQL 模块或 MySQL SQL 文字的测试改写或删除（逐个在补丁头写理由）；新测试 `tests/pg-runtime-graph.test.mjs`。

- [ ] **Step 1: 测试**：`pg-runtime-graph.test.mjs`：从外壳加载的那些入口（`poc/app/jiuan.mjs` 列的 33 个 `src/` 模块）出发静态走一遍 import，没有一个模块 import `mysql2`、`mysql-database.mjs`；`analysis-database` 用 `engine: 'mysql'` 报 `ANALYSIS_DATABASE_ENGINE_UNSUPPORTED`；`analysis-config` 接受 `{ engine: 'postgres', host: '127.0.0.1', port: 5433, database: 'jiuan', user: 'jiuan_app' }`；Review Focus 5 的「按文字查的列」清单逐列判断，确实依赖不分大小写的各一条测试。
- [ ] **Step 2–3:** 远端失败 → 实现。
- [ ] **Step 4: 全量**：`remote-jiuan-tests.sh --engine pg --out poc/bench/pg-port/after-pg.json`，`compare-jiuan-results.mjs baseline-mysql.json after-pg.json` 退出 0（Task 11 删掉的测试按补丁头的清单从比较里排除，比较脚本读一个 `poc/bench/pg-port/removed-tests.json`）。
- [ ] **Step 5:** 生成补丁，提交 `after-pg.json`、`removed-tests.json` 和补丁，`"pg-port 0017: PostgreSQL is the only engine; MySQL modules removed"`。

### Task 12: 测试台外壳

**Files:** Modify `poc/app/settings.mjs`（环境变量 `POC_DB_HOST`（缺省 `127.0.0.1`）、`POC_DB_PORT`（5433）、`POC_DB_NAME`（`jiuan`）、`POC_DB_USER`（`jiuan_app`）；`engine: 'postgres'`；密钥文件 `db_app_password`）、`poc/app/reviews.mjs`（DDL：`id bigint GENERATED BY DEFAULT AS IDENTITY`、`created_at timestamp(3)`、去掉 MySQL 表选项；`insertId` 用 `RETURNING id`）、`poc/app/kb-cache.mjs`（`fetched_at timestamp(3)`、`body text`、`ON CONFLICT (scope, cache_key) DO UPDATE`）、`poc/app/server.mjs`（第 82 行那条查询）；Test: `poc/app/test/unit/reviews.test.mjs`、`kb-cache.test.mjs`、`helpers/fake-kb-cache-pool.mjs`、`settings-guard.test.mjs`，新 `poc/app/test/unit/pg-stores.test.mjs`（`skip: !process.env.PG_TEST_URL`）。

- [ ] **Step 1: 测试**：假 pool 认新的 SQL；`pg-stores.test.mjs` 在真 PG 上：复核写入读出（`createdAt` 的毫秒不差、按 UTC）、知识库缓存的 upsert（同键第二次覆盖、`fetchedAt` 更新）、`settings` 缺省是 5433 / `jiuan` / `jiuan_app` / `postgres`。
- [ ] **Step 2:** 本机 `cd poc/app && node --test "test/unit/**/*.test.mjs"`：新的失败；`remote-jiuan-tests.sh` 加 `--shell-tests` 选项把外壳的单元测试也传过去跑（真 PG 那几条）。
- [ ] **Step 3–4:** 实现 → 本机全过、远端 `pg-stores.test.mjs` 过。
- [ ] **Step 5: 提交** `"pg-port: shell stores and settings on PostgreSQL"`。

### Task 13: 实例上的脚本

**Files:** Modify `poc/infra/bench/bench-configure.sh`（调 `pg-install.sh`；`psql` 里建角色 `jiuan_app`（口令按 `JIUAN_PG_APP_PASSWORD` 重设）、库 `jiuan`（`OWNER jiuan_app ENCODING UTF8 LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`）、`REVOKE CONNECT … FROM PUBLIC`、`ALTER DATABASE jiuan SET timezone`；外壳 env 写 `POC_DB_*`；密钥文件 `db_app_password`；不再调 `mysql-install.sh`、不再建 MySQL 的库和账号；legacy-07 段里 MySQL 改名那几行删掉（m7g 上已经改完））、`bench-reset.sh`（`docker exec jiuan-pg psql` / `pg_dump`：导出 `analysis_sync_states` 里 `scope_key LIKE 'agent-enablement:%'` 的行（`COPY (SELECT …) TO STDOUT`，二进制列原样），`DROP DATABASE jiuan` / `CREATE DATABASE …`（同 configure 的参数），起服务等迁移，停服务 `COPY … FROM STDIN` 写回，起服务；失败也起服务、导出不删）、`deploy.sh`（构件带 `pg-install.sh`；`ensure_bench_secrets`）、`migrate-data.sh`（九安的库改用 `pg_dump -Fc` / `pg_restore`，逐表核对改查 PG）、`backup.sh`、`upgrade-instance.sh`、`andon-finance-poc.yaml`（只改注释里的 MySQL，不改用户数据：改用户数据会让实例重启）、`poc/infra/secrets.env.example`（两项新密钥的说明）；Test: `poc/infra/test/*`。

- [ ] **Step 1: 测试先行**：`bench-infra.test.mjs`、`infra.test.mjs` 里所有 MySQL 断言换成 PG 的（容器名、端口、建库参数、`REVOKE CONNECT`、时区、重置的导出用 `COPY`、失败也起服务）；加一条「模板的用户数据和改之前逐字相同」。`poc/app/test/e2e/api.e2e.mjs` 加一条（经 SSH 只读）：实例上 `jiuan-pg` 在跑、`jiuan-mysql` 停了或不存在、外壳 env 里 `POC_DB_PORT=5433`；它要到 Task 16 切换后才会过。
- [ ] **Step 2–4:** 失败 → 实现 → `cd poc/infra && node --test "test/**/*.test.mjs"` 全过。
- [ ] **Step 5: 提交** `"pg-port: instance scripts use PostgreSQL"`。

### Task 14: 搬迁工具

**Files:** Create `poc/bench/mysql-to-pg.mjs`、`poc/infra/migrate-mysql-to-pg.sh`；Test: `poc/bench/test/mysql-to-pg.test.mjs`（`skip` 除非 `MYSQL_TEST_URL` 和 `PG_TEST_URL` 都给）。

**Interfaces:**
- `node mysql-to-pg.mjs --mysql <url> --pg <url> [--create-schema <九安副本目录>] [--dry-run] [--replace] [--batch 1000] [--only <表,…>]`；`--create-schema` 先 import 那个副本的 `src/pg-database.mjs` 跑 `migratePg` 建表；标准输出每表一行 `TABLE <名> rows=<n> mysql=<sha256> pg=<sha256> OK|MISMATCH`，最后一行 `MIGRATE_OK` 或 `MIGRATE_FAILED <原因>`；退出码 0 只在全部一致时。
- `DEPLOY_ENV=… migrate-mysql-to-pg.sh --target jiuan|jiuan_rehearsal [--create-db] [--drop-db] [--dry-run]`：本机先 `build-jiuan.sh` 到临时目录，把工具、`poc/bench/node_modules`、这份副本经 SSH（`rsync`）传到实例上的 `/var/tmp/jiuan-migrate.XXXXXX`（root 0700），在实例上用口令文件拼两边的 URL（MySQL 用 root 读库 `jiuan`；PG 用 `jiuan_app` 连目标库），带 `--create-schema` 跑工具，最后删临时目录；`--create-db` 先以 `postgres` 建目标库（属主、编码、排序、时区同 Task 13 的 `jiuan`），`--drop-db` 只许删 `jiuan_rehearsal`。
- 规范化行（算 sha256 用）：按主键排序；每列：`null` → `\N`；时间 → 两边各自的原文字补齐到 6 位小数（MySQL 用 `dateStrings: true` 读，PG 用 `to_char(col, 'YYYY-MM-DD HH24:MI:SS.US')`）；JSON → 按键递归排序后的 `JSON.stringify`；二进制 → hex；数字 → 十进制字符串；文字 → 原样；列之间 `\t`、行之间 `\n`。
- 复制顺序：按外键依赖拓扑排序（从 PG 的 `pg_constraint` 读）；自增列复制原值后 `setval` 到最大值；目标表不是空的就停（除非 `--replace`，先 `TRUNCATE … CASCADE`）。

- [ ] **Step 1: 测试**：在两个测试库里各建表：MySQL 那边用只打了补丁 0001–0007 的副本（`build-jiuan.sh --patches <只含 0001–0007 的临时目录> --out <目录>`）里的 `migrateMySql`，`remote-jiuan-tests.sh` 加 `--mysql-build <目录>` 把它一起传上去，测试从环境变量 `JIUAN_MYSQL_BUILD` 指的目录 import；PG 那边用 `--create-schema`；往 MySQL 造一份覆盖全部列类型的数据（二进制含 `\x00`、JSON 嵌套、`DATETIME(6)` 带微秒、空值、中文、`INT UNSIGNED` 最大值 4294967295）→ 搬 → 全部 `OK`、`MIGRATE_OK`；再改坏 PG 里一行 → 再核对（`--dry-run` 模式只核对）报 `MISMATCH`、退出 1；目标非空不带 `--replace` → 停。
- [ ] **Step 2–4:** 远端失败 → 实现 → 远端过。
- [ ] **Step 5: 提交** `"pg-port: one-off MySQL to PostgreSQL copy with per-table checksums"`。

### Task 15: 演练（线上，只读 MySQL，服务照常）

- [ ] **Step 1:** `bash poc/infra/backup.sh`（根卷快照），记下快照编号。
- [ ] **Step 2:** `migrate-mysql-to-pg.sh --target jiuan_rehearsal --create-db --dry-run`（只读两边、报告行数），再去掉 `--dry-run`：全部表 `OK`、`MIGRATE_OK`；记下用时。
- [ ] **Step 3:** `migrate-mysql-to-pg.sh --target jiuan_rehearsal --drop-db` 删演练库。任何一步不过就停，修好后从 Task 对应的地方重来。

### Task 16: 切换（线上；设计第 6.5 节的第 2–7 步，演练全过就直接做）

- [ ] **Step 1: 记数**（停服务之前，只读）：人工复核条数和最后一条的编号、知识库缓存条数、单据条数、AI 建议轮次条数、启用记录行数（MySQL 里查）。
- [ ] **Step 2:** 停 `andon-jiuan`。
- [ ] **Step 3:** `migrate-mysql-to-pg.sh --target jiuan --create-db`：`MIGRATE_OK`。
- [ ] **Step 4:** `DEPLOY_ENV=poc/infra/env/m7g.env bash poc/infra/deploy.sh --code-only`（新代码、外壳配到 PG、起服务）；`/poc/healthz` 回 `ok`，日志里没有 `PG_MIGRATION_DRIFT`。
- [ ] **Step 5: 切换后核对**（只读）：Step 1 的几个数一样；「Agent 接入」页（接口 `/api/analysis/v1/platform/agents` 或页面）审批 Agent、知识库 Agent 都就绪；单据池、工作台、知识库页能打开。不对就按设计的回退步骤退回。
- [ ] **Step 6:** `pg_dump -Fc` 一份 `jiuan` 到实例 `/var/backups/jiuan-pg-<时间>.dump`（root 0600）；`docker stop jiuan-mysql`（不删）；删 `poc/infra/bench/mysql-install.sh` 和 `test-databases.sh` 里 MySQL 那一半（提交在 Task 17）。
- [ ] **Step 7: 端到端**：`run.sh` 26 条加 Task 13 新增的那一条，全过。
- [ ] **Step 8:** `test-databases.sh drop`。

### Task 17: 文档、交付包、收尾

- [ ] **Step 1:** 按设计第 8 节改文档（架构与技术评估、工作流、快速上手、交付指南、交接、运维、部署与迭代、PoC 说明、部署说明、补丁清单、`secrets.env.example`），CHANGELOG 加一节（切换时间、停站多久、快照编号、搬了多少表多少行、核对结果、回退办法、MySQL 留到哪天）；`bash docs/build-html.sh` 再 `--check`。
- [ ] **Step 2:** 全部测试：`poc/infra`、`poc/app`、`poc/web`、`audit-agent`；`docs/delivery/make-package.sh` 出包通过。
- [ ] **Step 3:** 提交；整条分支请一位评审看一遍（设计、补丁、搬迁工具）；向项目负责人汇报，等确认后推送、同步交接仓库。
