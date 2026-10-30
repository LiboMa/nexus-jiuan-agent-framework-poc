# 九安审单：React 新前端（设计，2026-10-30）

状态：**已确认（2026-10-30，项目负责人：「没有，just go」）**。样稿：`.superpowers/brainstorm/1550-1793344741/content/`（`drafts-v2.html` 的 A 版、`dashboard-a-v9.html`、`drawer-a.html`）。标「实现方决定」的是讨论中由 Claude 定、项目负责人认可整体方案时一并接受的，可改。

## 1. 为什么、做成什么

- **为什么**：九安 v0.7.10 的前端是原生 JS（约 8,400 行、16 个文件），我们靠补丁往里加页面；风格旧、入口多。项目负责人要一套完整的新前端：React、蓝白、简洁、类 Apple 的交互，去掉「规则库」，知识库改为直接和知识库 Agent 交互，再加一个指标看板。
- **成功**：
  1. 测试台 `https://jiuan-v0710.tinyboat.blog/` 打开就是新前端；审核员在新前端里完成一天的工作：看工作台 → 进单据池 → 打开单据看 AI 建议、原件、单据信息 → 复核（采纳 / 改判）→ 下一张。
  2. 管理员在新前端里上传制度（经知识库 Agent）、管理「Agent 接入」、看设置。
  3. 工作台的每个指标都有真实数据来源（第 5 节）。
  4. 端到端测试按新界面重写并全部通过（知识库那几条等 PG 知识库 Agent 建好）。
- **非目标**：九安正式环境换前端（另议）；深色模式（实现方决定）；规则库（审核要点）、供应商付款、「AI 与我」对比、分析页（并进工作台）；回写汇联易；改九安的后端接口。
- **反目标**：前端绕过九安的会话 / CSRF / 角色校验；为了新前端改九安的接口合同；复核结果被当成审批写回汇联易；页面上出现英文报错或"请稍后再试"这类不说原因的提示。

## 2. 视觉系统（A 版）

- **颜色**：画布 `#F5F7FA`，面 `#FFFFFF`，正文 `#0E1B33`（深海军蓝），次要 `#5A6880`，弱 `#8A97AB`，分隔 `#E2E7EF`，主蓝 `#1E5EFF`，浅蓝 `#EEF3FF`；状态：通过 `#0E9F6E`、不通过 `#E5484D`、处理中 `#D19A2B`（状态色一律配图标 ✓ / ✕ 和文字，不只靠颜色——红绿在色弱下区分度只有 ΔE 6.2）；「我的规则」用紫 `#7A5AF8` / `#6941C6`。
- **字体**：系统字体栈 `-apple-system, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui`；数字用等宽数字（`tnum`）；字号 12 / 13 / 14 / 16 / 22 / 28，字重 400 / 500 / 600 / 650。
- **形状**：容器圆角 4 px；按钮、输入框、标签 0–2 px；图标是自绘的直角线条（24 网格、1.6 描边、方头、斜接拐角，矩形构图），不用圆角图标库。
- **Logo**：照 sub2api 的做法：深海军蓝渐变方块（`#142B56 → #0A1A39 → #061127`，内描边 `rgba(165,191,255,.35)`，蓝色外光）里一笔青到蓝渐变（`#79F4BD → #39D9E7 → #3875F6`）的"文件 + 对勾"直角线条；旁边字标「九安审单」。
- **布局**：左侧侧栏 220 px（可收起到 72 px，只留图标）：Logo 区、导航（工作台；分组「审核」：单据池、知识库、我的规则；分组「平台」：Agent 接入、设置）、底部账号区；右侧内容区，页面标题 22 px，下方分段页签。选中导航：浅蓝底 + 2 px 主蓝左边线。
- **交互**：次级内容一律用抽屉（单据详情，右侧 430 px）、弹框（上传制度、检索、查看规则全文、粘贴调用密钥、确认删除）、页签，不跳新页面；动效只用于打开 / 关闭抽屉和弹框（150–200 ms，尊重"减少动态效果"）；键盘可达、焦点可见。
- **文案**：中文、动词开头、说清发生了什么和怎么办；错误照九安和外壳的中文 `message` 原样显示。

## 3. 技术（实现方决定）

| 项 | 选择 |
|---|---|
| 框架 | React 19 + TypeScript，Vite 构建 |
| 样式 | Tailwind CSS（编译成静态 CSS 文件）。九安和外壳的页面都带 `style-src 'self'` 的 CSP：不能用往页面里插 `<style>` 的 CSS-in-JS；React 的 `style` 属性走 CSSOM，可以用 |
| 路由 | `#` 哈希路由（React Router `createHashRouter`），不需要服务端回退路由 |
| 数据 | TanStack Query；统一的 `api()`：同源、`credentials: 'same-origin'`、非 GET 带 `X-CSRF-Token`（取自 `GET /api/analysis/v1/session` 的 `data.csrfToken`）和 `Content-Type: application/json`；解 `{data}` / `{error:{code,message}}` 信封 |
| 组件 | Radix 的无样式组件（Dialog、Tabs、Popover、Tooltip）套 A 版样式；图表手写 SVG（悬停提示、表格视图） |
| 目录 | 新目录 `poc/web07/`（`src/`、`public/`、`index.html`、`vite.config.ts`、`tailwind`、测试）；构建产物 `poc/web07/dist/` 不进仓库 |
| 单元测试 | Vitest + Testing Library（组件、`api()`、指标计算的展示） |

## 4. 部署与登录

- **同一个站点**：测试台外壳的前门（`poc/app07/front.mjs` 的 `door.serve`）把 React 构建产物挂在 `/`（`index.html` 和 `/assets/*` 带哈希的文件），复用 `poc/app/http.mjs` 的 `createStaticFiles`；接口照旧是 `/api/analysis/v1/...`（九安）和 `/api/analysis/v1/poc/...`（外壳），会话 cookie（`jiuan_analysis`，`Path=/api/analysis/v1`）、Origin 检查、CSRF 都不变。
- **九安的旧页面**：过渡期仍可从 `/analysis.html` 打开（实现方决定），新前端的端到端测试全部通过后再撤；补丁 0001–0005 不动。
- **登录**：新前端自己画登录页（账号 + 口令）→ `POST /api/analysis/v1/poc/login` 拿一次性票据 → `POST /api/analysis/v1/auth/exchange` 换会话 → 进工作台；`GET /session` 401 时回到登录页；退出走 `/auth/logout`。前门里"没有登录标记就 302 到 `/poc/login`"那段改成直接给新前端（登录页由前端画）；`/poc/login` 旧页面过渡期保留。
- **构建**：`deploy.sh` 在打包前 `npm ci && npm run build`（`poc/web07`），单元测试一并跑；产物放进构件，外壳从 `current/web07/dist` 读。

## 5. 新增的后端（测试台外壳 `poc/app07`）

### 5.1 复核记录

- 表 `poc_review_decisions`（在 `jiuan07` 库里，随端到端测试的重置一起清空；实现方决定）：`id`、`document_id`、`document_version`、`advice_round`（复核时看到的那一轮）、`ai_result`（`pass` / `fail`）、`decision`（`adopt` 采纳 / `override` 改判）、`final_result`（`pass` / `fail`，采纳时等于 `ai_result`）、`reason`（改判原因代码）、`note`（≤ 200 字，可空）、`actor`（账号）、`created_at`。
- 改判原因（固定选项 + 备注）：`contract_covers` 合同或补充协议已涵盖、`evidence_complete` 原件齐全 AI 没识别、`rule_not_applicable` 适用规则不对、`amount_ok` 金额核对无误、`other` 其他（必须写备注）。
- 接口（管理员、分析员；只对自己有权限看的单据）：
  - `POST /api/analysis/v1/poc/reviews {documentId, sourceVersion, decision, reason?, note?}`：只能复核**当前版本已完成**的那一轮 AI 建议（没有完成的建议、版本过期 → 409）；同一人可以重复复核，以最后一次为准，旧的留着。
  - `GET /api/analysis/v1/poc/reviews?documentId=` → 这张单的复核历史；`GET …/reviews/latest?ids=a,b,c` → 单据池一页的复核状态。
- 不回写汇联易，不碰九安的审批写回。

### 5.2 工作台统计

- `GET /api/analysis/v1/poc/dashboard?window=today|14d|month` → 一次给齐工作台要的数（管理员看全员，分析员的「按审核员」只有自己一行；实现方决定）：
  - `pendingReview`：当前版本的 AI 建议已完成、还没有复核记录的对公付款单数，其中 `failCount` 是 AI 不建议通过的；
  - `advice`：窗口内完成的 AI 建议轮数、建议通过数、改判数；`passRate`；`avgDurationMs`、`maxDurationMs`（`finishedAt − startedAt`）；
  - `daily[]`：每天 `{date, pass, fail, running}`；
  - `topBasis[]`：不通过的那几轮里最常出现的依据，按「规则编号 / 单据字段 / 我的规则标题」归并，前 6 项（看板上的「不通过最常见的依据」，代替样稿里按语义归类的「原因」；实现方决定）；
  - `overrideRate[]`：每天 `{date, reviews, overrides}`（没有复核的日子不连线）；
  - `reviewers[]`：`{account, name, reviews, overrides, customRules}`；
  - `knowledge`：知识库方式、Agent 是否就绪、制度份数和规则条数（取最近一次入库结果和上传历史，**不为看板去调 Agent**）、最近入库时间；
  - `topRules[]`：窗口内建议里最常引用的规则编号前 2–5 项；
  - `myRules`：当前账号的「我的规则」份数和已用字数 / 5,000。
- 数据来源：AI 建议的轮次照 `agent-calls.mjs` 的做法遍历单据读 `agent-task` 状态（每张单只留当前一轮 + 5 轮历史，更早的数不到——看板注明「近 14 天」等窗口）；复核记录；外壳的知识库上传历史；`custom-rules`。结果缓存 60 秒。

## 6. 页面

| 入口 | 内容 | 用到的接口 |
|---|---|---|
| 工作台 | 样稿 `dashboard-a-v9.html`：四个数（待我复核、AI 已出建议、建议通过率、出建议用时）；每天的 AI 建议（堆叠柱）；不通过最常见的依据；人工改判率（折线）；按审核员；知识库状态、最常引用的规则、我的规则用量；右上「今天 / 近 14 天 / 本月」和「上传制度」 | `/poc/dashboard` |
| 单据池 | 页签「待复核 / 已复核 / 全部」，搜索单号、收款方；表格：单号、板块（公司）、事项、金额、AI 建议、复核；点一行开右侧抽屉；抽屉提交复核后自动开下一张待复核 | `/documents?…`、`/poc/reviews/latest` |
| 单据抽屉 | 页签：**AI 建议**（结论、用时、依据逐条带「公司制度 / 单据字段 / 原件 / 我的规则」标签、审批路径与最终审批人、「重新审核」= 九安的手动发起）；**原件**（原件清单、读取状态、按页看抽取的文字）；**单据信息**（九安 1:1 单据页的字段与明细）；**历史**（AI 建议的各轮、复核记录）。底部复核区（样稿 `drawer-a.html`）：采纳 AI 建议 / 改判（选原因，「其他」必须写备注）→「提交复核」 | `/documents/:id`、`/documents/:id/page`、`/documents/:id/advice`（GET/POST）、`/documents/:id/evidence`（GET、`/read` POST）、`/poc/reviews` |
| 知识库 | 页面：制度清单（标题、标识、版本、条数、状态、时间；下线 / 恢复按 `describe` 的 `ops` 显示；删除二次确认）+ 知识库 Agent 状态；弹框「上传制度」（拖入 .docx、制度标识按文件名预填、版本、文档名 → 轮询到入库完成）、「检索」（问题、板块、金额）；没配置 / 没启用时整页只说明怎么办（文案同补丁 0005） | `/poc/kb/*` |
| 我的规则 | 列表（标题、字数、时间）、「已用 N / 5,000 字」、上传 .md / .docx（上传后弹框显示转出的文字）、查看全文（弹框）、删除 | `/poc/custom-rules*` |
| Agent 接入 | 补丁 0001–0003 的功能用新风格重做：连 Nexus、发布清单、粘贴调用密钥启用（弹框）、设为审批 Agent、测试（单据 / 文本 / 请求信封）、调用记录 | `/platform/agent-access*`、外壳的 `/platform/agent-access/nexus*`、`/publications`、`/:pub/test`、`/tests/:id`、`/calls` 等（照现在补丁里的调用） |
| 设置 | 页签：平台概况与 Agent 中心（运行、日程、暂停 / 运行）、同步、连接器、中间件、审计、数据。**第二期**再做（实现方决定），第一期在这里放「打开九安原来的后台配置」链接到 `/analysis.html#adminConfig` | 九安 `/platform/*` |

角色：管理员看到全部入口；分析员看不到「Agent 接入」和「设置」，知识库只读（看清单、检索；上传、下线、删除只给管理员）；`policy_reviewer` 只有工作台和单据池的只读视图（不能复核、不能发起）。

## 7. 测试与验收

- 单元：`poc/web07`（Vitest）、`poc/app07`（`node --test`：复核接口、看板统计的口径——用假的 agent-task 状态和复核记录算出每个数）。
- 端到端：`poc/app/test/e2e/` 新加一份针对新前端的用例（登录 → 工作台的数字和单据池对得上 → 打开单据看建议 → 复核采纳 / 改判 → 工作台的待复核、改判率随之变化 → 我的规则上传 / 删除 → 知识库页（PG 知识库 Agent 建好后）→ Agent 接入页列出发布），旧用例里只测接口的部分保留。
- 截图核对样稿：工作台、单据池 + 抽屉、知识库弹框各一张（不截真实制度）。

## 8. 留给实现者的

组件拆分和目录结构；Tailwind 的 token 写法；图标集的具体画法（照第 2 节的约束）；看板的缓存细节；端到端用例的具体写法。

## 9. 补充的决定（2026-10-30，实现方决定，审阅后补）

| 问题 | 决定 |
|---|---|
| 复核按单据还是按人 | **按单据**：一张单只要有人复核了它当前的那一轮 AI 建议，就离开「待复核」；以最后一次复核为准（不管是谁）。「按审核员」统计的是每个人做过的复核。改判率 = 改判数 / 复核数（同一轮被复核多次只算最后一次） |
| 重新审核之后 | 复核记录绑定 `advice_round`：同一版本又跑完一轮新的 AI 建议，这张单回到「待复核」，抽屉和单据池标「AI 建议已更新」；409 校验也按「当前已完成的那一轮」 |
| 撤掉旧页面 | **不在这次计划里**：设置第二期做完之前，`/analysis.html` 一直保留，设置页链接过去 |
| `policy_reviewer` | 不加新账号；按角色控制的界面用单元测试覆盖 |
| 审批路径与最终审批人 | 取自 AI 建议里规则依据的 `note` 中「适用审批路径：…；最终审批人：…」（审核 Agent 提示词规定的写法）；解析不出就不显示这一行，不猜。汇联易里的实际审批流程放在「单据信息」页签（来自 `/documents/:id/page`，有就显示） |
| 改判的方向和原因 | 两个方向都可以。AI 不建议通过 → 改判为通过：`contract_covers` 合同或补充协议已涵盖、`evidence_complete` 原件齐全 AI 没识别、`amount_ok` 金额核对无误、`rule_not_applicable` 适用规则不对、`other`；AI 建议通过 → 改判为不通过：`evidence_missing` 原件缺失或不符、`amount_mismatch` 金额不符、`payee_mismatch` 收款方不符、`rule_not_applicable`、`other`。`other` 必须写备注；服务端按方向校验原因 |
