# 变更记录

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
- [Agent 接口](docs/delivery/agent-interface.md)：contextId 的每一项怎么算；断线后怎么轮询；时限只听调用中间件的 `signal`；修正消息只带文字；错误码表按 `error-map.json` 拆开 `rejected`，加 `AI_CANCELLED`，写明以 `error-map.json` 为准，错误对象带 `autoRetry`。
- [Agent 接入框架](docs/delivery/agent-framework.md)：适配层接口加 `verifyKey`、`onKeyRejected`、`partition`；写明打开模型接入口的开关时，草稿核验会误判「已配置」，要一起改。

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
