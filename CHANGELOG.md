# 变更记录

## 2026-11-06：九安的库从 MySQL 换成 PostgreSQL

**为什么**：九安的正式环境已经把库换成了 PostgreSQL，没有给新的开发包。项目负责人 2026-11-05 定：手上的 v0.7.10 就是最新的代码，在本地把九安的数据层改成 PostgreSQL，测试台跟着切过去；2026-11-06 确认（测试在远端实例上做，全过就直接切换）。要「无缝」，项目负责人的原话是：数据一条不丢、切过去后一切照常；切换时可以停站几分钟。只走 PostgreSQL，不同时支持两种库；九安的业务逻辑、页面、契约不动，知识库那台 PG（`nexus-pgvector`）和 Nexus 一侧也不动。

**改了什么**
- **九安副本**：补丁 0008–0018（`patches/jiuan-v0.7.10/`，每个补丁开头有一段中文说明；九安测试的改动在 `tests/` 子目录，只有 `build-jiuan.sh --with-tests` 才打）：
  - 0008 `src/pg-database.mjs`：和原来 mysql2 连接池一样用法的 PG 连接池（返回形状、类型、错误码照 mysql2；`?` → `$n`；时间按 UTC 墙上时间读写；连接被断开不出未捕获的异常）；
  - 0009 命名锁：`GET_LOCK` / `RELEASE_LOCK` / `IS_USED_LOCK` 换成会话级 advisory 锁；
  - 0010 PG 的基线表结构（版本 19）、迁移、启动时的表结构核对（对不上报 `PG_MIGRATION_DRIFT`，不启动）；
  - 0011 分析主库的查询；
  - 0012 附件下载 / 解析队列，单据数据的摘要、清空、锁快照；
  - 0013 单据详情读取队列和详情投影；
  - 0014 平台层（运行记录和设置、数据页、运行锁、调用网关等）；
  - 0015 审核要素和规则扫描；
  - 0016 审批回写、SAP 付款申请的存储和快照刷新；
  - 0017 PostgreSQL 是唯一的引擎，MySQL 的模块和 mysql2 依赖去掉；
  - 0018 评审后补的两处：等锁有时限（每个会话 `lock_timeout` 50 秒，同 InnoDB），事务里有语句出错后的 COMMIT 不再当成提交成功（报 `ER_TRANSACTION_ROLLED_BACK`）。

  mysql2 不在九安副本的依赖里了（`poc/bench/package.json` 还钉着它，构件的 `node_modules` 里也有，只给一次性的搬迁工具用）。
- **外壳**：九安的配置 `database.engine = 'postgres'`；连库用 `/etc/andon-finance/jiuan/env` 里的 `POC_DB_HOST=127.0.0.1`、`POC_DB_PORT=5433`、`POC_DB_NAME=jiuan`、`POC_DB_USER=jiuan_app` 和口令文件 `db_app_password`（root:jiuan 0640）。外壳自己的两张表也在 PG 的 `jiuan` 库里，`start()` 时建：`poc_review_decisions`（`id` 是 identity，`RETURNING id`）、`poc_kb_cache`（`ON CONFLICT … DO UPDATE`）。
- **实例上的脚本**：新的 `bench/pg-install.sh` 起容器 `jiuan-pg`（`postgres:17`，只听 127.0.0.1:5433，数据目录 `/var/lib/jiuan-pg`，上海时区；参数不对只换容器、数据目录不动）；新的 `bench/pg-database.sh [库名]` 建库 `jiuan`（属主 `jiuan_app`：能登录，不是超级用户、不能建库建角色；UTF8、排序和字符类别 C；库的时区上海；`REVOKE CONNECT … FROM PUBLIC`），可以重复跑，`jiuan_app` 的口令每次按 `secrets.env` 重设。`bench-configure.sh` 调这两个，不再碰 MySQL；`bench/mysql-install.sh` 删了。5432 留给知识库那台 PG。`bench-reset.sh` 改用 `COPY … TO STDOUT` / `COPY … FROM STDIN` 留住「Agent 接入」的启用记录、`DROP DATABASE jiuan WITH (FORCE)` 再重建（表在却导不出来就停、库不删；失败也起服务，导出留在 `/var/tmp/jiuan-reset.*/enablement.copy`）。`migrate-data.sh` 搬九安的库改用 `pg_dump -Fc` / `pg_restore`，逐表数行数改查 PG，两边都得是换库之后的构件。`backup.sh` 照旧是根卷快照。换库用的：`pg-prepare.sh`（补密钥、起 `jiuan-pg`，不碰在跑的服务）、`remote-jiuan-tests.sh` 和 `bench/test-databases.sh`（在实例上一次性的测试库容器里跑九安自带的测试）、`migrate-mysql-to-pg.sh` + `poc/bench/mysql-to-pg.mjs`（一次性的搬迁工具：MySQL 在一致的只读快照里读，PG 整个搬迁一个事务，逐表 sha256 核对；`schema_migrations` 不搬；identity 序列接着最大值；搬完 `ANALYZE`；PG 存不下的 NUL 写之前报出来；正式搬到 `jiuan` 时服务还在跑就拒绝）。
- **密钥**（`secrets.env`，`deploy.sh` 照「缺了才补、已有的不改」生成）：新的 `BENCH_PG_SUPERUSER_PASSWORD`（→ `/etc/andon-finance/bench/pg_superuser_password`，root 0600；PG 第一次初始化时用，实例上只认原值）、`JIUAN_PG_APP_PASSWORD`（→ `db_app_password`；可以换，下次部署两边一起换）。`JIUAN_DATA_KEY` 不变（永远不要换）。旧的 `BENCH_MYSQL_ROOT_PASSWORD`、`JIUAN_MYSQL_APP_PASSWORD` 留着给回退，部署不再读。
- **端到端测试**：`api.e2e.mjs` 加了一条：测试台跑在 PostgreSQL 上（容器 `jiuan-pg` 在跑、`jiuan-mysql` 停了或不在、外壳的 `POC_DB_PORT=5433`、重置后新建的库里有迁移建出的表）。现在共 27 条（web 15、api 12）。
- **没改的**：库里时间的混用照旧：库自己生成的时间（`DEFAULT CURRENT_TIMESTAMP` 等）是上海时间，九安和外壳写进去的是 UTC；PG 也按上海时区跑，所以值和换库前一样。
- **文档**：README、PoC 说明、部署说明、架构与技术评估、工作流和交付文档都改成 PostgreSQL；运维第 2.6 节写了查库、重置、备份、回退和以后删 MySQL 的做法；交接文档的密钥清单加了两项 PG 的口令，两项 MySQL 的标成只留给回退。

**怎么测的**
- 九安自带的测试（都在实例上一次性的测试库容器里跑，`remote-jiuan-tests.sh`）：换库前在真 MySQL 上记的基线是 261 个文件 2501 过、16 不过、136 跳过（`poc/bench/pg-port/baseline-mysql.json`）；换库后在真 PG 上 264 个文件 2475 过、16 不过、135 跳过（`after-pg.json`）。基线里过的都还过；29 条专测 MySQL 的测试删掉或改写了，列在 `removed-tests.json`；16 条不过的和基线一样，是环境原因。
- 外壳的单元测试 205 条，加上真 PG 上的 `pg-stores`、`reviews`、`kb-cache`；`poc/infra` 的测试 130 多条。
- 搬迁工具的测试（`poc/bench/test/mysql-to-pg.test.mjs`，真 MySQL + 真 PG）6 条全过。
- 端到端：切换后跑了两轮完整的端到端（每轮先用新的重置脚本删库重建、写回启用记录）。第一轮 27 条里 26 条过，「自定义规则」那条没过：删掉自定义规则再发起，DGZF-F07-001 回来是「不通过」，而同一轮里它的基线是「通过」（同一份 PG 数据上它先后两次都是通过）。第二轮 27 条全过（网页 15 条里 1 条按设计跳过：没给 KB_E2E_DOCX），这一轮 DGZF-F07-001 的基线本身就是「不通过」，删掉规则后也一样。所以是审核 Agent 对这张单的结论在两次运行之间会变（模型的波动），不是换库带来的；没改。新加的那条「九安连的是 PostgreSQL」两轮都过（jiuan-pg 在跑、jiuan-mysql 停了、POC_DB_PORT=5433、库里 73 张表）。
- 整条分支请一位评审看过（没碰线上，在本地把补丁重打一遍、和开发树逐字节对上，几套测试照跑一遍）：没有会丢数据、改数据的问题；有两处和 MySQL 不一样的行为要改，就是补丁 0018：
  一是等行锁原来 50 秒就报错（九安的列表同步、详情投影会重试或记下原因），换到 PG 后变成一直等，一个卡住的事务能把连接池占满；
  二是事务里某条语句出错、九安的代码接住了（MySQL 上没事），PG 已经把整个事务作废，之后的 COMMIT 不报错地回滚了，看上去像提交成功。
  两处都先写了测试（真 PG 上先失败、改完通过）。改完九安的测试在真 PG 上整套重跑：2631 条，基线里过的都还过，没有新的失败（原来不过的 16 条少了 1 条）；
  测试台重新部署（只换代码，库不动），端到端第三轮（北京时间 21:53–22:00）27 条全过（1 条按设计跳过），服务日志里没有锁等待超时、事务作废的报错。另有 12 条小问题记下没改，见交接文档第 6 节第 20 条。

**切换**（2026-11-06，北京时间 20:35–20:37）
- 第 0 步：根卷快照 `snap-0296baf8891b5df4b`（卷 `vol-0fa08d506ced8023f`）。
- 演练（服务照常跑在 MySQL 上）：72 张表、104,477 行搬进演练库 `jiuan_rehearsal`，逐表核对全部一致，搬加核对 10 秒；演练库删掉。
- 正式：20:35:10 停服务 → 搬 72 张表、104,538 行，逐表全部一致（10 秒）→ `deploy.sh --code-only`（新代码，外壳配到 PG）→ 20:37:21 健康检查通过。停站约 2 分 10 秒。最大的几张表：`platform_agent_runs` 5 万多行、`audit_sync_batches` 2 万多行、`platform_call_log` 1.2 万行。
- 切换后、端到端之前的核对：人工复核 2 条（最后一条编号 2）、知识库缓存 2 条、单据 6 张、单据版本 6 个、状态表各类的行数、「Agent 接入」的启用记录（密文 4879 字节，sha256 两边相同）都和停服务前一样；「Agent 接入」页 5 条记录状态不变，审批 Agent、知识库 Agent 都就绪；工作台、单据池、Agent 接入、知识库页都打得开；日志里没有表结构核对失败。
- 留底：20:38:31 做了一份 `pg_dump`：`/var/backups/jiuan-pg-20261106T123831Z.dump`（root 0600，9.4 MB，73 张表的数据）。容器 `jiuan-mysql` 停了，不删，数据目录 `/var/lib/jiuan-mysql` 留着。切换前的数据有三份：停着的 MySQL、这份 dump、上面的快照。

**回退**（项目负责人确认之前，出问题就做）：停服务 → 把 `/opt/andon-finance/previous`（上一版构件，连 MySQL）换回 `current` → `docker start jiuan-mysql` → 起服务。MySQL 里是切换那一刻的数据，切换后写进 PG 的不会带回去。下一次部署会把 `previous` 换成连 PG 的这一版，那以后要回退就得从换库之前的提交（main 上的 `55d1bc8`，`feat/jiuan-postgres` 从这里分出来）重新部署。步骤见[运维](docs/delivery/operations.md)第 2.6 节。

**还没做的**
- MySQL 容器和数据目录留到项目负责人说删再删；删的时候连同 `secrets.env` 里两项 MySQL 口令、`/etc/andon-finance/bench/mysql_root_password`、`/etc/andon-finance/jiuan/mysql_app_password` 一起删（`lib/bench-secrets.sh` 现在还会补这两项，删之前先从那里拿掉）。
- 九安原来就有的一个竞态（换库前 MySQL 上也有）：两个流程同时发布同一份审核要素草稿时，输的一方偶尔报 `ELEMENT_FAMILY_RETIRED` 而不是 `FAMILY_CONFLICT`（`element-lifecycle.mjs` 先读状态、再另读是否生效过），只影响报错的种类，不影响数据，大约五次里一次。不在这次的范围里，没改，交给项目负责人。

## 2026-11-05（二）：架构文档加上 pgvector 的介绍

[架构与技术评估](docs/architecture.md)新增第 6 节「知识库内部：pgvector 长什么样、怎么工作」（原来的第 6–10 节顺延成 7–11）：向量和余弦距离的原理、pgvector 提供的类型、运算符和两种索引、HNSW 怎么找最近邻，以及测试台库里的实际样子（PG 17.11、pgvector 0.8.7、规则表 449 行 × 1024 维、HNSW 索引 3.6 MB）、向量怎么在库里生成（`kb_embed` → PL/Python → Bedrock Cohere Embed v4，带缓存和限流）、`kb_search` 怎么排序。在测试台上用 `EXPLAIN ANALYZE` 确认：`kb_search` 先按关键词命中数排，所以不走 HNSW 索引，而是整表 449 行打分、4 毫秒，结果是精确的；检索日志 14 天 198 次，中位 69 毫秒，主要花在把问题变成向量。新图 `pgvector-search`。

## 2026-11-05：文档整理：架构与技术评估、工作流、新的快速上手；删去历史文档

项目负责人 2026-11-05 定：对整体的项目、方案、架构、工作流做一份技术层的分析，写进新版文档；过期的文档一律删去，现行的更新到最新。代码不变。

**新写、重写的**（都有 Markdown 和 HTML）
- [`docs/architecture.md`](docs/architecture.md)「架构与技术评估」：设计原则、运行时组成、数据放在哪、三条调用链、安全、部署架构、规模与实测数字（审核 Agent 改提示词后一轮中位 9.5 秒、约 0.04 美元；PG 知识库 Agent 一次 8 秒、约 0.04 美元），以及技术评估：做得好的、16 条风险与技术债（按优先级）、上生产前的路线。
- [`docs/workflows.md`](docs/workflows.md)「工作流」（新）：一张单从进来到复核、接入 Agent、知识库（入库、读清单的缓存、检索、审核 Agent 查库、换内容时要一起做的）、开发与变更、改提示词、部署三块、换机器迁域名、出包交接、日常运维，最后是瓶颈与改进。新图 `review-advice-flow`、`kb-flows`、`dev-workflow`。
- [`docs/delivery/quick-guide.md`](docs/delivery/quick-guide.md)「快速上手」：从只给管理员改成整个项目的入门：是什么、按角色从哪开始、10 分钟走一遍、管理员接 Agent 的八步（第 4 节）、从零部署的最短路径、日常维护、常见问题。
- `kb.rules/v1` 接口约定从 `docs/specs/` 挪到 [`docs/kb-rules-v1.md`](docs/kb-rules-v1.md)（还在用，进交接仓库和交付包了），按现状更新（Cohere Embed v4、四种格式、缓存）。

**删去的**（都在 git 历史里）：10 月的几轮可行性评估和取舍（`docs/assessment.md`、`feasibility-round2`、`compromise-round3.md`、`poc-a2a-round4.md`、`replication-feasibility.md`、`agent-discovery-registration.html`）；`docs/plans/`、`docs/specs/` 里的全部设计稿和实现计划；v0.5.3 时的进度看板（`progress.json`、`tools/progress/`、`docs/progress.html`）；`RULES_PLAN.md`；用不到的图和截图（`arch-overview.svg`、`flow-enable`、`skills-split`、`agents-page.png`）。没进 git 的草稿（`docs/tech-stack.md`、`frontend-deisgn.md`、`docs/plans` 与 `docs/specs` 下 10-24 的几份、`RULES_PLAN.md` 里没提交的笔记）挪进本机的 `archive/docs-drafts-2026-11-05/`，不进 git、不进交付包。

**现行文档跟着改的**：交付文档索引、根目录 README、交接文档（第 6 节只留没做完的 18 条，重新编号；已解决的和 v0.5.3 时期的记录删去）、运维第 2.8 节（v0.5.3 留下的东西已清完，只留一段说明）、交付包指南、交付指南的文档地图；`make-package.sh` 的「不交接」清单只留 `docs/specs`、`docs/plans`、`docs/superpowers` 和脱敏对照表。代码里还有 31 处注释写着「Spec 第 N 节」，指的是已删去的前端设计稿（在 git 历史里）。

**对着代码核对时改正的**（旧文档里就有的错，一起改了）
- **先部署 PG 的命令照原样跑不通**：交付指南 4.1、客户部署路线阶段 1、`kb/GUIDE.md` 第 4 节都写 `./deploy.sh all`，可 `all` 里的 `ingest` 要一份规则 .docx、`agent` 要改审核 Agent 的提示词，而 PG 先于 Agent 部署时审核 Agent 还不存在（缺省的 `AGENT_PATCH_PROMPT=true` 让预检停在「Nexus 里找不到 Agent」）。改成：`deploy.env` 写 `AGENT_PATCH_PROMPT=false`，只跑数据层 `preflight,db,network,egress,connector`；规则等 PG 知识库 Agent 部署好后从知识库页上传。
- **两套 Nexus 不是一套**：交接文档、运维说线上 Nexus AI `d3u3hj2us186y.cloudfront.net` 是 `nxs-beine1013` 的「实际地址」，不对（PG 知识库 Agent 的名片在 `nxs-beine1013` 上有、在 `d3u3…` 上是 404）。测试台用 `nxs-beine1013`，生产用 `d3u3…`，两边的发布和密钥不通用。快速上手第 4 节按这个写。
- 单据池里 AI 的结论在「AI 建议」一栏，「最近审核」是时间和人；状态用页面上的说法（审核中、已采纳、已改判、AI 建议已更新）。知识库页只收 .docx。启用时验密钥超过 60 秒页面会报超时（CloudFront 等源站最多 60 秒），记进了架构与技术评估第 10.2 节第 15 条。知识库页要部署配置里有 `KB_PG_PUBLICATION_ID`。

## 2026-11-03：知识库页的数据存在库里，打开页面不再每次问 Agent

**原因**（线上量的）：知识库页一打开要连着问 PG 知识库 Agent 两次：先问支持哪些操作（describe），再读制度清单。每次是 Nexus 上整轮模型（Sonnet 4.6 读约 11 KB 的提示词 → 调一次工具 → 把工具的 JSON 照抄回来），4–10 秒、约 0.03 美元；沙箱拿 VM 只要 0.01–0.1 秒。第一次打开 19 秒才出清单，5 分钟内再开也要 10 秒（describe 缓存 5 分钟，清单每次现问）。

**改法**（项目负责人定：规则入库之后很少再改，不必每次问 Agent）：操作清单、制度清单、每份制度的详情问到一次就存进九安 `jiuan` 库的新表 `poc_kb_cache`（`poc/app/kb-cache.mjs`，按方式 + 发布编号分开；外壳启动时建表），之后打开页面直接从库里给，外壳重启也不丢。只有这几种时候才再问 Agent：库里没有；页面上点「刷新清单」（`GET /api/analysis/v1/poc/kb/sources?refresh=1`，同时清掉存着的详情）；在这一页入库、下线、恢复、删除之后（不管结果，清单和那份制度的详情作废）；钥匙被拒或回复不合格（操作清单作废）。只存成功的回复；没启用时不给库里的；同时来的几次共用一次调用；库读写出错就照常问 Agent（日志 `POC_KB_CACHE_UNAVAILABLE`）。检索不存。清单和详情的回复多一个 `fetched_at`（外壳从 Agent 读到的时间），页面写上「清单是 … 从知识库 Agent 读来、存在测试台里的」。端到端测试加了一条：再读一次清单 3 秒内回来、`fetched_at` 不变。

## 2026-11-03：出包只带进了 git 的文件；出包前的检查没过就停下

`docs/delivery/make-package.sh` 原来按白名单整目录拷，开发目录里没提交的文件也会跟着走：2026-11-02 同步交接仓库时，项目负责人的草稿 `docs/tech-stack.md` 被带了过去（推送前已经拿掉，交接仓库里没有它；本机那天出的包里有，没发出去）。现在暂存之后、脱敏之前，把没进 git 的文件（没 `git add` 过的）拿掉并列出文件名；`evidence/` 只进交付包、本来就不进 git，照旧带上。

同时查出：出包前的检查是用 `&&` 把「通过」接在检查后面写的，在 `set -e` 下检查没过也会接着出包，`PACKAGE-INFO.txt` 照样写「都通过」。知识库工具的单元测试就是这样一直没跑通而没人发现（本机的 Python 缺 openpyxl 等包）。现在每一项没过都停下、不出包；知识库工具的单元测试在 uv 的临时环境里装上依赖再跑（142 条，要连真 PG 的 52 条跳过）；`PACKAGE-INFO.txt` 只写真跑了的检查（去掉 v0.5.3 时的「命令行测试」「参考补丁」）。交付包重新出了一版。

## 2026-11-02（三）：名字去掉「07」；交付指南、新 README

只留新 UI 以后，「07」不再用来区分两套，项目负责人 2026-11-02 定：代码、脚本、服务、实例上的用户、目录和库名都去掉「07」。行为不变。

**改了的名字**

| 哪里 | 原来 | 现在 |
|---|---|---|
| 代码目录、脚本 | `poc/app07/`、`poc/web07/`、`poc/bench/build-jiuan07.sh`、`poc/infra/bench/bench07-configure.sh`、`bench07-reset.sh`、`andon-jiuan07.service`、`poc/infra/test/bench07-*.test.mjs` | `poc/app/`、`poc/web/`、`poc/bench/build-jiuan.sh`、`poc/infra/bench/bench-configure.sh`、`bench-reset.sh`、`andon-jiuan.service`、`poc/infra/test/bench-*.test.mjs` |
| 端到端测试 | `poc/app07/test/e2e/run07.sh`、`web07.e2e.mjs`、`jiuan07.e2e.mjs` | `poc/app/test/e2e/run.sh`、`web.e2e.mjs`、`api.e2e.mjs` |
| 环境变量 | `POC07_*`、`E2E07_*`、`JIUAN07_*`、`J07_DOMAIN`；环境配置的 `JIUAN07_DOMAIN_NAME` | `POC_*`、`E2E_*`、`JIUAN_*`、`SITE_DOMAIN`；`DOMAIN_NAME` |
| `secrets.env` | `JIUAN07_MYSQL_APP_PASSWORD`、`JIUAN07_DATA_KEY` | `JIUAN_MYSQL_APP_PASSWORD`、`JIUAN_DATA_KEY`（`deploy.sh` 见到旧名字就原地改名、值不变，不会另生成一把数据密钥） |
| 栈模板 | 参数 `Jiuan07DomainName`；资源 `Jiuan07Distribution`、`Jiuan07RecordA` / `AAAA`；输出 `Jiuan07Url`、`Jiuan07DistributionId` | `DomainName`；`Distribution`、`SiteRecordA` / `AAAA`；`SiteUrl`、`DistributionId` |
| 实例上 | 服务 `andon-jiuan07`、用户和组 `jiuan07`、`/var/lib/jiuan07`、`/etc/andon-finance/jiuan07`、库 `jiuan07`、库账号 `jiuan07_app` | `andon-jiuan`、`jiuan`、`/var/lib/jiuan`、`/etc/andon-finance/jiuan`、库 `jiuan`、`jiuan_app` |

`poc/app/`、`poc/bench/build-jiuan.sh`、`bench-configure.sh`、`bench-reset.sh`、`run.sh` 这几个名字 v0.5.3 时用过：下面更早的记录里说拿掉了它们，指的是 v0.5.3 的那一份。

**没改的两个标识**：假汇联易的租户编号 `fake-tenant-jiuan07`（连接编号 `hly-prod-fake-tenant-jiuan07`）和外壳连 Nexus 的 operator 配置名 `jiuan07`。它们已经写进数据：库里各表的外键和「Agent 接入」的启用记录（九安用数据密钥加密，记录里带连接编号）都按它存。改了它们，端到端测试的重置会因为外键对不上而失败，启用记录也要管理员重新粘贴调用密钥。

**旧名字的实例自动改过来**（`poc/infra/bench/bench-configure.sh` 的 legacy-07 段，只在旧名字在、新名字不在时做，数据不动）：停掉、删掉 `andon-jiuan07.service`；`usermod -l` / `groupmod -n` 把用户和组改名（uid 不变）；挪目录、改家目录；MySQL 里新建库 `jiuan`、逐表 `RENAME TABLE` 过去（还有没搬走的表就停下，两边都不删）、删掉空的 `jiuan07`；`RENAME USER` 库账号，再按现在的口令和权限重设。`bench/mysql-install.sh`：v0.5.3 时建的 MySQL 容器（带 `MYSQL_PASSWORD_FILE`，那个文件已经没了，重启后起不来）先删掉容器、数据目录不动，再按现在的参数建。

**栈的改名不重建资源**：逻辑编号用 CloudFormation 的 stack refactor（`create-stack-refactor` → `execute-stack-refactor`）改，分发和两条记录原样保留；再用新模板更新栈。用户数据里改了一行注释，栈更新时实例停机再开了一次。

**`bench-reset.sh`**（端到端测试重置库用）：不管成功失败，退出时都把服务起来；中途失败时「Agent 接入」的启用记录导出留在 `/var/tmp/jiuan-reset.*/enablement.sql`（0600）不删，并说出路径；导出加 `--hex-blob`。

**新文档**：[交付指南](docs/delivery/delivery-guide.md)（从零部署三块、验收、日常变更与回滚、交接、现在的环境），加进文档索引、交付包指南和 `docs/build-html.sh`；根目录的 README.md 重写。其余文档换成新名字。

**环境**（m7g 栈 `andon-finance-m7g`，2026-11-02）：改名前根卷快照 `snap-0d6defa878e57b0b9`。21:17–21:45（UTC+8）站点不可用约 28 分钟：栈更新让实例停机再开，MySQL 容器还是 v0.5.3 时建的那个，重启后找不到已经删掉的口令文件，一直起不来（上面 `mysql-install.sh` 的改动就是为它）。第一次端到端测试因为当时租户编号也改了名，重置写回启用记录时外键对不上而失败，服务停着、启用记录的导出也没留下；当场起了服务，把两个标识改回原值，加固了 `bench-reset.sh`，启用记录从旧栈的库里取回（1 行）。之后端到端 26 条全部通过；`kb.sh verify` 只剩已知的一条。

## 2026-11-02（二）：只留新 UI，拿掉 v0.5.3 PoC；以后用 m7g

项目负责人 2026-11-02 定：机器类型以后用 **m7g.xlarge**（arm64）；旧的应用不要了。只留新 UI：九安 v0.7.10 测试台 = 新前端 `poc/web07` + 外壳 `poc/app07` + 九安 v0.7.10 副本。九安自己的原页面 `/analysis.html` 留着（它在九安开发包里；新 UI 的「设置」还链到它的后台配置和平台）。部署分三块：前端（`poc/infra/deploy.sh`）、PG 与知识库后端（`kb/`，测试台上由 `poc/infra/kb.sh` 驱动）、Nexus 上的 Agent 与发布（`audit-agent/`、`knowledgebase-writer-agent-pg/`、`skills/nexus-ai-operator`）。

**拿掉的**（v0.5.3 PoC 整套）
- 代码：`poc/app/`（v0.5.3 的 PoC 服务端、它的前端扩展 `public-src`、单元测试、v0.5.3 的端到端测试 `run.sh`、`poc.e2e.mjs`、`access.e2e.mjs`、`attachments.e2e.mjs`、截图脚本 `capture-screens.mjs`）、`poc/bench/build-jiuan.sh`、`poc/tools/`、`skills/agent-access/`、`knowledge-agent/`、`contract/`（Agent 接入框架的契约；九安 v0.7.10 自己的 `src/agent-contract/` 里有一份原样拷入的，不受影响）、`docs/delivery/patches/`（v0.5.3 参考补丁和 `make-reference-patch.sh`）、`poc/infra/bench/bench-configure.sh`、`andon-finance-bench.conf`、`bench-reset.sh`、`poc/infra/bench-test.sh`。
- 文档：并入九安、Agent 接入框架（含一页总览）、Agent 接口、单据初审契约、客户规则与 AI 初审、调用链、2026-10-17 的代码评审、开发者工作流；只用于它们的图和 v0.5.3 页面的截图。其余文档改成只写新 UI。

**挪了位置的**
- 外壳原来从 `poc/app` 借的 5 个模块搬进 `poc/app07/lib/`（`http`、`login`、`a2a-client`、`catalog`、`cli`），测试在 `poc/app07/test/unit/`。
- 部署脚本、模板、测试台脚本的测试搬到 `poc/infra/test/`（`cd poc/infra && node --test "test/**/*.test.mjs"`；夹具在 `test/fixtures/deploy-env`）。
- v0.7.10 的端到端测试在 `poc/app07/test/e2e/`：`DEPLOY_ENV=poc/infra/env/<环境>.env [KB_E2E_DOCX=…] bash poc/app07/test/e2e/run07.sh`。

**实例上的样子**：外壳（`andon-jiuan07.service`，用户 `jiuan07`）直接听 `0.0.0.0:4180`，安全组只放 CloudFront 回源前缀列表进 4180；没有 PoC 进程、没有按 Host 转发、没有 `andon` 用户。一个 CloudFront 分发（`Jiuan07Distribution`，别名是栈参数 `Jiuan07DomainName`）。MySQL 容器 `jiuan-mysql` 里只有 `jiuan07` 库；知识库的 PG 容器 `nexus-pgvector` 在同一台。

**栈模板**（`poc/infra/andon-finance-poc.yaml`）：去掉参数 `DomainName`、`AdvisoryPublicationId`；输出 `SiteUrl`、`DistributionId` 去掉（现在是 `Jiuan07Url`、`Jiuan07DistributionId`）；默认 `InstanceType=m7g.xlarge`、`RootVolumeSize=30`；用户数据只装 Node 24、Python、tar，建 `/opt/andon-finance`、`/etc/andon-finance`，构件由 `deploy.sh` 装，不在启动时拉。经 SSH 管理的参数照旧（`KeyName`、`SshAllowedCidr`、`SshVia`、`SsmManaged`）。

**`deploy.sh`**：跑 `poc/infra/test` → 构建九安 v0.7.10 副本 → 构建、测试新前端 → 外壳的单元测试 → 建栈或更新栈 → 补上缺的密钥 → 打包（外壳、九安副本、`web07/dist`、测试台脚本、operator）上传 → 实例上（root，经 SSM 或 SSH）装 `secrets.env`（root 0600）→ 解包 → `bench/bench07-configure.sh`（还会停掉、删掉留下的 `andon-finance-poc.service`，经 `bench/mysql-install.sh` 装 MySQL，建 jiuan07 的库和账号，写服务单元）→ 换上 `/opt/andon-finance/current`（上一版留在 `previous`）→ 重启 `andon-jiuan07`。健康检查 `https://<Jiuan07DomainName>/poc/healthz`。

**密钥与配置**：`secrets.env` 现在是五项：`REVIEWER_PASSWORD`、`CHECKER_PASSWORD`、`BENCH_MYSQL_ROOT_PASSWORD`、`JIUAN07_MYSQL_APP_PASSWORD`、`JIUAN07_DATA_KEY`（`poc/infra/secrets.env.example`）；`REGISTRY_KEY`、`BENCH_MYSQL_APP_PASSWORD`、`BENCH_DATA_KEY` 只有 v0.5.3 用，旧文件里留着不碍事。环境配置去掉 `DOMAIN_NAME`、`ADVISORY_PUBLICATION_ID`（`poc/infra/env/example.env`）。

**其他脚本**：`backup.sh` 只做根卷快照；`upgrade-instance.sh` 认 m7g.large / m7g.xlarge / t3.*，不许换架构；`migrate-data.sh` 只搬 `jiuan07` 库、PG 库 `nexus`（`--skip-pg` 时不搬）和 `/var/lib/jiuan07`；`kb.sh`、SSH 与 EC2 Instance Connect（`lib/remote.sh`）不变。交付包的检查改成跑 `poc/infra/test`、外壳的测试和 kb、audit-agent 的检查，白名单里去掉上面拿掉的目录。

**环境**：新代码 2026-11-02 部署到 m7g 栈 `andon-finance-m7g`（栈更新删掉了 v0.5.3 的分发和记录，实例停机再开一次）；实例上 v0.5.3 留下的库、文件、`andon` 用户清掉；端到端 26 条全部通过（第一次跑时本机网络中途断了，重跑通过）。2026-11-02 19:13–19:18（UTC+8）把 `jiuan-v0710.tinyboat.blog` 迁到 m7g 栈：先最后同步一次 `jiuan07` 库和状态目录（73 项一致），旧栈只改站点名为 `jiuan-v0710-old.tinyboat.blog` 腾出别名，m7g 栈再接上，站点停了约 5 分钟；迁完不改数据的检查都通过。旧栈 `andon-finance-poc` 项目负责人定先留几天再删，根卷快照 `snap-05180f1a83a6edada`。

## 2026-11-02：经 SSH 管理、Graviton（m7g）的测试环境；搬数据；交付包带上知识库文档管家（PG 版）的客户部署交付件

部署分成三块：PG 与知识库后端（`kb/`）、前端（`poc/infra/deploy.sh`）、Nexus 上的 Agent 与发布（`audit-agent/`、`knowledgebase-writer-agent-pg/`）。以后客户先用自己的 SSH 密钥部署 PG，再分批部署前端；测试阶段三样在一台机器上。

**经 SSH 管理**（`poc/infra/lib/remote.sh`，新增）
- 栈模板加了四个参数，默认值等于原来的样子（现有的栈更新时实例、角色、安全组都不变，`infra.test.mjs` 把它们按默认值还原后和原模板逐字比）：`KeyName`（EC2 密钥对）、`SshAllowedCidr`（22 端口单独一条规则 `SshIngress`，只在有密钥对时建）、`SsmManaged`（`false` 时实例角色不带 `AmazonSSMManagedInstanceCore`）、`RootVolumeSize`；实例类型可以是 `m7g.large` / `m7g.xlarge`，建栈时按类型的架构（x86_64 / arm64）取 AMI，栈建好后不让在两种架构之间换。实例的 Name 标签改成栈名。
- 环境配置的新键：`SSH_KEY_NAME`、`SSH_KEY_FILE`、`SSH_ALLOWED_CIDR`、`SSM_MANAGED`、`ROOT_VOLUME_SIZE`（`poc/infra/env/example.env`；`audit-agent/deploy_env.py` 同一套）。写了 `SSH_KEY_FILE`，`deploy.sh` 等实例上线、装构件、重启都经 SSH（`ec2-user` + `sudo`，脚本先写进远端临时文件再执行，任何一步失败都不做健康检查），`kb.sh` 让 kb 也经 SSH，`run07.sh` 的重置和测试里的只读命令也经 SSH。主机公钥第一次从实例的控制台输出里取来钉住（`poc/infra/.state/`，不进仓库、不进交付包），之后严格核对。
- 本机的网络连不到实例的地址段时（m7g 环境的弹性 IP 在 `184.192.0.0/12`，公司网络到不了；到 3 / 44 / 52 / 54 段的 EC2 都通），环境配置写 `SSH_VIA=eice`：栈另建一个 EC2 Instance Connect 端点（参数 `SshVia`，条件 `UseEice`；端点的安全组只许出 22 到实例，实例的 22 端口对它开），ssh 的 ProxyCommand 是 `aws ec2-instance-connect open-tunnel`，还是 SSH + 自己的密钥，不用 SSM。
- `kb/`：PG 主机可以经 SSH（`PG_HOST_TRANSPORT=ssh`、`PG_SSH_HOST`、`PG_SSH_KEY`、`PG_SSH_USER`、`PG_SSH_PORT`、`PG_SSH_KNOWN_HOSTS`、`PG_SSH_PROXY_COMMAND`（跳板机或 Instance Connect 端点），只用于 existing 模式），远端执行、读机密（只回密文）、端口转发都有 SSH 的走法；不写就和原来一样经 SSM。新测试 `kb/tests/test_host_transport.sh`（23 项）。kb/GUIDE.md 第 4 节写了客户用自己的密钥先部署 PG 的做法。

**换机器时搬数据**（`poc/infra/migrate-data.sh`，新增）：MySQL 三个库、PG 库 `nexus`、两个状态目录。旧环境经 SSM 只读导出，整包加密后经 15 分钟的预签名 URL 放进新环境的构件桶、搬完就删；新环境经 SSH 换数据，先核对两边的 `secrets.env` 相同，换完逐表核对行数和规则表的 md5。`--dry-run` 只看不改；`--skip-pg` 在 Nexus 已经切到新 PG 之后只同步 MySQL 和状态目录。

**m7g 测试环境上线**（栈 `andon-finance-m7g`，2026-11-02）：一台 m7g.xlarge（arm64）装前端、MySQL、知识库的 PG，经 SSH（`key-malibo-sa`）+ EC2 Instance Connect 端点；临时站点 `andon-finance-m7g.tinyboat.blog`、`jiuan-v0710-m7g.tinyboat.blog`。数据从线上 PoC 搬来，199 项逐表一致；16:59（UTC+8）起 Nexus 的数据库凭证密钥和 PG 连接器指向它（审核 Agent、PG 知识库 Agent 都跟着走，原来那台的 PG 没删）。端到端 26 条全部通过。域名迁移还没定。

**新前端的测试**：等待元素的上限从 1 秒放到 3 秒（`poc/web07/src/test/setup.ts`）。`deploy.sh` 里 `npm ci` 之后缓存是冷的，每个文件第一次懒加载页面常常超过 1 秒，2026-11-02 部署时有五个文件的第一项因此失败；单独跑全过。

- 新增 `customer-deploy/knowledgebase-writer-agent-pg/`：原样从交付仓库 `nexus-customer-deploy` 收进来的客户部署交付件（交付版本 1.0.1，工具包来源提交 `ec280c1`），有部署指南、编码工具部署说明、交付说明、部署手册和发布 zip。`docs/delivery/make-package.sh` 把它放进白名单，出包前用它的 `release/SHA256SUMS` 核对两个 zip，对不上就不出包。说明见 [customer-deploy/README.md](customer-deploy/README.md)。根目录的 `VERSION` 没有改。

## 2026-10-30：知识库文档管家（PG 版）；整个 PG 知识库换成 Cohere Embed v4

PG 方式也走「文档管家」那条路：制度文档经 A2A 的规则请求（`kb.rules/v1`）交给 Nexus 上新建的「知识库文档管家（PG 版）」（`knowledgebase_writer_agent_pg`），由它解析、写进审核 Agent 共用的 `approval_rules`，向量只在库里生成。同时整个 PG 知识库从 Titan v2 换成 Cohere Embed v4：审核 Agent 的 `kb_search`、`deploy.sh` 的入库和这个 Agent 都经库里同一个函数，用同一个模型。根目录的 `VERSION` 没有改。

**知识库文档管家（PG 版）**（`knowledgebase-writer-agent-pg/`，新增；说明见它的 [README.md](knowledgebase-writer-agent-pg/README.md)）
- 三个工具 `rules_writer` / `rules_search` / `rules_manager`，与 S3 Vectors 版的规则工具同名、同参数；一个工具一次做完，模型不读附件、不搬运规则、不算向量。
- 收 Word、Excel、PDF、Markdown：审批矩阵一行一条（与 `deploy.sh` 入库逐条相同），其余正文一条一块（`clause`，编号带制度标识前缀）；封面和修改记录不入库，解析报告里计数。
- `kb.rules/v1` 约定的操作全部支持，另加下线 / 恢复，以及 PG 版独有的 `preview`（只对比，不写库、不算向量）；回复过测试台客户端的形态校验。对话里入库先预览、人确认再写，下线、删除前先确认。
- 数据库凭证由 Nexus 密钥注入（`pg_kb`，`database_credentials`），拿不到就报 `credentials_missing`，不回落；错误里不带密码、主机、端口；等入库锁超过 30 秒或一句超过 240 秒就整份回滚，分别回「知识库正忙」「这次操作超时」。`check` 给了库里没有的制度标识回 `not_found`（同 `detail`）。
- `scripts/build_tools.py` 把 `kb/lib` 的 5 个核心模块逐个文件原样放进工具目录（头一行记提交号），与入口一起打成可重复的 .zip 和 `MANIFEST.json`；平台上整个目录导入、逐文件核对。另有探针模块（同目录相对 import、VM 里的包版本）、端到端用的虚构文档生成器、A2A 命令行 `scripts/a2a_rules.mjs`。

**共享核心**（`kb/lib/`）
- 新增 `doc_blocks`（四种格式 → 按原文顺序的标题 / 段落 / 表格块）、`clauses`（正文 → 一条一块的条款）、`kb_parse`（整份文档 → 记录与解析报告，带 `parser_version`）、`kb_store`（对比、冲突、一个事务里写入与清理、上传记录、下线 / 恢复 / 删除、清单、校验）。解析和入库规则各只实现一次。
- `parse_rules` 改成在块上解析，对 .docx 的输出与改动之前逐条相同（真实制度 102 条在本机比对）。`ingest_rules.py`、`kb_admin.py` 改成调 `kb_store` 的薄命令行：`ingest_rules.py` 的命令行参数和最后打印的 JSON 汇总（键名、口径）不变，入库时不再往 stderr 打逐条进度（`upserted i/N`）；`kb_admin.py` 的参数和输出不变；`deploy.sh` 的入库与 Agent 的入库拿同一把锁。

**库内向量与检索**（`kb/sql/kb_search.sql`）
- 唯一调 Bedrock 的是 `kb_embed_impl`：支持 Cohere v4（`search_document` / `search_query`，每次 96 条）和 Titan v2。应用用户经 `kb_embed(text, purpose)`（单条）、`kb_embed_batch(text[], purpose)`（批量，入库都经它）调到它；缓存键带模型、维度和用途；每分钟新向量上限分开数（单条 300、批量 2,000），只数缓存没命中的；批量在只读事务里遇到缓存没命中就拒绝（上限靠数缓存的行，只读事务里数不了）。
- 新增 `kb_meta` 登记向量模型（超级用户写、应用用户只读）。`kb_search` 的问句用 `search_query`；关键词命中数相同时，矩阵 / 制度说明 / 章节说明排在正文条款前面（库里没有条款时排序与原来相同）。
- 超级用户执行的部分加固：入库锁是第一句；内置函数和自有对象一律写全限定名；只接手超级用户建的表和函数；应用用户的表（规则表、归档表）先锁住再查，挂着会执行代码的附加物（触发器、规则、行级安全、CHECK / 外键约束、表达式 / 部分索引、生成列、域等类型的列、引用非内置函数的默认值，或它是分区）就拒绝、不碰它，没有才以表的属主身份读写（只换成属主挡不住这些代码：它们能换回超级用户身份）；回退只读超级用户建的、没有附加物的备份表。

**换模型与检索回归**（`kb/sql/migrate_embeddings.sql`、`restore_embeddings.sql`、`kb/deploy.sh`、`kb/lib/kb_regression.py`）
- `db` 阶段先读库里登记的模型，与配置不同就停（防混用）。`--migrate-embeddings` 在一个事务里装新函数、把旧向量备份进 `<表>_titan_backup`、重算规则表和归档表、登记 `kb_meta`；`--restore-embeddings` 反过来。
- 新阶段 `regress`：经 `kb_search` 逐题跑研究题库（自己限速），结果只有题号、规则编号和计数，写到仓库外；`--compare` 判前 5 命中不降、已知问题都过。`ingest` 改用 `--embed sql`；缺省模型改成 `us.cohere.embed-v4:0`（`deploy.env.example`、`cfn/pgvector-host.yaml` 的实例角色权限、preflight 探测）。

**两个文档管家共用的管理员脚本与提示词**（`knowbase-s3vectors-agent/scripts/`、`kb/prompt/`）
- `nexus_admin.py`、`render.py`、`admin_run.sh` 改成读各包的包描述 `nexus-package.json`（`--package`）：支持多文件（.zip）导入、整目录发布和逐文件核对，新增 `bind`（管理员就是属主时按人绑定密钥）。
- 「规则请求（`kb.rules/v1`）」的通用规则抽成共用片段 `kb/prompt/kb_rules_v1.zh.md`，两个提示词模板都引用；S3 Vectors 版渲染出的提示词和工具声明与改动之前逐字相同（测试钉住）。

**测试台栈**（`poc/infra/andon-finance-poc.yaml`）
- `KbBedrockPolicy` 加上 Cohere Embed v4（`us.` 推理配置文件和它路由到的三个区域的基础模型）；Titan v2 先留着供回退，切换稳定后去掉。

**线上实测**（2026-10-30，参考环境）
- 换模型：一个事务重算 102 条；研究题库前 5 命中 主题 46 → 49 / 58、改写 20 → 22 / 26，两道已知问题都过，审核 Agent `verify --e2e` 通过（策略更新后约 9 分钟内 Bedrock 间歇 403，IAM 生效延迟）。
- 文档管家：导入的 6 个文件与本地构建逐字节一致；对话和 A2A 两条路的预览、入库、检索、下线、恢复、删除、冲突拒绝、三种正文都按预期，正文入库前后检索回归逐题不变，结束时库里回到真实制度的 102 条。测试台 PG 方式的四张单据端到端待跑。

## Finance-Audit-Nexus-PoC v0.7.10（2026-10-26）

在测试台上加了第二套：九安自助审核平台测试环境开发包 **v0.7.10**，和 v0.5.3 的 PoC 并排（<https://jiuan-v0710.tinyboat.blog>，同一台实例）。v0.5.3 那一套的运行代码没有改，只在 A2A 客户端里加了可选的 DataPart。

**九安 v0.7.10 测试台**（`poc/bench/build-jiuan07.sh`、`poc/app07/`、`patches/jiuan-v0.7.10/`）
- 九安开发包按清单复制成副本（不带 `seeds/`、`database/`、`tests/`、`deploy/`、`scripts/`），只在副本上打补丁，`source/` 不动；由外壳 `poc/app07` 组装：口令登录、进程内的假汇联易（虚构的对公付款单和差旅报销单）、出网只放行 Nexus，回写关闭。
- 单据从假汇联易同步进单据池，九安先读原件，再自动发起 AI 独立建议（`review_advice@1`），经 A2A 交给 Nexus 上的「九安审核AI」。结论进单据页和两档结论；「模拟来单」能来一张新单。

**审核 Agent**（`audit-agent/`）
- 提示词 v3：认 `jiuan.agent/v1` 请求信封，处理 `review_advice@1`。按板块、业务事项、金额只读查询知识库（PostgreSQL + pgvector 的 `approval_rules`，经 Nexus 数据连接器），结论附规则编号与依据。单据里的「指示」只当数据。
- 第 1 次查询改用库内语义检索 `kb_search('<板块> <业务事项关键词> <金额>', 8)`，没对口的再按关键词 `ILIKE`，仍最多 3 次；规则问答（第 8 条）同样先 `kb_search`。`agentVersion` 为 `jiuan-audit-ai-kb-2026-10-26.1`。

**知识库**（`kb/`，原 `pgvector-rules-kb` 并入；`poc/infra/kb.sh`）
- 和测试台共用一套 IaC：PG 容器在测试台实例上，PG 端口的入站规则归测试台的栈（`KbAllowedCidr` / `KbIngress`）；`kb.sh` 从栈里取实例、网段和 Nexus 地址生成配置，再调用 `kb/deploy.sh`。
- 库内语义检索：`db` 阶段在运行中的容器里装 PL/Python（不重启），建 `kb_embed` / `kb_search`。问题由 PG 用实例角色调 Bedrock Titan v2 向量化（栈里新加的 `KbBedrockPolicy` 只许这一个模型）；先按问题里的关键词在规则原文里的命中数、再按语义排序；每次检索记进只追加的 `kb_search_log`（保留 90 天，连接器用户只能读）；只读事务里也能用；Bedrock 调用限流、重试，错误里不带 ARN 和账号。
- 权限：`public` 模式改归超级用户（应用用户留 `USAGE, CREATE`），连接器用户改不了超级用户的表和函数；`verify` 以应用用户在只读事务里探测 `kb_search`，不写库。
- 入库保护：规则编号已属于库里另一份文档时拒绝入库、一条不写（`rule_id` 是主键，原来会覆盖那份文档的规则）。
- create 模式新建的 PG 主机也能做库内检索（实例角色可调嵌入模型、IMDS 跳数 2）；`verify` 在 `kb_search` 出错时显示 PG 报的那一行。

**「规则库 › 制度知识库」页**（补丁 0004，后端 `poc/app07/kb-routes.mjs`、`kb-runner.mjs`，只给管理员）
- 上传审批矩阵格式的 .docx（≤ 20 MB，不解压就校验 zip 目录）→ 解析报告 → 入库预览（新增 · 重算向量 · 只更新说明 · 不变 · 删除；要删除的琥珀色、编号冲突的红字且不能入库）→ 确认入库（只认看过预览的标签和版本；向量在库里生成，测试台服务不需要 AWS 凭证）。同一文件再传一次，标签和版本取库里现有的，预览是「不变」。
- 上传历史（点开看这一版的规则）、按问题检索（和审核 Agent 用的同一个 `kb_search`）、检索日志（审核 Agent、页面、部署核对查了什么、命中了哪些）。

**「Agent 接入」页**（补丁 0001–0003，后端在 `poc/app07`）
- 连一次 Nexus，列出 Nexus 上开了 A2A 的发布，和已启用的合成一张表。启用只贴调用密钥（发布编号来自列表，原因自动填），不连 Nexus 也能手动添加（A2A 地址 + 调用密钥）。
- **启用即就绪，审批流只调一个审批 Agent**：启用后 Agent 供前端工作流调用；审批流只调管理员在卡片上指定的那一个（同一时间一个，替换、取消都先确认）。九安任务服务看的 `card.tasks` 只对它带审批流的任务。名片说明里有没有「契约 / 任务」两行不再挡启用（原来新发布的 Agent 一律被拒）。
- 测试三种：文本、请求信封（按契约预填示例，按契约判合格 / 不合格，原始回答可看）、单据；都记进调用记录。调用记录里每一轮一行，「查看反馈」看 Agent 返回的备注和逐条依据。

**测试**（2026-10-26）
- 九安 v0.7.10 端到端测试 9/9 通过（`KB_E2E_DOCX=<本机制度> poc/app/test/e2e/run07.sh`，审核 Agent 改用 `kb_search` 之后）：四张对公付款单自动出建议，结论符合预期，引用的规则编号都在知识库里；审批 Agent 的单据、文本、请求信封测试；模拟来单；制度知识库页上传、预览、入库、检索、检索日志；没有回写；出网只到 Nexus。
- 知识库：`kb.sh verify --e2e` 全部通过（规则问答命中 C03-1.2；A2A 三段式回归纯 JSON、未写库）。
- 单元测试：PoC 315 通过、11 个要 MySQL 的跳过；v0.7.10 外壳 43/43；知识库工具 12/12。
- v0.5.3 的端到端测试 11 通过、2 失败、2 跳过：失败和跳过的都要用审核员在 PoC「我的 Agent」里启用的知识 Agent，那把调用密钥现在被 Nexus 拒绝（状态「密钥失效」）。换一把能用的密钥后重跑；同一天早些时候是 15/15。

**测试台调整**（2026-11-01，项目负责人定）
- 一轮 AI 独立建议的时限从 120 秒放宽到 180 秒：补丁 0006 把副本里 `review_advice@1` 的 `limits.timeoutMs` 改成 180000（契约允许的上限）；`first_review@1` 和开发包本身不变。补丁 0007 把调用中间件给 `nexus-a2a` 的时限（原来也是 180 秒，计时器早几毫秒起，到点总是它先报 `CONNECTOR_TIMEOUT`）放到 200 秒，一轮由合同的 180 秒掐表，超时报 `AI_UNAVAILABLE`；「Agent 接入」页的启用核验跟着中间件的时限（200 秒），单据、请求信封测试仍按任务清单的 180 秒。外壳给任务服务的一轮租约从九安默认的 300 秒放到 420 秒（和流水线的单张时限一样）：排在连接器后面的一轮要先等前一轮的 180 秒，租约到期会被新的发起顶掉。一轮在 3 分钟内完成算正常。以前的设计文档里写的 120 秒是当时的数。
- 「我的规则」不再限制合计字数（原来每人 5,000 字；每人 10 份、单个文件 2 MB 照旧；单份转出的文字超过一次请求的上限时上传就拒绝——它单独都发不出去），只受九安单次请求大小（`maxRequestChars` 87,442 字）的限制：人发起一轮时，规则加上单据、原件一页不留也放不进一次请求，这一轮在发给 Nexus 之前就失败（`CUSTOM_RULES_TOO_LONG`，单据抽屉里说明「请删减我的规则后再发起」）；规则从不裁短，原件照旧从末尾逐页去（规则挤掉原件的页时外壳记一行 `POC_CUSTOM_RULES_TRIMMED <单据> <页数>`）。列表和工作台的 `limitChars` 改为 `null`；「我的规则」页、工作台只写「已用 N 字」，不再有用量条；九安原来的页面（补丁 0005）同样不写合计上限。工作台「出建议用时」写「上限 180 秒」。以前的设计文档里写的 5,000 字是当时的数。

**新前端和它的端到端测试**（2026-11-01）
- 测试台的首页 `/` 是新前端 `poc/web07`（React）：工作台、单据池和单据抽屉（AI 建议、原件、单据信息、历史；采纳或改判）、知识库、我的规则、Agent 接入、设置；九安原来的页面在 `/analysis.html`，旧的口令页 `/poc/login` 跳到 `/#access=<票据>` 由新前端换成会话。知识库、Agent 接入、设置只给管理员。
- 端到端测试拆成两个文件，`run07.sh` 一次重置先跑 `web07.e2e.mjs`（新前端的页面），再跑 `jiuan07.e2e.mjs`（只测接口的那些，加上新抽屉里的模型说明和自定义规则），两个文件共用一个开始时间 `E2E07_STARTED_AT`；`E2E07_FILES` 只跑其中一个。原来点九安旧页面（文档卡、「后台配置 › Agent 接入」、「规则库 › 制度知识库」）的步骤改到新前端上。
- 知识库换成审批风险判断卡（`risk-cards`，449 条；`finance-approval-v4` 已下线）后，四张虚构单的结论不再写死：每一轮要完成、是通过或不通过、有依据，引用的规则编号都在知识库里；检索按卡片原文里的卡片编号核对（「报废损失 董事长」前 3 名有 `卡片编号：EXP783344-财务`）。
- 2026-11-01 最后一次完整运行 26 条：25 通过、1 失败。失败的是「知识库 · 上传制度」：知识库 Agent 的入库工具回的是「没有变化」（449 条），Agent 却没有原样返回工具的 JSON，外壳按约定判 `KB_AGENT_REPLY_INVALID`（知识库 Agent 那边的问题，库没有变）。每一轮 AI 独立建议 7–20 秒，模拟来单从来单到出建议约 1 分钟，约 20,000 字的「我的规则」一轮 7 秒。

**知识库：经知识库 Agent，换成审批风险判断卡**（2026-10-30 – 11-01）
- 2026-10-30 起测试台的知识库页（新前端的「知识库」、九安原来的「规则库 › 制度知识库」，补丁 0004、0005）不再直连 PG，经 A2A 调 Nexus 上的 PG 知识库 Agent「知识库文档管家（PG 版）」`pub_6ea5f0855dff6c1b`（`kb.rules/v1`：describe、ingest、list、detail、deactivate、restore、delete、check、search；ingest 限时 5 分钟，其余 2 分钟），调用密钥在「Agent 接入」页启用。这个 Agent 的代码在另一个会话的分支 `feat/pg-kb-steward`，还没合进来。
- 2026-10-31（项目负责人定）有效的规则换成审批风险判断卡 `risk-cards`，449 条：`risk-cards-H1` 是说明，`risk-cards-T1.1`…`T1.448` 一条一张卡，全是 `clause`。V4.0 审批矩阵 `finance-approval-v4` 下线（可恢复，什么都没删）；下线期间 `kb/deploy.sh verify --e2e`（要命中 C03-1.2）会失败。
- 新增 `kb/convert/risk-cards/`：把原页面（HTML，265 个费用类型 × 两条线 = 530 张卡，其中 82 张业务线的卡不适用）转成入库用的 .docx（适用的 448 张卡）和给人看的 .xlsx。只有代码，原页面和转出来的文件不进仓库。转出来的 .docx 能过测试台的上传校验；PG 知识库 Agent 的离线解析器解析出 449 条（表格行 448 + 条款 1），没有拆错、没有重复。
- 2026-10-30 晚（约 22:12，UTC+8）另一个会话把 PG 知识库的向量换成 Cohere Embed v4（1024 维），连同栈里的 `KbBedrockPolicy`。本仓库的 `kb/sql/kb_search.sql` 还是 Titan：`feat/pg-kb-steward` 合进来之前，不从本仓库跑知识库的 db 阶段（`poc/infra/kb.sh db` / `all` / `ingest`、`kb/deploy.sh db`），测试台只用 `deploy.sh --code-only` 部署。（2026-11-02：分支合进 main，这条限制取消，见本文件开头一节）
- 2026-11-01 知识库客户端（`poc/app07/kb-steward-client.mjs`，两种知识库方式都用）收下 JSON 前面一句短的引导语（不超过 200 字、不含 `{ }`，后面是一个完整的 JSON 对象），记一行 `POC_KB_AGENT_REPLY_LEADIN <操作> <字数>`，不记内容。原因：知识库 Agent 有时在调工具前先写一句话，A2A 把各段文字拼在一起回来；上面 11-01 完整运行里失败的「知识库 · 上传制度」就是这样。

**审核 Agent：一轮从超时降到 7–20 秒**（2026-10-31 – 11-01，发布 `pub_5c53e70d8dc7ddea`）
- 提示词 `2026-10-28.1` → `10-31.1`（认审批风险判断卡）→ `10-31.2`（思考强度 `xhigh` 降到 `high`；按单据的「费用 / 付款类型」在「-」处拆开查、取 5 行，找到对口的就停，补查最多 6 行）→ `11-01.1`（知识库没有矩阵行就不找审批路径；最多查 3 次，写死；不查元数据、不做探索性的查询；① 的板块、金额档只用来挑矩阵行）。线上是 `jiuan-audit-ai-kb-2026-11-01.1`，发布修订号 18。动态配置里手工加的 15 个工具（`s3vectors_*`、`http_request_tool` 等，在名为 `demo` 的配置里）清掉了，现在 0 个；要恢复只能在 Nexus 网页上重新加。每一版的改前、改后、比对和下发记录在 `audit-agent/prompt-history/{2026-10-31,2026-11-01,2026-11-01b}/`。
- 超时的根因，从 Nexus 的 A2A 会话记录（`GET /api/v2/me/sessions`、`GET /api/v2/sessions/{id}/messages`）量出来：提示词还要审批路径和最终审批人，可知识库里没有矩阵行，Agent 一轮查 11–16 次去找；SQL 本身很快。改完一轮 7–20 秒，查 1–2 次。另外两点：九安的 A2A contextId 是确定的（单据、版本、指纹、第几次的哈希），一模一样的请求重发会落进 Nexus 上的同一段对话，回得很快；大多数第一次调用碰到 Bedrock 的 `ValidationException`（回放 reasoningContent），九安的重试接住了。
- 发布实际跑的模型是 `global.anthropic.claude-sonnet-5`；提示词元数据里写的 `${AGENT_MODEL}`（环境配置里是 opus-5-5）只是元数据，两者对不上。

**单据池**（2026-11-01）
- 新增「最近审核」一栏（可排序）：AI 这一轮和人工复核里晚的那个时间，第二行写「复核 · <名字>」或 AI 建议 / AI 失败 / AI 拒绝 / AI 开始；点表头按最近在前 → 最早在前 → 原来的顺序轮换。外壳的 `/poc/reviews/latest` 跟着带上 `current.startedAt` / `finishedAt` 和 `review.actorName`。
- 抽屉开着时，板块 · 事项挪到单号下面，1280 px 宽时每一栏也看得清；Agent 拒绝的一轮写「未给建议」。

**测试**（2026-11-01，上面这些修好以后）：九安 v0.7.10 端到端测试里知识库的 4 条、单据池的 6 条单独重跑，全部通过。

**文档**（2026-11-02）：交付文档（快速上手第 14 章、开发者指南第 5.1 节、交付包指南、交接文档、Skills 配置指南、客户部署路线、部署与迭代规范、运维、Agent 接入框架总览）、[PoC 说明](poc/README.md)、[kb/README.md](kb/README.md)、[kb/GUIDE.md](kb/GUIDE.md) 7.6 按上面这些更新。

## Finance-Audit-Nexus-PoC v0.1.0（2026-10-21 封板）

在 v0.1 上加了给九安开发者的对接指南，并用它在九安开发包的副本上从头演习了一遍；演习中发现的契约和接口文档的问题一并改了。和交接仓库上一次提交（2026-10-20）相比，PoC 和测试台的运行代码没有改；v0.1 之后 10-20 那几处修复（Agent 输出规则、两句页面提示、Agent 密钥改在前端加载）见下面 v0.1 一节的说明。

**开发者快速对接指南**（[developer-guide.md](docs/delivery/developer-guide.md)，新增）
- 给九安的前后端开发：一个业务需求从写任务契约、在线上 Nexus AI 上开发 Agent，做到后端调用、前端可用；每一步一段可以直接贴进 Claude Code 的提示词（P1 契约、P2 Agent、P3 适配层 + 模型接入口 + Agent 接入、P3b「Agent 接入」页面、P4 任务模块和接口、P5 页面），附放进九安仓库的 `CLAUDE.md` 模板。
- 接法按 Agent 接入框架：业务代码经九安的统一调用中间件调模型接入口的 `agentTask`，额度、暂停开关、时限、调用日志都在中间件；适配层只听 `signal`、不自己重试。
- 演习：在九安开发包 v0.5.3 的副本上，用一个虚构需求（差旅报销单的「费用说明」检查）按顺序跑了 P1、P3、P3b、P4、P5，每一轮由一个全新的编码代理照提示词做，我们复核测试、改动范围和密钥；发现的问题都改进了提示词。从头到尾没有调用真的 Nexus；P2 和签发调用密钥要在线上写入、花钱、本人操作，没有演习。

**契约**（`contract/`）
- 单据初审补了检查代码 `tasks/first_review/v1/checks.mjs`（三条一致性检查），有测试；新增 `request-misrouted.json`，`result-declined.json` 改为对应它；`describe` 补了请求例子。
- `envelope/v1/examples/a2a-request.json`、`stream.sse.txt` 的 contextId 按接口文档 4.1 的规则重算（原来的值漏了「分区」一项）；有测试核对。
- `error-map.json`：附件两条的说明改正（原来写「v1 不发文件 Part」，和接口文档矛盾）；对应关系没变。
- 任务模板：`description`、`doc`、`limits` 的占位说明改清楚。

**接口文档与框架**
- Agent 接口（`docs/delivery/agent-interface.md`，2026-11-02 随 v0.5.3 PoC 拿掉）：contextId 的每一项怎么算；断线后怎么轮询；时限只听调用中间件的 `signal`；修正消息只带文字；错误码表按 `error-map.json` 拆开 `rejected`，加 `AI_CANCELLED`，写明以 `error-map.json` 为准，错误对象带 `autoRetry`。
- Agent 接入框架（`docs/delivery/agent-framework.md`，2026-11-02 随 v0.5.3 PoC 拿掉）：适配层接口加 `verifyKey`、`onKeyRejected`、`partition`；写明打开模型接入口的开关时，草稿核验会误判「已配置」，要一起改。

**测试**：单元测试 280 个：本机 269 个通过，11 个要 MySQL 的跳过（这 11 个用 `poc/infra/bench-test.sh` 在测试台上跑，2026-10-19 11/11 通过，之后这部分没改）。Skill 与命令行测试 13 个通过。2026-10-21 完整端到端测试 15 个全部通过（0 失败、0 跳过；测试只用审核员本人在前端的连接和启用）。另外，开发者指南的演习在九安开发包副本上留下 145 个测试（演习用，不进交付包），全部通过。

## Finance-Audit-Nexus-PoC v0.1（2026-10-19 封板）

第一个封板版本：九安审核平台 v0.5.3 × Nexus AI 的 PoC，连同测试台、Agent 接入框架的设计稿和全部交付文档。线上：<https://andon-finance.tinyboat.blog>（测试台）、Nexus <https://nxs-beine1013.tinyboat.blog>（v0.3.28）（线上 Nexus AI 的实际地址：<https://d3u3hj2us186y.cloudfront.net/>）。

**PoC 第一期（10-16 – 10-18）**
- 九安原服务端与原前端跑在一台 EC2 上，经 CloudFront 对外；单据全部虚构。
- 审批流：模拟来单 → 九安预审 → AI 初审（经 A2A 调「九安审核AI」，失败自动重试一次）→ 一步人工复核；卡片上直接显示建议。审批流的调用密钥从页面上的启用记录读。
- 「我的 Nexus」（接口约定 `agent-access-v1`）：每个账号用自己的 API 密钥连接 Nexus、列出自己的发布、启用（粘贴调用密钥，当场验证）、换密钥、停用。
- 调用测试：按任务、带附件（合计 6 MB 以内）调用已启用的 Agent，看运行记录。
- 九安知识 Agent（`pub_2cc24c29d2e5b2c9`）：`describe`、`answer`、`select`、`suggest_rules`、`propose`。
- 命令行 `agent_access.py`；部署脚本 `deploy.sh`（S3 + SSM）；进度看板。

**测试台（10-19）**
- 实例原地换到 t3.large（升级前做了根卷快照和账号目录打包）；本机 MySQL 8.0（Docker 容器 `jiuan-mysql`）。
- 服务端跑九安开发包的副本（`poc/bench/build-jiuan.sh`：复制开发包、打补丁、装锁定的 `mysql2`）和九安自己的运行时：MySQL 存储、平台存储、连接器、调用中间件、流水线运行器；汇联易和钉钉不接。
- 种子单据和模拟来单照九安同步的写法写进九安的库；来单原文和编号存在九安的键值状态里，重启不丢。
- 端到端测试开始前重建测试台的库；要 MySQL 的单元测试用 `bench-test.sh` 在测试台上跑。
- 最终评审的 3 个 Important 已修好并部署：实例上的测试台密钥只认原值；健康检查真的去查库；回到内存存储不碰 MySQL。部署脚本检查 SSM 结果（评审 I1）。

**Agent 接入框架（设计稿 v2，待批准）**
- 通用信封 `jiuan.agent/v1`、任务目录、第一个任务单据初审 `first_review@1`（逐条和整张单据都只有通过 / 不通过，原因写在备注）；契约文件在 `contract/`，已校验。
- 九安补丁 0001–0006 是下一份计划；业务网关层以后再做。

**Skills 与交付**
- 给前端用户的[快速上手](docs/delivery/quick-guide.md)：在客户自己的前端和线上 Nexus AI 之间，一步步生成密钥、连接、启用、调用测试、在审批流里用。页面上两句过时的提示也一并改了：调用测试的空状态不再让人去改 `secrets.env`；登录页不再说单据会在重启后重置。
- 两个 Skill：应用自己的 `skills/agent-access/` 打包成可以安装的形式（`SKILL.md`、`README.md`、`references/`）；`skills/nexus-ai-operator/` 固定为 1.1.0，`deploy.sh` 默认用它。[Skills 配置指南](docs/delivery/skills-guide.md)写了怎么导入、怎么连到自己的 Nexus。
- 交接仓库 <https://github.com/LiboMa/nexus-jiuan-agent-framework-poc-guide>：只有交接内容（代码、两个 Skill、契约、交接文档），由 `make-package.sh --export` 生成；设计稿、实现计划、进度看板、历次评估、评审记录留在开发仓库。
- 交付文档 12 份加索引、一页总览、架构文档，Markdown 和 HTML 两个版本；交付包由 `docs/delivery/make-package.sh` 生成。
- 旧证据、旧包、建 Agent 时的调用记录移进 `archive/`（不进交付包）。

**测试**：单元测试 275 个（本机 264 通过、11 个要 MySQL 的跳过；测试台上 11/11）；Skill 与命令行测试 13 个；封板前的完整端到端测试 16 个：14 通过、1 失败、1 按设计跳过，失败的是「九安审核AI」偶发返回不合法的 JSON（字符串里有未转义的双引号）。2026-10-20 在发给 Agent 的请求里加了输出规则（只输出 JSON；字符串里不用英文双引号，引用用「」），之后2026-10-20 完整端到端测试 15 个全部通过（0 失败、0 跳过；测试只用审核员本人在前端的连接和启用）。

**已知没做完**：见[交接文档](docs/delivery/handover.md)第 6 节（源站明文 HTTP、审批记录还在内存里、上生产前的密钥事项、测试台评审的 12 个 Minor 等）。
