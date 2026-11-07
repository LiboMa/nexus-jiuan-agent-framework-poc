# 设计：九安 v0.7.10 测试台的数据库从 MySQL 换成 PostgreSQL

2026-11-05 · 状态：项目负责人 2026-11-06 确认（测试在远端实例上做，测试全过就直接切换） · 这份设计只在开发仓库（`docs/specs/` 不进交接仓库和交付包）

## 1. 为什么做

客户（九安）的正式环境已经把数据库换成了 PostgreSQL，但没有给出新的开发包。项目负责人定：**我们手上的 v0.7.10 就是最新的代码**，在本地把九安的数据层改成 PostgreSQL，测试台跟着切过去。以后补丁、验收都以这一版为准。

「无缝」的意思（项目负责人原话）：**数据一条不丢、切过去后一切照常**。切换时可以停站几分钟。

## 2. 目标、非目标、反目标

**目标**
1. 九安 v0.7.10 副本的数据层只用 PostgreSQL：建表、迁移、全部查询、命名锁、开机时的表结构核对。
2. 测试台外壳自己的两张表（`poc_review_decisions`、`poc_kb_cache`）和它直接发的查询也改成 PostgreSQL。
3. 测试台实例上：新起一个 PostgreSQL 容器给九安用，MySQL 里库 `jiuan` 的全部数据搬过去，**逐表核对行数和内容**，然后切换。
4. 切换后：单元测试、九安自带的集成测试（在 PostgreSQL 上跑）、端到端 26 条全过；「Agent 接入」的启用记录、人工复核、知识库缓存、单据和 AI 建议的各轮都在。
5. 文档、部署脚本、交付包跟着更新。

**非目标**
- 不同时支持 MySQL 和 PostgreSQL：新代码只走 PostgreSQL（同时支持两种会让测试量翻倍，客户也已经不用 MySQL）。
- 不改九安的业务逻辑、页面、契约。
- 不碰知识库的 PG（容器 `nexus-pgvector`、库 `nexus`）和 Nexus 一侧。
- 不迁移九安开发包里旧的本地脚本（`scripts/provision-analysis-db.mjs` 等 Windows 上的旧工具）和旧的同步数据库路径（`src/db.mjs` 的 SQLite / `mysql-sync-*`，测试台不加载）。

**反目标**（技术上「能跑」但算失败的）
- 有数据没搬过来，或者搬过来变了样（时间差了时区、数字变成字符串、布尔变了、二进制被改了编码）。
- 换库后行为悄悄变了：大小写比较、排序、`affectedRows` 的含义、唯一冲突、锁等待超时，和 MySQL 时不一样而测试没发现。
- 切到一半停在中间状态（服务起不来、两边都有一部分数据）。
- 「Agent 接入」的启用记录解不开（数据密钥 `JIUAN_DATA_KEY` 和密文必须原样）。

## 3. 约束

- **不直接改九安的源码**：`source/` 里的开发包不动；所有改动做成补丁，从 `0008` 起，打在 `poc/bench/build-jiuan.sh` 构建的副本上，打不上就停。补丁按模块分开，便于评审（第 6.2 节）。
- 九安副本的依赖锁定版本：`pg` 已经在开发包的 `package.json` 里（8.16.3），用它；`mysql2` 从副本的依赖里去掉（证明没有代码还在用它）。
- 测试优先：每个补丁先让对应的测试在 PostgreSQL 上失败，再改通。
- 线上的写操作（建容器、搬数据、切换）先演练、给项目负责人看过再执行；端到端通过、项目负责人确认后才推送。
- 不打印密钥；搬数据的日志里只有表名、行数、校验值，不打印数据内容。
- PostgreSQL 版本：17（和知识库那台一样的大版本），官方镜像 `postgres:17`，arm64。
- **时间照旧**：MySQL 容器按 `TZ=Asia/Shanghai` 运行（2026-11-05 在 m7g 上查：`@@system_time_zone = CST`，`NOW()` 比 `UTC_TIMESTAMP()` 快 8 小时）。所以库自己生成的时间（`DEFAULT CURRENT_TIMESTAMP`、`ON UPDATE CURRENT_TIMESTAMP`、SQL 里写的 `CURRENT_TIMESTAMP(6)`，约 31 列）是上海时间，九安和外壳自己写进去的时间（mysql2 `timezone: 'Z'`）是 UTC。这个混用是九安原来就有的（它自己的 compose 也用上海时区），这次**不改**：PG 也按上海时区运行，时间原样搬、原样读写，切换前后的值可以直接比较。

## 4. 现状（2026-11-05 查的）

- 九安的数据层：`src/mysql-database.mjs`（连接池、19 个迁移、迁移锁、开机时按 MySQL 的 `information_schema` 核对表结构）、`src/analysis-database.mjs`（入口：只认 `engine: 'mysql'`，否则报 `ANALYSIS_DATABASE_ENGINE_UNSUPPORTED`）、`src/analysis-config.mjs`（正式部署配置要求 MySQL）。
- 73 张表；约 30 个文件、400 多处 `query` / `execute`。MySQL 专有的写法：`ON DUPLICATE KEY UPDATE` 31 处、`JSON_EXTRACT` 等 JSON 函数 14 处、`INSERT IGNORE` 8 处、`GET_LOCK` / `RELEASE_LOCK` 8 处、`FOR UPDATE SKIP LOCKED` 6 处、`ON UPDATE CURRENT_TIMESTAMP` 10 处、`ENGINE=InnoDB` 与字符集 72 处、反引号标识符、`CHECK` 约束 90 处。
- 列类型：`JSON` 218、`DATETIME` 121、`INT UNSIGNED` 65、`LONGBLOB` 34（「Agent 接入」的启用记录在 `analysis_sync_states.payload LONGBLOB` 里，加密）、`BIGINT` 23、`BOOLEAN` 8 等。
- 调用方依赖 mysql2 的返回形状：`const [rows] = await pool.query(...)`、`.affectedRows` 25 处、`.insertId` 3 处；依赖 mysql2 的错误码：`ER_DUP_ENTRY` 7 处、`ER_LOCK_WAIT_TIMEOUT` 4 处等。mysql2 连接用 `timezone: 'Z'`，时间按 UTC 读写。
- 九安开发包自带 273 个测试文件，其中 57 个是要真 MySQL 的集成测试（`MYSQL_TEST_URL`，没给就跳过）。我们的构建不复制 `tests/`，这些测试从没在副本上跑过。
- 外壳：`poc/app/reviews.mjs`、`kb-cache.mjs` 各有一张表（MySQL 的 DDL 和 `ON DUPLICATE KEY`），`server.mjs` 有一条直接查 `analysis_sync_states` 的查询；单元测试用只认这些 SQL 的假 pool。补丁 0001–0007 里没有 SQL。
- 实例上：`bench/mysql-install.sh` 起容器 `jiuan-mysql`（mysql:8.0，127.0.0.1:3306，数据目录 `/var/lib/jiuan-mysql`）；`bench/bench-configure.sh` 建库 `jiuan`、账号 `jiuan_app`，写外壳的配置；`bench/bench-reset.sh` 用 `mysqldump` 导出启用记录、删库重建；`migrate-data.sh` 用 `mysqldump` 搬库；`secrets.env` 里有 `BENCH_MYSQL_ROOT_PASSWORD`、`JIUAN_MYSQL_APP_PASSWORD`。

## 5. 目标的样子

```
EC2（m7g.xlarge）
 ├─ andon-jiuan（外壳 + 九安副本）── pg 连接池 ──→ 容器 jiuan-pg（postgres:17，127.0.0.1:5433，库 jiuan，账号 jiuan_app）
 ├─ 容器 nexus-pgvector（知识库，不动）
 └─ 容器 jiuan-mysql（切换后停掉、不删，数据目录留着做回退，项目负责人说删再删）
```

- 九安的 PG 只听本机 `127.0.0.1:5433`（5432 留给知识库那台在私网地址上用，免得混淆）；数据目录 `/var/lib/jiuan-pg`。（我的决定）
- 库 `jiuan`，属主 `jiuan_app`；`REVOKE CONNECT ON DATABASE jiuan FROM PUBLIC`；超级用户 `postgres` 的口令只给 root 读。
- 新的启动密钥：`BENCH_PG_SUPERUSER_PASSWORD`、`JIUAN_PG_APP_PASSWORD`，由 `deploy.sh` 照「缺了才补、已有的不改」生成。`JIUAN_DATA_KEY` 不变。旧的两个 MySQL 口令留在 `secrets.env` 里给回退用。（我的决定）
- 外壳配置里的数据库：`engine: 'postgres'`、`host: 127.0.0.1`、`port: 5433`、`database: jiuan`、`user: jiuan_app`。

## 6. 怎么改

### 6.1 驱动适配层：让调用方几乎不用动

新文件 `src/pg-database.mjs`（补丁 0008）提供和现在 `createMySqlPool` 一样用法的连接池，底层是 `pg`：

- `pool.query(sql 或 { sql, timeout }, params)` → `[rows, fields]`；DML 回 `[{ affectedRows, insertId, changedRows }]`。
- `pool.getConnection()` → 连接对象，有 `query`、`execute`、`beginTransaction`、`commit`、`rollback`、`release`；`pool.end()`。
- **占位符**：SQL 里继续写 `?`，适配层按 SQL 词法（跳过字符串、带引号的标识符、注释）换成 `$1…$n`。因此**禁止用 jsonb 的 `?` / `?|` / `?&` 运算符**，要用 `jsonb_exists()` 等函数。
- **`insertId`**：要它的 INSERT 必须写 `RETURNING <自增列>`，适配层取第一行第一列。
- **`affectedRows`**：PG 的 `rowCount`。MySQL 的 `ON DUPLICATE KEY UPDATE` 是「插入算 1、更新算 2、没变算 0」，PG 的 `ON CONFLICT` 不管插入还是更新都是 1。依赖这个差别的调用方（实现时逐个查 25 处 `.affectedRows`）要改成显式判断（例如 `RETURNING (xmax = 0) AS inserted`，或比较前后值）。
- **类型**（适配层统一设置 `pg` 的类型解析，保持和 mysql2 一样的值）：
  - `bigint` / `count(*)` → JavaScript 数字（超出 2^53 就报错，不悄悄丢精度）；
  - `numeric` → 字符串（和 mysql2 的 DECIMAL 一样）；
  - `timestamp(3/6) without time zone`：读出来时把库里的墙上时间当 UTC 解析成 `Date`（和 mysql2 `timezone: 'Z'` 一样）；写进去时 `Date` 参数也照 mysql2 的做法序列化成**不带时区**的 UTC 墙上时间文字（`YYYY-MM-DD HH:MM:SS.mmm`），不让 PG 按会话时区换算；库和会话的 `TimeZone = 'Asia/Shanghai'`（容器 `TZ=Asia/Shanghai`，库 `ALTER DATABASE jiuan SET timezone`），所以 `CURRENT_TIMESTAMP` 写进 `timestamp` 列的是上海时间，和 MySQL 一样；
  - `jsonb` → 解析好的对象（mysql2 读 JSON 列也是对象）；
  - `bytea` → `Buffer`；
  - MySQL 的 `BOOLEAN` / `TINYINT(1)` → PG 的 `smallint`（读出来仍是 0 / 1 数字，调用方不用改）。
- **超时**：拿连接的上限照旧（`acquireTimeoutMs`）；单条查询的上限用 `statement_timeout`（`{ sql, timeout }` 的写法照旧）；连接上限照旧（请求池 5、锁池 16）。
- **错误码**：把 PG 的 SQLSTATE 映射成调用方在查的 mysql2 错误码：`23505` → `ER_DUP_ENTRY`、`40P01` → `ER_LOCK_DEADLOCK`、`55P03`（锁等待超时）→ `ER_LOCK_WAIT_TIMEOUT`、`57014`（查询超时）→ 现在 mysql2 查询超时时调用方看到的那个码。原来的 PG 错误留在 `cause` 里。实现时先把调用方在查的错误码列全。
- **命名锁**：`GET_LOCK(name, 秒)` / `RELEASE_LOCK(name)` / `IS_USED_LOCK(name)` 换成会话级 advisory 锁：键是 `sha256(name)` 的前 8 字节当有符号 64 位整数；等锁用 `SET lock_timeout` 再 `pg_advisory_lock`，超时报 `ER_LOCK_WAIT_TIMEOUT` 的样子；「被谁占着」查 `pg_locks`。锁池（长期占锁的连接单独一个池）照旧。提供 `acquireNamedLock(conn, name, seconds)`、`releaseNamedLock(conn, name)`、`isNamedLockUsed(conn, name)` 三个函数，调用方原来拼 `SELECT GET_LOCK(...)` 的地方改调它们。
- **事务隔离**：InnoDB 缺省是 REPEATABLE READ，PG 缺省是 READ COMMITTED。九安里已经有两处显式 `READ COMMITTED`；其余照 PG 缺省，靠集成测试发现差别（第 7 节）。

### 6.2 补丁怎么分（从 0008 起，每个都能单独评审、单独测试）

| 补丁 | 内容 |
|---|---|
| 0008 | `src/pg-database.mjs`：适配层、类型、错误码、命名锁；`src/analysis-database.mjs`、`src/analysis-config.mjs` 认 `engine: 'postgres'`，正式部署配置的「必须用 MySQL」改成「必须用 PostgreSQL」，`ANALYSIS_MYSQL_URL` 换成 `ANALYSIS_DATABASE_URL` |
| 0009 | 表结构：一个 PostgreSQL 基线迁移，等于 MySQL 第 1–19 个迁移跑完后的最终结构（73 张表、全部索引、外键、`CHECK`）；迁移记录表照旧，基线登记为第 1–19 版都已执行，以后的迁移从第 20 版接着编；迁移锁用 advisory 锁；开机时的表结构核对改成读 PG 的系统目录（表、列、类型、可空、缺省、索引、外键、`CHECK`），对不上就拒绝启动，和现在一样 |
| 0010 起 | 按模块改查询，每个补丁一组文件（例如：分析存储；附件队列；单据详情与投影；平台存储、调度与调用中间件；要素与扫描；审批写回与 SAP；其余）。每个文件里：反引号换双引号、`ON DUPLICATE KEY UPDATE` 换 `ON CONFLICT (<唯一键>) DO UPDATE SET … = EXCLUDED.…`、`INSERT IGNORE` 换 `ON CONFLICT DO NOTHING`（只吞唯一冲突；MySQL 的 `INSERT IGNORE` 还会吞别的错，逐处确认没有依赖）、JSON 函数换 jsonb 运算符、时间函数换 PG 的写法、命名锁换 6.1 的三个函数、`ON UPDATE CURRENT_TIMESTAMP` 的 10 处改成在 UPDATE 里显式写（或触发器，二选一，统一一种） |
| 最后一个 | 九安副本的 `package.json` 去掉 `mysql2`；删掉不再用的 `mysql-database.mjs` 导出（或整文件），确认没有 `import` 还指着它 |

`ON CONFLICT` 必须写明冲突目标：MySQL 的 `ON DUPLICATE KEY` 碰上**任何**唯一键都会触发，PG 只认写明的那一个。有多个唯一键的表，实现时逐处确认 MySQL 实际可能触发的是哪一个。

**大小写**：MySQL 的库是 `utf8mb4_unicode_ci`（比较不分大小写），PG 缺省分大小写。实现时列出按文字比较的列（编号、账号、公司编号等）；九安生成的编号本来就区分大小写的照 PG；确实依赖不分大小写的（如果有）用 `lower()` 显式写，并加测试。库用 `UTF8` 编码、`C` 排序规则（结果稳定，和中文无关的排序一致）。（我的决定，有依赖再改）

### 6.3 测试台外壳

- `reviews.mjs`、`kb-cache.mjs`：DDL 改成 PG（`timestamp(3)`、`ON CONFLICT`），继续经九安的连接池（拿到的就是 6.1 的适配层）。
- `server.mjs`：查 `analysis_sync_states` 的那一条照 PG 写。
- `settings.mjs`：数据库配置 `engine: 'postgres'`，端口、库名、账号来自外壳的环境文件。
- 单元测试：假 pool 里的 SQL 跟着改；另加一组要真 PG 的测试（`PG_TEST_URL`，没给就跳过），覆盖这两张表的读写和时间、数字的类型。

### 6.4 实例上的脚本（`poc/infra/`）

- `bench/pg-install.sh`（新，取代 `mysql-install.sh`）：起容器 `jiuan-pg`，只绑 `127.0.0.1:5433`，数据目录 `/var/lib/jiuan-pg`，超级用户口令从 `/run/bench-secrets/` 的文件读；等就绪；幂等（容器在、参数对就不动）。
- `bench/bench-configure.sh`：建角色 `jiuan_app`、库 `jiuan`（属主 `jiuan_app`，`UTF8` / `C`），口令按 `secrets.env` 重设；写外壳配置的数据库项；不再建 MySQL 的库和账号（MySQL 容器不再由它管）。
- `bench/bench-reset.sh`：用 `pg_dump --data-only -t analysis_sync_states --where`（或等价的 `COPY … TO STDOUT`）导出启用记录，删库重建，起服务跑迁移，写回，同样的「失败也起服务、导出不删」规则。
- `migrate-data.sh`：搬九安的库改用 `pg_dump` / `pg_restore`；逐表核对改成查 PG。
- `deploy.sh`：补新的两项密钥；构件里带 `pg-install.sh`；健康检查照旧。
- `backup.sh`、`upgrade-instance.sh`、模板里提到 MySQL 的注释跟着改；测试（`poc/infra/test`）跟着改。

### 6.5 一次性的数据搬迁（MySQL → PostgreSQL）

新工具 `poc/bench/mysql-to-pg.mjs`（随构件到实例上，Node 24；读 MySQL 用 `mysql2`，写 PG 用 `pg`，两个依赖只给这个工具用，不进九安副本）和外面包一层的 `poc/infra/migrate-mysql-to-pg.sh`（本机运行，经 SSH 在实例上执行）：

1. **前提核对**：MySQL 容器在、PG 容器在且库 `jiuan` 里**已经由新代码的迁移建好了空表**（第 6.2 节的基线）、PG 里的表都是空的（不是空就停，除非明确给了 `--replace`）。
2. **按表复制**：按外键依赖的顺序；每张表按主键顺序分批读（例如每批 1000 行），在一个 PG 事务里写入；类型转换：
   - `DATETIME(n)` → `timestamp(n)`：墙上时间原样复制（读 MySQL 时用 `dateStrings` 取原文字，不经任何时区换算）；
   - `JSON` → `jsonb`（MySQL 返回的对象原样序列化）；
   - `LONGBLOB` / `BLOB` → `bytea`，逐字节相同；
   - `BOOLEAN` / `TINYINT` → `smallint`；
   - `INT UNSIGNED` / `BIGINT UNSIGNED` → PG 里能装下的类型（基线里已定），超出范围就停；
   - 自增列复制原值，复制完把序列设到最大值之后。
3. **逐表核对**：两边的行数；再按主键顺序把每一行规范化（时间用两边各自的原文字、补齐到 6 位小数，不做时区换算；JSON 按键排序；二进制成 hex；数字成十进制字符串）后算 sha256，两边逐表比。任何一张表对不上就整体失败、不切换。另外单独核对启用记录那几行的 `payload` 字节完全相同。
4. **输出**：每张表一行「表名、行数、校验值、一致 / 不一致」，不打印数据内容。
5. **`--dry-run`**：只读两边、报告会复制多少行，不写 PG。

**切换步骤**（测试台；项目负责人 2026-11-06 定：第 7 节的测试和第 1 步的演练全过就直接往下做，不再停下来等确认）：

| 步 | 做什么 | 做完是什么样 |
|---|---|---|
| 0 | `backup.sh` 做根卷快照 | 有快照编号 |
| 1 | **演练**：服务照常跑，`deploy.sh --code-only` 先装 `jiuan-pg` 和新工具（外壳仍连 MySQL：这一步的构件里外壳配置还是 MySQL，见下面的说明），在 PG 里建一个演练库 `jiuan_rehearsal`，用新代码的迁移建表，`migrate-mysql-to-pg.sh --target jiuan_rehearsal` 复制并核对 | 全部表一致；记下用时。演练库删掉 |
| 2 | **停服务**（停站开始） | `andon-jiuan` 停了，MySQL 不再有写入 |
| 3 | 正式复制、核对（目标库 `jiuan`） | 全部表一致 |
| 4 | 装新代码（外壳配置切到 PG）、启动 | 健康检查通过；开机的表结构核对通过（停站结束，预计几分钟） |
| 5 | **切换后核对**（只读，在端到端之前：端到端一开始会重置库 `jiuan`）：和第 2 步停服务时记下的数比，人工复核的条数和最后一条、知识库缓存的条数、单据和 AI 建议轮次的条数都一样；「Agent 接入」页的审批 Agent 和知识库 Agent 还是就绪（说明启用记录解得开）；单据池、工作台、知识库页打得开 | 都一样 |
| 6 | `pg_dump` 一份切换后的库 `jiuan` 留底（实例上 `/var/backups/jiuan-pg-<时间>.dump`，root 0600），停掉 `jiuan-mysql`（不删容器和数据目录） | 切换前的数据有三份：停着的 MySQL、这份 dump、第 0 步的快照 |
| 7 | 端到端 26 条，加第 7 节新增的检查 | 全过 |

说明：第 1 步和第 4 步装的是两份构件。实现时可以把「外壳连哪个库」做成外壳配置里的一项，由 `bench-configure.sh` 按环境配置写（例如 `JIUAN_DB_ENGINE=mysql|postgres`，只在切换期间存在，切换完成后去掉 MySQL 分支），也可以把第 1 步的演练做成独立的脚本、不经 `deploy.sh`。两种都行，实现时定一种，写进计划。（留给实现）

**回退**：第 4 步之后、项目负责人确认之前，出问题就：停服务 → `/opt/andon-finance/previous`（上一版构件，连 MySQL）换回 `current` → 起 `jiuan-mysql` → 起服务。MySQL 里是切换那一刻的数据；切换之后写进 PG 的新数据（新的复核、新的 AI 建议）不会自动带回去（测试台上这一段只有端到端测试的数据，可以接受）。项目负责人确认后，回退窗口保留几天，之后由项目负责人决定删 MySQL 容器和数据目录。

## 7. 测试

| 层 | 内容 | 在哪跑 |
|---|---|---|
| 适配层单元测试 | 占位符转换（字符串、引号、注释里的 `?` 不换）、返回形状、类型（大数报错、时间是 UTC、jsonb、bytea、smallint）、错误码映射、命名锁（两个连接抢锁、超时、释放、谁占着） | 本机，要真 PG |
| 九安的测试 | 全部 273 个测试文件。**基线**：在改之前的副本上（补丁 0001–0007），用本机的真 MySQL 8.0（`MYSQL_TEST_URL`）跑一遍，记下每个测试过还是不过。**改完后**用真 PG（`PG_TEST_URL`）再跑：基线里过的必须还过；基线里本来就不过的列出来、不修（不在这次改九安的业务逻辑）。57 个集成测试只改连接、建表和清理，不改断言；约 10 个专门测 `mysql-database.mjs` 或检查 MySQL SQL 文字的测试，改写成测新的 PG 模块或删掉，每一个都在补丁说明里写清楚为什么 | 本机，要真 MySQL 和真 PG |
| 外壳 | 205 条单元测试，加 6.3 的真 PG 测试 | 本机 |
| 基础设施 | `poc/infra/test` 跟着改（脚本、密钥、容器参数、重置） | 本机 |
| 搬迁工具 | 造一份覆盖全部列类型的 MySQL 数据（含二进制、JSON、带毫秒的时间、空值、中文、最大的无符号整数）→ 搬 → 核对一致；故意改坏一行 → 核对报不一致 | 本机，要真 MySQL 和真 PG |
| 端到端 | 26 条，另加一条：测试台的九安连的是 PG（经 SSH 只读查：`jiuan-pg` 在跑、`jiuan-mysql` 停了、外壳配置是 postgres）。「切换前的数据还在」不放进端到端（它一开始就重置库），由切换步骤的第 5 步核对 | 线上 |

**测试用的真 PG / MySQL 都在远端实例上**（项目负责人 2026-11-06 定：不在本机用 Docker）：先在实例上起好 `jiuan-pg`（第 6.4 节），里面另建一个只给测试用的库 `jiuan_test`（账号 `jiuan_test`，测完删）；MySQL 的基线用现有的 `jiuan-mysql` 里另建的库 `jiuan_test`（账号只能看这个库，测完删），不碰库 `jiuan`。九安副本连同它的 `tests/`、外壳的测试经 SSH 传到实例上的临时目录（`/var/tmp/jiuan-pgtest.*`，跑完删）再跑；本机只跑不需要数据库的测试。

## 8. 文档

架构与技术评估（运行时组成、数据放在哪、安全、实测数字）、工作流、快速上手、交付指南、交接（资产清单、密钥清单）、运维（看日志、重置、备份、排障）、部署与迭代、PoC 说明、部署说明、`secrets.env.example`、补丁清单、CHANGELOG。

## 9. 风险

| 风险 | 对策 |
|---|---|
| 某处行为差别测试没覆盖到（大小写、`affectedRows`、隔离级别、`INSERT IGNORE` 吞掉的别的错误） | 第 6.1、6.2 节逐处核对的清单；九安自带的 57 个集成测试；端到端；切换后保留回退窗口 |
| 九安的 57 个集成测试本身写死了 MySQL 的东西，改测试时改错了测试的本意 | 测试改动和代码改动放在同一个补丁里评审；只改连接、建表和清理，不改断言；断言要改的单独列出来说明为什么 |
| 补丁太大，以后九安给新开发包时难以重打 | 按模块拆补丁；适配层把调用方的改动压到最少；每个补丁的说明写清楚改了哪类写法 |
| 搬迁时数据被改了样 | 逐表 sha256 核对，对不上不切换；启用记录单独按字节核对 |
| 停站比预计长 | 演练时记下用时；数据量小（测试台），预计几分钟 |

## 10. 留给实现的

- 6.2 节「0010 起」的补丁怎么按文件分组。
- `ON UPDATE CURRENT_TIMESTAMP` 用显式 UPDATE 还是触发器（统一一种）。
- 6.5 节切换期间「外壳连哪个库」怎么切（配置项还是独立脚本）。
- 每批复制多少行。
- 具体的 PG 类型选择（例如 `INT UNSIGNED` 用 `bigint` 还是 `integer` 加 `CHECK`），只要 6.1 的「读出来的值和 mysql2 一样」成立。

## 11. 审阅时定下的（2026-11-05）

1. **时间**：照第 3 节「时间照旧」：PG 按上海时区运行，时间原样搬、原样读写。九安原来「库生成的时间是上海时间、应用写的是 UTC」的混用不在这次改。
2. **切换前的数据什么时候核对**：在端到端之前、单独一步（第 6.5 节第 5 步），因为端到端一开始就重置库；核对完先 `pg_dump` 留底（第 6 步）。
3. **补丁 0008 起给谁**：和 0001–0007 一样随交付包走，就是项目负责人说的「最新的代码」。我们没见过九安正式环境里的 PostgreSQL 版代码，选择照本设计：PostgreSQL 17、`public` 模式、`jsonb`、`timestamp without time zone`、命名锁用 advisory 锁。以后九安给出他们的版本，再对齐。
4. **九安自带测试的及格线**：照第 7 节：先在 MySQL 上跑出基线，PG 上要和基线一样；基线里本来就不过的列出来、不修；专门测 MySQL 模块的约 10 个测试改写或删除并说明理由。
