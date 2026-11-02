# Finance-Audit-Nexus-PoC v0.7.10

九安审核平台 × Nexus AI 的 PoC：九安自助审核平台 v0.7.10 的原服务端跑在测试台上（九安真实运行时 + 本机 MySQL），前面是我们的新前端，AI 能力在 Nexus 上，经 A2A 调用；数据全部虚构。2026-11-02 起只留这一套（新 UI）：原来并排的 v0.5.3 PoC 已从代码里拿掉（[变更记录](CHANGELOG.md)）。首页 `/` 是新前端 `poc/web07`（React）：工作台、单据池（抽屉里看 AI 建议、原件、单据信息、历史，采纳或改判）、知识库、我的规则、Agent 接入、设置；九安原来的页面在 `/analysis.html`。单据池自动出 AI 独立建议，审核 Agent 用库内语义检索查知识库；知识库经 Nexus 上的 PG 知识库 Agent 读写，2026-10-31 起有效的规则是审批风险判断卡。机器类型以后用 m7g.xlarge（arm64）。

**部署分三块**：前端（`poc/infra/deploy.sh`）、PG 与知识库后端（`kb/`，测试台上由 `poc/infra/kb.sh` 驱动）、Nexus 上的 Agent 与发布（`audit-agent/`、`knowledgebase-writer-agent-pg/`、`skills/nexus-ai-operator`）；测试阶段三样在一台机器上。

**从这里开始**：用浏览器打开 `docs/delivery/README.html`（交付文档索引），第一份读[交付包指南](docs/delivery/package-guide.md)。

| 想做什么 | 读哪份 |
|---|---|
| 在新前端的「Agent 接入」页接上 Nexus 上的 Agent（给管理员） | [快速上手](docs/delivery/quick-guide.md) |
| 九安开发者在 v0.7.10 上接 Nexus 上的 Agent（契约、写 Agent、启用、时限、提示词的教训） | [开发者快速对接指南](docs/delivery/developer-guide.md) |
| 验收、签收这个包 | [交付包指南](docs/delivery/package-guide.md) |
| 接手维护 | [交接文档](docs/delivery/handover.md) |
| 在编码工具里装 nexus-ai-operator | [Skills 配置指南](docs/delivery/skills-guide.md) |
| 九安怎么部署、走到上线（先 PG，再 Agent，再分批部署前端） | [客户部署路线](docs/delivery/customer-rollout.md) |
| 部署（三块：前端、PG 与知识库、Nexus 上的 Agent）、回滚、日常运维 | [部署与迭代规范](docs/delivery/deploy-iteration.md)、[运维与后续迭代](docs/delivery/operations.md)、[部署说明](poc/infra/README.md) |
| 九安 v0.7.10 测试台：新前端（工作台、单据池、知识库、我的规则、Agent 接入）、审批 Agent、测试、模拟来单、端到端测试 | [PoC 说明](poc/README.md) |
| 部署、核对知识库（PG + pgvector → Nexus 连接器 → 审核 Agent）、库内语义检索、测试台经 PG 知识库 Agent 入库 | [kb/README.md](kb/README.md)（先看「现状」）、[kb/GUIDE.md](kb/GUIDE.md) |
| 把审批风险判断卡（HTML 原页面）转成可入库的 .docx | [kb/convert/risk-cards/README.md](kb/convert/risk-cards/README.md) |
| 改审核 Agent（「九安审核AI」）的提示词、看历次改动 | [audit-agent/README.md](audit-agent/README.md)、`audit-agent/prompt-history/` |
| 这个版本改了什么 | [CHANGELOG.md](CHANGELOG.md) |

| 目录 | 内容 |
|---|---|
| `docs/` | 交接文档（Markdown 是源，HTML 由 `docs/build-html.sh` 生成）、图、截图 |
| `poc/app07/` | 九安 v0.7.10 测试台的外壳：口令登录、假汇联易、出网守卫、「Agent 接入」页的后端（Nexus 发布列表、测试、调用记录）、知识库页的后端（经 Nexus 上的知识库 Agent 上传、制度清单、检索）、新前端用的接口（复核、工作台、AI 轮次、原件分页）；`lib/`：A2A 客户端、名片规整、operator 命令行、口令登录、HTTP 小工具；`test/unit/` 单元测试，`test/e2e/` 端到端测试（`run07.sh`、`web07.e2e.mjs`、`jiuan07.e2e.mjs`） |
| `poc/web07/` | 九安 v0.7.10 测试台的新前端（React + Vite + Tailwind，哈希路由）：外壳在 `/` 给它的构建产物，九安原来的页面在 `/analysis.html`；`npm test`、`npm run build`，`poc/infra/deploy.sh` 构建后随构件发出 |
| `poc/bench/` | 构建九安 v0.7.10 副本（开发包 + 补丁 + `mysql2`）：`build-jiuan07.sh` |
| `patches/jiuan-v0.7.10/` | 打进九安 v0.7.10 副本的补丁 0001–0007（「Agent 接入」页、就绪与审批 Agent、「规则库 › 制度知识库」页、两种知识库方式与「我的规则」、`review_advice@1` 的时限 180 秒、`nexus-a2a` 连接器的时限 200 秒） |
| `audit-agent/` | 审核 Agent（「九安审核AI」）的提示词与下发脚本：信封模式、`review_advice@1`、只读查知识库（先 `kb_search`）；`prompt-history/`：每次改线上提示词的改前、改后、比对、下发记录 |
| `kb/` | 知识库部署工具：PG + pgvector 容器、库内语义检索 `kb_search`、Nexus 数据连接器、规则入库、Agent 提示词受管规则、核对；测试台上用 `poc/infra/kb.sh` 驱动（整库 Cohere Embed v4，跑 db 阶段前看 kb/README.md「现状」） |
| `kb/convert/risk-cards/` | 审批风险判断卡 HTML → 可入库的 .docx、整理表的脚本（只有代码，原页面和转出来的文件不进仓库） |
| `knowledgebase-writer-agent-pg/` | PG 知识库 Agent「知识库文档管家（PG 版）」的源码：工具、提示词、打包与导入脚本、A2A 命令行 `scripts/a2a_rules.mjs`（说明见它的 README.md） |
| `customer-deploy/knowledgebase-writer-agent-pg/` | 「知识库文档管家（PG 版）」的客户部署交付件（1.0.1）：部署指南、部署手册、发布 zip；源码在根目录的 `knowledgebase-writer-agent-pg/` |
| `poc/infra/` | CloudFormation 模板（默认 m7g.xlarge）、`deploy.sh`（部署前端）、备份、换型、搬数据、测试台脚本、`kb.sh`（从栈里取配置驱动 `kb/`）；`test/`：部署脚本、模板、测试台脚本的测试（`cd poc/infra && node --test "test/**/*.test.mjs"`） |
| `skills/nexus-ai-operator/` | Nexus 一侧的 Skill（1.1.0）：编码工具用它在 Nexus 上建 Agent、发布 |

**不在这里、另行交接**：`poc/infra/secrets.env`（当面交接）、九安开发包 `source/九安自助审核平台-测试环境开发包-v0.7.10/`（按版本号向九安取）、各人的 Nexus API 密钥（各人在自己的 Nexus 网页上生成）。测试证据 `evidence/` 只在交付包里。`secrets.env` 的样例和对应关系见 `poc/infra/secrets.env.example` 和[交接文档](docs/delivery/handover.md)第 2.5 节。

**脱敏**：AWS 账号和 EC2 的标识（实例、IP、VPC、子网、安全组、快照、卷、构件桶、CloudFront 分发、托管区、证书）都换成了 AWS 文档的示例值，比如账号 `123456789012`、实例 `i-0123456789abcdef0`。部署到自己的账号前，把 `poc/infra/andon-finance-poc.yaml` 里 Parameters 的默认值换成自己的。线上 Nexus AI 的实际地址：<https://d3u3hj2us186y.cloudfront.net/>。
