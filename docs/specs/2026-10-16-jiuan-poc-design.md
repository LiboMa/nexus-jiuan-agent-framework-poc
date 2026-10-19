# 规格：九安自助审核平台 PoC（九安前端 + Nexus Agent + 审批流，部署在 Nexus 同 VPC）

- 日期：2026-10-16
- 状态：设计逐节确认；2026-10-16 按新要求修订（改为 IaC 部署到 Nexus 同 VPC 的 EC2，用 CloudFront 暴露）；规格已获同意，进入实现计划
- 范本：`audit-nexus/source/审核平台-测试环境开发包-v0.5.3/`（只读引用，不修改）
- Nexus：Nexus-AI 0.3.28，https://nxs-beine1013.tinyboat.blog（环境 `nxs-beine1013-eaba1a`，VPC `vpc-0e6ea1709661ddb1e`）
- PoC 地址：https://andon-finance.tinyboat.blog

## 1. 目标与成功标准

**User Story**：

1. 九安的前端跑在测试环境里，用浏览器打开；
2. 我用 Claude Code 在 Nexus 上构建 Agent；
3. 前端能看到这些 Agent 的数据与状态，能调用并测试；
4. 用前端里的单据数据走审批流，交给后端的 Agent 处理并拿回结果；
5. 九安开发包的核心功能在 PoC 里运行。

**已定的决定**：

| 决定 | 结论 |
|---|---|
| 审批决定权 | Agent 只给建议，「通过 / 退回」由人做决定，与九安「模型不下结论」的设计一致 |
| 实现方案 | 方案 A：九安原服务端 + 原前端，存储换成内存，再加两处 PoC 扩展 |
| 运行位置 | 用 IaC（CloudFormation）在 Nexus 同 VPC 的公有子网建一台 EC2，测试环境跑在上面，本地不再启动 |
| 对外暴露 | CloudFront + `andon-finance.tinyboat.blog`（复用现有通配证书 `*.tinyboat.blog`） |
| 访问控制 | 口令登录：两个虚构账号「审核员」「复核人」，口令存在 SSM Parameter Store |
| 调用 Nexus Agent | A2A（对外发布 + 调用密钥）；Agent 列表与状态经 REST（专给这台 EC2 的 API 密钥）读取 |
| 构建 Agent | 在 Claude Code 里用 nexus-ai-operator（REST）：复制、改提示词、发布 A2A |
| 平台 MCP 服务 | 不启动：nexus-ai-operator 走 REST，用不到 MCP；以后需要在 Claude Code 里经 MCP 调 Agent 时再单独开 |

**成功标准（验收）**：

1. 一条命令完成部署（建栈、上传构件、在 EC2 上启动）；浏览器打开 https://andon-finance.tinyboat.blog，用口令登录后能看到单据池与单据详情；预审与两档结论由九安自己的代码算出。
2. 「Nexus Agent」页列出你在 Nexus 上的 Agent 及其状态、版本、模型、发布与 A2A 通道情况；用 Claude Code 新建并发布的 Agent，点「刷新」后会出现。
3. 对已发布并配好调用密钥的 Agent，在页面上输入内容调用，能看到原始返回、九安校验是否通过、时延与错误码，并记入运行记录。
4. 对一张单据发起审批流：先预审，再由 Agent 给出建议（含退回草稿），审核员做决定，复核人确认，最终为「已通过」或「已退回」；每一步的状态和留痕在页面上可见。
5. 单元测试全部通过；Playwright 对线上地址的端到端测试走通标准 1–4。
6. 一条命令完成清理（删栈、删参数、清空构件桶）。

## 2. 架构

```
浏览器 ──HTTPS──▶ CloudFront（andon-finance.tinyboat.blog，*.tinyboat.blog 证书，关闭缓存，转发 Host 与 Cookie）
                      │ HTTP，应用端口 4180（安全组只放 CloudFront 回源前缀列表 pl-3b927c52）
                      ▼
EC2（Nexus VPC 公有子网 subnet-0dda59910e53ee804，Elastic IP，Amazon Linux 2023，nodejs24，systemd）
   ├─ 九安 createAnalysisApp（测试实例 instance='test'，origin 固定为 https://andon-finance.tinyboat.blog）
   ├─ PoC 口令登录（校验口令后走九安的本地票据换会话）
   ├─ 内存 store（虚构单据，以及 AI 与证据服务的键值状态）
   ├─ 九安 AI 建议 / 草稿核验服务 → Nexus 模型客户端（A2A，第四轮的实现）
   ├─ 审批流状态机与留痕（PoC）
   └─ Nexus 目录：REST（nexus-ai-operator CLI，凭证是这台 EC2 专用的 API 密钥）
          │ HTTPS（经 Nexus 的 CloudFront；A2A 走流式，不受 60 秒限制）
          ▼
   Nexus：/a2a/<发布编号>（调用）、/api/v2/agents 与 /api/v2/publications（列表与状态）
```

Nexus 的 ALB 只允许 CloudFront 回源（`pl-3b927c52`），所以 EC2 经 Nexus 的公网域名调用，不改 Nexus 的任何安全组。

**应用目录** `audit-nexus/poc/app/`：

| 文件 | 职责 |
|---|---|
| `server.mjs` | 组装九安的 `createAnalysisApp`，加上依赖服务、PoC 路由、口令登录和前端托管；监听地址与端口取自环境变量（EC2 上为 0.0.0.0:4180） |
| `config.mjs` | 启动时从 SSM Parameter Store 读口令与 Nexus 密钥（EC2 上）；本机开发时从环境变量读 |
| `memory-store.mjs` | 九安 store 接口的内存实现：`listCompanies`、`overview`、`listDocuments`、`getDocument`、`getDocumentHead`、`listBatches`、`analytics`、`readState`、`readStates`、`writeState`、`compareAndWriteState`（乐观锁） |
| `seed.mjs` | 虚构单据（第 7 节） |
| `nexus/catalog.mjs` | 经 nexus-ai-operator CLI 子进程读取 Agent 列表、详情、版本、发布与通道状态；不读取 CLI 的凭据文件 |
| `nexus/model-client.mjs` | 九安 `createModelClient` 契约的 A2A 实现（沿用 `poc/a2a-entry/nexus-a2a-model.mjs`）；按发布编号从 SSM 取调用密钥 |
| `approval/workflow.mjs` | 审批流状态机与留痕（第 5 节） |
| `public/` | 九安前端副本，加 `poc-agents.js`、`poc-approval.js` 和口令登录页；路由与导航只做小改 |
| `test/` | 单元测试与 Playwright 端到端测试 |

**基础设施目录** `audit-nexus/poc/infra/`：

| 文件 | 职责 |
|---|---|
| `andon-finance-poc.yaml` | CloudFormation 模板（第 3 节） |
| `deploy.sh` | 建栈或更新栈；打包应用与九安开发包上传到构件桶；经 SSM 让 EC2 拉取、安装依赖、重启服务；最后做健康检查 |
| `destroy.sh` | 删栈、删 SSM 参数、清空构件桶 |
| `README.md` | 前置条件、部署、放密钥、清理 |

**九安依赖服务的组装**：

- 优先用 `createAnalysisRuntimeServices`，需要的 `ruleProvider`、`sourceClient`、`gateway`、`extractor` 提供内存版或桩实现。
- 如果其中的调用中间件离不开 MySQL，改为直接用 `createAnalysisAiAdviceService` 与 `createAnalysisDraftEvidenceService`。上下文用九安的 `buildAnalysisBasePrecheck` / `buildAnalysisRuleTrial` 组装，证据上下文用虚构页文字。
- 实现计划的第一步就是验证这一处。

## 3. 部署（IaC）

**CloudFormation 栈 `andon-finance-poc`**（us-east-1）：

- **参数**：
  - `VpcId`：`vpc-0e6ea1709661ddb1e`
  - `SubnetId`：`subnet-0dda59910e53ee804`
  - `DomainName`：`andon-finance.tinyboat.blog`
  - `HostedZoneId`：`Z02657523IKMDPFJE34YX`
  - `CertificateArn`：现有的 `*.tinyboat.blog`
  - `InstanceType`：缺省 `t3.small`
  - `AppPort`：缺省 4180
- **资源**：
  - **构件桶（S3）**：私有，服务端加密，禁止公开访问。
  - **实例角色与实例配置文件**：`AmazonSSMManagedInstanceCore`；读构件桶；读 `/andon-finance/poc/*` 参数（含 SecureString 解密）。
  - **安全组**：
    - 入站只放 CloudFront 回源前缀列表 `pl-3b927c52` 访问 `AppPort`，不开 22；
    - 出站不限，用于访问 Nexus、SSM 和 S3。
  - **EC2**：
    - Amazon Linux 2023 最新 AMI（经 SSM 公共参数解析），IMDSv2；
    - 用户数据安装 `nodejs24`、`nodejs24-npm`、`python3`，建 systemd 服务 `andon-finance-poc`；
    - 服务启动前先从构件桶取最新构件。
  - **Elastic IP**：给 CloudFront 一个稳定的回源域名 `ec2-<ip>.compute-1.amazonaws.com`。
  - **CloudFront 分配**：
    - 回源只走 HTTP、端口 `AppPort`；
    - 缓存策略 `CachingDisabled`，回源请求策略 `AllViewer`（转发 Host、Cookie、查询串，九安会校验 Host 与 Origin）；
    - 观众协议重定向到 HTTPS，别名 `DomainName`，证书 `CertificateArn`，TLSv1.2_2021。
  - **Route 53**：A 与 AAAA 别名记录指向 CloudFront。
- **输出**：站点地址、实例编号、构件桶名、分配编号。

**SSM 参数**（`/andon-finance/poc/`，SecureString）：

| 参数 | 谁来放 | 说明 |
|---|---|---|
| `accounts/reviewer-password`、`accounts/checker-password` | `deploy.sh` 首次部署时随机生成 | 你用 `aws ssm get-parameter --with-decryption` 读取 |
| `nexus/api-key` | 你 | 在 Nexus 网页「个人设置 › API 密钥」给这台 EC2 生成一把（档位 `read_only` 即可），用 `aws ssm put-parameter` 放进来；EC2 首次启动时用它 `login`，之后 CLI 自动续期与轮换 |
| `nexus/a2a/<发布编号>` | 你 | 每个要调用的发布一把调用密钥，在网页「互联中心 › 对外发布」签发；放进来以后在页面上点「刷新」就生效，不用重新部署 |

密钥由你在自己的终端里放进 SSM，比如 `aws ssm put-parameter --type SecureString --overwrite --name /andon-finance/poc/nexus/a2a/<发布编号> --value "$(pbpaste)"`，不经过对话。

**部署与更新**：

- 执行 `audit-nexus/poc/infra/deploy.sh`：
  1. `aws cloudformation deploy`；
  2. 打包 `poc/app` 与九安开发包的 `code/`，上传构件桶；
  3. `aws ssm send-command` 让实例拉取、安装依赖、重启服务；
  4. 访问 `https://andon-finance.tinyboat.blog/api/health` 确认成功。
- 只改代码时，跳过建栈，直接从第 2 步开始。

**费用估计**：

- t3.small 约 15 美元 / 月；公网 IPv4 约 3.6 美元 / 月；CloudFront、S3、SSM 基本可以忽略。
- 每次 Agent 调用约 0.05 美元，记在 Nexus 发布者名下。

## 4. Nexus 集成

- **Agent 来源**：
  - 起步沿用第四轮的「九安审核AI（PoC）」（`agent_56d44dd9350f4a568bca387319e12ae4`，只输出 JSON、不挂工具），以及它的发布 `pub_5c53e70d8dc7ddea`。这个发布当前已暂停，需要恢复，并由你签一把新的调用密钥。
  - 之后你在 Claude Code 里用 nexus-ai-operator 新建、发布的 Agent，签好调用密钥放进 SSM 后，点「刷新」就会出现，并且可以调用。
- **「Nexus Agent」页**：
  - 卡片：名称、说明、状态、版本、模型、所有者、发布与 A2A 通道状态、「调用密钥已配置 / 未配置」；
  - 「刷新」：重新读取列表，并重新从 SSM 加载调用密钥；
  - 「调用测试」（只对已发布并配了密钥的 Agent 开放）：
    - 输入任意文本，或选一张单据，自动组装审批建议的输入；
    - 显示原始返回、九安校验结果（选了单据时）、时延和错误码；
    - 最近 50 次调用作为运行记录，存在内存里。
  - 显示两项 AI 任务当前用的是哪个发布，在配置里指定。
- **AI 任务的模型客户端**：
  - A2A 0.3 `message/stream`，每次调用用新会话；
  - 剥掉一层 ```json 代码围栏，并在运行记录里计数；
  - 中止时发 `tasks/cancel`，超时 180 秒；
  - 错误码映射沿用第四轮。

## 5. 审批流

**状态**：

- 未发起
- 预审中
- AI 处理中
- AI 失败
- 待审核
- 待复核（通过）
- 待复核（退回）
- 已通过
- 已退回
- 已失效

**合法转换**：

| 从 | 到 | 由谁 | 条件 |
|---|---|---|---|
| 未发起 / 已失效 | 预审中 | 审核员 | 「发起审批」 |
| 预审中 | AI 处理中 | 系统 | 九安预审完成 |
| AI 处理中 | 待审核 | 系统 | Agent 建议通过九安校验 |
| AI 处理中 | AI 失败 | 系统 | 调用失败、超时或输出不合格 |
| AI 失败 | AI 处理中 | 审核员 | 「重试 AI」 |
| AI 失败 | 待审核 | 审核员 | 「转人工」（不带 Agent 建议） |
| 待审核 | 待复核（通过） / 待复核（退回） | 审核员 | 做决定；与 Agent 建议不一致时必须填写理由；退回必须有退回说明（默认带出 Agent 草稿，可修改） |
| 待复核（通过 / 退回） | 已通过 / 已退回 | 复核人 | 「确认」；复核人不能是做决定的同一人 |
| 待复核（通过 / 退回） | 待审核 | 复核人 | 「驳回」，必须填写理由 |
| 任意非终态 | 已失效 | 系统 | 单据版本变化 |

**规则**：

- Agent 的输出只写进「建议」字段，不调用任何状态转换。
- 每一步都记录单据版本、预审与规则的哈希、发布编号、模型标识。
- 每次状态变化记一条留痕：操作人、时间、动作、理由、Agent 输出摘要、时延。
- 非法转换返回 409，状态不变。

**页面**：

- 单据详情里的「审批流」卡片：当前状态、各步骤（等待 / 进行中 / 完成 / 失败）、Agent 建议、按当前账号可用的操作按钮、时间线。
- 单据池列表里加一列「审批状态」。

**接口（`/api/poc/`）**：

- `GET approvals/:documentId`
- `POST approvals/:documentId/start`
- `POST approvals/:documentId/retry`
- `POST approvals/:documentId/manual`
- `POST approvals/:documentId/decide`（`{decision: approve|return, reason, returnNote}`）
- `POST approvals/:documentId/confirm`
- `POST approvals/:documentId/reject`
- `GET agents`
- `POST agents/refresh`
- `POST agents/:publishId/invoke`
- `GET agents/runs`

所有写接口沿用九安的会话 Cookie 与 CSRF 校验。

## 6. 账号与登录

- 两个虚构账号：「审核员（虚构）」与「复核人（虚构）」，都是 `local_owner` 模式，可见两家虚构公司。
- 登录页 `/poc/login`：
  1. 输入账号与口令；
  2. 服务端用定长时间比较校验口令（口令来自 SSM）；
  3. 校验通过后签发九安本地票据（`auth.issueLocalTicket`），走九安原有的 `/auth/exchange` 换成会话 Cookie（Secure、HttpOnly、SameSite=Strict）。
- 登录失败按来源 IP 限流（每分钟 10 次）。来源 IP 取 CloudFront 写入的 `X-Forwarded-For`。
- 未登录访问任何页面都跳转到登录页。
- 九安原有的钉钉登录按钮不显示，因为认证配置里没有启用。

## 7. 数据

- 8–10 张虚构单据，两家虚构公司（「示例子公司甲 / 乙（虚构）」），结构照九安测试里的单据对象（`sourceForm` 的字段、明细、发票、附件元数据），版本按九安的哈希方式计算。
- 覆盖的情形：
  - 低风险差旅；
  - 缺附件；
  - 招待超标并在说明里夹带指令；
  - 市场费用；
  - 房租对公付款（合同 × 发票 × 付款三方一致，用于草稿核验）。
- 3–4 张带附件页文字。
- 每次服务启动重新生成，状态只在内存里，重启即清空。

## 8. 错误处理

| 情况 | 表现 |
|---|---|
| 某个发布没有配调用密钥，或已暂停 | 卡片显示「未配置密钥」或「已暂停」，「调用测试」不可用 |
| A2A 调用失败（401 / 404 / 429 / 503 / 超时） | 按第四轮的映射显示错误码；审批流进入「AI 失败」，可以重试 |
| API 密钥失效（连接被停用或过期） | Agent 列表显示「状态未取到」以及处理办法（在网页重新生成，放进 SSM，重启服务） |
| 输出不合格 | `AI_INVALID_RESPONSE`，原始返回在运行记录里可见 |
| 非法的审批转换 | 409，前端提示原因 |
| 服务异常退出 | systemd 自动重启；数据在内存里，重启后清空，页面提示「测试环境已重置」 |

## 9. 测试

- **单元测试**（本机，`node:test`，不依赖 AWS 与 Nexus）：
  - 内存 store 的乐观锁；
  - 审批流的全部合法与非法转换、双人规则、版本失效、「不一致须填理由」；
  - 口令校验与限流；
  - 模型客户端剥围栏；
  - catalog 对 CLI 输出的解析。
- **部署检查**：`deploy.sh` 结束时检查健康接口；用 `cfn-lint` 检查模板（本机装了的话）。
- **端到端测试**（Playwright，对 https://andon-finance.tinyboat.blog，真实调用 Nexus，约 0.05 美元一次）：
  1. 用口令登录后打开单据池；
  2. 打开单据，发起审批，等待 AI 建议；
  3. 审核员退回、复核人确认，结果为「已退回」；
  4. 另一张单据：审核员通过、复核人确认，结果为「已通过」；
  5. Agent 页列出 Agent，调用测试成功。

## 10. 分期

- **第一期（本规格）**：先完成「Agent 调用的主体协作」，包括：
  - 九安前端与服务端跑在测试 EC2 上；
  - Agent 列表、状态与调用测试；
  - 单据审批流交给 Nexus Agent 给建议、由人做决定。

  存储用内存，调用走 A2A 与 REST，不需要 MySQL 和 MCP。
- **之后逐步优化**（2026-10-16 约定）：凡是要用到 MySQL，或者应用要用 MCP，一律先在远端测试服务器（这台 EC2 或同 VPC 的测试资源）上构建，不放在本地。候选项：
  - 换成九安的真实 MySQL 存储；
  - 应用侧的 MCP，例如钉钉官方 MCP 发提醒，或经同 VPC 调 Nexus 平台的 MCP；
  - CloudFront 改为 VPC 源站；
  - 规则发布与双人复核接上九安原有的实现。

## 11. 范围之外

汇联易同步、钉钉免登、MySQL、规则发布、付款与平台中心各页（显示为空）、回写汇联易、平台 MCP 服务、正式环境部署、高可用（单台实例）。

## 12. 风险

| 风险 | 应对 |
|---|---|
| `createAnalysisRuntimeServices` 的调用中间件离不开 MySQL | 实现计划第一步先验证；不行就改用两个服务工厂（第 2 节） |
| CloudFront 回源到 EC2 走 HTTP（和 Nexus 的 ALB 相同的做法），这一段明文 | 数据全部虚构；安全组只放 CloudFront；以后可改为 CloudFront VPC 源站 |
| 站点在公网，页面能触发 Nexus 调用、产生费用 | 口令登录加登录限流；调用测试按会话限流（每分钟 5 次） |
| 九安的 Host 与 Origin 校验 | origin 配成 `https://andon-finance.tinyboat.blog`，CloudFront 用 `AllViewer` 转发 Host |
| EC2 的 API 密钥（连接）只能在一台机器上用 | 实例被替换后，需要在网页上重新生成，放进 SSM |
| 单次 AI 时延 30–60 秒 | 审批流异步执行，页面轮询；按钮在 AI 处理中时禁用 |
| 模型输出不稳定（代码围栏、风险等级波动） | 剥围栏并计数；审批流不以风险等级做门槛 |
| 九安前端某些页面依赖本 PoC 不提供的接口 | 显示为空或报「未配置」；PoC 只保证单据池、单据详情、Agent 页、审批流卡片 |
