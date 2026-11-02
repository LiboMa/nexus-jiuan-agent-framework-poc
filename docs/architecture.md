---
subtitle: 九安审核平台 × Nexus AI · PoC 交付
date: 2026-11-02
status: 交付版 v3（写的是九安 v0.7.10 测试台现在跑着的样子；2026-11-02 起只留新 UI；数据全部虚构）
scope: 九安 v0.7.10 测试台（jiuan-v0710.tinyboat.blog；m7g 测试环境的临时站点 jiuan-v0710-m7g.tinyboat.blog）、nxs-beine1013.tinyboat.blog（线上 Nexus AI 的实际地址：d3u3hj2us186y.cloudfront.net）、audit-nexus/poc、kb、audit-agent、knowledgebase-writer-agent-pg
audience: 应用开发、Agent 开发、运维
---

# 九安 × Nexus PoC：架构

写的是现在测试台上跑着的样子，不是规划。数据全部虚构。2026-11-02 起只留这一套：原来并排的 v0.5.3 PoC（PoC 服务端、「Nexus Agent」页、知识 Agent）已从代码里拿掉，见[变更记录](../CHANGELOG.md)。交付相关的文档见[交付文档索引](delivery/README.md)。

## 1. 一句话

一台 EC2（m7g.xlarge，arm64）经 CloudFront 对外提供九安 v0.7.10 测试台：外壳直接听实例的 4180，首页 `/` 是新前端，`/analysis.html` 和九安的接口是九安 v0.7.10 的副本；单据存在本机 MySQL 里。AI 能力都在 Nexus 上：九安经 A2A 把每张对公付款单交给管理员指定的审批 Agent，出 AI 独立建议；知识库在同一台机器的 PG 里，审核 Agent 经数据连接器只读查，PG 知识库 Agent 读写。

![系统总览：浏览器经 CloudFront 到实例上的测试台外壳（新前端、九安 v0.7.10 副本、MySQL、知识库的 PG）；九安经 A2A 调 Nexus 上的审核 Agent，外壳经 A2A 调 PG 知识库 Agent，两个 Agent 都经数据连接器到 PG](assets/diagrams/bench-overview.svg)

## 2. 组件

```
浏览器（管理员 poc-reviewer / 分析员 poc-checker，虚构账号）
   │ HTTPS  <DomainName>
CloudFront（一个分发 Distribution；不缓存；转发 Host、Origin、Cookie 与查询串）
   │ HTTP :4180（安全组只放 CloudFront 回源前缀列表 pl-3b927c52）
EC2（m7g.xlarge；Nexus 同 VPC 公有子网；Amazon Linux 2023，Node 24）
   └─ systemd 服务 andon-jiuan（用户 jiuan，0.0.0.0:4180，屏蔽 IMDS，出网只放行 Nexus）
         ├─ 外壳 poc/app：前门 front.mjs（/ 给新前端 web/dist，口令登录 /poc/login，模拟来单 /poc/intake，健康检查 /poc/healthz）
         │     ├─ 新前端用的接口 /api/analysis/v1/poc/*：复核、工作台、AI 轮次、原件分页、我的规则、知识库
         │     ├─ 「Agent 接入」页的后端：Nexus 发布列表（经 nexus-ai-operator）、测试、调用记录
         │     └─ 进程内的假汇联易（九安的测试环境客户端照常跑，不做真实网络 I/O）
         └─ 九安 v0.7.10 副本（开发包 + 补丁 0001–0007，source/ 不动）：/analysis.html 与 /api/analysis/v1/*
               ├─ 单据同步与流水线、读原件、Agent 任务服务（review_advice@1）、调用中间件 nexus-a2a
               ├─ A2A 适配层 providers/nexus-a2a.mjs（契约 src/agent-contract/，jiuan.agent/v1）
               ├─ 「Agent 接入」（启用记录，调用密钥加密存库）
               └─ MySQL 容器 jiuan-mysql（mysql:8.0，127.0.0.1:3306，库 jiuan）
      PG 容器 nexus-pgvector（pgvector/pgvector:pg17，私网 IP:5432，库 nexus，kb_search、Cohere Embed v4）
            │ ① A2A 0.3 message/stream，Bearer <管理员在「Agent 接入」页粘贴的调用密钥>
            │ ② A2A 名片 /a2a/<发布编号>/.well-known/agent-card.json（公开，不带密钥）
            │ ③ REST（nexus-ai-operator，「Agent 接入」页连 Nexus 时用管理员自己的 API 密钥）
Nexus nxs-beine1013（v0.3.28）
   ├─ 发布 pub_5c53e70d8dc7ddea → 九安审核AI（PoC）：审批 Agent，review_advice@1，经数据连接器只读查 PG
   └─ 发布 pub_6ea5f0855dff6c1b → 知识库文档管家（PG 版）：kb.rules/v1，工具经数据库凭证密钥读写 PG
```

## 3. 调用链

**AI 独立建议**（单据池里的对公付款单）：
1. 九安每分钟从（假）汇联易同步一次；新单进单据池，外壳先把原件读完（九安流水线里「下载原件」「抽取页文字」两步是暂停的）。
2. 九安的 Agent 任务服务按 `review_advice@1` 组装请求信封（单据字段、付款明细、原件的脱敏页文字；人从单据页发起时附上这个人的「我的规则」），经调用中间件 `nexus-a2a` 交给 A2A 适配层。
3. 路由只给「Agent 接入」页上管理员指定的审批 Agent（外壳 `agent-routes.mjs` 注入，任务服务再按名片查一遍），用它启用时的调用密钥；没有审批 Agent 时这一轮记成 `AGENT_TASK_UNROUTED`。
4. 审核 Agent 用 `kb_search` 查知识库（一轮 1–2 次），回结果信封；适配层按契约检查，不合格就在同一段对话里要求修正一次。一轮上限 180 秒。
5. 新前端单据池「最近审核」显示结论；人在抽屉里「采纳 AI 建议」或「改判」，只记在测试台，不回写汇联易。

**知识库页**：新前端「知识库」→ 外壳 `kb-steward-routes.mjs` → `kb-steward-client.mjs` 经 A2A（`kb.rules/v1`）→ PG 知识库 Agent → 它的工具 → PG。测试台不连 PG、不解析文档。

**「Agent 接入」页**：连 Nexus（外壳经 nexus-ai-operator 用管理员的 API 密钥列发布）→ 启用（九安当场读名片、用调用密钥发 `tasks/get`，通过后加密存库）→ 设为审批 Agent → 测试（文本、请求信封、单据）→ 调用记录。

![接入一个新 Agent 的时序：建好、发布 → 本人签发调用密钥 → 管理员在「Agent 接入」页启用 → 设为审批 Agent 或测试](assets/diagrams/ops-onboard-agent.svg)

## 4. 密钥与配置

- **Agent 和 Nexus 的密钥不在任何文件里**：管理员在「Agent 接入」页连接 Nexus（operator 的凭证在 `/var/lib/jiuan/nexus/`）、粘贴调用密钥启用（加密存进九安的库，页面上只显示指纹）。加、换、停用都不改文件、不部署、不重启。
- **启动配置**：只在本机的 `poc/infra/secrets.env`（0600），五项：两个虚构账号的口令、MySQL 的 root 口令、`jiuan_app` 的口令、九安存储的数据密钥（样例 `poc/infra/secrets.env.example`）。`deploy.sh` 经加密的构件桶装到实例的 `/etc/andon-finance/secrets.env`（root 0600），再拆成 `/etc/andon-finance/bench/`、`/etc/andon-finance/jiuan/` 下的文件给 MySQL 和外壳。
- **普通配置**（站点名、Nexus 地址、知识库方式与知识库 Agent 的发布）：在环境配置 `poc/infra/env/<环境>.env` 和栈参数里；每次部署按它们重写 `/etc/andon-finance/jiuan/env`。审批流发给哪个发布不在配置里，由「Agent 接入」页决定。

## 5. 部署：三块

| 块 | 内容 | 工具 |
|---|---|---|
| 前端 | 外壳、新前端、九安 v0.7.10 副本、九安的 MySQL | `poc/infra/deploy.sh`：测试 → 构建（`poc/bench/build-jiuan.sh`、`poc/web`）→ 建栈（模板 `poc/infra/andon-finance-poc.yaml`）→ 打包上传 → 实例上（经 SSM 或 SSH）装构件、配置（`bench/bench-configure.sh`）、重启 → 健康检查 `/poc/healthz` |
| PG 与知识库后端 | PG + pgvector、`kb_search`、规则入库、Nexus 数据连接器与数据库凭证密钥 | `kb/deploy.sh`，测试台上由 `poc/infra/kb.sh` 驱动；客户用自己的 SSH 密钥先部署这一块 |
| Nexus 上的 Agent 与发布 | 审核 Agent、PG 知识库 Agent | `audit-agent/apply.py`、`knowledgebase-writer-agent-pg/`（客户部署件 `customer-deploy/`）、`skills/nexus-ai-operator` |

测试阶段三块在一台机器上；换机器用 `poc/infra/migrate-data.sh`。细节见[部署与迭代规范](delivery/deploy-iteration.md)和[部署说明](../poc/infra/README.md)。

## 6. 代码地图

| 路径 | 做什么 |
|---|---|
| `poc/app/server.mjs` | 组合根：照九安 `scripts/start-analysis.mjs` 组装九安副本，换掉配置、汇联易传输、出网，挂上外壳的接口 |
| `poc/app/front.mjs` | 前门：`/` 给新前端，口令登录页、模拟来单页；别的请求交给九安 |
| `poc/app/nexus-access.mjs`、`agent-tests.mjs`、`agent-calls.mjs`、`agent-routes.mjs`、`envelope-tests.mjs` | 「Agent 接入」页：发布列表、测试、调用记录、审批流只发给审批 Agent、请求信封测试用的契约部分 |
| `poc/app/kb-steward-routes.mjs`、`kb-steward-client.mjs`、`kb-docx.mjs` | 知识库页：接口、经 A2A 调知识库 Agent（`kb.rules/v1`）、上传的 .docx |
| `poc/app/reviews.mjs`、`dashboard.mjs`、`advice-rounds.mjs`、`evidence-pages.mjs`、`user-scope.mjs` | 新前端用的接口：复核（表在 `jiuan` 库）、工作台、AI 轮次、原件分页、公司范围 |
| `poc/app/custom-rules.mjs`、`custom-rules-advice.mjs` | 我的规则：上传、附进人发起的那一轮 |
| `poc/app/fake-hly.mjs`、`fixtures.mjs`、`seed-anchor.mjs`、`intake.mjs`、`originals-first.mjs` | 假汇联易、虚构单据、种子时间锚点、模拟来单、先读原件 |
| `poc/app/guard.mjs`、`settings.mjs`、`jiuan.mjs` | 出网守卫、运行设置、九安副本的唯一入口 |
| `poc/app/lib/` | `a2a-client.mjs`（A2A 0.3 流式客户端）、`catalog.mjs`（发布与名片）、`cli.mjs`（调 nexus-ai-operator）、`login.mjs`（口令登录）、`http.mjs`（HTTP 小工具） |
| `poc/web/` | 新前端（React 19、TypeScript、Vite、Tailwind 4、TanStack Query、Radix，哈希路由） |
| `patches/jiuan-v0.7.10/` | 打进九安副本的补丁 0001–0007 |

## 7. 已知限制

- **源站是明文 HTTP**：CloudFront 到实例这一段（评审 C2，[交接文档](delivery/handover.md)第 6.1 节）。
- **数据只在这一台实例上**：MySQL、PG、`/var/lib/jiuan` 都在根卷上；替换前 `backup.sh`，换机器 `migrate-data.sh`。
- **九安上游的 `review_advice@1` 时限是 120 秒**：测试台用补丁放到 180 秒（[开发者快速对接指南](delivery/developer-guide.md)第 4 章）。
- **健康检查看不出 AI 建议出不来**：调用密钥失效、Nexus 出错时 `/poc/healthz` 照样通（评审 I6）。
- **这套 Nexus 用的是旧部署模板**：`/a2a` 经前端反代转发，请求体超过 10 MB 会被截断。
