---
subtitle: 九安审核平台 × Nexus AI · Finance-Audit-Nexus-PoC v0.1.0
date: 2026-10-19
status: 封板 Finance-Audit-Nexus-PoC v0.1（PoC 第一期已上线；测试台是九安真实运行时 + 本机 MySQL；Agent 接入框架是设计稿，九安补丁还没写）
stamp: 交接
scope: andon-finance.tinyboat.blog（PoC）、nxs-beine1013.tinyboat.blog（Nexus；线上 Nexus AI 的实际地址是 d3u3hj2us186y.cloudfront.net）、本机 audit-nexus/ 目录
audience: 接手维护的工程师、运维、Agent 开发者、项目负责人
---

# 交接文档

## 1. 一页概览

**是什么**：九安审核平台 v0.5.3 的原服务端和原前端，跑在一台 EC2 上（测试台）。2026-10-19 起，跑的是九安开发包的副本（`.build/jiuan`，`source/` 不动），用九安自己的运行时：MySQL 存储、平台存储、连接器、调用中间件、流水线运行器；不接汇联易和钉钉，单据是虚构的，存在实例本机的 MySQL 8.0 里。AI 能力全部在 Nexus 上，由两个 Agent 提供；PoC 服务端经 A2A 调用它们。每个应用账号用自己的 Nexus API 密钥连接，看到自己发布的 Agent，粘贴调用密钥启用后就能在页面或命令行上调用测试。

![系统总览：浏览器和编码工具经 CloudFront 访问 EC2（九安服务端副本、PoC 插件、本机 MySQL）；PoC 插件经 A2A 调用 Nexus 上的两个 Agent；deploy.sh 经 S3 和 SSM 部署。红线是现在还是明文的那一段](../assets/diagrams/arch-overview.svg)

**现在的状态**（2026-10-19）：

| 项 | 状态 |
|---|---|
| PoC 站点 | 已上线：<https://andon-finance.tinyboat.blog> |
| 测试台 | 2026-10-19 升级完：t3.small 换成 t3.large（弹性 IP 没变）；本机 MySQL 8.0（Docker 容器 `jiuan-mysql`）；健康检查 `database: ok`、`source: poc-bench`；九安平台中心能打开（卡片「汇联易单据同步」，暂停状态）。记录见 `evidence/bench/2026-10-19-upgrade.md` |
| 审批流（来单 → 九安预审 → AI 初审 → 人工复核） | 可用。2026-10-18 起：来单后系统自动发起 AI 初审（失败自动重试一次），卡片上直接显示建议，一步人工复核；PoC 用「模拟来单」模拟来单；调用密钥从系统里读。注意客户规则还没有进入 AI 初审，见[客户规则与 AI 初审](rules-binding.md) |
| 「我的 Nexus」：连接、列出、启用、换密钥、停用（接口约定 `agent-access-v1`） | 第一期已实现、已上线；页面上实测连接、启用、重新验证都正常；审核员已启用两个 Agent，连接用的是 `builder` 档位（开发测试阶段可以，上生产前改只读，见第 6 节第 5 条） |
| 应用自己的 Skill `agent-access`（给 Claude Code、Codex、Kiro CLI 用） | 已实现；2026-10-19 打包成可以安装的 Skill（`SKILL.md`、`README.md`、`references/`）。怎么装、怎么和 nexus-ai-operator 配合，见 [Skills 配置指南](skills-guide.md) |
| 知识 Agent（`pub_2cc24c29d2e5b2c9`） | 在 Nexus 上可用；知识写在提示词里（虚构） |
| Agent 接入框架（契约 `jiuan.agent/v1`） | 设计稿 v2，待批准。契约文件 `contract/` 已写好、已校验；第一个任务是单据初审 `first_review@1`。九安补丁 0001–0006 还没写（第二份计划），审批流现在仍由 PoC 插件调用「九安审核AI」 |
| 测试 | 单元测试 280 个：本机 269 个通过，11 个要 MySQL 的跳过（这 11 个用 `poc/infra/bench-test.sh` 在测试台上跑，2026-10-19 11/11 通过，之后这部分没改）。Skill 与命令行测试 13 个通过。2026-10-21 完整端到端测试 15 个全部通过（0 失败、0 跳过；测试只用审核员本人在前端的连接和启用）。v0.1 封板前有两次各 1 项失败，都是第 6 节第 12 条那个 Agent 输出问题，已处理 |
| 交付前评审 | 作为 PoC 可以交接维护；上生产前有 2 个 Critical、11 个 Important 要改，见第 6.1 节（I1 已在 2026-10-19 修好） |
| 代码托管 | **交接仓库** <https://github.com/LiboMa/nexus-jiuan-agent-framework-poc-guide>：只有交接内容（代码、两个 Skill、契约、交接文档），给客户用；由 `docs/delivery/make-package.sh --export` 从开发目录同步。**开发仓库** <https://github.com/LiboMa/nexus-jiuan-agent-framework-poc>：另外还有设计稿、实现计划、进度看板、历次评估和评审记录。两个都是私有仓库。交接仓库的封板标签是 `v0.1`（2026-10-19）、`v0.1.0`（2026-10-21）和 `v0.7.10`（2026-10-26，分支 `release/v0.7.10`，本版）；开发仓库停在 `v0.1` |

**页面长这样**（2026-10-17 截自线上，数据都是虚构的）：

![单据池：两家虚构公司的 8 张单据，卡片上显示审批状态](../assets/screens/documents.png)

![Nexus Agent 页：「我的 Nexus 连接」（已连接、Nexus 账号与档位）和「我的 Agent」（已启用的两个 Agent）](../assets/screens/agents-page.png)

**一句话的交接要点**：Markdown 文档是唯一的源；部署只用 `poc/infra/deploy.sh`；Agent 的调用密钥和 Nexus 的 API 密钥由各账号在前端「Nexus Agent」页自己加载，加密存在实例上，加、换、停用都不用部署或重启；应用自己的启动配置（两条口令、`REGISTRY_KEY`、测试台的三项密钥）只在本机的 `poc/infra/secrets.env`，不进构件、不进文档、不贴进对话；九安开发包只读，服务端跑的是打过补丁的副本，前端改动靠锚点补丁生成。

## 2. 资产清单

![资产地图：本机（代码、密钥文件、operator、九安开发包与它的副本 .build/jiuan）、AWS（CloudFront、S3 构件桶、EC2 与实例上的 MySQL 容器）、Nexus（两个发布、调用密钥）之间怎么连](../assets/diagrams/handover-assets.svg)

### 2.1 代码与目录

都在本机的 `~/MyDev/LLM/Nexus-AI-strands/application-deploy/audit-nexus/` 下。

| 路径 | 内容 | 谁维护 |
|---|---|---|
| `poc/app/` | PoC 服务端、前端扩展、示例附件、单元测试与端到端测试（代码地图见[架构文档](../architecture.md)第 8 节） | 应用开发 |
| `poc/app/access/` | 「我的 Nexus」：每个账号的连接、启用、加密存储、验证 | 应用开发 |
| `poc/app/nexus/` | A2A 客户端、模型客户端、调用测试、附件、运行记录 | 应用开发 |
| `poc/app/approval/` | 审批流状态机与接口 | 应用开发 |
| `poc/app/bench/`、`poc/app/jiuan-mysql.mjs` | 测试台的组合根：九安 MySQL 存储（`store.mjs`）、九安平台（`platform.mjs`）、种子单据与模拟来单的写入（`state.mjs`）、九安配置（`settings.mjs`）；`jiuan-mysql.mjs` 从九安副本载入模块 | 应用开发 |
| `poc/app/public-src/` | 前端扩展（`nexus-poc.js`、`nexus-invoke.js`、`nexus-poc.css`） | 应用开发 |
| `poc/app/scripts/build-public.mjs` | 用锚点补丁从九安原前端生成前端副本 | 应用开发 |
| `poc/bench/` | `build-jiuan.sh`：从九安开发包复制 `code/` → 按顺序打补丁 → 装上锁定版本的 `mysql2` 3.14.3，输出到 `.build/jiuan/` | 应用开发 |
| `.build/jiuan/` | 生成物（九安副本 + 补丁 + 依赖）；`deploy.sh` 每次重建，不要手改 | — |
| `poc/app07/` | 九安 v0.7.10 测试台的外壳（`server.mjs` 组合根，口令登录、进程内假汇联易、出网守卫，「Agent 接入」页的后端：`nexus-access.mjs` 发布列表、`agent-tests.mjs` 测试、`agent-calls.mjs` 调用记录、`agent-routes.mjs` 审批流路由）；`poc/bench/build-jiuan07.sh` 构建九安 v0.7.10 副本到 `.build/jiuan07/`（生成物，不要手改） | 应用开发 |
| `patches/jiuan-v0.7.10/` | 打进九安 v0.7.10 副本的补丁 0001–0003，按文件名顺序：连 Nexus 列发布；「Agent 接入」页；启用即就绪、审批流只调管理员指定的一个审批 Agent | 应用开发 |
| `audit-agent/` | 审核 Agent「九安审核AI」的提示词（v3：信封模式、`review_advice@1`、只读查知识库）、下发脚本 `apply.py`（写提示词并重存发布的动态配置） | Agent 开发 |
| `patches/jiuan-v0.5.3/` | 打进九安副本的补丁，按文件名顺序。现在还没有这个目录，第二份计划写 0001–0006 | 应用开发 |
| `contract/` | Agent 接入框架的契约：信封、名片要求、错误码、任务目录、审批流接口 | 应用开发、Agent 开发 |
| `poc/infra/` | CloudFormation 模板、`deploy.sh`、`destroy.sh`、`backup.sh`（升级前备份）、`upgrade-instance.sh`（换实例类型）、`bench-test.sh`（在测试台上跑要 MySQL 的测试）、`bench/`（实例上的 MySQL 安装、配置、重置脚本与 systemd 片段）、`secrets.env`（只在本机，0600） | 运维 |
| `skills/nexus-ai-operator/` | Nexus 一侧的 Skill（1.1.0，从 Nexus-AI 项目复制，不带任何密钥）：编码工具用它在 Nexus 上建 Agent、发布；`deploy.sh` 也从这里取 `scripts/nexus.py` 打进构件 | Agent 开发 |
| `skills/agent-access/` | 应用自己的 Skill：`SKILL.md`（给编码工具读）、`README.md`（给人读）、`scripts/agent_access.py`（Python 3.9 标准库）、`references/`（接口约定、配方）、`tests/`（13 个） | 应用开发 |
| `knowledge-agent/` | 知识 Agent 的提示词（`prompt.yaml` v2，`prompt-v1.yaml`）与维护说明 | Agent 开发 |
| `docs/` | 交接文档：`docs/delivery/` 是交付文档，另有架构文档和开发者工作流；`docs/build-html.sh` 生成 HTML。设计稿、实现计划、进度看板、历次评估和评审记录只在开发仓库 | 全员 |
| `evidence/` | 各轮的截图与测试证据；`bench/` 是 2026-10-19 测试台升级的记录与日志；`e2e/last-run.jsonl` 是最近一次端到端测试的结果 | — |
| `archive/` | 不再使用、只留作记录的旧证据、旧包、建 Agent 时的调用记录、测试台升级的执行记录（说明见 `archive/README.md`）；不进交付包 | — |
| `VERSION`、`CHANGELOG.md`、`README.md`（根目录） | 版本号 `Finance-Audit-Nexus-PoC v0.7.10`、每个版本改了什么、包的入口说明 | 应用开发 |
| `source/审核平台-测试环境开发包-v0.5.3/`、`source/九安自助审核平台-测试环境开发包-v0.7.10/` | 九安原开发包。**只读，不改，不执行其中脚本**；v0.7.10 的 `seeds/`、`database/` 含真实数据，不打开、不复制 | 九安 |

另外两处本机依赖：
- nexus-ai-operator：用仓库里的 `skills/nexus-ai-operator/`（1.1.0），`deploy.sh` 只打包其中的 `scripts/nexus.py`；要换版本用环境变量 `NEXUS_OPERATOR_SCRIPT`；
- 本机 operator 凭证 `~/.nexus/`：不读、不复制、不打印。

### 2.2 线上环境

AWS 账号 533267047935，区域 us-east-1。交接仓库和交付包里，本节和全文的 AWS 账号与 EC2 标识（实例、IP、VPC、子网、安全组、快照、卷、构件桶、CloudFront 分发、托管区、证书）都已换成 AWS 文档的示例值，比如账号 `123456789012`、实例 `i-0123456789abcdef0`。

| 资源 | 值 |
|---|---|
| CloudFormation 栈 | `andon-finance-poc`（模板 `poc/infra/andon-finance-poc.yaml`） |
| EC2 | `i-01d753d48056fd423`，t3.large（2026-10-19 起是测试台），Amazon Linux 2023，Node 24，systemd 服务 `andon-finance-poc` |
| MySQL | 实例上的 Docker 容器 `jiuan-mysql`（mysql:8.0，只听 127.0.0.1:3306），数据目录 `/var/lib/jiuan-mysql`，库 `jiuan_analysis`；端到端测试前用 `bench/bench-reset.sh` 重建这个库 |
| 九安 v0.7.10 | 同一台实例：systemd 服务 `andon-jiuan07`（系统用户 `jiuan07`，只听 127.0.0.1:4181，屏蔽 IMDS），程序 `/opt/andon-finance/current/app07/server.mjs` + 九安副本；PoC 进程按 Host 把 `jiuan-v0710.tinyboat.blog` 的请求转过去（`poc/app/host-proxy.mjs`），安全组不变；第二个 CloudFront 分发。库 `jiuan07`（同一个 `jiuan-mysql` 容器，账号 `jiuan07_app`）；配置与密钥文件 `/etc/andon-finance/jiuan07/`；工作目录 `/var/lib/jiuan07/`（`nexus/` 是「Agent 接入」页连 Nexus 的凭证，`seed-anchor.json` 是种子单据的时间锚点）。端到端测试前 `bench/bench07-reset.sh` 重建 `jiuan07` 库，保留启用记录（含审批 Agent）和 Nexus 连接 |
| 知识库 | 同一台实例上的 Docker 容器 `nexus-pgvector`（`pgvector/pgvector:pg17`，只绑实例私网 IP 的 5432），库 `nexus`、表 `approval_rules`（制度原文不进仓库）；经 Nexus 的 PostgreSQL 数据连接器接到「九安审核AI」，Agent 只读查询。由 pgvector-rules-kb 部署工具建，见 `audit-agent/README.md` |
| 公网 IP | EIP `13.223.152.186`；安全组只放 CloudFront 回源前缀列表 `pl-3b927c52` 访问 4180，不开 22 |
| 构件桶 | `andon-finance-poc-artifactbucket-786tdeg4dqkb`：`releases/current.tgz`、`releases/archive/<时间>.tgz`、`secrets/secrets.env`（SSE） |
| CloudFront | `E92MPQ217VIPX`，站点 `andon-finance.tinyboat.blog`，回源 `andon-finance-origin.tinyboat.blog` |
| 运维通道 | 只走 SSM（Run Command、Session Manager）；实例角色禁止读 SSM 参数 |
| 实例上的目录 | `/opt/andon-finance/current`（当前版本）、`/opt/andon-finance/previous`（上一次启动前的版本；服务崩溃循环时会被覆盖，**回滚要用构件桶里的归档包**）、`/etc/andon-finance/{env,secrets.env,bench.env}`、`/etc/andon-finance/bench/`（测试台的三个密钥文件，root:andon 0640）、`/var/lib/andon-finance/users/<账号>/`（各账号数据） |

### 2.3 Nexus

<https://nxs-beine1013.tinyboat.blog>，v0.3.28。（线上 Nexus AI 的实际地址：<https://d3u3hj2us186y.cloudfront.net/>）

| 对象 | 编号 | 用途 |
|---|---|---|
| 九安审核AI（PoC） | Agent `agent_56d44dd9350f4a568bca387319e12ae4`，发布 `pub_5c53e70d8dc7ddea` | 审批建议、草稿核验；审批流在用（栈参数 `AdvisoryPublicationId`）。调用密钥取自账号在「我的 Agent」里对它的启用：先用发起人本人的，再用别的账号的，所以至少要有一个账号启用它 |
| 九安知识Agent（PoC） | Agent `agent_949d9bc407b9430aae20f26326ef6fca`，发布 `pub_2cc24c29d2e5b2c9` | `describe` / `answer` / `select` / `suggest_rules` / `propose` |

两个发布都打开了 A2A 和 MCP；PoC 只用 A2A。这套 Nexus 用的是旧部署模板（`/a2a` 经前端反代，请求体上限 10 MB），所以 PoC 把附件合计限在 6 MB。

### 2.4 账号

| 账号 | 在哪 | 说明 |
|---|---|---|
| `poc-reviewer`（审核员）、`poc-checker`（复核人） | PoC 站点 | 虚构账号，口令在 `secrets.env`；端到端测试也用这两个账号 |
| `admin`（editor） | Nexus | 发布者账号；审核员在 PoC 上连接的就是它 |

### 2.5 密钥清单

只写位置和用途，不写值。密钥分两类：**Agent 和 Nexus 的密钥由用户在前端加载**，不放进任何文件；**应用自己的启动配置**放在 `secrets.env`。

**Agent 和 Nexus 的密钥（用户在前端加载，不在 `secrets.env` 里）**

| 名字 | 在哪 | 用途 | 怎么加、怎么换 |
|---|---|---|---|
| 各账号的 Nexus 连接 | 实例 `/var/lib/andon-finance/users/<账号>/nexus/` | 按这个账号自己的 Nexus 身份读发布列表 | 用户在「Nexus Agent」页 ›「我的 Nexus 连接」填自己的 API 密钥（或 `agent_access.py nexus connect`）；页面上「断开」；Nexus 上停用 API 密钥 |
| 各账号启用的调用密钥 | 实例 `users/<账号>/enabled.json`（用 `REGISTRY_KEY` 加密） | 调用测试，以及审批流（先用发起人自己启用的「九安审核AI」，没有就用别的账号启用的） | 用户在「我的 Agent」里「启用」时粘贴（或 `agent_access.py enable --key-stdin`），当场验证；页面上「换密钥」「停用」。不用改文件、不用部署、不用重启 |
| operator 的 API 密钥 `claude_code` | 本机 `~/.nexus/` | 本机 nexus-ai-operator 建 Agent、发布 | 一直用到过期；上生产前统一清理 |
| 旧的共享 CLI 连接 `jiuan-audit-host` | 实例 `/var/lib/andon-finance/nexus/` | 第一期之前用的，已不用 | 开发测试阶段不用管；上生产前统一清理 |

**应用的启动配置（`poc/infra/secrets.env`）**

样例：`poc/infra/secrets.env.example`，里面没有任何真实的值。

流向：本机 `poc/infra/secrets.env`（0600）→ `deploy.sh` 上传到构件桶 `secrets/secrets.env`（服务端加密）→ SSM 在重启服务之前装到实例的 `/etc/andon-finance/secrets.env`（root:andon 0640）→ `bench/bench-configure.sh` 把三项 `BENCH_*` 再写成 `/etc/andon-finance/bench/` 下的三个文件 → 服务启动时读一次（`POC_SECRETS_FILE`、`BENCH_SECRETS_DIR`）。

| 键 | 实例上在哪 | 谁读 | 怎么来 |
|---|---|---|---|
| `REVIEWER_PASSWORD`、`CHECKER_PASSWORD` | `/etc/andon-finance/secrets.env` | 服务端（口令登录，至少 12 个字符）；端到端测试（`run.sh` 读出来传成 `E2E_REVIEWER_PASSWORD`、`E2E_CHECKER_PASSWORD`） | 自己定，或 `deploy.sh` 第一次运行时生成 |
| `REGISTRY_KEY` | 同上 | 服务端：加密各账号 `enabled.json` 里的调用密钥 | 缺了 `deploy.sh` 自动补（`openssl rand -base64 32`）。**换掉它，所有账号都要在页面上重新启用 Agent** |
| `BENCH_MYSQL_ROOT_PASSWORD` | `/etc/andon-finance/bench/mysql_root_password` | MySQL 容器（建库）、`bench-reset.sh`（重建库） | 缺了自动补（`openssl rand -hex 16`），只补不换 |
| `BENCH_MYSQL_APP_PASSWORD` | `/etc/andon-finance/bench/mysql_app_password` | MySQL 容器（建应用账号）、服务端（连库） | 同上 |
| `BENCH_DATA_KEY` | `/etc/andon-finance/bench/analysis_data_key` | 服务端（打开九安的库） | 缺了自动补（`openssl rand -base64 32`）。**永远不要换**：九安会用它核对库里的连接行，换了整个库就打不开 |

旧文件里如果还有 `NEXUS_API_KEY`、`NEXUS_A2A_KEY_…`、`E2E_KNOWLEDGE_A2A_KEY`、`E2E_NEXUS_API_KEY` 这几行，都可以删掉：Agent 的密钥已经改成在前端加载，端到端测试也用审核员本人在前端的连接和启用。

操作：
1. **新环境**：最省事是不建这个文件，直接运行 `poc/infra/deploy.sh`，它会生成两条随机口令、`REGISTRY_KEY` 和三项 `BENCH_*`。要自己定口令，就 `cp poc/infra/secrets.env.example poc/infra/secrets.env && chmod 600 poc/infra/secrets.env`，填好两条口令，其余保持注释。
2. **改口令**：改本机文件，再 `deploy.sh --code-only`；服务重启后生效。
3. **测试台的三项密钥**：只补不换。实例上已有的只认原值，`secrets.env` 里的不一样时，部署在重启前就失败、服务照旧跑（[运维](operations.md)第 2.7 节）。
4. **交接**：整个文件当面交接。丢了 `BENCH_DATA_KEY`，测试台的库就打不开。

规则：
- 调用密钥只能由 Nexus 网页登录的本人签发，Operator 和 API 密钥签发都会被拒（Nexus 代码 `api/v2/services/access_credential_service.py:283-286`）。
- **开发测试阶段：给出的密钥一直用到过期，不主动吊销、不轮换。** Agent 用的调用密钥一律由用户在前端加载、从系统里读（页面上的启用记录），不另放。轮换与清理放到上生产前统一做（第 6.1 节第 8 条）。

### 2.6 并入九安时：调用密钥与「Agent 接入」

2026-10-19 定：九安里审核 Agent 的调用密钥**从启用记录读**，和第 2.5 节的规则一样，不另放密钥文件。

- **服务端（必须做）**：九安平台中心加「Agent 接入」：
  - 管理员填发布编号、粘贴这个发布的调用密钥；
  - 九安当场检查两件事，都不花钱：名片描述里有契约和任务列表（`contract/envelope/v1/card-requirements.json`）；用这把密钥发一个 `tasks/get`，Nexus 认它；
  - 通过后加密存进九安自己的存储；
  - 一个发布一把密钥（每把调用密钥只对一个发布有效）；初审的路由表只从已启用的发布里选；
  - Nexus 回 401 时，把这把标成「密钥失效」，在页面上换一把。
- **接口**：沿用 PoC 已实现的 agent-access-v1 里启用的那部分：启用、换密钥、停用、不带密钥重新验证。参考代码是 `poc/app/access/` 下的 `me.mjs`（`enable`、`disable`、`refresh`、`credentialFor`、`markInvalid`）、`verify.mjs`、`crypto.mjs`、`routes.mjs`。
- **界面（可选）**：九安开发者自己写；也可以复用 PoC「Nexus Agent」页「我的 Agent」卡片的逻辑（`poc/app/public-src/nexus-poc.js`：待启用 › 启用 › 粘贴调用密钥、换密钥、停用）。
- **和 PoC 的区别**：PoC 是每个账号各自启用；九安这里是平台级的，由管理员为整个平台启用。每个账号连接自己的 Nexus（「我的 Nexus」）仍按[并入九安](integration.md)的第三期。

这是 Agent 接入框架的通用部分，以后所有类型的 Agent 都这样启用。细节见[Agent 接入框架](agent-framework.md)第 3、6 节。

## 3. 文档索引（推荐阅读顺序）

1. 本文。
2. [架构、模块与工作流](../architecture.md)：线上跑着的样子、每个模块、调用链。
3. [快速上手](quick-guide.md)：给前端用户，一步步把前端接上 Nexus 上的 Agent。
   [开发者快速对接指南](developer-guide.md)：给九安的前后端开发，一个业务需求从写契约、在 Nexus 上开发 Agent，做到后端调用、前端可用，每步配 Claude Code 提示词。
   [Skills 配置指南](skills-guide.md)：在编码工具里装好、连好 nexus-ai-operator 和 agent-access。
4. [以补丁和独立模块的形式并入九安](integration.md)：交付给原应用的两种方式与推荐做法。
   - 各类 Agent 怎么经 A2A 接进九安（设计稿）：[Agent 接入框架总览（HTML）](agent-framework-overview.html) → [Agent 接入框架：架构、工作流与交付接口](agent-framework.md) → [Agent 接口](agent-interface.md) → 第一个任务[单据初审](first-review-contract.md)。
5. [部署与迭代规范](deploy-iteration.md)：每类变更怎么改、怎么测、怎么发、怎么回滚。
6. [运维与后续迭代](operations.md)：日常操作手册、故障排查、迭代的最佳方式。
7. [客户部署路线](customer-rollout.md)：从 v0.1.0 到九安上线的五个阶段、部署工具包、第一周做什么。
8. [开发者工作流](../agent-developer-workflow.md)：一个 Agent 从建好到在前端可用的全过程；接口约定 agent-access-v1 见 `skills/agent-access/references/interface.md`。
9. 使用说明：[PoC 说明](../../poc/README.md)、[部署说明](../../poc/infra/README.md)、[知识 Agent 说明](../../knowledge-agent/README.md)。

每份交付文档都有同名的 HTML 版本，由 `docs/build-html.sh` 从 Markdown 生成。

## 4. 职责划分

| 事项 | 负责 | 需要确认 |
|---|---|---|
| PoC 服务端、前端扩展、命令行 | 应用开发 | 项目负责人确认端到端测试结果后才能发布 |
| Agent 提示词、发布、能力清单 | Agent 开发（用 Operator Skill） | 应用开发跑一次调用测试 |
| 调用密钥签发（开发测试阶段用到过期，不主动吊销） | Nexus 账号本人（网页） | — |
| `secrets.env`、部署、回滚、实例 | 运维 | 项目负责人 |
| 九安开发包升级 | 九安提供；应用开发重做锚点补丁 | 端到端测试 |
| 线上端到端测试（会重建测试台的库、产生费用） | 应用开发 | 运行前通知在用的人 |
| 测试台的换型、停机、变更集 | 运维 | 每一步动手前项目负责人当场同意 |

固定规则（不会变）：
1. **四步使用逻辑**：开发者用 Operator 构建 Agent、发布、拿调用密钥 → 前端经 A2A 自动发现并加载测试 → 用 vibe coding 优化调用和界面 → 测试、上线。知识和 Agent 在一起（在 Nexus 上），前端只做调用。
2. **提交前**：端到端测试完成、项目负责人确认之后再推送，不是开发完测完就提交。
3. **密钥**：开发测试阶段，给出的密钥一直用到过期；Agent 的调用密钥从系统里读（页面上的启用记录），不另放、不主动吊销。

## 5. 接手第一周

- [ ] 拿到 AWS 账号 533267047935 的部署权限（CloudFormation、S3 构件桶、SSM Run Command）和 Nexus 账号。
- [ ] 本机装好 Node ≥ 24、Python 3.9+、AWS CLI v2、pandoc ≥ 3、本机 Chrome（端到端测试用）。
- [ ] 从现任维护人那里当面拿到 `poc/infra/secrets.env`（不经聊天工具），放到 `poc/infra/`，权限 0600。
- [ ] 跑一遍单元测试：`cd poc/app && node --test "test/unit/**/*.test.mjs"`（275 个，本机有 11 个要 MySQL 的会跳过）和 `python3 -m unittest discover -s ../../skills/agent-access/tests`（13 个）。
- [ ] 按 [Skills 配置指南](skills-guide.md)把 nexus-ai-operator 和 agent-access 装进自己的编码工具，各用一把自己的 API 密钥连接。
- [ ] 用 `poc/infra/bench-test.sh` 在测试台上跑那 11 个要 MySQL 的测试（只用 `jiuan_bench_test` 库，不碰线上的库）。
- [ ] 读第 3 节的前五份文档。
- [ ] 在页面上用审核员走一遍：「我的 Nexus 连接」已连接 →「我的 Agent」里两个 Agent 已启用 → 调用测试 →「重新读能力清单」。不要停用审核员已启用的两个 Agent：审批流和端到端测试都用它们。要练启用和停用，用复核人账号连接自己的 Nexus 来练。
- [ ] 做一次只改文档的 `deploy.sh --code-only`，看健康检查通过；再按[部署与迭代规范](deploy-iteration.md)练一次回滚。
- [ ] 跑一次完整的端到端测试（约 0.36 美元；开始前会重建测试台的库），把结果和截图交给项目负责人确认。

## 6. 交接时的未完成事项

按紧急程度排列。

1. **构件和健康检查还不带提交号**（评审 C1 的后一半）：代码已经进了私有仓库（交接仓库的标签 `v0.1.0`），但 `deploy.sh` 的归档包名和健康检查里还没有提交号，线上跑的是哪个提交要靠时间对。见[部署与迭代规范](deploy-iteration.md)第 2 节。
2. **CloudFront 到源站是明文 HTTP**（评审 C2）：登录口令、会话、用户粘贴的密钥在这一段上没有加密。PoC 只有虚构数据，开发测试阶段可以接受；上生产前必须改成 HTTPS。
3. **部署脚本还剩一个缺口**（评审 I2）：服务崩溃循环会覆盖实例上的 `previous`，回滚只用构件桶里的归档包。（I1 已修好：SSM 不是 `Success`，`deploy.sh` 就报失败。）
4. **值班看不到问题**（评审 I6）：健康检查只看服务是否就绪；调用密钥失效、Nexus 调用失败都不会让它变红，日志里也没有。每天要实际发起一次审批看看。
5. **上生产前要做的密钥事项**（开发测试阶段不用动）：审核员连接 Nexus 用的是 `builder`（可写）档位，上生产前改成只读（评审 I4）；统一清理 operator 的 API 密钥 `claude_code`、旧的共享 CLI 连接 `jiuan-audit-host` 和 `secrets.env` 里不再用的几行。
6. **上生产前必须改的**：见第 6.1 节。
7. **初审 MVP（第二份计划）**：Agent 接入框架设计稿待项目负责人批准；批准后写九安补丁 0001–0006（通用的 Agent 接入、任务调用、规则、初审与审批流、界面）。在这之前，客户规则不进 AI 初审（[客户规则与 AI 初审](rules-binding.md)）。
8. **审批记录还在内存里**：单据和模拟来单已经在 MySQL 里，重启不丢；审批记录、登录状态和运行记录重启后清空。初审 MVP 里审批状态改存九安的存储。
9. **测试台的小缺口**：九安左侧导航还没有「平台运行」分组，平台中心只能经地址 `#platformAgents` 打开；测试台的 MySQL 数据只在这台实例的数据卷上，实例被替换前先跑 `poc/infra/backup.sh`（[运维](operations.md)第 2.6 节）。
10. **业务网关层以后再做**：多轮会话、延后结果、分区与串联、整个租户范围的任务、按次配额（[Agent 接入框架](agent-framework.md)第 0 节）。
11. **测试台评审的 Minor**（12 个，都不影响现在的使用，按需要再改）：
    - 来单编号第一次并发取号可能死锁一次（回 500，再点一次就好）；
    - 连上 MySQL 之后的启动步骤失败会让进程退出；
    - 模拟来单先写单据、后存原文，按单据号查找时没核对单据号；
    - 写入失败时批次停在「运行中」；
    - 种子单据共用一个采集时间，单据池的顺序和内存模式不一样；
    - `bench-reset.sh` 的 SQL 失败时服务停着不开；
    - `run.sh` 不打印 SSM 输出，看不出是重置了还是退回重启；
    - MySQL 容器挂进了整个测试台密钥目录，应该只挂两个密码文件；
    - `build-jiuan.sh` 只看 `mysql2` 的版本决定要不要 `npm ci`；
    - 换型脚本只检查实例这一个资源；
    - `backup.sh` 默认第一块卷是根卷；
    - 测试台打开九安存储时没带上部署方式，环境里多出的 `MYSQL_URL` 会把它指到别处。
    - 另外：九安左侧导航没有「平台运行」分组（见第 9 条）。
12. **「九安审核AI」偶发返回不合法的 JSON**（已处理，2026-10-20）：Agent 曾在 JSON 字符串里直接写未转义的英文双引号，九安按规定拒收（`AI_INVALID_RESPONSE`）。现在发给 Agent 的每条请求都带一段输出规则（`nexus/a2a-client.mjs` 的 `buildPrompt`：只输出一个 JSON 对象；字符串里不用英文双引号，引用一律用「」）；端到端测试第 5 项一显示失败就带错误码报出来。改完之后完整端到端测试 15 个全部通过。模型仍可能偶尔不守规则，审批流会自动重试一次；调用测试面板失败时再点一次发送就行。

已经解决的（2026-10-20）：
- **工作流文档按应用现状更新**：Agent 的调用密钥在前端加载，`secrets.env` 只放应用的启动配置；端到端测试只用审核员本人在前端的连接和启用；`deploy.sh` 新建 `secrets.env` 时不再写调用密钥那一行。
- **Agent 输出不合法 JSON**（第 6 节第 12 条）：请求里加了输出规则，完整端到端测试 15 个全部通过。
- **交接仓库**：<https://github.com/LiboMa/nexus-jiuan-agent-framework-poc-guide>，只有交接内容；AWS 账号与 EC2 标识已脱敏；有 `secrets.env.example`。

已经解决的（2026-10-19）：
- **测试台升级**：升级前备份（根卷快照 `snap-03051c671bc2738a0`，实例上打包了账号目录）→ 停机换型到 t3.large → 先按内存存储部署、装好 MySQL → 在测试台上跑要 MySQL 的测试（11/11，4 次故意改坏代码都被抓住）→ 切到 MySQL → 端到端测试 15 通过、0 失败、1 按设计跳过。各账号的连接与启用都没变。记录在 `evidence/bench/2026-10-19-upgrade.md`。
- **部署能看出安装失败**（评审 I1）：`deploy.sh` 检查 SSM 的执行结果，不是 `Success` 就报失败。
- **测试台的最终评审**（3 个 Important，每个都先写了会失败的测试再修；2026-10-19 已部署，SSM 结果 Success，健康检查 `database: ok`）：
  - 实例上已有的测试台密钥只认原值：`secrets.env` 被重新生成或改过时，部署在重启前就失败，服务照旧跑；`BENCH_DATA_KEY` 格式不对也不写；
  - 健康检查真的去查库：库断了 `/api/health` 回 503，`database` 是 `unavailable`；
  - 回到内存存储不碰 MySQL：MySQL 坏了也能用 `POC_STORE=memory deploy.sh --code-only` 退回来。
- **端到端测试不再重启服务**：开始前用 `bench/bench-reset.sh` 重建测试台的库（重建失败才退回重启）。
- **Agent 接入框架**：设计稿 v2 与契约文件（`contract/`），按通用框架设计，以后的财务、知识库等各类 Agent 都用同一套信封和任务目录。
- **应用自己的 Skill**：`skills/agent-access/` 打包成可以安装的 Skill（`SKILL.md`、`README.md`、`references/`），有测试检查它和命令行脚本一致；两个 Skill 的配置写进 [Skills 配置指南](skills-guide.md)。
- **代码进 Git**（评审 C1 的前一半）：交接仓库 <https://github.com/LiboMa/nexus-jiuan-agent-framework-poc-guide>（只有交接内容；标签 `v0.1`，2026-10-21 起 `v0.1.0`），开发仓库 <https://github.com/LiboMa/nexus-jiuan-agent-framework-poc>（标签 `v0.1`）。
- **整理**：第 2–4 轮的原始接口返回、10-17 和 10-18 的旧包、建 Agent 时的调用记录、测试台升级的执行记录移进 `archive/`（不进交付包，引用它们的历史文档已改链接）。

已经解决的（2026-10-18）：
- **审批流的调用密钥**：改为从系统里读：先用发起人在 Agent 页启用的那把，没有再用别的账号启用的，最后才用 `secrets.env` 兜底（这个兜底 2026-10-20 起也不用了：调用密钥一律在前端加载）；Nexus 回 401 时只把用到的那一把标记失效。线上验证：`secrets.env` 里那把 Nexus 已不认，审批流照样走通。
- **完整端到端测试**：14 通过、0 失败、1 按设计跳过。
- **被端到端测试删掉的知识 Agent 启用**：已由本人重新启用；测试也改成了只用、不动本人启用的项。

### 6.1 上生产前必须改的

来自 2026-10-17 的交付前代码评审（评审记录在开发仓库），编号沿用评审里的：

| 编号 | 问题 | 现在 |
|---|---|---|
| C1 | 没有版本管理，也没有版本标识 | 代码已进 Git（交接仓库标签 `v0.1.0`）；构件和健康检查还不带提交号 |
| C2 | CloudFront 到源站是明文 HTTP，走公网 | 没改 |
| I1 | `deploy.sh` 没部署成功也可能报成功 | 已修好（2026-10-19） |
| I2 | 每次服务启动都重新拉包，崩溃循环会毁掉回滚点 | 没改；回滚只用构件桶里的归档 |
| I3 | 只给测试用的真凭证被装到了公网主机上 | 没改 |
| I4 | 没有强制 Nexus 连接用只读档位；CLI 的凭证明文落盘 | 没改 |
| I5 | 调用测试的「审批建议」模式，会把单据事实发给用户启用的任何 Agent | 没改；要加发布白名单 |
| I6 | 值班看不到问题 | 没改 |
| I7 | 前端补丁的检查只看锚点和语法 | 没改 |
| I8 | operator 脚本没钉版本，也没有合同测试 | 一半：仓库里固定为 `skills/nexus-ai-operator/` 1.1.0；合同测试没做 |
| I9 | 测试关卡不在生产的运行时上跑 | 没改 |
| I10 | 唯一的集成关卡是在唯一的线上环境跑端到端测试 | 没改 |
| I11 | 主机从不打补丁 | 没改 |

按这个顺序改：
1. 版本（C1）；
2. 传输加密（C2）；
3. 持久化：审批记录、运行记录、限流放进九安的 MySQL 存储，运行记录带公司、按公司过滤；
4. 每个账号的 Nexus 数据改存数据库、信封加密，强制只读档位（I4）；
5. 去掉 PoC 脚手架：口令登录、种子数据、内存存储、`exchange` 的回环绕过；
6. 模型调用走九安的 `ai-model` 连接器；
7. 「审批建议」模式的发布白名单（I5）；
8. 密钥：服务端和测试的分开（I3），静态加密用 KMS，`REGISTRY_KEY` 能轮换，清理第 2.5 节列的旧凭证；
9. 可观测性（I6）；
10. 流水线（I1、I2、I8、I9、I10）；
11. 主机（I11）。

九安自己部署时（[客户部署路线](customer-rollout.md)），第 3–8 条由框架补丁在九安里实现；第 1、2、10、11 条只关我们自己的测试台。

## 7. 交接确认

| 项 | 交出 | 接收 | 日期 |
|---|---|---|---|
| 代码与文档（第 2.1 节） | | | |
| 两个 Skill（[Skills 配置指南](skills-guide.md)） | | | |
| 测试台（第 2.2 节；MySQL 与三项测试台密钥） | | | |
| AWS 与 Nexus 权限（第 2.2、2.3 节） | | | |
| `secrets.env`（当面交接） | | | |
| 未完成事项（第 6 节） | | | |
| 端到端测试结果与截图 | | | |
