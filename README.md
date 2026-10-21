# Finance-Audit-Nexus-PoC v0.1.0

九安审核平台 v0.5.3 × Nexus AI 的 PoC：九安原服务端和原前端跑在测试台上（九安真实运行时 + 本机 MySQL），AI 能力在 Nexus 上，经 A2A 调用；数据全部虚构。2026-10-19 封板。

**从这里开始**：用浏览器打开 `docs/delivery/README.html`（交付文档索引），第一份读[交付包指南](docs/delivery/package-guide.md)。

| 想做什么 | 读哪份 |
|---|---|
| 在前端接上 Nexus 上的 Agent（给前端用户） | [快速上手](docs/delivery/quick-guide.md) |
| 九安开发者对接 Nexus AI（写契约 → 开发 Agent → 后端 → 前端） | [开发者快速对接指南](docs/delivery/developer-guide.md) |
| 验收、签收这个包 | [交付包指南](docs/delivery/package-guide.md) |
| 接手维护 | [交接文档](docs/delivery/handover.md) |
| 在编码工具里装两个 Skill（nexus-ai-operator、agent-access） | [Skills 配置指南](docs/delivery/skills-guide.md) |
| 九安怎么从 v0.1.0 走到上线 | [客户部署路线](docs/delivery/customer-rollout.md) |
| 九安怎么经 A2A 接各类 Agent | [Agent 接入框架总览（HTML）](docs/delivery/agent-framework-overview.html) |
| 部署、回滚、日常运维 | [部署与迭代规范](docs/delivery/deploy-iteration.md)、[运维与后续迭代](docs/delivery/operations.md) |
| 这个版本改了什么 | [CHANGELOG.md](CHANGELOG.md) |

| 目录 | 内容 |
|---|---|
| `docs/` | 交接文档（Markdown 是源，HTML 由 `docs/build-html.sh` 生成）、图、截图 |
| `poc/app/` | PoC 服务端、测试台组合根、前端扩展、单元测试与端到端测试 |
| `poc/bench/` | 构建九安副本（开发包 + 补丁 + `mysql2`） |
| `poc/infra/` | CloudFormation 模板、部署、备份、换型、测试台脚本 |
| `contract/` | Agent 接入框架的契约（信封、任务目录、审批流接口） |
| `skills/nexus-ai-operator/` | Nexus 一侧的 Skill（1.1.0）：编码工具用它在 Nexus 上建 Agent、发布 |
| `skills/agent-access/` | 应用自己的 Skill（装进 Claude Code、Codex、Kiro CLI） |
| `knowledge-agent/` | 九安知识 Agent 的提示词 |

**不在这里、另行交接**：`poc/infra/secrets.env`（当面交接）、九安开发包 `source/审核平台-测试环境开发包-v0.5.3/`（按版本号向九安取）、各人的 Nexus API 密钥（各人在自己的 Nexus 网页上生成）。测试证据 `evidence/` 只在交付包里。`secrets.env` 的样例和对应关系见 `poc/infra/secrets.env.example` 和[交接文档](docs/delivery/handover.md)第 2.5 节。

**脱敏**：AWS 账号和 EC2 的标识（实例、IP、VPC、子网、安全组、快照、卷、构件桶、CloudFront 分发、托管区、证书）都换成了 AWS 文档的示例值，比如账号 `123456789012`、实例 `i-0123456789abcdef0`。部署到自己的账号前，把 `poc/infra/andon-finance-poc.yaml` 里 Parameters 的默认值换成自己的。线上 Nexus AI 的实际地址：<https://d3u3hj2us186y.cloudfront.net/>。
