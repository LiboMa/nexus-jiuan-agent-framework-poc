# 九安审单 React 新前端 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 测试台 `/` 换成一套 React 新前端（A 版布局：工作台、单据池 + 抽屉 + 复核、知识库、我的规则、Agent 接入、设置），后端照用九安和外壳现有的接口，另加复核记录和工作台统计两个外壳接口。

**Architecture:** 新目录 `poc/web07`（React 19 + TypeScript + Vite + Tailwind），构建产物由测试台外壳的前门同源挂在 `/`；会话、CSRF、角色都沿用九安。外壳新增 `reviews.mjs`（复核记录，存 `jiuan07` 库）和 `dashboard.mjs`（看板统计，读 AI 建议轮次、复核、知识库上传历史、我的规则）。

**Tech Stack:** React 19、TypeScript 5、Vite、Tailwind CSS 4（`@tailwindcss/vite`）、React Router（`createHashRouter`）、TanStack Query、Radix UI（Dialog / Tabs / Tooltip）、Vitest + Testing Library；外壳 Node 24（`node --test`）、MySQL 8（`mysql2`）；端到端 Playwright。

**Spec:** `docs/specs/2026-10-30-react-frontend-design.md`（含第 9 节补充的决定）。样稿：`.superpowers/brainstorm/1550-1793344741/content/{drafts-v2.html（A 版）,dashboard-a-v9.html,drawer-a.html}`。

## Global Constraints

- 颜色：画布 `#F5F7FA`、面 `#FFFFFF`、正文 `#0E1B33`、次要 `#5A6880`、弱 `#8A97AB`、分隔 `#E2E7EF`、主蓝 `#1E5EFF`、浅蓝 `#EEF3FF`；通过 `#0E9F6E`、不通过 `#E5484D`、处理中 `#D19A2B`；我的规则 `#7A5AF8` / `#6941C6`。状态色一律配 ✓ / ✕ 图标和文字。
- 字体：`-apple-system, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui`；数字 `font-feature-settings: "tnum"`；字号 12/13/14/16/22/28，字重 400/500/600/650。
- 形状：容器圆角 4 px；按钮、输入、标签 0–2 px；图标自绘直角线条（24 网格、描边 1.6、`stroke-linecap: square`、`stroke-linejoin: miter`），不用圆角图标库。Logo 照 Spec 第 2 节（深海军蓝渐变方块 + 青到蓝渐变「文件 + 对勾」）。
- 布局：侧栏 220 px，可收起到 72 px；导航「工作台；审核：单据池、知识库、我的规则；平台：Agent 接入、设置」；选中：浅蓝底 + 2 px 主蓝左边线。单据抽屉右侧 430 px。动效只给抽屉 / 弹框开合，150–200 ms，`prefers-reduced-motion` 时关掉。
- CSP：页面带 `style-src 'self'`——不能用往页面插 `<style>` 的 CSS-in-JS；Tailwind 编译成静态 CSS；React 的 `style` 属性可以用。
- 同源：接口只走 `/api/analysis/v1/...`（九安）和 `/api/analysis/v1/poc/...`（外壳）；非 GET 带 `X-CSRF-Token`（来自 `GET /api/analysis/v1/session` 的 `data.csrfToken`）和 `Content-Type: application/json`；解 `{data}` / `{error:{code,message}}`；错误照 `message` 原样显示（中文）。
- 不改九安的后端接口和接口合同；复核不回写汇联易；九安旧页面 `/analysis.html` 和补丁 0001–0005 保留。
- 角色：管理员全部入口；分析员没有「Agent 接入」「设置」，知识库只读；`policy_reviewer` 只读工作台和单据池，不能复核、不能发起。
- 复核按单据、绑定 `advice_round`；改判原因按方向（Spec 第 9 节的两组代码），`other` 必须写备注，备注 ≤ 200 字。
- 文案中文、动词开头；空状态和错误说清发生了什么、怎么办。
- `poc/web07/dist/`、`node_modules/` 不进仓库；没有真实制度原文进仓库、截图、日志。
- 提交不加 `--no-verify`（Code Defender 钩子拦了就停下报告）；只 `git add` 本任务的文件；端到端通过、项目负责人确认后才推送。

## Review Focus

1. **会话过期或服务重启**（会话在内存里，重启就丢；cookie 8 小时）：任何接口回 401 时回到登录页并说「登录已过期，请重新登录」，不白屏；重新登录后 CSRF 令牌重新取。→ Task 1 的测试钉住。
2. **一张单处在各种中间状态**：还没有 AI 建议、建议进行中、失败（带错误码）、被拒（declined）、AI 建议已更新（复核过的那一轮之后又有新一轮）：抽屉和单据池各给清楚的状态与下一步，不报错。→ Task 5 的测试钉住。
3. **两人同时复核 / 复核时 AI 刚跑完新一轮**：服务端 409（`REVIEW_STALE`），页面提示「这张单的 AI 建议刚更新，请先看新的建议」并刷新，不覆盖。→ Task 3、Task 5 的测试钉住。
4. **工作台没有数据**（测试台刚重置）：各数显示 0 或「—」，图表画出空状态，不出 `NaN`、不出除零。→ Task 4、Task 7 的测试钉住。
5. **分析员手动改地址进管理员页面**（`#/agents`、`#/settings`）：显示「没有权限」视图，接口也照样拒绝。→ Task 1、Task 8 的测试钉住。

---

### Task 1: `poc/web07` 骨架：设计系统、图标、Logo、外壳布局、接口与会话

**Files:**
- Create: `poc/web07/package.json`、`vite.config.ts`、`tsconfig.json`、`index.html`、`src/main.tsx`、`src/styles.css`（Tailwind 4 `@theme` 写入 Global Constraints 的 token）、`src/api/client.ts`、`src/api/session.ts`、`src/ui/icons.tsx`、`src/ui/Logo.tsx`、`src/ui/*.tsx`（Button、Pill、Segmented、Panel、Drawer、Modal、Tabs、Empty）、`src/shell/AppShell.tsx`、`src/shell/nav.ts`、`src/pages/Login.tsx`、`src/pages/NoAccess.tsx`、`src/pages/Settings.tsx`（第一期：链接到 `/analysis.html#adminConfig` 和 `#platform`）、`src/router.tsx`（路由先挂占位页）、`src/test/*.test.tsx`、`.gitignore`（`dist/`、`node_modules/`）
- Test: `cd poc/web07 && npm test`（Vitest）

**Interfaces:**
- Produces：
  - `api<T>(path: string, init?: { method?: 'GET'|'POST'|'PUT'|'DELETE'; body?: unknown; raw?: BodyInit; headers?: Record<string,string> }): Promise<T>`：同源、`credentials:'same-origin'`；非 GET 自动带 `X-CSRF-Token`；返回 `data`；失败抛 `ApiError { status, code, message }`；401 时触发 `onUnauthorized()`（清会话缓存、跳登录）。
  - `useSession(): { user: { id, name, role: 'admin'|'analyst'|'policy_reviewer' }, csrfToken, capabilities } | null`（TanStack Query，键 `['session']`）。
  - 登录：`login(account, password)` → `POST /api/analysis/v1/poc/login` 得 `ticket` → `POST /api/analysis/v1/auth/exchange {ticket}` → 刷新 `['session']`；启动时如果地址里有 `#access=<票据>`（旧登录页跳过来的）也照样换。退出：`POST /api/analysis/v1/auth/logout`。
  - 路由（哈希）：`#/`（工作台）、`#/documents`（`?doc=<id>` 打开抽屉）、`#/knowledge`、`#/my-rules`、`#/agents`、`#/settings`、`#/login`。`canSee(route, role): boolean` 按 Global Constraints 的角色规则。
  - 图标组件 `<Icon name="dashboard|documents|knowledge|myRules|agent|settings|upload|search|check|cross|close|file|chevronLeft|chevronRight|refresh|warning" />`。

- [ ] **Step 1: 写测试**：`api` 带 CSRF、解信封、抛 `ApiError`（`code`、中文 `message` 原样）；401 调 `onUnauthorized` 并跳 `#/login` 显示「登录已过期，请重新登录」（Review Focus 1）；`#access=` 启动时换票并清掉地址里的票据；`canSee` 对三个角色的结果；分析员访问 `#/agents` 看到「没有权限」（Review Focus 5）；侧栏收起 / 展开、选中态；`Logo` 渲染出渐变方块和字标；没有任何组件往 `document.head` 插 `<style>`（测 `document.querySelectorAll('style').length` 为 0）。
- [ ] **Step 2: 跑** `cd poc/web07 && npm install && npm test`，FAIL。
- [ ] **Step 3: 实现**（照样稿 A 版的侧栏与卡片尺寸；图标按 Global Constraints 画）。
- [ ] **Step 4: 跑** `npm test` PASS；`npm run build` 产物里没有内联 `<style>`、没有 `eval`。
- [ ] **Step 5: 提交** `feat(web07): React shell — design tokens, square icons, logo, session and login`

### Task 2: 前门挂新前端；部署时构建

**Files:**
- Modify: `poc/app07/front.mjs`（`GET /` 和 `/assets/*` 给 `web07` 构建产物；去掉「没有登录标记就 302 到 `/poc/login`」）、`poc/infra/deploy.sh`（打包前 `cd poc/web07 && npm ci && npm test && npm run build`，把 `dist/` 放进构件的 `release/web07/`）、`poc/app07/test/unit/front-intake.test.mjs`（或新 `front-web.test.mjs`）、`poc/app/test/unit/bench07-infra.test.mjs` / `infra.test.mjs`（部署脚本的静态检查）
- Test: `cd poc/app07 && npm test`、`cd poc/app && npm test`

**Interfaces:**
- Consumes: Task 1 的构建产物结构（`dist/index.html`、`dist/assets/<hash>.js|css`）。
- Produces: `createFrontDoor({ origin, login, publicDir, webDir = path.join(here, '../web07') })`：`GET /` → `webDir/index.html`；`GET /assets/<文件>` → 只认构建产物里真实存在的文件（启动时读一次清单），MIME 只认 js / css / svg / png / woff2，带现有的 `PAGE_CSP`、`nosniff`、`no-referrer`；`index.html` `no-store`，`/assets/*` 可长缓存（文件名带哈希）；`webDir` 不存在时 `/` 回 503「新前端还没构建」。`/poc/login`、`/poc/intake`、登录接口照旧。

- [ ] **Step 1: 写测试**：`/` 给 `index.html` 且 CSP 头存在；`/assets/x.js` 只给清单里的文件、`/assets/../server.mjs` 之类 404；没有构建产物时 503；登录接口和 `/poc/login` 不变；`deploy.sh` 在打包前构建并带上 `web07`。
- [ ] **Step 2: 跑**，FAIL → **Step 3: 实现** → **Step 4: 跑** 两个外壳测试套件 PASS；本机 `cd poc/web07 && npm run build` 后用外壳的前门单元测试加载真实 `dist/` 一次。
- [ ] **Step 5: 提交** `feat(app07): the front door serves the React app at /; deploy builds it`

### Task 3: 外壳：复核记录

**Files:**
- Create: `poc/app07/reviews.mjs`、`poc/app07/advice-rounds.mjs`（从 `agent-calls.mjs` 抽出读 AI 建议轮次的逻辑，`agent-calls.mjs` 改用它，行为不变）、`poc/app07/test/unit/reviews.test.mjs`
- Modify: `poc/app07/server.mjs`（挂路由、`start()` 时建表）、`poc/app07/agent-calls.mjs`
- Test: `cd poc/app07 && npm test`

**Interfaces:**
- Produces：
  - `readAdviceRounds({ tenantId, agentTaskKey, readState, listDocuments, task = 'review_advice' }): Promise<Array<{ documentId, companyId, documentVersion, round, trigger, requestedBy, status, result, basis, errorCode, startedAt, finishedAt, current: boolean }>>`（当前一轮 + 历史轮次，按单据）。
  - 表 `poc_review_decisions`（Spec 5.1 的列）；`createReviews({ pool, readCurrentAdvice, now })` → `{ start(), add(actor, input), history(documentId), latest(documentIds), all({ since }) }`；`readCurrentAdvice(documentId) → { documentVersion, round, status, result } | null`。
  - 路由（管理员、分析员；`policy_reviewer` 403 `REVIEW_FORBIDDEN`）：`POST /api/analysis/v1/poc/reviews {documentId, sourceVersion, round, decision:'adopt'|'override', reason?, note?}` → 201 `{ review }`；`GET …/reviews?documentId=` → `{ items }`；`GET …/reviews/latest?ids=a,b,…`（≤ 50）→ `{ items: { [documentId]: { state: 'no_advice'|'running'|'pending'|'reviewed'|'outdated', current: {round,result,status}|null, review|null } } }`。
  - `review`：`{ id, documentId, documentVersion, adviceRound, aiResult, decision, finalResult, reason, note, actor, createdAt }`。
  - 错误：`REVIEW_ADVICE_NOT_READY` 409「这张单还没有完成的 AI 建议，等建议出来再复核」；`REVIEW_STALE` 409「这张单的 AI 建议刚更新，请先看新的建议」；`REVIEW_INVALID` 400（原因不属于这个方向、`other` 没写备注、备注超过 200 字）。

- [ ] **Step 1: 写测试**（假的 `pool` 用内存实现同样的 SQL 接口，或测试里用 `mysql2` 的假连接——照外壳现有测试的做法）：采纳 → `finalResult === aiResult`；改判两个方向各自的原因表（Spec 第 9 节），错方向的原因 400；`other` 无备注 400；版本或轮次不是当前的 409 `REVIEW_STALE`（Review Focus 3：两人同时提交，第二个看到的轮次已不是当前时也是 409）；当前一轮未完成 409；同一单多次复核 `latest` 取最后一次；新一轮完成后 `state === 'outdated'`；`policy_reviewer` 403；`advice-rounds` 抽出后 `agent-calls` 现有测试不变通过。
- [ ] **Step 2: 跑**，FAIL → **Step 3: 实现** → **Step 4: 跑** `npm test` PASS。
- [ ] **Step 5: 提交** `feat(app07): reviews — adopt or override the AI advice, bound to the round`

### Task 4: 外壳：工作台统计

**Files:**
- Create: `poc/app07/dashboard.mjs`、`poc/app07/test/unit/dashboard.test.mjs`
- Modify: `poc/app07/kb-steward-routes.mjs`（导出 `historyList()` 和 `status()`：方式、是否配置、是否就绪——不调 Agent）、`poc/app07/server.mjs`
- Test: `cd poc/app07 && npm test`

**Interfaces:**
- Consumes: Task 3 的 `readAdviceRounds`、`reviews.all()`；`customRules.list(accountId)`；`kb.historyList()`、`kb.status()`。
- Produces: `GET /api/analysis/v1/poc/dashboard?window=today|14d|month` → `{ window, from, to, pendingReview:{count,failCount}, advice:{completed,pass,fail,overrides,passRate,avgDurationMs,maxDurationMs}, daily:[{date,pass,fail,running}], topBasis:[{kind:'rule'|'field'|'evidence'|'custom',label,count}], overrideRate:[{date,reviews,overrides}], reviewers:[{account,name,reviews,overrides,customRules}], knowledge:{mode,configured,ready,sources,rules,lastIngestAt}, topRules:[{ruleId,count}], myRules:{files,usedChars,limitChars} }`；日期按 Asia/Shanghai；`passRate`、平均值在分母为 0 时为 `null`；分析员的 `reviewers` 只有自己；结果按 `(window, 角色, 账号)` 缓存 60 秒。`topBasis` 归并：`rule` 取规则编号（`ref` 开头的编号）、`custom` 取「自定义：」后的标题、`field` / `evidence` 取 `ref`。

- [ ] **Step 1: 写测试**（假的轮次、复核、上传历史、我的规则）：每个数的口径（Spec 5.2 + 第 9 节：按单据、绑定轮次、改判率 = 改判 / 复核、同一轮多次复核只算最后一次）；没有任何数据时全为 0 / `null` 且结构完整（Review Focus 4）；窗口边界（上海时区跨天）；分析员只看到自己；不调 Agent（`kb.status()` 的假实现若被调到 `request` 就失败）。
- [ ] **Step 2: 跑**，FAIL → **Step 3: 实现** → **Step 4: 跑** PASS。
- [ ] **Step 5: 提交** `feat(app07): dashboard numbers from advice rounds, reviews, KB history and own rules`

### Task 5: 前端：单据池、单据抽屉与复核

**Files:**
- Create: `poc/web07/src/pages/Documents.tsx`、`src/documents/DocumentDrawer.tsx`、`src/documents/AdviceTab.tsx`、`EvidenceTab.tsx`、`DetailTab.tsx`、`HistoryTab.tsx`、`ReviewForm.tsx`、`src/documents/approvalPath.ts`、`src/api/documents.ts`、测试
- Test: `cd poc/web07 && npm test`

**Interfaces:**
- Consumes: Task 1 的 `api`、`useSession`、UI 组件；Task 3 的复核接口；九安的 `/documents?…`、`/documents/:id`、`/documents/:id/page`、`/documents/:id/advice`（GET / POST `{sourceVersion}`）、`/documents/:id/evidence`（GET、`/read` POST `{sourceVersion}`）——请求与返回字段照九安 `public/document-list.js`、`public/analysis.js`（1559–1606 行附近）、`public/document-page.js` 的现有用法。
- Produces: `parseApprovalPath(note: string): { path: string; finalApprover: string } | null`（从「适用审批路径：…；最终审批人：…」解析，解析不出回 `null`）。

- [ ] **Step 1: 写测试**：单据池三个页签「待复核 / 已复核 / 全部」按 `reviews/latest` 的 `state` 分；搜索传 `q`；点行开抽屉（地址 `?doc=`）；抽屉四个页签；AI 建议页：依据带四种标签、`parseApprovalPath` 有值才显示审批路径；「重新审核」发 `POST advice`（`policy_reviewer` 不显示）；**各种状态**（Review Focus 2）：没有建议、进行中（轮询）、失败（显示错误码和「重新审核」）、declined（显示原因）、`outdated`（标「AI 建议已更新」）；复核：采纳 / 改判（原因按方向、`other` 必填备注、备注 200 字上限），提交成功后开下一张待复核；409 `REVIEW_STALE` 时提示并刷新（Review Focus 3）。
- [ ] **Step 2: 跑**，FAIL → **Step 3: 实现**（照样稿 `drawer-a.html`）→ **Step 4: 跑** PASS。
- [ ] **Step 5: 提交** `feat(web07): document pool, drawer with advice, originals, details, history, and reviews`

### Task 6: 前端：知识库与我的规则

**Files:**
- Create: `poc/web07/src/pages/Knowledge.tsx`、`src/knowledge/UploadPolicyModal.tsx`、`SearchModal.tsx`、`PolicyList.tsx`、`src/pages/MyRules.tsx`、`src/myRules/*`、`src/api/knowledge.ts`、`src/api/myRules.ts`、测试
- Test: `cd poc/web07 && npm test`

**Interfaces:**
- Consumes: 外壳 `/poc/kb/mode`（`{mode, configured, ready, ops}`）、`/poc/kb/sources`、`/poc/kb/sources/:id[/deactivate|restore|delete]`、`/poc/kb/uploads[/:id]`、`POST /poc/kb/sources?sourceId&sourceVersion&title`（原始 .docx，`X-File-Name`）、`/poc/kb/search?q&segment&amount&k`；`/poc/custom-rules`（列表 `{items, usedChars, limitChars:5000, limitFiles:10}`、`POST` 原始文件 + `X-File-Name`、`GET /:id`、`POST /:id/delete`）。行为与文案照补丁 0005 的 `kb-page.js`（同步接口的工具失败是 HTTP 200 + `data.success === false`，要当失败处理）。
- Produces: `<UploadPolicyModal open onClose />`（Task 7 的工作台复用）。

- [ ] **Step 1: 写测试**：未配置 / 未启用时整页只说明怎么办；`describe` 的 `ops` 决定下线 / 恢复；删除二次确认；上传：制度标识按文件名预填（`^[a-z0-9][a-z0-9-]{1,62}$`）、轮询到 `ingested|skipped|failed`、进行中按钮不可点；检索参数可空；`data.success === false` 显示失败；分析员只读；我的规则：上传后弹框显示转出的文字、超限显示服务端的中文提示、「已用 N / 5,000 字」随列表更新、请求进行中按钮不可点。
- [ ] **Step 2: 跑**，FAIL → **Step 3: 实现** → **Step 4: 跑** PASS。
- [ ] **Step 5: 提交** `feat(web07): knowledge base page and modals; my rules`

### Task 7: 前端：工作台

**Files:**
- Create: `poc/web07/src/pages/Dashboard.tsx`、`src/dashboard/StatTiles.tsx`、`DailyAdviceChart.tsx`、`TopBasis.tsx`、`OverrideRateChart.tsx`、`Reviewers.tsx`、`KnowledgeCard.tsx`、`TopRules.tsx`、`MyRulesCard.tsx`、`src/charts/*`（SVG 柱、折线、悬停提示、表格视图切换）、测试
- Test: `cd poc/web07 && npm test`

**Interfaces:**
- Consumes: Task 4 的 `/poc/dashboard`；Task 1 的 UI。

- [ ] **Step 1: 写测试**：窗口切换发 `window=`；四个数与接口一致（`null` 显示「—」）；每天的 AI 建议：堆叠三段、图例三项带文字、柱间 2 px 间隙、悬停提示当天明细、可切表格视图；人工改判率：没有复核的日子断开不连线、最后一点直接标数；按审核员表（分析员只一行）；空数据全部有空状态、无 `NaN`（Review Focus 4）；「上传制度」打开知识库的上传弹框（Task 6 的组件）。
- [ ] **Step 2: 跑**，FAIL → **Step 3: 实现**（照样稿 `dashboard-a-v9.html`；状态色配文字和图标）→ **Step 4: 跑** PASS。
- [ ] **Step 5: 提交** `feat(web07): dashboard — tiles, daily advice, top basis, override rate, reviewers`

### Task 8: 前端：Agent 接入

**Files:**
- Create: `poc/web07/src/pages/Agents.tsx`、`src/agents/*`（连接 Nexus、发布清单、启用弹框、审批 Agent、测试、调用记录）、`src/api/agents.ts`、测试
- Test: `cd poc/web07 && npm test`

**Interfaces:**
- Consumes: 补丁 0001–0003 在九安页面里用到的接口和行为（照 `patches/jiuan-v0.7.10/0001…0003*.patch` 里 `platform-center.js` / `analysis.js` 的改动、外壳 `poc/app07/nexus-access.mjs`、`agent-tests.mjs`、`agent-calls.mjs`）：`/platform/agent-access`（GET / POST 粘贴密钥启用）、`/platform/agent-access/:id/(rotate|disable|refresh|approve|unapprove)`、`/platform/agent-access/nexus[/disconnect]`、`/publications`、`/:pub/test`、`/tests/:id`、`/test-documents`、`/test-templates`、`/calls`。

- [ ] **Step 1: 写测试**：只有管理员能进（Review Focus 5）；连接 / 断开 Nexus；发布清单与已启用合并成一张表（同一发布只列一次）；粘贴密钥在弹框里、密钥输入框是 `type=password`、提交后清空、任何地方不显示明文；审批 Agent 只能一个、标「审批 Agent」；其他就绪的标「供前端工作流调用（不进审批流）」；三种测试（单据 / 文本 / 请求信封）发对请求、显示结果；调用记录表。
- [ ] **Step 2: 跑**，FAIL → **Step 3: 实现** → **Step 4: 跑** PASS。
- [ ] **Step 5: 提交** `feat(web07): Agent access — Nexus, publications, keys, approval agent, tests, calls`

### Task 9: 端到端（新前端）、上线与文档

**Files:**
- Create: `poc/app/test/e2e/web07.e2e.mjs`
- Modify: `poc/app/test/e2e/run07.sh`（先跑 `web07.e2e.mjs`，再跑 `jiuan07.e2e.mjs` 里只测接口的部分；页面部分迁到新文件）、`poc/app/test/e2e/jiuan07.e2e.mjs`（去掉已迁走的界面操作）、`README.md`、`poc/README.md`、`docs/tech-stack.md`、`CHANGELOG.md`
- Test: 端到端本身

- [ ] **Step 1: 写用例**：登录页（账号口令）→ 工作台的数字有、与单据池对得上 → 单据池打开 DGZF-F07-002 → 抽屉四个页签有内容 → 复核「采纳」→ 待复核少一张、工作台的待复核随之变化 → 另一张「改判」选原因 → 改判率有值 → 我的规则上传 / 删除 → Agent 接入页列出发布、审批 Agent 标识 → 知识库页（PG 知识库 Agent 配好时走上传 / 检索；没配时显示「知识库 Agent 还没配置」）→ 分析员登录看不到 Agent 接入和设置。截图：工作台、单据池 + 抽屉、知识库弹框（不截真实制度）。
- [ ] **Step 2: 上线（项目负责人确认后）**：`DEPLOY_ENV=… bash poc/infra/deploy.sh --code-only`；健康检查；`/` 是新前端、`/analysis.html` 仍可开。
- [ ] **Step 3: 跑** `DEPLOY_ENV=… bash poc/app/test/e2e/run07.sh`：新前端用例全过；接口部分照旧；知识库那几条在 PG 知识库 Agent 建好前按预期跳过或失败（写明原因）。
- [ ] **Step 4: 文档**：README、poc/README、技术栈文档写明新前端（目录、构建、路由、旧页面在 `/analysis.html`）。
- [ ] **Step 5: 提交** `test(e2e): the React app end to end; docs`
