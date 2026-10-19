# Finance-Audit-Nexus-PoC v0.1

九安审核平台 v0.5.3 × Nexus AI 的 PoC：九安原服务端和原前端跑在测试台上（九安真实运行时 + 本机 MySQL），AI 能力在 Nexus 上，经 A2A 调用；数据全部虚构。2026-10-19 封板。

**从这里开始**：用浏览器打开 `docs/delivery/README.html`（交付文档索引），第一份读[交付包指南](docs/delivery/package-guide.md)。

| 想做什么 | 读哪份 |
|---|---|
| 验收、签收这个包 | [交付包指南](docs/delivery/package-guide.md) |
| 接手维护 | [交接文档](docs/delivery/handover.md) |
| 在编码工具里装两个 Skill | [Skills 配置指南](docs/delivery/skills-guide.md) |
| 九安怎么经 A2A 接各类 Agent | [Agent 接入框架总览（HTML）](docs/delivery/agent-framework-overview.html) |
| 部署、回滚、日常运维 | [部署与迭代规范](docs/delivery/deploy-iteration.md)、[运维与后续迭代](docs/delivery/operations.md) |
| 这个版本改了什么 | [CHANGELOG.md](CHANGELOG.md) |

| 目录 | 内容 |
|---|---|
| `docs/` | 全部文档（Markdown 是源，HTML 由 `docs/build-html.sh` 生成）、图、截图 |
| `poc/app/` | PoC 服务端、测试台组合根、前端扩展、单元测试与端到端测试 |
| `poc/bench/` | 构建九安副本（开发包 + 补丁 + `mysql2`） |
| `poc/infra/` | CloudFormation 模板、部署、备份、换型、测试台脚本 |
| `contract/` | Agent 接入框架的契约（信封、任务目录、审批流接口） |
| `skills/agent-access/` | 应用自己的 Skill（装进 Claude Code、Codex、Kiro CLI） |
| `knowledge-agent/` | 九安知识 Agent 的提示词 |
| `progress.json`、`tools/progress/` | 开发进度清单与看板 |
| `evidence/` | 测试证据与截图 |

**不在包里、另行交接**：`poc/infra/secrets.env`（当面交接）、九安开发包 `source/审核平台-测试环境开发包-v0.5.3/`（按版本号向九安取）、各人的 Nexus 凭证与 nexus-ai-operator 接入包（各人在 Nexus 网页上自己生成）。
