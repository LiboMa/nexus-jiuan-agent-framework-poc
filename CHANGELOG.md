# 变更记录

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
- 一轮 AI 独立建议的时限从 120 秒放宽到 180 秒：补丁 0006 把副本里 `review_advice@1` 的 `limits.timeoutMs` 改成 180000（契约允许的上限，和调用中间件给 `nexus-a2a` 的时限一样）；`first_review@1` 和开发包本身不变。一轮在 3 分钟内完成算正常。以前的设计文档里写的 120 秒是当时的数。
- 「我的规则」不再限制合计字数（原来每人 5,000 字；每人 10 份、单个文件 2 MB 照旧），只受九安单次请求大小（`maxRequestChars` 87,442 字）的限制：人发起一轮时，规则加上单据、原件一页不留也放不进一次请求，这一轮在发给 Nexus 之前就失败（`CUSTOM_RULES_TOO_LONG`，单据抽屉里说明「请删减我的规则后再发起」）；规则从不裁短，原件照旧从末尾逐页去。列表和工作台的 `limitChars` 改为 `null`；「我的规则」页、工作台只写「已用 N 字」，不再有用量条；九安原来的页面（补丁 0005）同样不写合计上限。工作台「出建议用时」写「上限 180 秒」。以前的设计文档里写的 5,000 字是当时的数。

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
