# 第三轮：折衷方案验证 — 九安自助审核平台 × Nexus-AI v0.3.28

- 日期：2026-10-15
- 起因：对第二轮报告（`feasibility-round2.md`）提出的 4 个问题，以及一个折衷结论
  - 问题 1：5 个硬阻塞之外，还有没有其他最难迁移的点？
  - 问题 2：钉钉能否改造成「平台连接器 + MCP」？
  - 问题 3：能否换一个带 Node.js 运行时的 VM？
  - 问题 4：数据库能否用连接器接公网 MySQL？
  - 折衷结论：用问题 2、3、4 的三件事作为折衷，把平台迁到 Nexus 上。本报告逐项验证这个结论。
- 方法：
  1. 只读调研 Nexus v0.3.28 的代码，分两路：
     - 应用页面、身份、MCP；
     - 连接器、VM 运行时、网络、密钥。
  2. 只读调研审核平台源码：钉钉用法、Node 版本、数据库，以及其他难点。
  3. 关键结论由我本人复核代码，包括「应用访客会话拿不到任何密钥」和 Nexus 的运行时版本清单。
  4. 新平台上用 nexus-ai-operator 只读查看连接器与 MCP 模块。
  5. 读取 Amazon Linux 2023 官方软件源的元数据，以及钉钉官方 MCP 仓库。
- 全程只读：没有运行审核平台的任何代码，也没有在 Nexus 平台上做任何写入。原始证据在 `audit-nexus/archive/evidence/round3/`。

## 0. 结论

**这个折衷完成不了迁移。** 三件事逐项核实的结果：

| 折衷的三件事 | 能不能做到 | 实际解决了什么 |
|---|---|---|
| 钉钉 → 连接器 + MCP | **只能做一半**：能以企业应用身份调钉钉接口（通讯录、消息、待办、审批），**做不了访客登录与授权** | 没有解决任何阻塞 |
| VM 换 Node.js 运行时 | **能**：官方源已有 `nodejs24`，Nexus 自己的版本清单本来就要求 Node 24，平台方改构建脚本一行、重建镜像即可 | 解决「运行时版本」这一项；但 VM 只能跑一轮对话之内的脚本，跑不了这个平台本身 |
| 连接器接公网 MySQL | **连接器不能当业务库**；改为工具自己用驱动直连可以连上，但访客触发的会话拿不到数据库口令 | 「应用数据库」只解决了一半 |

更关键的是，核实过程中又发现几个比原来 5 个更底层的约束，详见第 1 节：

- 应用访客会话**拿不到任何密钥**；
- **每小时 30 个会话按「出口 IP × 应用」计算**，全公司共用；
- 每个操作都要**至少一轮模型**，并且由模型决定调不调工具；
- 审核平台本身是**单实例、带进程级状态**的服务。

加上折衷之后各阻塞的状态：

| 阻塞 | 折衷能解决吗 | 说明 |
|---|---|---|
| 1. 访客身份与权限 | ✗ | 连接器和 MCP 只代表企业应用。用免登授权码换身份需要 AppSecret，访客会话拿不到；Nexus 也不会把身份绑定到后续请求 |
| 2. 应用数据库 | △ | 连接器 ✗；工具直连 ✓，但只能在非访客的回合里用，访客回合没有口令 |
| 3. 不经模型的确定性执行 | ✗ | Node 让原来的代码可以复用，但每次执行仍要一轮模型来触发 |
| 4. 调度与数据管道 | ✗ | 定时任务仍是 Agent 提示词；单实例锁、限流与断路器状态无法跨回合保存 |
| 5. Node 24 运行时 | ✓ | 平台方改 `build-rootfs.sh` 一行并重建镜像 |
| 6. 访客会话无密钥（新增） | ✗ | Nexus 的设计：「凭证 / 应用 / 作业类调用方不借用任何用户的密钥」 |
| 7. 每小时 30 个会话按出口 IP 计（新增） | ✗ | 代码里写死的常量 |
| 8. 单实例、进程级状态（新增） | ✗ | 进程生命周期内持有的 MySQL 锁、内存里的会话、进程内的调度器 |

8 项里只有 1 项完全解决、1 项解决一半。按这个折衷迁过去，平台最多变成「由 Agent 逐回合触发的一组脚本」：

- 没有登录、按公司授权和双人确认；
- 没有可靠的同步；
- 每个操作 20 秒以上，并依赖模型是否照做。

对多主体财务预审平台来说，这不可接受。

**可行的折衷**（第 6 节）：**状态与登录留在平台自己的进程里，AI 与协同放进 Nexus。**

- 平台照原样部署，位置尽量贴近 Nexus：同一 AWS 账号的私网，并接入 Nexus 互联中心，由 Nexus 统一运维。
- Nexus 承担这几块：
  - AI 两项任务（A2A，见第二轮报告）；
  - 钉钉提醒与待办（官方 MCP，放在定时任务里）；
  - 管理层数据问答（只读连接器）；
  - 运维诊断（Bridge 只读服务器组）。
- 原有行为 100% 保留，约 7–13 人日。

## 1. 问题 1：5 个硬阻塞之外，还有哪些最难的点

### 1.1 Nexus 侧（本轮新核实）

| # | 难点 | 证据（Nexus v0.3.28） | 影响 |
|---|---|---|---|
| 6 | **应用访客会话拿不到任何密钥**，与访问模式无关 | 派发时按发起方计算授权：`credential` 发起方一律返回空（`nexus_utils/sandbox/scheduler.py:1119-1133` → `nexus_utils/secret_key_grants.py:21,72`）；访客会话被标为 `credential`（`api/v2/services/apps_runtime.py:1000`）；应用路径从不预置授权 | 访客触发的工具拿不到数据库口令、钉钉 AppSecret、汇联易 OAuth 密钥、数据加密密钥；连接器也拿不到凭据。唯一的绕法是把口令写进工具代码，不可接受 |
| 7 | **每小时 30 个会话，按「出口 IP × 应用」计** | `SESSION_RATE_LIMIT_PER_HOUR = 30`（`app_service.py:34`），由建会话和上传两个接口共用一个计数器（`apps.py:1107`、`apps.py:1156`）；每次打开页面，每用到一个 Agent 就新建一个会话 | 公司在同一出口 IP 后面时，全公司每小时只有 30 次访问。另有每个会话最多 60 条消息、10 次上传 |
| 8 | **每个操作至少一轮模型，由模型决定调不调工具** | 流程里只执行 Agent 步骤（`apps.py:2922-2923`、`apps.py:3796-3800`）；工具结果不回传页面，要模型转述（`apps.py:2765-2779`） | 用到工具时至少 2 次模型调用，20 秒以上，还要消耗 token；模型可能跳过工具或改参数，所以每个工具都要做幂等。这与审核平台的设计原则「编排由代码做，模型只在声明的步骤出现、不下结论」直接冲突（`方案.md:52`、`方案.md:138`、`方案.md:174-178`） |
| 9 | **页面传给 Agent 的数据只是文字，而且可以伪造** | 消息正文最多 20,000 字（`apps.py:1275`），运行参数只作为提示上下文（`app_service.py:1655-1672`）；公开接口不验登录（`api/v2/auth/middleware.py:74`） | 工具拿不到可信的、带类型的输入；任何人用 curl 都能伪造参数 |
| 10 | **没有审计级的文件留存** | 会话工作区随会话删除，所有者可以删，空间上限没有强制执行；存储桶没有对象锁 | 附件证据库没有合规的落脚点 |
| 11 | **几处安全问题** | VM 隔离缺口 R1–R3（`docs/superpowers/specs/2026-10-09-v0328-platform-ops-isolation-design.md:37-47`）；stdio 方式的 MCP 子进程继承整个运行环境，包括 VM 里的 AWS 凭据地址（`nexus_utils/mcp/mcp_client/client_factory.py:89-91`）；MySQL 连接器没有真正关掉多语句执行，写入路径不校验表名和列名（`nexus_utils/data_connector/providers/mysql_provider.py:191`、`:264-316`）；应用的口令模式用不加盐的 sha256（`app_service.py:2416`） | 财务数据放进来之前，都要先有处理方案 |

### 1.2 审核平台自身（读源码核实）

| 难点 | 证据（审核平台 `code/`） | 为什么在 Nexus 上难 |
|---|---|---|
| **只能单实例运行，状态在进程里** | 启动时拿到并持有汇联易、钉钉网关的 MySQL 锁，直到进程退出（`scripts/start-analysis.mjs:44-46`，`src/platform/call-middleware.mjs:487`）；登录会话存在内存 `Map` 里（`src/analysis-auth.mjs:45`）；调度器、租约、队列都是进程内的定时器（`src/platform/scheduler.mjs:313-323`） | Nexus 的 VM 按回合分配，闲置 15 分钟回收；没有常驻进程，也没有入站端口 |
| **重度依赖事务、锁与 DDL** | 56 张表、11 个迁移、41 个 CHECK 约束（需要 MySQL 8.0.16+）；每次启动都 `GET_LOCK`，执行 DDL，并对照 `information_schema` 核对结构（`src/mysql-database.mjs:966-1033`）；8 个模块用交互式事务，约 22 处 `FOR UPDATE`，队列用 `SKIP LOCKED` 领任务；一页 50 张单据在一个事务里写完 | 只有能保持会话的直连才能承载（见问题 4） |
| **数据全部加密** | AES-256-GCM，只有列表元数据是明文（`src/mysql-analysis-store.mjs:35-48`、`:98`）；密钥是挂载进来的文件（`src/analysis-config.mjs:84-85`） | 连接器或 Agent 读到的只是密文；密钥要在每次工具调用时可用，又撞上「访客无密钥」 |
| **汇联易同步是长时间、串行、限流的** | 每次调用间隔至少 1.5 秒，每天最多 20,000 次，单次响应最大 32 MB、超时 120–180 秒；重试、退避、断路器状态都在内存里；全量回补的断点清单写在本地磁盘（`providers/huilianyi-stage-oauth.mjs`、`src/platform/call-middleware.mjs:12-27,693-698`、`scripts/full-sync-huilianyi.mjs:22-26`） | VM 只有 1 vCPU / 1 GiB，单条 shell 命令 900 秒、单次工具调用 1800 秒；回合结束后状态全部丢失 |
| **附件库在本地磁盘** | 加密存放在 `data/analysis-runtime/attachments/`，单个最大 18 MB；原件还会以 Base64 存进 MySQL（`src/analysis-attachment-vault.mjs`、`src/analysis-evidence-service.mjs:188-189`） | 需要持久且可审计的存储 |
| **PDF 与 OCR 依赖本地程序** | PDF 文字靠 Python `pypdf` 子进程（`src/document-text.mjs:93-117`）；OCR 只支持 Windows（`scripts/ocr-image.ps1`） | VM 里要同时有 Python 与 pypdf；OCR 换成视觉模型属于新的数据出境 |
| **界面与接口面大** | 13 个哈希路由，约 2,700 行原生 JS，同源 `fetch` 调 56 个接口；有的接口先回 202、在后台继续干活；Host 与 Origin 写死，CSP 只允许 `'self'`，禁止被嵌入 iframe（`analysis-server.mjs:190-202`） | Nexus 应用页禁止 `fetch`，每个动作都是一轮 Agent |
| **目标本身还在变** | 运行中的版本没有规则发布，生效规则为空（`src/analysis-rule-workspace.mjs:198,226`）；双人复核只存在于没有被调用的代码里（`src/stage-policies.mjs:522-601`）；`policy_reviewer` 角色实际什么都做不了；12 张表没有任何写入方；AI 是空实现 | 迁移要先和客户确认目标范围 |

## 2. 问题 2：钉钉改成「平台连接器 + MCP」是否可行

**答：只能做一半。能以企业应用身份调钉钉接口，不能做访客登录与授权。** 而审核平台用钉钉恰恰只为了登录。

**审核平台怎么用钉钉**（源码核实）：只用于身份，没有任何消息或通知功能（`src/platform/connectors.mjs:57-58`）。

1. 页面必须在钉钉客户端里打开，用 JSAPI 的 `dd.runtime.permission.requestAuthCode({corpId})` 拿到免登授权码（`public/analysis.js:1815-1820`）。
2. 服务端依次调用 `gettoken`（用 AppKey 和 AppSecret）、`/topapi/v2/user/getuserinfo`（授权码换 userid）、`/topapi/v2/user/get`（取工号 `job_number`）（`providers/dingtalk.mjs:22-37`）。
3. 用工号匹配配置文件里的账号，每个账号带着它能看的公司清单（`src/analysis-auth.mjs:9-34,66`）。
4. 发会话 Cookie（HttpOnly、SameSite=Strict），每个写请求校验 CSRF；每次查询按公司清单过滤。

**钉钉官方 MCP**（`open-dingtalk/dingtalk-mcp`，npm `dingtalk-mcp` 1.1.21）：

- 提供 12 组能力：通讯录、部门、机器人消息与 DING、待办、日程、考勤、工作通知、应用管理、服务窗、Teambition、日志统计、荣誉。
- 用 `npx` 以 stdio 方式运行，凭据是企业应用的 Client ID / Secret。
- **没有任何工具做「免登授权码换用户身份」**。

**放到 Nexus 上，免登这条链路的每一环：**

| 环节 | Nexus v0.3.28 上的情况 | 判定 |
|---|---|---|
| 页面里调 JSAPI 拿授权码 | 应用页是顶层文档，但被放在 opaque origin 里（CSP `sandbox`，不带 `allow-same-origin`，`apps.py:142-152`）。可以从 CDN 加载 JSAPI；钉钉容器会不会给这种页面发授权码，代码层面无法判断。另外 `/a/{appId}` 会 302 跳转并丢掉查询参数（`apps.py:917-920`），每次发布地址都会变 | 待真机实测（iOS / Android / PC） |
| 用授权码换身份 | 要用 AppSecret，访客会话拿不到任何密钥（第 1 节第 6 项） | ✗ |
| 把身份绑定到后续请求 | Nexus 不提供；所有访客都以应用所有者的身份运行（`app_service.py:2708`），工具分不出是谁在调用；`store` 和文件也不按访客隔离 | ✗ |
| 每次请求按公司和角色授权、双人确认 | 只能在自定义工具里写；但 Agent 默认就带 shell、Python、读写文件这些通用工具，模型也可能不调用你的工具 | ✗（没有平台保证） |

连接器（`http_api`）也一样：它生成的工具只给模型用，并且在访客会话里拿不到凭据。

**风险提示**：MCP 服务器的环境变量（含钉钉 Client Secret）存在 MCP 自己的配置里，不经过密钥授权。所以挂了钉钉 MCP 的 Agent，在访客会话里也可能带着企业应用凭据（VM 内能否解析到这份配置还需实测）。这样一来，访客可以通过提示词让 Agent 查全员通讯录，或给任何人发消息。

**合适的用法**：在可行的折衷里（第 6 节），把官方钉钉 MCP 用于「工作通知、待办、审批提醒」这类以企业应用身份执行的动作，放在定时任务或内部 Agent 里，不放在访客能触发的应用里。

## 3. 问题 3：用带 Node.js 运行时的新 VM 是否可行

**答：技术上可行，平台方改一行构建脚本即可；但 VM 只能跑一轮对话之内的脚本，跑不了这个平台本身。**

**审核平台实际需要的 Node 版本**（源码静态扫描）：

- `package.json` 声明 `>=24`，Docker 用 `node:24`，但代码里没有找到任何必须 Node 23 / 24 才有的特性。
- 实际下限：
  - 服务端 20.12+（`node:util` 的 `parseEnv`，`scripts/start-analysis.mjs:18`）；
  - 测试套件 22.0+（`Promise.withResolvers`）；
  - `pnpm start:*` 脚本 22.9+（`--env-file-if-exists`）。
- Node 18 会在 import 阶段直接失败。
- 所以「`>=24`」是供应商的选择和验证范围，不是技术硬需求。用 Node 24 最稳妥，22 也能跑。

**Nexus 这边**：

- **官方源已有新版本**：Amazon Linux 2023 官方源现在有 `nodejs22`（22.23.2）和 `nodejs24`（24.21.0），2026-10-15 读取软件源元数据核实。**这更正了前两轮「源里没有 Node 24」的说法。**
- **平台自己本来就要求 Node 24**：Nexus 的运行时版本单一源写的是 `node: "24"  # AL2023 包名 nodejs24 + nodejs24-npm`（`config/runtime_versions.yaml:18`），应用主机也已经是 Node 24。只有 VM 镜像还在装 `nodejs npm`，也就是 Node 18（`infrastructure/sandbox/build-rootfs.sh:323`），CI 的版本校验也没覆盖到这一行。**这是平台自己的遗漏，值得单独修。**
- **修法**：
  1. 把第 323 行改成 `nodejs24 nodejs24-npm`；
  2. 重建镜像：`nexus-cli sandbox rebuild-rootfs -y --restart-nodes`，或者在管理后台走「运行时镜像：构建、启用、带金丝雀的滚动更新」；
  3. 沙箱节点逐台重启。
  - 运行时镜像和环境配方都只能加 Python 包，做不到这件事。

**换上 Node 24 之后，VM 能跑什么、不能跑什么：**

| 能跑 | 不能跑 |
|---|---|
| 一轮对话内的脚本：对一张单据做规整与预审、跑一个同步窗口、执行一次数据库迁移、导出报表，并用 `mysql2` 直连外部 MySQL（见问题 4） | 平台本身：56 个接口与界面的 HTTP 服务（VM 没有入站端口）、调度器与运行器（闲置 15 分钟回收，`credential` 发起方的 VM 用完即销毁，没有常驻进程的概念）、进程级锁与内存会话 |

每台 VM 只有 1 vCPU / 1 GiB；单条 shell 命令 900 秒，单次工具调用 1800 秒。依赖包要么每次冷启动重新安装，要么由平台方打进镜像。PDF 文字提取还需要 Python 和 pypdf。

**定位**：Node VM 让「复用原有业务代码」成为可能（比第一轮假设的改写成 Python 省工），但它不改变「谁来触发、谁来常驻」的问题。

## 4. 问题 4：用连接器接公网 MySQL 适配数据库是否可行

**答：连接器不行。工具自己用驱动直连可以连上，但访客会话拿不到口令，而且公网暴露财务库风险高。**

**连接器能做什么**：

- 它只是给模型用的查询工具，每次调用新建连接、用完关闭，没有连接池；
- 没有事务；`CREATE` / `ALTER` / `DROP` / `TRUNCATE` 默认拦截；
- 写入只支持单表、等值条件；
- 模型最多看到 30 行、4000 字（`tools/system_tools/data_connector/data_connector_query.py:20-22`）；
- 凭据只发给「用户」发起的回合，访客和定时任务的回合拿不到（第 1 节第 6 项）；
- TLS 那段代码看起来连不上加密连接（`nexus_utils/data_connector/providers/mysql_provider.py:30-41`，未实测）。

**审核平台需要什么**：能保持会话的连接，具体包括：

- 进程生命周期内持有的 `GET_LOCK`；
- 多语句事务、`FOR UPDATE` 与 `SKIP LOCKED`；
- 每次启动执行 DDL 并核对 `information_schema`；
- 会话变量与预处理语句；
- 约 24 MB 的大字段。

两者差距是结构性的。而且数据是加密的，连接器只能读到列表元数据的明文。

**改为工具直连**（在 VM 里用 `mysql2` 或 PyMySQL）：

- **网络**：默认的 `internet` 模式放行任意端口的公网 IPv4。私网地址默认被拦，管理员可以用 `allow_cidrs` 放通（`config/default_config.yaml:302-311`，`nexus_utils/sandbox/netpolicy.py:193-205`）。数据库要放行沙箱节点的 NAT 出口 IP。
- **口令**：只有用户发起的对话和定时任务的回合能拿到托管的口令和数据密钥，访客回合拿不到。
- **公网暴露**：财务库放到公网，即便有 TLS 和 IP 白名单，也是不必要的风险。更好的做法是放在私网，由管理员放通对应 CIDR。
- **时延**：大事务（一页约上千条语句）跨公网的时延未实测。

## 5. 对前两轮结论的更正

1. **Node 24**：前两轮写「源里没有 Node 24」。更正：Amazon Linux 2023 官方源已有 `nodejs24`，Nexus 的版本清单本来就要求 24，只是 VM 镜像没跟上。
2. **审核平台对 Node 的要求**：实际 20.12+ 就能运行服务端，22+ 能跑完测试；`>=24` 是声明值。
3. **第一轮「高保真重建」打分偏乐观**：
   - 原因：当时假设工具能用托管密钥连自带的 RDS，但访客会话拿不到任何密钥。
   - 后果：凡是访客操作触发的数据访问，都只能把口令写进代码。「57% 保持原语义」中依赖数据库的部分，在访客场景下实际做不到。
   - 结论不变：仍不建议。
4. **双人复核**：第一轮写的是「一人写、另一人确认」。更正：这只存在于没有被调用的代码里；当前运行的版本没有规则发布，生效规则为空。

## 6. 可行的折衷：状态与登录留在平台进程里，AI 与协同放进 Nexus

```
钉钉客户端 ──免登──▶ 审核平台（Node 24 + MySQL 8，原样部署；同一 AWS 账号私网的 EC2/ECS + RDS，或客户服务器）
                       ├─ providers/ai-model.mjs ──A2A──▶ Nexus 发布的 Agent（AI 两项任务，不挂工具、不需要密钥）
                       └─ 只读视图（列表元数据）◀── Nexus 只读 MySQL 连接器 ◀── 管理层在 Nexus 对话里做数据问答
Nexus 定时任务（发起方按用户计，可带密钥）──▶ 钉钉官方 MCP：待核验提醒、待办、工作通知
Nexus 互联中心（Bridge，「只读诊断」服务器组）──▶ 审核平台所在服务器：日志、健康检查、运维诊断
```

| 部分 | 放在哪 | 为什么 |
|---|---|---|
| 登录、按公司授权、同步、预审、规则、界面、附件库 | 审核平台自己的进程（原样） | 这些都要常驻进程、可信会话、事务与 DDL，Nexus 上没有承载位置 |
| AI 两项任务 | Nexus：A2A 对外发布 | 第二轮已论证；Agent 不挂工具，不受「访客无密钥」影响 |
| 钉钉提醒与待办 | Nexus：定时任务里的 Agent 加官方钉钉 MCP | 定时任务的回合能带密钥。用平台的身份发提醒，不碰登录。需实测 VM 内能否解析 MCP 配置 |
| 管理层数据问答 | Nexus：用户本人在对话里，用只读连接器查只读账号的元数据视图 | 用户本人发起的回合能拿到连接器凭据；数据库放私网，管理员放通 CIDR，避开连接器的 TLS 问题 |
| 运维诊断 | Nexus：互联中心（Bridge）只读服务器组 | 平台方在 Nexus 里用 Agent 查日志、看健康状态 |

**工作量**：在第二轮的 5.5–9 人日之上加——

- 钉钉提醒 1–2 天（可选）；
- 数据问答 Agent 1–2 天（可选）；
- Bridge 接入 0.5 天。

**合计约 7–13 人日。原有行为 100% 保留。**

**如果坚持整个平台运行在 Nexus 上**，需要 Nexus 产品层面补齐：

- 访客身份（含钉钉或 OIDC 登录）；
- 按应用授权、只给确定性工具使用的服务端密钥；
- 流程里的确定性工具步骤；
- 可常驻、可入站的服务运行时；
- 带重试和告警的可靠任务；
- 审计级存储。

其中 VM 的 Node 24 是一行就能修的快速改进，其余都是大版本工作。v0.3.28 新增的「自定义资源」以后可以把这个平台部署到客户服务器上并由 Nexus 维护，但它本版关闭。即使打开：

- Web 模板不能指定 Node 版本，服务器要预装 Node 24；
- MySQL 模板在 Amazon Linux 上装的是 MariaDB 10.11，要用 Ubuntu 才是 MySQL 8。

## 7. 需要实测才能定的点

1. 钉钉容器（iOS / Android / PC）能否给 Nexus 应用页（opaque origin）发免登授权码。即便能，也只解决「拿到授权码」这一环。
2. 通过界面创建的 MCP 服务器，在 VM 里能否被解析到；定时任务回合里能否用上连接器。
3. 大事务跨公网到 MySQL 的时延。
4. 连接器的 TLS 能否真正建立加密连接。

## 8. 下一步

1. **请客户确认目标**：是「AI 能力跑在 Nexus 上」，还是「整个平台跑在 Nexus 上」？如果是后者，按第 6 节末尾的平台能力列表，评估 Nexus 路线图。
2. **按第 6 节推进**：先做第二轮的 A2A 对接（需要你同意后在平台上建资源），再视需要加钉钉提醒和数据问答。
3. **请平台方先修 VM 的 Node 版本**（`build-rootfs.sh:323`），以及第二轮第 6 节列出的高风险项。

## 附：证据

- **Nexus（v0.3.28）**：
  - 访客会话无密钥：`nexus_utils/secret_key_grants.py:21,72`、`nexus_utils/sandbox/scheduler.py:1119-1133`、`api/v2/services/apps_runtime.py:1000`
  - 会话限流：`api/v2/services/app_service.py:34,2511-2530`、`api/v2/routers/apps.py:1107,1156`
  - 应用页沙箱：`apps.py:142-152,914,917-920`
  - 流程只执行 Agent 步骤：`apps.py:2922-2923,3796-3800`
  - 连接器：`nexus_utils/data_connector/providers/mysql_provider.py`、`config/data_connector.yaml:35-42`、`tools/system_tools/data_connector/data_connector_query.py:20-22`
  - VM 网络：`config/default_config.yaml:302-311`、`nexus_utils/sandbox/netpolicy.py`
  - VM 生命周期：`config/default_config.yaml:173,184,187,202`
  - Node 版本：`config/runtime_versions.yaml:18`、`infrastructure/sandbox/build-rootfs.sh:323`
  - MCP：`nexus_utils/mcp/mcp_client/client_factory.py:89-91`；`config/capabilities/mcp_servers.yaml`
  - 钉钉：只有分身的 1:1 私聊通道（`nexus_utils/avatar/im/adapters/dingtalk.py`）
- **审核平台（`code/`）**：
  - 钉钉：`public/analysis.js:1799-1820`、`providers/dingtalk.mjs`、`src/analysis-auth.mjs`
  - Node 版本：`package.json:7-9`、`scripts/start-analysis.mjs:18`、`Dockerfile:1`
  - 数据库：`src/mysql-database.mjs:555-567,966-1033`、`src/mysql-source-foundation.mjs:421-453`
  - 加密：`src/mysql-analysis-store.mjs:35-48`
  - 单实例：`scripts/start-analysis.mjs:44-46`、`src/platform/call-middleware.mjs:487`
- **外部**：
  - Amazon Linux 2023 官方源元数据（2026-10-15）：`nodejs` 18.20.8、`nodejs20` 20.20.2、`nodejs22` 22.23.2、`nodejs24` 24.21.0
  - 钉钉官方 MCP：`github.com/open-dingtalk/dingtalk-mcp` README（12 组能力、stdio、应用凭据），npm `dingtalk-mcp` 1.1.21
- **新平台只读**：`audit-nexus/archive/evidence/round3/`（连接器建立接口的 schema、MCP / 工具 / 动态配置模块说明）
