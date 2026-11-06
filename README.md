# Finance-Audit-Nexus-PoC v0.7.10

九安审核平台 × Nexus AI 的 PoC。九安自助审核平台 v0.7.10 的原服务端跑在测试台上（九安真实运行时 + 本机的 PostgreSQL；2026-11-06 从 MySQL 换过来），前面是新前端，AI 能力在 Nexus 上，经 A2A 调用；数据全部虚构。

![系统总览：浏览器经 CloudFront 到实例上的测试台外壳（新前端、九安 v0.7.10 副本、九安的 PostgreSQL、知识库的 PG）；九安经 A2A 调 Nexus 上的审核 Agent，外壳经 A2A 调 PG 知识库 Agent，两个 Agent 都经数据连接器到 PG](docs/assets/diagrams/bench-overview.svg)

- **新前端**（首页 `/`）：工作台、单据池（抽屉里看 AI 建议、原件、单据信息、历史，采纳或改判）、知识库、我的规则、Agent 接入、设置。九安原来的页面在 `/analysis.html`。
- **AI 独立建议**：单据池里的单据读完原件后，九安经 A2A 调管理员指定的审批 Agent「九安审核AI」（`review_advice@1`）；它经 Nexus 的数据连接器只读查 PG 知识库（库内语义检索 `kb_search`，Cohere Embed v4）。
- **知识库**：经 Nexus 上的「知识库文档管家（PG 版）」读写（[`kb.rules/v1`](docs/kb-rules-v1.md)）；有效的规则是审批风险判断卡（449 条）。页面数据存在测试台的库里，打开不必每次问 Agent。

系统怎么搭、为什么这样搭、风险在哪：[架构与技术评估](docs/architecture.md)；每件事按什么顺序做：[工作流](docs/workflows.md)。

## 从哪里开始

**部署一整套、验收、交接：读[交付指南](docs/delivery/delivery-guide.md)。** 其余按角色：

| 你是 | 先读 |
|---|---|
| 第一次接触 | [快速上手](docs/delivery/quick-guide.md)：是什么、10 分钟走一遍、按角色从哪开始 |
| 部署的人（我们、九安运维） | [交付指南](docs/delivery/delivery-guide.md) → 各块自己的说明（下表） |
| 管理员（在页面上接 Agent） | [快速上手](docs/delivery/quick-guide.md)第 4 节 |
| 九安的开发、Agent 开发 | [开发者快速对接指南](docs/delivery/developer-guide.md)、[Skills 配置指南](docs/delivery/skills-guide.md)、[架构与技术评估](docs/architecture.md)、[工作流](docs/workflows.md) |
| 项目负责人 | [架构与技术评估](docs/architecture.md)第 10 节（风险与上生产前要改的）、[客户部署路线](docs/delivery/customer-rollout.md)、[交付包指南](docs/delivery/package-guide.md) |
| 接手维护、值班 | [交接文档](docs/delivery/handover.md)、[运维与后续迭代](docs/delivery/operations.md)、[部署与迭代规范](docs/delivery/deploy-iteration.md) |

全部交付文档的索引：浏览器打开 `docs/delivery/README.html`。这个版本改了什么：[CHANGELOG.md](CHANGELOG.md)。

## 部署分三块

| 块 | 代码 | 一句话 | 说明 |
|---|---|---|---|
| 1. PG 与知识库后端 | `kb/` | PG + pgvector 容器、`kb_search`、规则表、Nexus 上的数据连接器与数据库凭证密钥；客户用自己的 SSH 密钥部署（`kb/deploy.sh preflight → all → verify`） | [kb/README.md](kb/README.md)、[kb/GUIDE.md](kb/GUIDE.md) |
| 2. Nexus 上的 Agent 与发布 | `audit-agent/`、`customer-deploy/knowledgebase-writer-agent-pg/` | 审核 Agent（`setup.py`、`apply.py`，都先 `--dry-run`）；PG 知识库 Agent（照部署指南）；调用密钥由发布者本人在 Nexus 网页上签发 | [审核 Agent 说明](audit-agent/README.md)、[PG 知识库 Agent](knowledgebase-writer-agent-pg/README.md) |
| 3. 前端 | `poc/infra/`、`poc/web/`、`poc/app/`、`patches/` | 一台 EC2 + CloudFront；`deploy.sh` 测试 → 构建 → 建栈 → 装构件 → 健康检查，经 SSH（或 SSM） | [部署说明](poc/infra/README.md)、[PoC 说明](poc/README.md) |

正式环境按 1 → 2 → 3 部署，前端分批上；测试阶段三块在一台 m7g.xlarge（arm64）上。

## 现在的环境（2026-11-06）

| | |
|---|---|
| 站点 | <https://jiuan-v0710.tinyboat.blog>（栈 `andon-finance-m7g`，一台 m7g.xlarge；经 SSH + EC2 Instance Connect 端点管理） |
| 九安的库 | 实例上的 PostgreSQL 容器 `jiuan-pg`（127.0.0.1:5433，库 `jiuan`）；2026-11-06 从 MySQL 切过来。MySQL 容器 `jiuan-mysql` 停着、不删，留着做回退，项目负责人说删再删（[运维](docs/delivery/operations.md)第 2.6 节） |
| Nexus | `nxs-beine1013`：审核 Agent 发布 `pub_5c53e70d8dc7ddea`，PG 知识库 Agent 发布 `pub_6ea5f0855dff6c1b`；生产用另一套线上 Nexus AI <https://d3u3hj2us186y.cloudfront.net/> |
| 旧栈 | `andon-finance-poc`（t3.large）先留几天，等项目负责人说再删 |

## 目录

| 目录 | 内容 |
|---|---|
| `poc/web/` | 新前端（React + Vite + Tailwind，哈希路由）；`npm test`、`npm run build` |
| `poc/app/` | 测试台外壳：口令登录、假汇联易、出网守卫、「Agent 接入」与知识库页的后端、新前端用的接口；`lib/` 共用模块；`test/unit/` 单元测试，`test/e2e/` 端到端测试（`run.sh`、`web.e2e.mjs`、`api.e2e.mjs`） |
| `poc/bench/` | `build-jiuan.sh`：开发包 + 补丁 + 锁定版本的 `pg` → 九安 v0.7.10 副本；`mysql-to-pg.mjs`：一次性的 MySQL → PostgreSQL 搬迁工具（2026-11-06 用过，以后一般用不到）；`pg-port/`：换库前后九安自带测试的结果 |
| `patches/jiuan-v0.7.10/` | 打进九安副本的补丁 0001–0018：0001–0007 是「Agent 接入」、审批 Agent、制度知识库页、我的规则、两处时限；0008–0018 把九安的数据层换成 PostgreSQL |
| `poc/infra/` | 栈模板（默认 m7g.xlarge）、`deploy.sh`、`kb.sh`、`migrate-data.sh`、`backup.sh`、`upgrade-instance.sh`、`lib/remote.sh`（SSH / Instance Connect / SSM）、`bench/`（实例上的脚本：`bench-configure.sh`、`bench-reset.sh`、`pg-install.sh`、`pg-database.sh`、服务单元）；换库用过的一次性脚本 `pg-prepare.sh`、`migrate-mysql-to-pg.sh`、`remote-jiuan-tests.sh`、`env/example.env`、`secrets.env.example`；`test/` |
| `kb/` | 知识库部署工具（preflight、db、network、egress、connector、ingest、agent、verify）；`convert/risk-cards/` 把审批风险判断卡转成可入库的 .docx |
| `audit-agent/` | 审核 Agent 的提示词与下发脚本；`prompt-history/` 每次改线上提示词的留底 |
| `knowledgebase-writer-agent-pg/` | PG 知识库 Agent 的源码：工具、提示词、打包与导入脚本、A2A 命令行 |
| `customer-deploy/knowledgebase-writer-agent-pg/` | PG 知识库 Agent 的客户部署交付件（1.0.1）：部署指南、部署手册、发布 zip |
| `knowbase-s3vectors-agent/` | S3 Vectors 方式的知识库 Agent（备用的另一种知识库方式；现有环境用 PG） |
| `skills/nexus-ai-operator/` | 编码工具在 Nexus 上建 Agent、发布用的 Skill（1.1.0） |
| `docs/` | [架构与技术评估](docs/architecture.md)、[工作流](docs/workflows.md)、[`kb.rules/v1` 约定](docs/kb-rules-v1.md)；`delivery/` 交付文档；Markdown 是源，`docs/build-html.sh` 生成 HTML 和图；`docs/delivery/make-package.sh` 出交付包 |

## 测试

```bash
cd poc/infra && node --test "test/**/*.test.mjs"           # 部署脚本、模板、实例上的脚本
cd poc/app && node --test "test/unit/**/*.test.mjs"        # 外壳
cd poc/web && npm test                                     # 新前端
python3 -B -m unittest discover -s audit-agent/tests       # 审核 Agent 的提示词与下发
# kb 的测试见 kb/GUIDE.md；出包时 docs/delivery/make-package.sh 全部再跑一遍

# 端到端（真实调用 Nexus，约 5 分钟；会重置测试台的库）
DEPLOY_ENV=poc/infra/env/<环境名>.env KB_E2E_DOCX=<转好的风险判断卡 .docx> bash poc/app/test/e2e/run.sh
```

## 不在仓库里、另行交接

- `poc/infra/secrets.env`（两个账号的口令和测试台密钥，当面交接；样例 `poc/infra/secrets.env.example`）、`poc/infra/env/<环境名>.env`、`kb/deploy.env`、`poc/infra/.state/`。
- 九安开发包 `source/九安自助审核平台-测试环境开发包-v0.7.10/`（按版本号向九安取）。
- 各人的 Nexus API 密钥（各人在自己的 Nexus 网页上生成）；两个发布的调用密钥（发布者本人在网页上签发，管理员在「Agent 接入」页粘贴）。
- 测试证据 `evidence/` 只在交付包里。

**脱敏**：交付包里 AWS 账号和 EC2 的标识（实例、IP、VPC、子网、安全组、快照、卷、构件桶、CloudFront 分发、托管区、证书）都换成了 AWS 文档的示例值，比如账号 `123456789012`、实例 `i-0123456789abcdef0`。部署到自己的账号前，把 `poc/infra/andon-finance-poc.yaml` 里 Parameters 的默认值换成自己的。
