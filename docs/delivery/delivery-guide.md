---
subtitle: 九安审核平台 × Nexus AI · Finance-Audit-Nexus-PoC v0.7.10
date: 2026-11-06
status: 交付版（写的是现在的做法；2026-11-02 在 m7g 测试台上从部署到端到端验收走过一遍；2026-11-06 九安的库换成 PostgreSQL）
scope: 从零部署一整套（PG 与知识库后端 → Nexus 上的 Agent 与发布 → 前端）、验收、日常变更与回滚、交接
audience: 部署的人（我们、九安运维）、项目负责人
---

# 交付指南（Delivery Guide）

这份指南讲怎么把一整套从零部署起来、怎么验收、以后怎么改和怎么退。每一步都给出命令和「做完是什么样」。细节在各部分自己的文档里，这里只给顺序、要点和链接。

## 1. 交付的是什么

一套「九安审核平台 × Nexus AI」：九安自助审核平台 v0.7.10 跑在测试台上，前面是新前端，AI 能力在 Nexus 上，经 A2A 调用；数据全部虚构。分三块部署，各有各的工具：

| 块 | 是什么 | 代码 | 文档 |
|---|---|---|---|
| **PG 与知识库后端** | PostgreSQL + pgvector 容器、库内语义检索 `kb_search`（库里调 Bedrock 的 Cohere Embed v4 生成向量）、规则表、Nexus 上的数据连接器和数据库凭证密钥 | `kb/`（测试台上由 `poc/infra/kb.sh` 驱动）；`kb/convert/risk-cards/`（审批风险判断卡 → 可入库的 .docx） | [kb/README.md](../../kb/README.md)、[kb/GUIDE.md](../../kb/GUIDE.md) |
| **Nexus 上的 Agent 与发布** | 审核 Agent「九安审核AI」（`review_advice@1`，经连接器只读查知识库）；PG 知识库 Agent「知识库文档管家（PG 版）」（`kb.rules/v1`：入库、清单、检索） | `audit-agent/`；`knowledgebase-writer-agent-pg/`（源码）与 `customer-deploy/knowledgebase-writer-agent-pg/`（客户部署件）；`skills/nexus-ai-operator/` | [审核 Agent 说明](../../audit-agent/README.md)、[PG 知识库 Agent](../../knowledgebase-writer-agent-pg/README.md)、[Skills 配置指南](skills-guide.md) |
| **前端** | 新前端 `poc/web`（React）、测试台外壳 `poc/app`、九安 v0.7.10 副本（打 `patches/jiuan-v0.7.10/` 的补丁）、九安的 PostgreSQL（容器 `jiuan-pg`）；一台 EC2 + CloudFront | `poc/infra/`（栈模板、`deploy.sh`、`migrate-data.sh`、`backup.sh`、`upgrade-instance.sh`）、`poc/bench/build-jiuan.sh` | [部署说明](../../poc/infra/README.md)、[PoC 说明](../../poc/README.md) |

测试阶段三块在一台 m7g.xlarge（arm64）上；正式环境三块分开，先 PG，再 Agent，再分批部署前端（[客户部署路线](customer-rollout.md)）。

## 2. 一页看懂

![系统总览：浏览器经 CloudFront 到实例上的测试台外壳（新前端、九安 v0.7.10 副本、九安的 PostgreSQL、知识库的 PG）；九安经 A2A 调 Nexus 上的审核 Agent，外壳经 A2A 调 PG 知识库 Agent，两个 Agent 都经数据连接器到 PG](../assets/diagrams/bench-overview.svg)

- 浏览器 → CloudFront（站点 `DomainName`）→ 实例的 4180 端口：测试台外壳 `andon-jiuan.service` 直接在这里听（安全组只放 CloudFront 回源）。首页 `/` 是新前端，九安原来的页面在 `/analysis.html`，接口在 `/api/analysis/v1/…`。
- 单据池里的单据读完原件后自动出「AI 独立建议」：九安经 A2A 调「Agent 接入」页上指定的审批 Agent（审核 Agent），一轮上限 180 秒；审核 Agent 经 Nexus 的 PostgreSQL 数据连接器只读查 PG（先 `kb_search`）。
- 知识库页（只给管理员）经 A2A 调 PG 知识库 Agent；它的工具用数据库凭证密钥 `pg_kb` 经私网连 PG，向量在库里生成。测试台不直连 PG。
- 人工复核（采纳 AI 建议或改判）只记在测试台，不回写汇联易；单据来自外壳里的假汇联易。

## 3. 开始前

| 要什么 | 说明 |
|---|---|
| AWS 账号与区域 | 能建 CloudFormation 栈、EC2、CloudFront、Route 53 记录；`us-east-1`（证书和 Bedrock 模型访问也在这里） |
| 网络 | Nexus 所在的 VPC 和其中一个公有子网（PG 要能被 Nexus 的 API Server 和 Sandbox VM 经私网连到） |
| 域名 | Route 53 托管区，us-east-1 的 ACM 证书覆盖站点名 |
| Nexus | 一个管理员账号；Sandbox 已启用；Bedrock 开通 Cohere Embed v4（`us.cohere.embed-v4:0`） |
| SSH 密钥 | **用部署人自己的**：EC2 密钥对 + 本机私钥（权限 600）。本机网络连不到实例的弹性 IP 时用 EC2 Instance Connect 端点（`SSH_VIA=eice`） |
| 本机工具 | Node.js 24 与 npm、AWS CLI v2、`uv`、`python3`、`ssh`、`rsync`、`openssl`、`curl`；跑端到端要本机装 Chrome |
| 九安开发包 | `source/九安自助审核平台-测试环境开发包-v0.7.10/`（按版本号向九安取，不进仓库） |

**环境配置**（一个环境一份，不进仓库）：

```bash
cp poc/infra/env/example.env poc/infra/env/<环境名>.env && chmod 600 poc/infra/env/<环境名>.env
```

照注释填：栈名和区域、VPC 与子网、`INSTANCE_TYPE=m7g.xlarge`、站点 `DOMAIN_NAME` 和回源名 `ORIGIN_DOMAIN_NAME`、托管区与证书、`NEXUS_ORIGIN` 和 `NEXUS_PROFILE`、知识库的 `KB_MODE=pg` 与 `KB_ALLOWED_CIDR`、经 SSH 管理的 `SSH_KEY_NAME` / `SSH_KEY_FILE` / `SSH_ALLOWED_CIDR`（或 `SSH_VIA=eice`）/ `SSM_MANAGED=false`。Agent 和发布的编号（`AGENT_ID`、`PUBLICATION_ID`、`CONNECTOR_ID`、`KB_PG_PUBLICATION_ID`）部署完对应那一块再填回来。

**密钥配置** `poc/infra/secrets.env`：第一次跑 `deploy.sh` 自动生成（两个账号的口令 + 测试台密钥：PG 的两项、数据密钥，和切换前 MySQL 留给回退的两项，0600），只在本机和实例上，当面交接；样例和对应关系见 `poc/infra/secrets.env.example`。Agent 的调用密钥不放这里。

## 4. 部署

正式环境的顺序是 4.1 → 4.2 → 4.3：Agent 要绑到已经在的 PG，前端要启用已经发布的 Agent。测试台三块在一台机器上，实例由 `deploy.sh` 建，所以顺序是：先 4.3 的第 1、2 步建栈、装前端，再 4.1、4.2，最后回到 4.3 的第 3 步在页面上启用。

### 4.1 PG 与知识库后端

**客户环境**（独立的 PG 主机，用自己的 SSH 密钥）：

1. 起一台主机：带自己的密钥对；安全组对部署人的地址开 22、对 Nexus 的私网段开 PG 端口；实例角色许调 `EMBED_MODEL_ID`（Cohere v4 的推理配置文件和它路由到的三个区域，[kb/GUIDE.md](../../kb/GUIDE.md) 2.4）。
2. 填 `kb/deploy.env`（从 `deploy.env.example` 复制，0600）：`PG_HOST_MODE=existing`、`PG_HOST_INSTANCE_ID`、`PG_HOST_TRANSPORT=ssh`、`PG_SSH_HOST`、`PG_SSH_KEY`（连不到主机地址时加 `PG_SSH_PROXY_COMMAND`）、`NEXUS_URL` 和管理员密码来源；`EMBED_MODEL_ID` 不写就是 Cohere v4。**再写 `AGENT_PATCH_PROMPT=false`**：PG 先于 Agent 部署时审核 Agent 还不存在（缺省的 `true` 会让预检停在「Nexus 里找不到 Agent」），它的提示词由 4.2 的 `audit-agent/apply.py` 管。
3. 只跑数据层这几个阶段（不跑 `all`：`all` 里的 `ingest` 要一份规则 .docx，`agent` 会改审核 Agent 的提示词；规则在 4.3 之后从知识库页上传）：

   ```bash
   cd kb
   ./deploy.sh preflight,db,network,egress,connector --dry-run   # 只读：预检，再看每个阶段会改什么（~ 行）
   ./deploy.sh preflight,db,network,egress,connector             # db 装 Docker、起容器、建 kb_search；network 开 PG 端口；egress 放行 Sandbox 出站；connector 把私网地址和密码登记进 Nexus
   ./deploy.sh verify                                             # 逐层核对；规则还没上传时 [ingest] 报「规则表不存在」是预期的，上传后再跑一次
   ```

   create 模式（工具替你建专用主机）在最前面加 `host`。

**测试台**（PG 和前端在同一台实例上，栈先建好；kb 的设置在 `poc/infra/kb.env`）：

```bash
DEPLOY_ENV=poc/infra/env/<环境名>.env bash poc/infra/kb.sh preflight
DEPLOY_ENV=… bash poc/infra/kb.sh db --dry-run && DEPLOY_ENV=… bash poc/infra/kb.sh db
DEPLOY_ENV=… bash poc/infra/kb.sh connector --dry-run && DEPLOY_ENV=… bash poc/infra/kb.sh connector
DEPLOY_ENV=… bash poc/infra/kb.sh verify
```

环境配置写了 `SSH_KEY_FILE` 时，`kb.sh` 自动让 kb 经 SSH（和 `deploy.sh` 用同一份钉住的主机公钥）。

**规则入库**：有效的规则是审批风险判断卡。原页面是 HTML，先用 [kb/convert/risk-cards/](../../kb/convert/risk-cards/README.md) 转成 .docx，再在新前端的「知识库 › 上传制度」上传（经 PG 知识库 Agent，所以要 4.2 做完）；制度标识 `risk-cards`。制度原文不进仓库、日志和截图。

做完是什么样：`verify` 只剩已知的一条（审批矩阵 `finance-approval-v4` 下线期间 `C03-1.2` 不在检索前 3 名）；规则表 449 行、都有向量；连接测试通过。

### 4.2 Nexus 上的 Agent 与发布

1. **PG 知识库 Agent**：照 `customer-deploy/knowledgebase-writer-agent-pg/` 的部署指南（`GUIDE.zh.md`；让编码工具代做看 `AI-DEPLOY.zh.md`）在 Nexus 上复制一个 Agent、经脚本导入工具（网页上的「导入工具」不会声明数据库密钥，别用）、把 `pg_kb` 绑到 4.1 `connector` 建的那把数据库凭证密钥、保存提示词、发布成 A2A。发布编号填进环境配置的 `KB_PG_PUBLICATION_ID`。
2. **审核 Agent**：

   ```bash
   python3 audit-agent/setup.py --env poc/infra/env/<环境名>.env --dry-run   # 找或建 Agent 和 A2A 发布、处理动态配置
   python3 audit-agent/setup.py --env poc/infra/env/<环境名>.env
   python3 audit-agent/apply.py --env poc/infra/env/<环境名>.env --dry-run   # 下发提示词：打印线上 → 渲染结果的 diff
   python3 audit-agent/apply.py --env poc/infra/env/<环境名>.env
   ```

   发布的名片要声明 `review_advice@1`；数据连接器绑 4.1 的那个；思考强度 `high`；动态配置里不留用不到的工具。每次改线上提示词在 `audit-agent/prompt-history/` 留一个目录（改前、改后、比对、下发记录）。`AGENT_ID`、`PUBLICATION_ID`、`CONNECTOR_ID` 填回环境配置。
3. **调用密钥**：两个发布各一把，**只能由发布者本人在 Nexus 网页上签发**（API 签发会被拒）。下一步在前端页面上粘贴，不写进任何文件。

写提示词的几条教训（[开发者快速对接指南](developer-guide.md)第 5 节）：不要求知识库里没有的东西；查询次数写死、不许探索性的查询；关键词照规则行的写法；用不到的工具别挂。

### 4.3 前端

1. **建栈、装前端**（第一次建 CloudFront 要 5–15 分钟）：

   ```bash
   DEPLOY_ENV=poc/infra/env/<环境名>.env bash poc/infra/deploy.sh             # 测试 → 构建 → 建栈或更新栈 → 打包上传 → 实例上安装 → 健康检查
   DEPLOY_ENV=poc/infra/env/<环境名>.env bash poc/infra/deploy.sh --code-only # 以后只改了代码：不动栈
   ```

   动 AWS 之前先跑 `poc/infra/test` 的测试、构建九安副本（`poc/bench/build-jiuan.sh`）、新前端 `npm ci` → 测试 → 构建、外壳的单元测试，哪一步不过就停。实例上（root，经 SSM 或 SSH）：装 `secrets.env`（只有 root 能读）→ 解开新构件 → `bench/bench-configure.sh`（PostgreSQL 容器 `jiuan-pg`、库 `jiuan` 和它的属主 `jiuan_app`、系统用户 `jiuan`、服务 `andon-jiuan`、`/etc/hosts` 堵掉九安写死的外部地址）→ 换上新构件（上一版留在 `previous`）→ 重启 → 查 `https://<站点>/poc/healthz`。
2. **经 SSH 管理**：主机公钥第一次从实例的控制台输出里取来钉住（`poc/infra/.state/`），之后严格核对；本机网络连不到弹性 IP（2026-11-02 m7g 环境的弹性 IP 在 `184.192.0.0/12`，公司网络到不了）时 `SSH_VIA=eice`，栈另建一个 EC2 Instance Connect 端点，还是 SSH + 自己的密钥，不用 SSM。
3. **在页面上接好 Agent**（管理员 `poc-reviewer`，口令在 `secrets.env`；[快速上手](quick-guide.md)第 4 节）：
   - 「Agent 接入」页：连接 Nexus（贴管理员自己的 Nexus API 密钥）→ 两个发布各贴一次调用密钥启用 → 审核 Agent「设为审批 Agent」（要写原因）→ 文本、请求信封、单据三种测试。
   - 「知识库」页：显示知识库 Agent 就绪；上传 4.1 转好的风险判断卡 .docx。

## 5. 验收

**端到端测试**（真实调用 Nexus，一次约 1–3 美元、5 分钟；会先重置测试台的库 `jiuan`，「Agent 接入」的启用记录保留）：

```bash
DEPLOY_ENV=poc/infra/env/<环境名>.env KB_E2E_DOCX=<本机转好的风险判断卡 .docx> bash poc/app/test/e2e/run.sh
```

先跑 `web.e2e.mjs`（新前端的页面，15 条），再跑 `api.e2e.mjs`（接口、出网、写回、自定义规则、库是 PostgreSQL，12 条），共 27 条；没给 `KB_E2E_DOCX` 时网页的上传那条跳过。

| 验收项 | 做完是什么样 |
|---|---|
| 站点 | `https://<站点>/poc/healthz` 回 `ok`；首页是新前端，带 CSP `style-src 'self'`；`/analysis.html` 能开 |
| 登录与角色 | 管理员看得到工作台、单据池、知识库、我的规则、Agent 接入、设置；分析员 `poc-checker` 看不到知识库、Agent 接入、设置，接口也拒绝 |
| AI 独立建议 | 四张对公付款单都有结论和依据；引用的规则编号都在知识库里；审核 Agent 的检索记进 `kb_search_log` |
| 复核 | 采纳、改判后单据池和工作台跟着变；不回写汇联易 |
| 知识库 | 风险判断卡 449 条有效；再传同一份是「没有变化」；检索能命中卡片 |
| Agent 接入 | 审批 Agent 就绪、接 `review_advice@1`；知识库 Agent 就绪、不进审批流；三种测试合格 |
| 出网 | 被拦下的只有九安写死的外部地址，没有 Nexus |
| 九安的库 | 跑在 PostgreSQL 上：容器 `jiuan-pg` 在跑、`jiuan-mysql` 停着或不在、外壳的 `POC_DB_PORT=5433`，重置后新建的库里有迁移建出的表 |
| 知识库后端 | `kb.sh verify`（或 `kb/deploy.sh verify`）只剩已知的那一条 |

**单元测试**（不连任何服务）：`cd poc/infra && node --test "test/**/*.test.mjs"`；`cd poc/app && node --test "test/unit/**/*.test.mjs"`；`cd poc/web && npm test`；kb 的 Python 测试和 shell 测试（[kb/GUIDE.md](../../kb/GUIDE.md)）；`python3 -m unittest discover -s audit-agent/tests`。出包时 `docs/delivery/make-package.sh` 会再跑一遍。

**2026-11-02 的结果**（m7g 测试台）：单元测试 `poc/infra` 108 条、外壳 193 条（1 条跳过）、新前端 331 条全过；端到端 26 条全过；`kb.sh verify` 只剩已知的一条。

**2026-11-06 换库**：外壳单元测试 205 条、`poc/infra` 130 多条；九安自带的测试在真 PG 上 2475 条过（换库前过的都还过）；切换和端到端的结果见[变更记录](../../CHANGELOG.md)。

## 6. 日常变更与回滚

| 要做的事 | 怎么做 | 怎么退 |
|---|---|---|
| 改代码（外壳、新前端、补丁） | 跑对应的测试 → `deploy.sh --code-only` | 用构件桶 `releases/archive/` 里上一版的包换回 `releases/current.tgz` 再 `--code-only`（[部署与迭代规范](deploy-iteration.md)第 6.1 节） |
| 改审核 Agent 的提示词 | `audit-agent/apply.py --dry-run` → 下发，留 `prompt-history/` | 用上一版的提示词 `apply.py --base …` 再下发一次 |
| 改规则 | 新前端「知识库 › 上传制度」（同一份再传是「没有变化」；改版只写变了的） | 「下线」旧版本、「恢复」上一版 |
| 改栈参数、换机型 | 改环境配置 → `deploy.sh`；换机型用 `upgrade-instance.sh`（只在同一种架构之间换，先 `backup.sh`） | 参数改回去再 `deploy.sh` |
| 备份 | `backup.sh`：根卷快照（九安的 PostgreSQL、知识库的 PG、留着的 MySQL 数据目录、`/var/lib/jiuan` 都在根卷上） | 用快照建卷换回根卷 |
| 换回 MySQL（2026-11-06 换库，项目负责人确认之前出问题才做） | — | [运维](operations.md)第 2.6 节：停服务 → `previous` 换回 `current` → `docker start jiuan-mysql` → 起服务；下一次部署之后就要从换库之前的提交重新部署 |
| 换机器、迁域名 | 另建一个栈 → `deploy.sh` → `kb.sh db` → `migrate-data.sh`（旧环境经 SSM 只读导出、加密搬运、逐表核对）→ `kb.sh connector` 把 Nexus 指到新 PG → 端到端 → 旧栈腾出站点名、新栈接上（[交接文档](handover.md)第 2.2 节有 2026-11-02 的实际做法） | 旧栈没删之前：`kb.sh connector` 用旧环境的配置再跑一次，Nexus 就指回旧 PG |

**要知道的几件事**：
- 栈模板里实例的用户数据（哪怕只改注释）一变，栈更新时实例就要停机再开一次；容器都会重启。
- 2026-11-02 起目录、脚本、服务、用户、库名都去掉了「07」（`poc/web`、`poc/app`、`andon-jiuan`、库 `jiuan`……）。旧名字的实例第一次部署新代码时，`bench-configure.sh` 自动把服务、用户、目录、库和账号原地改名，数据不动。只有两个已经写进数据里的标识保留原值：假汇联易的租户编号 `fake-tenant-jiuan07`（库里各表和「Agent 接入」的启用记录按它存），和外壳连 Nexus 的 operator 配置名 `jiuan07`。
- 端到端测试每次都会重置库 `jiuan`；要留数据，先 `backup.sh`。
- 迁域名的那几分钟里查过 DNS 的机器，最多 15 分钟内可能只拿到 IPv6 地址、连不上；macOS 上 `sudo killall -HUP mDNSResponder` 清缓存。

## 7. 交接与签收

1. **出包**：`docs/delivery/make-package.sh`（跑完全部检查再出 `dist/<版本>.tar.gz` 和 `.sha256`；AWS 账号和 EC2 的标识脱敏成 AWS 文档的示例值；暂存目录里有密钥就不出包）。`--export <目录>` 同步到交接仓库。
2. **对着清单验收**：[交付包指南](package-guide.md)第 6 节，加上本文第 5 节的端到端结果。
3. **当面交接**：`poc/infra/secrets.env`；九安开发包按版本号另给；各人的 Nexus API 密钥各人在自己的 Nexus 网页上生成。
4. **交给维护的人**：[交接文档](handover.md)（资产清单、密钥清单、未完成事项、上生产前必须改的）。

**现在的环境**（2026-11-06）：

| | |
|---|---|
| 测试台 | 栈 `andon-finance-m7g`，一台 m7g.xlarge（arm64），站点 <https://jiuan-v0710.tinyboat.blog>；经 SSH（`key-malibo-sa`）+ EC2 Instance Connect 端点管理，不用 SSM；环境配置 `poc/infra/env/m7g.env` |
| Nexus | `nxs-beine1013`；审核 Agent 发布 `pub_5c53e70d8dc7ddea`；PG 知识库 Agent 发布 `pub_6ea5f0855dff6c1b`；PG 数据连接器 `pgvector-andon`（`conn-f0c7233959d9`）指向测试台实例的私网地址 |
| 九安的库 | 测试台实例上的 PostgreSQL 容器 `jiuan-pg`（127.0.0.1:5433，库 `jiuan`），2026-11-06 20:35–20:37（UTC+8）从 MySQL 切过来；MySQL 容器 `jiuan-mysql` 停着、不删，留着做回退，项目负责人说删再删 |
| 知识库 | 测试台实例上的容器 `nexus-pgvector`；有效规则是审批风险判断卡 `risk-cards`（449 条），向量 Cohere Embed v4 |
| 旧栈 | `andon-finance-poc`（t3.large）等删（项目负责人定先留几天；根卷快照 `snap-05180f1a83a6edada`） |

## 8. 文档地图

| 想做什么 | 读哪份 |
|---|---|
| 包里有什么、怎么校验、验收、签收 | [交付包指南](package-guide.md) |
| 接手维护：有什么、在哪、没做完什么 | [交接文档](handover.md) |
| 九安怎么走到上线（阶段、前置、风险） | [客户部署路线](customer-rollout.md) |
| 每类变更怎么改、怎么测、怎么发、怎么退 | [部署与迭代规范](deploy-iteration.md) |
| 日常运维、看日志、排障 | [运维与后续迭代](operations.md) |
| 第一次接触、管理员在「Agent 接入」页接 Agent | [快速上手](quick-guide.md) |
| 每件事按什么顺序做（审核、知识库、变更、部署、交接） | [工作流](../workflows.md) |
| 九安开发者接 Nexus 上的 Agent（契约、时限、提示词） | [开发者快速对接指南](developer-guide.md) |
| 编码工具里装 nexus-ai-operator | [Skills 配置指南](skills-guide.md) |
| 架构、风险与技术债 | [架构与技术评估](../architecture.md) |
