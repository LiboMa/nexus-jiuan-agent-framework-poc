# andon-finance PoC：九安审核平台 × Nexus Agent

九安审核平台 v0.5.3 的原服务端和原前端，用虚构单据运行。2026-10-19 起线上是测试台：跑九安开发包的副本（`bench/build-jiuan.sh` 构建）和九安自己的运行时，单据存在实例本机的 MySQL 8.0 里；本机开发和单元测试仍用内存存储（`POC_STORE=memory`，默认）。AI 部分经 A2A 调用 Nexus 上的两个 Agent。整体架构见 [`../docs/architecture.md`](../docs/architecture.md)。
新 Agent 怎么接入前端，见 [`../docs/agent-developer-workflow.md`](../docs/agent-developer-workflow.md)。

- **站点**：https://andon-finance.tinyboat.blog
- **账号**：审核员 `poc-reviewer`、复核人 `poc-checker`，都是虚构账号。口令在本机的 `infra/secrets.env`（`REVIEWER_PASSWORD`、`CHECKER_PASSWORD`），不要外传。
- **数据**：两家虚构公司、8 张虚构单据。测试台上单据和模拟来单存在 MySQL 里，重启不丢；审批记录、登录状态和调用记录在内存里，重启后清空；端到端测试开始前会重建库，单据回到 8 张种子。各账号的 Nexus 连接与启用存在实例磁盘上，重启不丢。

## 页面

- **单据**：九安原页面，多了两样东西：
  - 单据池顶上的「模拟来单」：按模板生成一张新的虚构单据，系统自动跑九安预审和 AI 初审（失败自动重试一次），卡片上直接显示「AI 初审：结论 · 风险」，不用点；
  - 单据详情里的「审批流」卡片：先显示 AI 初审建议，再由一位复核人人工复核（通过或退回），流程结束。原有的 8 张单据可以手动「发起 AI 初审」。AI 只给建议，决定由人做。
- **规则库**：九安原页面。
- **Nexus Agent**：连接 → 启用 → 调用测试。
  - **连接**：在「我的 Nexus 连接」里粘贴你自己的 Nexus API 密钥（Nexus「个人设置 › API 密钥」新建，只读档位就够）。每个账号连自己的，互不影响。
  - **启用**：「我的 Agent」列出你在 Nexus 上的发布，每个带 A2A 名片（协议版本、接受哪些附件类型），分「已启用」「待启用」「有问题」三组；还没发布的 Agent 折叠在最下面。点「启用」，粘贴这个发布的调用密钥（Nexus「互联中心 › 对外发布」签发）。应用当场验证，不花钱；默认顺便读一次能力清单（约 0.03 美元）。之后可以换密钥、重新读能力清单、停用。
  - **调用测试**：只用你自己启用的。要测审批 Agent，先在「我的 Agent」里启用「九安审核AI」。经 A2A 调用，有三种输入方式：
    - 自由文本；
    - 审批建议：选一张单据，输出用九安的校验函数检查；
    - 按任务：用启用时读到的能力清单选任务，输入会预填示例。
  - 附件可以拖进来、点选，也可以点「示例附件」一键加入。最多 5 个，单个不超过 5 MB，合计不超过 6 MB。类型可以是图片、PDF、Excel、CSV、Word、Markdown、文本、JSON、YAML、XML、HTML。
  - 下方是最近 50 次调用的记录（只看得到自己发起的调用测试和审批流的记录），可以看原始返回。附件只记名称、类型和大小。

每次调用约 0.05 美元，记在 Nexus 发布者名下；每个账号每分钟最多 5 次。

## 九安 v0.7.10（和 PoC 并排）

- **站点**：https://jiuan-v0710.tinyboat.blog。同一台实例，PoC 进程按 Host 把请求转给本机 4181（`app/host-proxy.mjs`）；账号和口令与 PoC 相同。
- **另一套（m7g 测试环境，2026-11-02 起）**：栈 `andon-finance-m7g`，一台 m7g.xlarge（arm64）装前端、MySQL 和知识库的 PG，经 SSH 管理（见 [`infra/README.md`](infra/README.md)「经 SSH 管理」），临时站点 https://jiuan-v0710-m7g.tinyboat.blog；数据从上面这套搬来（`infra/migrate-data.sh`）。域名迁移还没定，正式域名还在原来那台。
- **组成**：九安 v0.7.10 开发包的副本（`bench/build-jiuan07.sh`，按清单复制，再打 `../patches/jiuan-v0.7.10/` 下的补丁，`source/` 不动）+ 外壳 `app07/`（口令登录、进程内的假汇联易、出网只放行 Nexus）。单据存在本机 MySQL 的 `jiuan07` 库。
- **新前端**（`web07/`，React 19 + TypeScript + Vite + Tailwind 4 + TanStack Query + Radix；2026-11-01 起）：外壳的前门（`app07/front.mjs`）在 `/` 给它的构建产物，九安原来的页面照旧在 `/analysis.html`。守着 CSP `style-src 'self'`（不注入 `<style>`）。哈希路由：
  - `#/login` 登录（账号 + 口令）；旧的口令页 `/poc/login` 照旧，跳到 `/#access=<票据>`，新前端把票据换成会话、从地址栏抹掉；
  - `#/` 工作台：四个数（待我复核、AI 已出建议、建议通过率、出建议用时（上限 180 秒））；每天的建议（堆叠柱）、不通过最常见的依据、人工改判率、按审核员；知识库、最常引用的规则、我的规则三张卡；看今天 / 近 14 天 / 本月；「上传制度」只给管理员。「最常引用的规则」认 `C…` / `G-…` 和风险判断卡的 `risk-cards-T…` 等条款编号（2026-11-02 起），编号旁边是依据里跟着的说明；
  - `#/documents` 单据池（只有对公付款单）：待复核 / 已复核 / 全部，能搜索；「刷新」，有一轮在跑或待复核是空的时候约每 12 秒自动刷新。「最近审核」一栏是 AI 这一轮和人工复核里晚的那个时间，第二行写「复核 · <名字>」或 AI 建议 / AI 失败 / AI 拒绝 / AI 开始；点表头按最近在前 → 最早在前 → 原来的顺序轮换。点一行开右侧抽屉（地址带 `?doc=<id>`；抽屉开着时板块 · 事项挪到单号下面）：AI 建议（发起 / 重新审核）、原件（读取原件、按页看文字；在 AI 建议里点依据上的「第 N 页」就跳到原件的那一页）、单据信息、历史（每一轮 AI 建议和每次复核，带复核人名字）；底部复核：「采纳 AI 建议」或「改判」，改判的原因按方向选，选「其他」要写不超过 200 字的备注。复核只记在测试台，不回写汇联易；提交后打开下一张待复核的单；
  - `#/knowledge` 知识库（只给管理员，项目负责人 2026-10-31 定的）：制度清单、上传记录、「上传制度」（只收 .docx，标题预填完整的文件名、带 .docx）、「检索」，都经知识库 Agent（见下面「知识库」）；`#/my-rules` 我的规则（管理员和分析员；页面写「已用 N 字」，不限合计字数，规则见下面「我的规则」）；
  - `#/agents` Agent 接入、`#/settings` 设置（只给管理员；设置一期只链到 `/analysis.html#adminConfig` 和 `#platform`）。角色：`poc-reviewer`「审核员（虚构）」是管理员；`poc-checker`「复核人（虚构）」是分析员，导航里没有知识库、Agent 接入、设置，直接打开是「没有权限」，接口那头也只认管理员；九安的 `policy_reviewer` 没有分到公司，单据池和工作台是空的。
  - 构建：`cd web07 && npm ci && npm test && npm run build`（`infra/deploy.sh` 动 AWS 之前做这一步，`dist/` 随构件发出）；外壳启动时读一次 `dist/`，重新构建后要重启外壳。
  - 新前端用的外壳接口（`/api/analysis/v1/poc/…`，都按「这个人的公司 ∩ 测试台的公司」过滤）：`reviews`（POST 复核；`?documentId=` 一张单的复核；`latest?ids=` 单据池用，带这一轮的 `current.startedAt` / `finishedAt` 和复核人 `review.actorName`）、`dashboard?window=`（缓存 60 秒，每次复核、每一轮结束都清）、`advice-rounds?documentId=`、`evidence-pages?documentId=`。
- **Agent 接入**（新前端 `#/agents`；九安原来的页面在「后台配置 › Agent 接入」；补丁 0001–0003，后端在 `app07/`）：
  - 连一次 Nexus：在对话框里贴你自己的 Nexus API 密钥。页面列出你在 Nexus 上开了 A2A 的发布，和已启用的合在一张表里，每个 Agent 一行；
  - 启用：点「启用」，在对话框里只贴这个发布的调用密钥；页面上之后只显示指纹。启用后 Agent「就绪」，供前端工作流调用；名片说明里有没有「契约 / 任务」两行都不挡启用。列表里没有的发布用「手动添加 Agent」（A2A 地址 + 调用密钥）；
  - 审批流只调「审批 Agent」：在一个就绪的 Agent 上点「设为审批 Agent」，对话框里要写原因（同一时间只有一个，替换前先确认；名片没声明 `review_advice@1` / `first_review@1` 时先提醒，设了多半出不来建议），表格上方一行写着审批流现在调谁。现在是「九安审核AI（PoC）」（补丁 0003 上线时按它名片声明的 review_advice@1 迁移过来的）。知识库 Agent「知识库文档管家（PG 版）」也在这里启用，就绪、不进审批流；
  - 就绪的卡上有「测试」，三种测法：文本（一段话原样发过去看回复）、请求信封（按契约预填 jiuan.agent/v1 示例请求，回答按契约判合格 / 不合格，原始回答也能看）、单据（选一张对公付款单，照自动初审组装请求）。测试只记进调用记录，不改单据的结论；每分钟最多 5 次；
  - 另有「停用」（先确认）、「重新验证」（用存着的密钥再向 Nexus 验一次名片和密钥；九安原来的页面上叫「复核」），密钥失效的有「换钥匙」；
  - 下方是调用记录：审批流的每一轮（自动初审、单据页发起）和每次测试一行，「查看反馈」看 Agent 返回了什么。操作记录折叠在最下面。
- **知识库**（新前端 `#/knowledge`；九安原来的页面是「规则库 › 制度知识库」，补丁 0004、0005；后端 `app07/kb-steward-routes.mjs`、`app07/kb-steward-client.mjs`，只给管理员）：2026-10-30 起测试台不连 PG、不解析文档，经 A2A 调 Nexus 上的 PG 知识库 Agent「知识库文档管家（PG 版）」`pub_6ea5f0855dff6c1b`（约定 `kb.rules/v1`：describe、ingest、list、detail、deactivate、restore、delete、check、search）。它的调用密钥在「Agent 接入」页启用；它的代码在 [`../knowledgebase-writer-agent-pg/`](../knowledgebase-writer-agent-pg/README.md)（2026-11-02 合进 main）。
  - 上传 .docx 后在后台入库，页面轮询上传记录；同一份再传一次是「没有变化」（skipped）。另有制度清单、下线 / 恢复 / 删除、检索。
  - 2026-10-31 起（项目负责人定）有效的规则是**审批风险判断卡** `risk-cards`，449 条：`risk-cards-H1` 是说明，`risk-cards-T1.1`…`T1.448` 一条一张卡，都是 `rule_type=clause`，卡片全文（卡片编号、费用类型、…、一期可行性）在 `scope_controls` / `content`。上传时制度标识 `risk-cards`、版本 `2026-10-29`、标题就是文件名。原页面是 HTML，转成可入库的 .docx 见 [`../kb/convert/risk-cards/`](../kb/convert/risk-cards/README.md)。原来的 V4.0 审批矩阵 `finance-approval-v4`（102 条）已**下线**（可恢复，什么都没删）。
  - 知识库 Agent 偶尔在 JSON 前多写一句话：外壳收下不超过 200 字、不含 `{ }` 的一句，日志记 `POC_KB_AGENT_REPLY_LEADIN <操作> <字数>`（不记内容）。
  - 知识库本身（PG 容器、连接器、Agent 提示词）用 `infra/kb.sh` 部署和核对，见 [`../kb/README.md`](../kb/README.md) 与 [`../kb/GUIDE.md`](../kb/GUIDE.md) 7.5–7.7。向量是 Cohere Embed v4；跑 db 阶段前确认 `kb/deploy.env` 的 `EMBED_MODEL_ID` 是 Cohere v4（缺省就是），否则防混用检查会停下（`kb/GUIDE.md` 7.6）。
- **我的规则**（管理员和分析员；补丁 0005，后端 `app07/custom-rules.mjs`）：每人最多 10 份、单个文件 2 MB，不限合计字数，只受九安一次请求的上限（`maxRequestChars` 87,442 字）限制：单份转出的文字就超过它，上传时拒绝（`CUSTOM_RULES_UNSENDABLE`）；人发起一轮时规则加上单据放不进一次请求，这一轮在发给 Nexus 之前就失败（`CUSTOM_RULES_TOO_LONG`）；规则从不裁短，挤掉原件的页时外壳记一行 `POC_CUSTOM_RULES_TRIMMED <单据> <页数>`。
- **时限**：一轮 AI 独立建议 180 秒（补丁 0006 只改副本里 `review_advice@1` 的 `limits.timeoutMs`；九安上游契约是 120 秒），调用中间件给 `nexus-a2a` 200 秒（补丁 0007，超时报 `AI_UNAVAILABLE`），外壳给一轮的租约 420 秒（排在后面的一轮不会被顶掉）。2026-11-01 改过审核 Agent 的提示词以后，一轮 7–20 秒。
- **模拟来单**：https://jiuan-v0710.tinyboat.blog/poc/intake（管理员）。九安下一轮同步（约 1 分钟）把新单拉进单据池，读完原件后自动发起 AI 独立建议。
- **端到端测试**：`DEPLOY_ENV=infra/env/<环境>.env bash app/test/e2e/run07.sh`。先重建 `jiuan07` 库（保留 Agent 接入的启用记录和 Nexus 连接），只从 `infra/secrets.env` 读两个账号的口令，不读任何调用密钥；再按先后跑两个文件，共用一个开始时间：
  - `web07.e2e.mjs`：新前端的页面——旧口令页和新登录页、工作台的数和单据池对得上、单据池打开一张单（抽屉四个页签都有内容）、采纳和改判（工作台跟着变、改判率有值）、我的规则上传和删除、Agent 接入（审批 Agent、知识库 Agent 就绪、单据 / 文本 / 请求信封测试）、知识库（就绪、上传制度、检索）、分析员看不到管理员的页；
  - `jiuan07.e2e.mjs`：只测接口的那些（结论和引用的规则编号都在知识库里、检索日志、调用记录、两档结论、没有回写、模拟来单、出网只到 Nexus），加上新抽屉里的模型说明和自定义规则（含一份约 20,000 字的长规则在 180 秒内跑完）。
  - 加 `KB_E2E_DOCX=<本机转好的风险判断卡 .docx>`（[`../kb/convert/risk-cards/`](../kb/convert/risk-cards/README.md) 转出来、入库的那一份）时知识库那条在页面上传它（预期「没有变化」skipped、449 条），没给就跳过；知识库页的制度详情、检索结果不截图，制度原文不进仓库。`E2E07_FILES=web07.e2e.mjs` 只跑一个文件，再加 node 的 `--test-name-pattern` 只跑几条（每次都先重置测试台）。
  - 完整跑一次约 1–3 美元的 Nexus 调用。
  - 2026-11-01：完整运行 26 条，25 通过，失败的那条是知识库 Agent 回复前多一句话，已修（外壳收下引导语）；之后知识库的 4 条、单据池的 6 条单独重跑全部通过。
  - 2026-11-02 最近的结果：对 m7g 测试环境（`DEPLOY_ENV=infra/env/m7g.env`，经 SSH + EC2 Instance Connect 端点；Nexus 已指向它的 PG）完整运行 26 条全部通过（web07 15、jiuan07 11，带 `KB_E2E_DOCX`），约 4 分钟。

## 不经界面调用（命令行）

给 Claude Code、Codex、Kiro CLI 用的接入命令行 `agent_access.py`（Python 3.9 标准库；写操作要加 `--yes`；密钥一律从标准输入读，输出里不会出现密钥）。四条常用命令：

```bash
cd audit-nexus
A=skills/agent-access/scripts/agent_access.py
python3 $A login --origin https://andon-finance.tinyboat.blog --account poc-reviewer --password-stdin --yes   # 口令从标准输入读
python3 $A nexus connect --yes                    # 从标准输入读你的 Nexus API 密钥
python3 $A enable pub_2cc24c29d2e5b2c9 --key-stdin --yes   # 从标准输入读这个发布的调用密钥
python3 $A invoke pub_2cc24c29d2e5b2c9 --task answer --input '{"question":"北京出差住宿每晚最多报多少？"}' --wait --yes
```

`status`、`agents`、`runs` 只读，不用 `--yes`；`disable`、`logout` 要加。退出码和全部命令见 [`skills/agent-access/SKILL.md`](../skills/agent-access/SKILL.md)。

`try-agent.mjs` 用口令直接调 PoC 接口（调用的发布要先在前端启用）：

```bash
cd audit-nexus/poc/app
node scripts/try-agent.mjs --list                                   # 已启用的发布与示例附件（不调用 Agent）
node scripts/try-agent.mjs --publication pub_2cc24c29d2e5b2c9 --task describe
node scripts/try-agent.mjs --publication pub_2cc24c29d2e5b2c9 --task select \
  --input '{"document":{"companyId":"poc-company-a","documentType":"employee_reimbursement","expenseType":"差旅费","departmentName":"销售一部（虚构）"}}' \
  --sample hotel-invoice-png
node scripts/try-agent.mjs --publication pub_5c53e70d8dc7ddea --document FYBX-POC-001 --attach ./住宿发票.pdf
```

脚本走的路和页面一样：CloudFront → PoC 服务端 → A2A → Nexus。口令从 `infra/secrets.env` 读，不会打印。

## 测试

```bash
cd audit-nexus/poc/app
node --test "test/unit/**/*.test.mjs"        # 单元测试，用本机的假 A2A 网关，不连 Nexus；要 MySQL 的 11 个本机跳过，用 ../infra/bench-test.sh 在测试台上跑
python3 -m unittest discover -s ../../skills/agent-access/tests   # agent-access Skill 与命令行的 13 个测试
test/e2e/run.sh                               # 端到端测试：先重建测试台的库，再跑全部（约 0.36 美元）
test/e2e/run.sh attachments.e2e.mjs           # 只跑附件与发现（约 0.15 美元）
test/e2e/run.sh access.e2e.mjs                # 只跑连接与启用的检查、调用一次（约 0.05 美元）
```

端到端测试用审核员本人在前端的连接和启用，不从文件读 Agent 密钥。审核员还没连接 Nexus、或者没启用知识 Agent 时，相关的几项会跳过并写明原因：在前端用审核员连接、启用一次就行。

端到端测试用本机的 Chrome（Playwright 不下载浏览器），截图存到 `audit-nexus/evidence/`。

## 目录

| 路径 | 内容 |
|---|---|
| `app/` | PoC 服务端、前端扩展、示例附件与测试（代码地图见架构文档第 8 节） |
| `app/samples/` | 示例附件（虚构），由 `tools/make-samples.py` 生成 |
| `infra/` | CloudFormation 模板、部署与清理脚本、密钥文件（只在本机），见 [`infra/README.md`](infra/README.md) |
| `tools/make-samples.py` | 生成示例附件 |
| `a2a-entry/` | 第四轮的 A2A 调用验证（历史，不再部署） |
| `../knowledge-agent/` | 知识 Agent 的提示词与维护说明，见 [`../knowledge-agent/README.md`](../knowledge-agent/README.md) |

九安开发包（`audit-nexus/source/`）只读，不改：前端副本由 `app/scripts/build-public.mjs` 按锚点补丁生成；九安前端一变，补丁就会报错，不会悄悄漏改。
