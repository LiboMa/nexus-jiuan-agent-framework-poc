# 第二轮可行性评估：九安自助审核平台 × Nexus-AI v0.3.28

- 日期：2026-10-14
- 对象：九安自助审核平台（测试环境开发包 v0.5.3，Node.js 24 + MySQL 8）
- 平台：https://nxs-beine1013.tinyboat.blog（Nexus-AI 0.3.28 enterprise，环境 `nxs-beine1013-eaba1a`，CloudFront `E3D4FHABSMYLP4`）
- 第一轮材料：`assessment.md`（实施难度）、`replication-feasibility.md`（1:1 复刻调研，基于 v0.3.27）
- 配套：`feasibility-round2.html`（同样的内容，带动态示意）

## 0. 本轮怎么核实的

1. **用 nexus-ai-operator 连接平台**：以 admin 身份登录（经 API 密钥的调用按规则封顶为 editor，权限档位 builder）。对 33 个模块做能力发现，并用只读调用核对配置：沙箱策略、发布约束、连接器类型、发布网关就绪状态、额度。
2. **比对 Nexus 仓库 v0.3.27 → v0.3.28**（232 个提交、820 个文件）：逐项复核第一轮的 5 个硬阻塞，并完整阅读新增的对外发布网关。
3. **只读查看这套环境**：CloudFront、ALB 监听规则、安全组、沙箱节点、登录页。
4. **对照审核平台的接入契约**：`providers/ai-model.mjs`、调用中间件、数据治理。

全程只读：没有在平台上创建 Agent、发布或密钥。唯一的写入是登录本身，它按 nexus-ai-operator 的设计替 admin 生成了一把 API 密钥（名称 `claude_code`，档位 builder），评估结束后可以在「个人设置 › API 密钥」停用。原始输出存在 `audit-nexus/archive/evidence/round2/`。

## 1. 结论

| 路线 | 第一轮（v0.3.27） | 本轮（v0.3.28） | 原因 |
|---|---|---|---|
| **A. 整体迁入 Nexus，1:1 复刻** | ≈ 0% | **≈ 0%，不建议** | 5 个硬阻塞一个都没有变化 |
| **B. 在 Nexus 上高保真重建**（自带 RDS） | 56 项核心功能：57% 保持原语义、30% 降级、13% 做不到 | **不变，不建议** | 没有任何一项打分因 v0.3.28 改变；做不到的仍是「合规」与「职责分离」 |
| **C. 平台独立部署，Nexus 做 AI 层** | 推荐：经应用 Agent API，4.5–8 人日 | **仍推荐，接法更好：改用 A2A 对外发布**，约 5.5–9 人日 | v0.3.28 新增的对外发布正是「给其他系统调用」的通道：流式返回、按发布签发的调用密钥、限流与并发闸门、版本与模型钉住 |

**一句话：v0.3.28 没有让「整体迁入」变得可行，但让「对接」更顺了。** 推荐的做法是：平台照原样独立部署，`providers/ai-model.mjs` 经 A2A 调用 Nexus 上发布的 Agent。前提有两个：

- 客户接受调用内容在 Nexus 的隐藏会话里留存一段时间（默认 30 天，管理员可以调短）；
- 上线前先处理这套环境的几项高风险配置（第 6 节）。

## 2. v0.3.28 新增了什么，和本项目的关系

| 新能力 | 是什么 | 对本项目 |
|---|---|---|
| **对外发布**（Experimental） | 把 Agent 连同动态配置发布为 A2A 服务、MCP 工具或微信 ClawBot。外部调用 `/a2a/<发布编号>`、`/mcp/<发布编号>`，以发布者的身份和额度运行 | **对接通道首选（A2A）**，见第 4 节 |
| **API 密钥 + nexus-ai-operator** | 用户在「个人设置」生成密钥，交给 Agent 或脚本，按用户本人的权限和档位调用平台 API | 适合做运维与验证（本轮就是用它评估的）。技术上也能做机器对机器调用，但它代表一个真人用户：封顶 editor，没有服务账号、单密钥限流和 IP 白名单。**不建议当作生产对接凭证** |
| 业务洞察、审计追踪改版 | 平台使用统计；平台操作的审计（区分人工与系统操作、敏感操作、来源 IP） | 记录的是平台操作，不提供业务审批或双人复核 |
| 自定义资源（**本版关闭**） | 在用户自己接入的服务器上部署 MySQL、PostgreSQL、Redis 或 Web 项目 | 本版默认关闭，CHANGELOG 写明「已知问题留到下个版本，请不要手动打开」。只做全新安装，不能托管现有应用；Web 模板用服务器上已有的 `node`，没有就装发行版自带的 `nodejs`（Amazon Linux 2023 是 18），不能选版本。**不是迁移路径**，下个版本再看 |
| Agent 模式、分身 | 与数字分身对话的极简界面 | 无关 |

## 3. 第一轮 5 个硬阻塞的复核

| # | 阻塞 | v0.3.28 | 证据（路径:行号，v0.3.28） |
|---|---|---|---|
| 1 | **访客身份与权限**（钉钉工号登录、按公司限定可见范围、双人确认） | **不变** | 访问模式仍是 `none / apikey / password`（`api/v2/routers/apps.py:657`，`api/v2/services/app_service.py:2448-2455`）；访客会话仍以所有者身份运行（`app_service.py:2708`）；页面拿不到访客身份（`apps.py:2277-2304`）；平台单点登录仍只有 SAML（`api/v2/auth/config.py:4`）；身份与数据层方案仍是「方案待评审，未实现」（`docs/_archive/app-center-l3-data-and-identity-plan-20260910.md:3`） |
| 2 | **应用自己的数据库**（56 张表、事务、迁移） | **不变** | 数据连接器写入仍是单表、无事务（`tools/system_tools/data_connector/data_connector_write.py:19-61`），查询仍是最多 1000 行、30 秒（`config/data_connector.yaml:34-42`）；页面持久化仍是每个链接 256 KB（`apps.py:1519-1528`）；新增的数据库迁移（73–83）都不是应用数据 |
| 3 | **不经大模型的确定性执行**（列表、筛选、每次读取时计算） | **不变** | 流程里仍只执行 Agent 步骤（`apps.py:2922-2924`、`apps.py:3799-3800`）；页面仍禁止 `fetch`（`application_build_tools.py:871-886`）。新增的入口（对外发布、API 密钥）每次也都是一轮 Agent |
| 4 | **常驻数据管道与调度**（每小时增量同步、重试、告警） | **调度器不变**；新增可经 API 密钥调用「立即触发」 | `nexus_utils/event_scheduler/executor.py`、`scheduler.py` 没有改动：失败仍只记失败，不重试、不告警、没有任务超时（`scheduler.py:514-516`）；`POST /api/v2/event-jobs/{id}/trigger`（`api/v2/routers/event_jobs.py:581-592`）只是「立刻跑一次」，不是带数据的 webhook；仍没有入站 webhook |
| 5 | **运行时 Node.js 24** | **不变** | VM 镜像仍装 Amazon Linux 2023 自带的 `nodejs`，即 18.20.8（`infrastructure/sandbox/build-rootfs.sh:322-323`，该目录在两个版本之间没有改动）；环境配方仍只支持 Python 依赖（`config/capabilities/env_recipes.yaml:4-5`） |

另有一项**本轮新发现、与正式数据有关的风险**：v0.3.28 的一份草案记录了 VM 隔离的已知缺口，状态为「草案，待用户确认」，沙箱代码在本版没有改动（`docs/superpowers/specs/2026-10-09-v0328-platform-ops-isolation-design.md:37-47`）：

- VM 内的 root 可以把代码卷重新挂成可写（R1）；
- 可以挂载数据卷根目录，读写所有用户的工作区（R2）；
- 整个 `/code` 可读（R3）。

## 4. 推荐方案：平台独立部署，经 A2A 调用 Nexus

```
审核平台（Docker Compose：Node 24 + MySQL 8，照原样部署）
  └─ 调用中间件（超时 120 s、并发 2、每天 150 次，原样不动）
      └─ providers/ai-model.mjs ── A2A SendStreamingMessage，Authorization: Bearer <调用密钥> ──▶ https://<Nexus>/a2a/<发布编号>
             ▲ 流式返回 answer 全文                                                            └─ 发布者专用账号的 Agent（钉住版本与模型）→ 模型
             └─ parseAdvisoryResult / validateDraftEvidenceResult（平台自带机械校验，不合格不形成结论）
```

### 4.1 为什么改用 A2A 对外发布

| | 应用 Agent API（第一轮方案） | **A2A 对外发布（推荐）** | API 密钥 + `/agents/{id}/invoke` |
|---|---|---|---|
| 设计用途 | 应用的机器接口 | **给其他系统调用** | 给编码 Agent 和脚本用 |
| 成熟度 | 稳定，两个版本之间无改动 | Experimental，v0.3.28 新增；网关单进程运行 | v0.3.28 新增 |
| 凭证 | 每个应用 Agent 一把 `X-API-Key`，只能本人在网页签发 | 每个发布可签多把：明文只显示一次，可设到期（最长 365 天）、轮换（旧钥默认宽限 24 小时）、随时停用 | 代表一个真人用户；需要实现密钥兑换（访问密钥 60 分钟续期，连接密钥约 7 天轮换） |
| 返回内容 | `{text, data}`：按输出 schema 提示模型并解析 | **只有文本**，平台不强制 schema | 文本 |
| 长调用 | 同步阻塞：经 CloudFront 超过 60 秒就失败 | **流式返回**（`SendStreamingMessage`），或提交后轮询 `GetTask` | 同步阻塞：受同样的 60 秒限制 |
| 限流 | 所有者预算与应用配额；**不受**每 IP 每小时 30 个会话的限制（`apps.py:1812` 的接口不走 `check_session_rate`） | 每把密钥 60 次/分钟（突发 10 次/10 秒），每个发布并发 8 轮；发布者额度用尽时返回 429 并自动暂停发布 | 只有月度 token 额度，没有单密钥限流 |
| 版本与模型 | 跟随应用版本 | 跟随最新版本或钉住某一版；可以单独指定模型 | Agent 当前版本 |
| 内容留存 | 会话以所有者身份保存，应用调用记录里能看到完整过程 | 隐藏会话保存消息、回复、工具结果和附件；闲置 30 天后删除，管理员可以调短 | 接口说明写「不创建会话，不保存消息记录」（`api/v2/routers/agents.py:636-657`），**未实测** |

**选 A2A 的理由**：这是唯一同时解决「长调用」「凭证生命周期」「限流与并发」「版本钉住」的通道。

两个代价都可以接受：

- **不强制 schema**：影响不大。审核平台本来就不信任模型输出，结构、枚举、长度、引用逐字匹配都过机械校验，不合格一律记为 `AI_INVALID_RESPONSE`、不形成结论。
- **Experimental**：AI 在这个平台里只是「参谋」。AI 不可用时，页面显示「AI 模型尚未接入」，规则核验照常工作，失败的影响面小。

另外两个通道的用法：

- **应用 Agent API** 留作备选，用于必须由 Nexus 侧解析 JSON 的场景。
- **API 密钥 + invoke** 留作「不留存内容」的候选：先实测它是否真的不留存，再决定。

### 4.2 Nexus 侧怎么配

1. **发布者用专用账号**（例如 `jiuan-audit-svc`）。调用以发布者的身份运行、扣发布者的额度，与个人账号隔离；只有 Agent 的创建者能发布它，管理员也不例外（`api/v2/services/publication_service.py:340-342`）。
2. **一个 Agent**：系统提示词只写「严格按请求里的任务说明与 JSON Schema 输出，只输出 JSON」，**不挂任何工具**（纯推理，缩小 VM 内的暴露面）。
   - 任务说明（`ADVISORY_TASK` / `DRAFT_EVIDENCE_TASK`）和输出 schema 随每次请求发送，所以提示词仍由审核平台的代码管理，和校验函数一起演进。
3. **一个发布，只开 A2A**：钉住 Agent 版本和模型。
   - 注意：发布者失去模型权限时，网关会回落到 Agent 的默认模型，只给一个 `model_not_permitted` 警告，而不是报错（`nexus_utils/publication_gateway/executor.py:779-789`）。审核平台记录版本血缘时，要写清发布编号、钉住的版本和模型。
4. **调用密钥**：stage、prod 各签一把，并设到期日。密钥由用户本人在网页上签发后，填进审核平台的 `ai-model-api-key` 密钥绑定，不经过对话或聊天工具传递。
5. **管理员配置**：
   - 按客户要求调短 `hidden_session_retention_days`（`config/services/publication.yaml`，热生效）；
   - 确认发布者账号的额度与预算告警；
   - 配好模型单价。本环境用量里的 `cost_usd` 目前为空。

### 4.3 审核平台侧怎么改：只动 `providers/ai-model.mjs`

调用方、中间件（超时、限流、并发、额度、日志）和页面文案都不用改。实现 `createModelClient` 即可：

1. `options.secrets[0]` 取调用密钥；发布地址放在配置里。
2. 每次调用发一条 A2A v1.0 `SendStreamingMessage`：
   - 请求头带 `A2A-Version: 1.0` 和 `Authorization: Bearer <调用密钥>`；
   - 请求体是一个 text Part，内容为任务说明、JSON Schema、输入 JSON；
   - **每次用新的 `contextId`**，不复用会话，避免 `conversation_busy` 和跨单据串话。
3. 读取名为 `answer` 的产出物的最终全文，然后：
   - advisory 走 `parseAdvisoryResult`；
   - 草稿核验先 `JSON.parse`，再走 `validateDraftEvidenceResult`。
4. 收到 `AbortSignal` 时调用 `CancelTask`。调用方断开后，这一轮在 Nexus 上仍会跑完并计费（`executor.py:33-35`）。
5. 完成后把 `MODEL_PROVIDER_IMPLEMENTED` 改为 `true`。

错误码映射：

| Nexus 返回 | 含义 | 映射为 |
|---|---|---|
| 401 `api_key_required`；404 `publication_not_found` | 没带密钥；密钥无效、过期、发布暂停或删除（网关统一回 404） | `AI_AUTH_INVALID` |
| 429 `rate_limited` / `too_many_inflight` | 限流、并发已满 | `AI_RATE_LIMIT` |
| 429 `budget_exceeded` | 发布者额度用尽，发布已自动暂停 | `AI_UNAVAILABLE`，并提醒管理员恢复 |
| 503 `gateway_unavailable` | 网关依赖不可用 | `AI_UNAVAILABLE` |
| 413 `payload_too_large` | 请求体超限 | `AI_REQUEST_INVALID` |
| 任务终态 failed（`metadata.error_code` 如 `timeout`） | 本轮失败 | `AI_UNAVAILABLE` |
| 流中断、网络错误 | — | `AI_NETWORK` |
| 输出不是合法 JSON，或机械校验不通过 | — | `AI_INVALID_RESPONSE` |
| 本地超时或用户取消 | — | `AI_CANCELLED`（同时发 `CancelTask`） |

数据治理沿用平台自己的机制：

- stage 默认允许；
- prod 需要 `AI_DATA_ENVIRONMENT=prod`，加上租户和公司范围；
- `AI_MODEL_DATA_RETENTION` 如实声明 Nexus 的保留期。平台本来就把它当作「未经核实的声明」，不当证据。
- **草稿核验只发页面文字，不发附件**。附件会复制进 EFS 上的会话工作区，在 VM 隔离缺口（R2）修复前不要这样传正式数据。

### 4.4 容量与时延

- **容量**：审核平台的中间件对 AI 是并发 2、每天 150 次，远低于网关默认的 60 次/分钟、并发 8。
- **时延**：每次调用新开会话，在沙箱 VM 里运行。冷启动需要几十秒到几分钟，本环境当前有 1 台沙箱节点（c8i.xlarge）。流式返回让 CloudFront 的 60 秒源站超时不再是问题；中间件 120 秒的超时（可调到 180 秒）要在联调时按实测调整。

## 5. 工作项与估算（粗估；前提是客户提供凭据、测试租户可用）

| # | 工作 | 估算 |
|---|---|---|
| 1 | 部署测试环境：Docker Compose、MySQL、配置文件、数据密钥、汇联易 OAuth 与钉钉凭据、钉钉可访问的 HTTPS 域名 | 1–2 天（不变；客户凭据仍是最大阻塞） |
| 2 | Nexus 侧：发布者账号、Agent、A2A 发布（钉住版本与模型）、调用密钥、留存期与额度配置 | 0.5–1 天 |
| 3 | 实现 `providers/ai-model.mjs`：A2A 流式客户端、取消、错误码映射；单元测试，加上用平台自带校验函数做契约测试 | 1.5–2.5 天（比第一轮多约 0.5 天：流式与取消） |
| 4 | 联调与评测：在测试租户的真实单据上看结构化输出通过率、引用逐字匹配率、时延、单次成本 | 2–3 天 |
| 5 | 环境加固（平台方）：见第 6 节的高风险项 | 0.5 天 |
| | **合计** | **约 5.5–9 人日** |

可选增强与第一轮相同：用视觉模型补上 Linux 下缺失的扫描件识别、「一句话写规则」、按费用类型的审核 Agent。其中扫描件识别要发图片附件，须等第 6 节第 4、7 项处理完。

## 6. 这套环境要先处理的问题

| # | 问题 | 影响 | 建议 | 级别 |
|---|---|---|---|---|
| 1 | 登录页把管理员的账号和口令 `admin` / `nexus` 写成了输入框提示，而它们就是真实口令 | 任何人都能以管理员身份登录 | 改口令，去掉提示 | 高 |
| 2 | 服务器安全组 `sg-05e6db7bf33a631eb` 对 0.0.0.0/0 开放 22 端口 | SSH 暴露在公网 | 收紧来源，或改用 SSM | 高 |
| 3 | CloudFront 回源到 ALB 只走 http | 单据数据在 CloudFront 到 ALB 这一段明文传输 | 改为 HTTPS 回源 | 高 |
| 4 | ALB 没有把 `/a2a/*`、`/mcp/*` 转到发布网关（8003）的规则，这套环境用的是旧部署模板 | 调用经前端服务转发，附件合计约 7 MB 以上会失败 | 按新模板加规则（`infrastructure/cloudformation/nexus-ai-env.yaml:906-916`） | 中 |
| 5 | CloudFront 源站读超时为 60 秒 | 同步调用超过 60 秒会失败 | 对接一律用流式；需要同步调用时评估调大超时 | 中 |
| 6 | 隐藏会话默认保留 30 天；发布者账号可能在全局搜索（`GET /api/v2/me/sessions`）里看到消息预览（按代码推断，未在界面上验证） | 单据内容在平台上留存，并可能被发布者看到 | 调短保留期；发布者用专用账号，不给其他人登录 | 中 |
| 7 | VM 隔离的已知缺口（R1–R3）在本版没有修复 | 其他 VM 里的 root 有可能读到会话工作区里的附件 | 本项目的 Agent 不挂工具、不发附件；正式数据上线前请平台方给出修复计划 | 高（正式数据） |
| 8 | 能力发现显示经 API 密钥可以签发发布的调用密钥（`allowed=true`），但运行时会拦截：只有网页登录的用户能签发，经 API 密钥一律 403 `issuer_must_be_owner`（第四轮实测，`api/v2/services/access_credential_service.py:283-286`） | 不是漏洞，只是能力发现的标记与实际行为不一致 | 反馈 Nexus 团队修正能力发现里的 `allowed` 标记 | 低 |
| 9 | 本轮登录生成的 API 密钥（`claude_code`，档位 builder） | 评估结束后不再需要 | 在「个人设置 › API 密钥」停用 | 信息 |

## 7. 如果坚持「整个平台运行在 Nexus 上」

第一轮第 6 节列出的平台能力，v0.3.28 一项都没有补上：

1. 应用访客身份；
2. 应用数据层；
3. 确定性步骤；
4. 可靠的定时任务与入站 webhook；
5. 行级数据范围；
6. Node 24 运行时；
7. 网络：Agent API 超时、回源 HTTPS。

本版新增的「自定义资源」以后也许能让 Nexus 在客户的服务器上部署并维护这个平台，但它不是托管路径，本版还关闭着。建议把这 7 项作为需求提给 Nexus 路线图；在它们落地之前，不启动迁移。

## 8. 下一步

1. **请客户回答第一轮的 4 个问题**（`assessment.md` 第 6 节），目前还没有答复。其中第 4 题现在可以问得更具体：单据内容会在 Nexus 的隐藏会话里保存 N 天，并经 Bedrock 处理，是否可以接受？
2. **经你同意后，在 v0.3.28 上做一次端到端验证**：
   - 建测试 Agent、A2A 发布和调用密钥；
   - 用脱敏的示例单据调用审批建议；
   - 实测时延、冷启动、结构化输出通过率和留存行为；
   - 完成后暂停或删除这些资源。

   这些都是写操作，按 nexus-ai-operator 的规则需要你明确同意。
3. **请平台方处理第 6 节的高风险项**，尤其是第 1、2、3、7 项。

## 附：证据

- **能力发现与只读调用**（`audit-nexus/archive/evidence/round2/`）：
  - `caps.json`（33 个模块）
  - `module-*.json`（对外发布、接入凭证、应用、自定义资源、定时任务、连接器、账号、沙箱、环境配方、密钥、分身、额度）
  - `publication-gateway-readiness.json`（网关、MCP、A2A、微信都已就绪）
  - `get_api_v2_sandbox_policy.json`（默认运行时 `ec2`）
  - `get_api_v2_apps_config_publish.json`（默认有效期 7 天，最长 90 天，允许永久）
  - `manifest.json`（功能开关：`agent_publish`、`agent_connections` 开，`custom_resources` 关）
- **环境**：
  - `cloudfront-E3D4FHABSMYLP4.json`（源站读超时 60 秒、回源 http-only）
  - `alb-rules.json`（只有 `/api/*`、`/playbook*`、`/bridge/*`、`/avatar-api/*` 四条规则）
  - `ec2-instances.json`；沙箱节点按 `nexus:environment` 标签核对，本环境 1 台
- **代码**（v0.3.28）：
  - 发布网关：`nexus_utils/publication_gateway/`（`app.py`、`auth.py`、`gates.py`、`executor.py`、`a2a_endpoint.py`、`mcp_endpoint.py`）
  - 发布默认配置：`config/services/publication.yaml`
  - 功能说明：`docs/features/agent-publication.md`
  - API 密钥：`nexus_utils/security/agent_scopes.py`、`credential_path_policy.py`
  - 其余见各节
- **审核平台**：`code/providers/ai-model.mjs`（接入契约与错误码）、`code/src/platform/call-middleware.mjs:17-18`（ai-model 并发 2、每天 150 次）、`code/src/ai-data-governance.mjs`（正式数据范围与留存声明）
