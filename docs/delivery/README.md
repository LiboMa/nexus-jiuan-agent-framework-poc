---
subtitle: 九安审核平台 × Nexus AI · Finance-Audit-Nexus-PoC v0.7.10
date: 2026-11-05
status: 只留新 UI（九安 v0.7.10 测试台）；v0.5.3 PoC 已拿掉
scope: audit-nexus/ 全部交付文档
audience: 所有接手的人
---

# 交付文档索引

![系统总览：浏览器经 CloudFront 到实例上的测试台外壳（新前端、九安 v0.7.10 副本、MySQL、知识库的 PG）；九安经 A2A 调 Nexus 上的审核 Agent，外壳经 A2A 调 PG 知识库 Agent，两个 Agent 都经数据连接器到 PG](../assets/diagrams/bench-overview.svg)

**Finance-Audit-Nexus-PoC v0.7.10**（2026-10-26 封板；2026-11-02 起只留新 UI）。现在的状态：
- **九安 v0.7.10 测试台**是唯一的一套：首页 `/` 是新前端 `poc/web`（工作台、单据池、知识库、我的规则、Agent 接入、设置），后面是外壳 `poc/app` 和九安 v0.7.10 的副本；九安原来的页面在 `/analysis.html`。原来并排的 v0.5.3 PoC 2026-11-02 从代码里拿掉了（[变更记录](../../CHANGELOG.md)）。
- **单据池自动出 AI 独立建议**：管理员在「Agent 接入」页指定的审批 Agent「九安审核AI（PoC）」处理 `review_advice@1`，经数据连接器只读查 PG 知识库；一轮上限 180 秒。
- **知识库**经 Nexus 上的 PG 知识库 Agent「知识库文档管家（PG 版）」读写（`kb.rules/v1`）；有效的规则是审批风险判断卡。
- **部署分三块**：前端（`poc/infra/deploy.sh`）、PG 与知识库后端（`kb/`）、Nexus 上的 Agent 与发布（`audit-agent/`、`knowledgebase-writer-agent-pg/`、`skills/nexus-ai-operator`）。机器类型以后用 m7g.xlarge（arm64）。

**第一次接触先读[快速上手](quick-guide.md)**；包里有什么、怎么校验、怎么验收看[交付包指南](package-guide.md)；**部署一整套照[交付指南](delivery-guide.md)**。这里是交付用的全部文档；每份都有 Markdown（源）和 HTML（生成）两个版本，HTML 用浏览器直接打开。

| 文档 | 回答什么 | 先读给谁 |
|---|---|---|
| [快速上手](quick-guide.md) | **给第一次接触的人**：这是什么、按角色从哪开始、10 分钟走一遍单据池和知识库、管理员怎么把 Nexus 上的 Agent 接上、从零部署的最短路径、日常维护和常见问题 | 所有人，第一份 |
| [架构与技术评估](../architecture.md) | 系统由哪几块组成、为什么这样搭、数据放在哪、安全、部署架构；规模和实测数字、风险与技术债、上生产前要改的 | 应用开发、Agent 开发、项目负责人 |
| [工作流](../workflows.md) | 一张单从进来到复核、接入 Agent、知识库、开发与变更、改提示词、部署、换机器、出包交接、日常运维，各按什么顺序做；瓶颈与改进 | 所有人 |
| [交付指南（Delivery Guide）](delivery-guide.md) | **给部署的人**：从零部署三块（PG 与知识库后端 → Nexus 上的 Agent 与发布 → 前端）、端到端验收、日常变更与回滚、交接；现在的环境 | 部署的人、项目负责人，第一份 |
| [九安开发者快速对接指南](developer-guide.md) | **给九安的开发**：九安 v0.7.10 里已经有的契约、A2A 适配层和「Agent 接入」；怎么在 Nexus 上写一个 Agent、启用它；时限、知识库、提示词的教训 | 九安后端、Agent 开发 |
| [客户部署路线](customer-rollout.md) | 九安怎么部署到上线：三块各部署什么、先 PG（九安自己的 SSH 密钥）、再 Agent、再分批部署前端；要九安提供什么、风险 | 项目负责人、九安团队 |
| [交付包指南](package-guide.md) | 交付包里有什么、怎么生成和校验、按角色从哪读起、验收清单、签收 | 所有人 |
| [Skills 配置指南](skills-guide.md) | 编码工具（Claude Code、Codex、Kiro CLI）里怎么装、怎么连 nexus-ai-operator；排障、安全底线 | Agent 开发 |
| [交接文档](handover.md) | 有哪些东西、在哪、谁负责、还有什么没做完、接手第一周做什么 | 所有人 |
| [部署与迭代规范](deploy-iteration.md) | 每类变更怎么改、怎么测、怎么发布、怎么回滚 | 应用开发、运维 |
| [运维与后续迭代](operations.md) | 日常操作手册、故障排查、迭代的最佳方式 | 运维、值班 |

测试台和知识库 Agent 之间的接口约定：[`kb.rules/v1`](../kb-rules-v1.md)。使用说明在代码旁边：[PoC 说明](../../poc/README.md)（新前端、Agent 接入、知识库、我的规则、端到端测试）、[部署说明](../../poc/infra/README.md)、[审核 Agent 说明](../../audit-agent/README.md)、知识库的 [kb/README.md](../../kb/README.md) 与 [kb/GUIDE.md](../../kb/GUIDE.md)、PG 知识库 Agent 的 [README](../../knowledgebase-writer-agent-pg/README.md)。上生产前必须改的在[交接文档](handover.md)第 6.1 节。

## 更新文档

1. 改 Markdown（`docs/**/*.md`）。
2. 运行 `docs/build-html.sh`，生成同名的 HTML。
3. 推送前运行 `docs/build-html.sh --check`，确认 HTML 都是最新的。

新增交付文档时，把它加进 `docs/build-html.sh` 里的清单。文档之间的链接写成 `.md`，生成 HTML 时会自动换成 `.html`。
