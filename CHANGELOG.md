# 变更记录

## Finance-Audit-Nexus-PoC v0.1（2026-10-19 封板）

第一个封板版本：九安审核平台 v0.5.3 × Nexus AI 的 PoC，连同测试台、Agent 接入框架的设计稿和全部交付文档。线上：<https://andon-finance.tinyboat.blog>（测试台）、Nexus <https://nxs-beine1013.tinyboat.blog>（v0.3.28）。

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
- 应用自己的 Skill `skills/agent-access/` 打包成可以安装的形式（`SKILL.md`、`README.md`、`references/`）；[Skills 配置指南](docs/delivery/skills-guide.md)写了它和 nexus-ai-operator 怎么装、怎么连。
- 交付文档 12 份加索引、一页总览、架构文档，Markdown 和 HTML 两个版本；交付包由 `docs/delivery/make-package.sh` 生成。
- 旧证据、旧包、建 Agent 时的调用记录移进 `archive/`（不进交付包）。

**测试**：单元测试 266 个（本机 255 通过、11 个要 MySQL 的跳过；测试台上 11/11）；Skill 与命令行测试 13 个；封板前的完整端到端测试 16 个：14 通过、1 失败、1 按设计跳过。失败的是调用测试里「九安审核AI」偶发返回了不合法的 JSON（字符串里有未转义的双引号，九安按规定拒收），不是代码问题；项目负责人接受这个结果封板，改法见交接文档第 6 节第 12 条。

**已知没做完**：见[交接文档](docs/delivery/handover.md)第 6 节（源站明文 HTTP、审批记录还在内存里、上生产前的密钥事项、测试台评审的 12 个 Minor 等）。
