# andon-finance PoC：九安 v0.7.10 测试台（新 UI）

九安自助审核平台 v0.7.10 的原服务端，用虚构单据运行，前面是我们的新前端。AI 部分经 A2A 调用 Nexus 上的 Agent：审批 Agent 出 AI 独立建议，PG 知识库 Agent 读写知识库。2026-11-02 起只留这一套：原来并排的 v0.5.3 PoC（`app/`、它的前端扩展、命令行 `agent_access.py`、知识 Agent）已从代码里拿掉，见 [`../CHANGELOG.md`](../CHANGELOG.md)。

- **站点**：https://jiuan-v0710.tinyboat.blog，在栈 `andon-finance-m7g` 上（2026-11-02 起；一台 m7g.xlarge 装前端、九安的 PostgreSQL 和知识库的 PG，经 SSH 管理，见 [`infra/README.md`](infra/README.md)「经 SSH 管理」）。旧栈 `andon-finance-poc` 等删。
- **账号**：管理员 `poc-reviewer`「审核员（虚构）」、分析员 `poc-checker`「复核人（虚构）」，都是虚构账号。口令在本机的 `infra/secrets.env`（`REVIEWER_PASSWORD`、`CHECKER_PASSWORD`），不要外传。
- **怎么跑的**：外壳（systemd 服务 `andon-jiuan`，用户 `jiuan`）直接听实例的 4180，安全组只放 CloudFront 回源进来；单据存在本机 PostgreSQL（容器 `jiuan-pg`，127.0.0.1:5433）的 `jiuan` 库，重启不丢。整体架构见 [`../docs/architecture.md`](../docs/architecture.md)。
- **组成**：九安 v0.7.10 开发包的副本（`bench/build-jiuan.sh`，按清单复制，再打 `../patches/jiuan-v0.7.10/` 下的补丁，`source/` 不动）+ 外壳 `app/`（口令登录、进程内的假汇联易、出网只放行 Nexus）。单据存在本机 PostgreSQL 的 `jiuan` 库。
- **新前端**（`web/`，React 19 + TypeScript + Vite + Tailwind 4 + TanStack Query + Radix；2026-11-01 起）：外壳的前门（`app/front.mjs`）在 `/` 给它的构建产物，九安原来的页面照旧在 `/analysis.html`。守着 CSP `style-src 'self'`（不注入 `<style>`）。哈希路由：
  - `#/login` 登录（账号 + 口令）；旧的口令页 `/poc/login` 照旧，跳到 `/#access=<票据>`，新前端把票据换成会话、从地址栏抹掉；
  - `#/` 工作台：四个数（待我复核、AI 已出建议、建议通过率、出建议用时（上限 180 秒））；每天的建议（堆叠柱）、不通过最常见的依据、人工改判率、按审核员；知识库、最常引用的规则、我的规则三张卡；看今天 / 近 14 天 / 本月；「上传制度」只给管理员。「最常引用的规则」认 `C…` / `G-…` 和风险判断卡的 `risk-cards-T…` 等条款编号（2026-11-02 起），编号旁边是依据里跟着的说明；
  - `#/documents` 单据池（只有对公付款单）：待复核 / 已复核 / 全部，能搜索；「刷新」，有一轮在跑或待复核是空的时候约每 12 秒自动刷新。「最近审核」一栏是 AI 这一轮和人工复核里晚的那个时间，第二行写「复核 · <名字>」或 AI 建议 / AI 失败 / AI 拒绝 / AI 开始；点表头按最近在前 → 最早在前 → 原来的顺序轮换。点一行开右侧抽屉（地址带 `?doc=<id>`；抽屉开着时板块 · 事项挪到单号下面）：AI 建议（发起 / 重新审核）、原件（读取原件、按页看文字；在 AI 建议里点依据上的「第 N 页」就跳到原件的那一页）、单据信息、历史（每一轮 AI 建议和每次复核，带复核人名字）；底部复核：「采纳 AI 建议」或「改判」，改判的原因按方向选，选「其他」要写不超过 200 字的备注。复核只记在测试台，不回写汇联易；提交后打开下一张待复核的单；
  - `#/knowledge` 知识库（只给管理员，项目负责人 2026-10-31 定的）：制度清单、上传记录、「上传制度」（只收 .docx，标题预填完整的文件名、带 .docx）、「检索」，都经知识库 Agent（见下面「知识库」）；`#/my-rules` 我的规则（管理员和分析员；页面写「已用 N 字」，不限合计字数，规则见下面「我的规则」）；
  - `#/agents` Agent 接入、`#/settings` 设置（只给管理员；设置一期只链到 `/analysis.html#adminConfig` 和 `#platform`）。角色：`poc-reviewer`「审核员（虚构）」是管理员；`poc-checker`「复核人（虚构）」是分析员，导航里没有知识库、Agent 接入、设置，直接打开是「没有权限」，接口那头也只认管理员；九安的 `policy_reviewer` 没有分到公司，单据池和工作台是空的。
  - 构建：`cd web && npm ci && npm test && npm run build`（`infra/deploy.sh` 动 AWS 之前做这一步，`dist/` 随构件发出）；外壳启动时读一次 `dist/`，重新构建后要重启外壳。
  - 新前端用的外壳接口（`/api/analysis/v1/poc/…`，都按「这个人的公司 ∩ 测试台的公司」过滤）：`reviews`（POST 复核；`?documentId=` 一张单的复核；`latest?ids=` 单据池用，带这一轮的 `current.startedAt` / `finishedAt` 和复核人 `review.actorName`）、`dashboard?window=`（缓存 60 秒，每次复核、每一轮结束都清）、`advice-rounds?documentId=`、`evidence-pages?documentId=`。
- **Agent 接入**（新前端 `#/agents`；九安原来的页面在「后台配置 › Agent 接入」；补丁 0001–0003，后端在 `app/`）：
  - 连一次 Nexus：在对话框里贴你自己的 Nexus API 密钥。页面列出你在 Nexus 上开了 A2A 的发布，和已启用的合在一张表里，每个 Agent 一行；
  - 启用：点「启用」，在对话框里只贴这个发布的调用密钥；页面上之后只显示指纹。启用后 Agent「就绪」，供前端工作流调用；名片说明里有没有「契约 / 任务」两行都不挡启用。列表里没有的发布用「手动添加 Agent」（A2A 地址 + 调用密钥）；
  - 审批流只调「审批 Agent」：在一个就绪的 Agent 上点「设为审批 Agent」，对话框里要写原因（同一时间只有一个，替换前先确认；名片没声明 `review_advice@1` / `first_review@1` 时先提醒，设了多半出不来建议），表格上方一行写着审批流现在调谁。现在是「九安审核AI（PoC）」（补丁 0003 上线时按它名片声明的 review_advice@1 迁移过来的）。知识库 Agent「知识库文档管家（PG 版）」也在这里启用，就绪、不进审批流；
  - 就绪的卡上有「测试」，三种测法：文本（一段话原样发过去看回复）、请求信封（按契约预填 jiuan.agent/v1 示例请求，回答按契约判合格 / 不合格，原始回答也能看）、单据（选一张对公付款单，照自动初审组装请求）。测试只记进调用记录，不改单据的结论；每分钟最多 5 次；
  - 另有「停用」（先确认）、「重新验证」（用存着的密钥再向 Nexus 验一次名片和密钥；九安原来的页面上叫「复核」），密钥失效的有「换钥匙」；
  - 下方是调用记录：审批流的每一轮（自动初审、单据页发起）和每次测试一行，「查看反馈」看 Agent 返回了什么。操作记录折叠在最下面。
- **知识库**（新前端 `#/knowledge`；九安原来的页面是「规则库 › 制度知识库」，补丁 0004、0005；后端 `app/kb-steward-routes.mjs`、`app/kb-steward-client.mjs`，只给管理员）：2026-10-30 起测试台不连 PG、不解析文档，经 A2A 调 Nexus 上的 PG 知识库 Agent「知识库文档管家（PG 版）」`pub_6ea5f0855dff6c1b`（约定 `kb.rules/v1`：describe、ingest、list、detail、deactivate、restore、delete、check、search）。它的调用密钥在「Agent 接入」页启用；它的代码在 [`../knowledgebase-writer-agent-pg/`](../knowledgebase-writer-agent-pg/README.md)（2026-11-02 合进 main）。
  - 上传 .docx 后在后台入库，页面轮询上传记录；同一份再传一次是「没有变化」（skipped）。另有制度清单、下线 / 恢复 / 删除、检索。
  - **页面数据存在库里**（2026-11-03 起，项目负责人定：规则入库之后很少再改）：知识库 Agent 回的操作清单（describe）、制度清单、每份制度的详情问到一次就存进九安 `jiuan` 库的 `poc_kb_cache`（`app/kb-cache.mjs`，按方式 + 发布编号分开），之后打开页面直接从库里给，外壳重启也不丢；页面写上清单是什么时候从 Agent 读的。只有这几种时候才再问 Agent：库里没有；点「刷新清单」（`GET …/sources?refresh=1`，同时清掉存着的详情）；在这一页入库、下线、恢复、删除之后（清单和那份制度的详情作废）；钥匙被拒或回复不合格（操作清单作废）。检索不存，每次现问。别处改了知识库（例如 `kb/deploy.sh` 入库）要点「刷新清单」。端到端测试的重置删库重建，缓存随之清空。问 Agent 一次要 4–10 秒（Nexus 上整轮模型：读提示词 → 调工具 → 照抄工具的 JSON，约 0.03 美元）；从库里给不到 1 秒。
  - 2026-10-31 起（项目负责人定）有效的规则是**审批风险判断卡** `risk-cards`，449 条：`risk-cards-H1` 是说明，`risk-cards-T1.1`…`T1.448` 一条一张卡，都是 `rule_type=clause`，卡片全文（卡片编号、费用类型、…、一期可行性）在 `scope_controls` / `content`。上传时制度标识 `risk-cards`、版本 `2026-10-29`、标题就是文件名。原页面是 HTML，转成可入库的 .docx 见 [`../kb/convert/risk-cards/`](../kb/convert/risk-cards/README.md)。原来的 V4.0 审批矩阵 `finance-approval-v4`（102 条）已**下线**（可恢复，什么都没删）。
  - 知识库 Agent 偶尔在 JSON 前多写一句话：外壳收下不超过 200 字、不含 `{ }` 的一句，日志记 `POC_KB_AGENT_REPLY_LEADIN <操作> <字数>`（不记内容）。
  - 知识库本身（PG 容器、连接器、Agent 提示词）用 `infra/kb.sh` 部署和核对，见 [`../kb/README.md`](../kb/README.md) 与 [`../kb/GUIDE.md`](../kb/GUIDE.md) 7.5–7.7。向量是 Cohere Embed v4；跑 db 阶段前确认 `kb/deploy.env` 的 `EMBED_MODEL_ID` 是 Cohere v4（缺省就是），否则防混用检查会停下（`kb/GUIDE.md` 7.6）。
- **我的规则**（管理员和分析员；补丁 0005，后端 `app/custom-rules.mjs`）：每人最多 10 份、单个文件 2 MB，不限合计字数，只受九安一次请求的上限（`maxRequestChars` 87,442 字）限制：单份转出的文字就超过它，上传时拒绝（`CUSTOM_RULES_UNSENDABLE`）；人发起一轮时规则加上单据放不进一次请求，这一轮在发给 Nexus 之前就失败（`CUSTOM_RULES_TOO_LONG`）；规则从不裁短，挤掉原件的页时外壳记一行 `POC_CUSTOM_RULES_TRIMMED <单据> <页数>`。
- **时限**：一轮 AI 独立建议 180 秒（补丁 0006 只改副本里 `review_advice@1` 的 `limits.timeoutMs`；九安上游契约是 120 秒），调用中间件给 `nexus-a2a` 200 秒（补丁 0007，超时报 `AI_UNAVAILABLE`），外壳给一轮的租约 420 秒（排在后面的一轮不会被顶掉）。2026-11-01 改过审核 Agent 的提示词以后，一轮 7–20 秒。
- **九安的库**（2026-11-06 起 PostgreSQL：九安的正式环境已经换成 PostgreSQL，项目负责人 2026-11-05 定测试台跟着换；补丁 0008–0018）：容器 `jiuan-pg`（postgres:17，只听 127.0.0.1:5433，上海时区），库 `jiuan` 的属主 `jiuan_app`（只有它连得上）。外壳从 `/etc/andon-finance/jiuan/env` 的 `POC_DB_HOST` / `POC_DB_PORT` / `POC_DB_NAME` / `POC_DB_USER` 和口令文件 `db_app_password` 连库，九安的配置是 `database.engine = 'postgres'`。外壳自己的两张表 `poc_review_decisions`、`poc_kb_cache` 也在这个库里，启动时建。九安启动时建表、核对表结构，对不上（`PG_MIGRATION_DRIFT`）就不启动。切换前的 MySQL（容器 `jiuan-mysql`）2026-11-06 晚上删了，回不到 MySQL 了；查库、备份和从 `pg_dump` 恢复的做法见[运维](../docs/delivery/operations.md)第 2.6 节。
- **模拟来单**：`https://<站点>/poc/intake`（管理员）。九安下一轮同步（约 1 分钟）把新单拉进单据池，读完原件后自动发起 AI 独立建议。
- **端到端测试**：`DEPLOY_ENV=infra/env/<环境>.env bash app/test/e2e/run.sh`（2026-11-02 从 `app/test/e2e/` 搬来），共 27 条（`web.e2e.mjs` 15 条、`api.e2e.mjs` 12 条）。先重建 `jiuan` 库（保留 Agent 接入的启用记录和 Nexus 连接），只从 `infra/secrets.env` 读两个账号的口令，不读任何调用密钥；再按先后跑两个文件，共用一个开始时间：
  - `web.e2e.mjs`：新前端的页面——旧口令页和新登录页、工作台的数和单据池对得上、单据池打开一张单（抽屉四个页签都有内容）、采纳和改判（工作台跟着变、改判率有值）、我的规则上传和删除、Agent 接入（审批 Agent、知识库 Agent 就绪、单据 / 文本 / 请求信封测试）、知识库（就绪、上传制度、检索）、分析员看不到管理员的页；
  - `api.e2e.mjs`：只测接口的那些（结论和引用的规则编号都在知识库里、检索日志、调用记录、两档结论、没有回写、模拟来单、出网只到 Nexus），加上新抽屉里的模型说明和自定义规则（含一份约 20,000 字的长规则在 180 秒内跑完）；2026-11-06 加了一条：测试台跑在 PostgreSQL 上（容器 `jiuan-pg` 在跑、`jiuan-mysql` 停了或不在、外壳的 `POC_DB_PORT=5433`、重置后新建的库里有迁移建出的表）。
  - 加 `KB_E2E_DOCX=<本机转好的风险判断卡 .docx>`（[`../kb/convert/risk-cards/`](../kb/convert/risk-cards/README.md) 转出来、入库的那一份）时知识库那条在页面上传它（预期「没有变化」skipped、449 条），没给就跳过；知识库页的制度详情、检索结果不截图，制度原文不进仓库。`E2E_FILES=web.e2e.mjs` 只跑一个文件，再加 node 的 `--test-name-pattern` 只跑几条（每次都先重置测试台）。
  - 完整跑一次约 1–3 美元的 Nexus 调用。
  - 2026-11-01：完整运行 26 条，25 通过，失败的那条是知识库 Agent 回复前多一句话，已修（外壳收下引导语）；之后知识库的 4 条、单据池的 6 条单独重跑全部通过。
  - 2026-11-02 的结果：对 m7g 测试环境（`DEPLOY_ENV=infra/env/m7g.env`，经 SSH + EC2 Instance Connect 端点；Nexus 已指向它的 PG）完整运行 26 条全部通过（web 15、jiuan 11，带 `KB_E2E_DOCX`），约 4 分钟。
  - 2026-11-06 换库之后：三轮，第二轮和第三轮（补丁 0018 之后）27 条全过（1 条按设计跳过）；第一轮「自定义规则」那条因为 DGZF-F07-001 的 AI 结论前后不一样没过，详见[变更记录](../CHANGELOG.md)

## 测试

```bash
cd audit-nexus/poc
(cd web && npm ci && npm test && npm run build)                 # 新前端
bash bench/build-jiuan.sh && (cd app && node --test "test/unit/**/*.test.mjs")   # 外壳的单元测试（要先构建九安副本；有一条读 web/dist，没构建就跳过）
(cd infra && node --test "test/**/*.test.mjs")                    # 部署脚本、模板、测试台脚本
DEPLOY_ENV=infra/env/<环境>.env bash app/test/e2e/run.sh       # 端到端，见上面「端到端测试」
DEPLOY_ENV=infra/env/<环境>.env bash infra/remote-jiuan-tests.sh --engine pg --out <结果.json>   # 九安自带的测试，在实例上一次性的测试库里跑（不碰在用的服务和库 jiuan）
node infra/test/compare-jiuan-results.mjs bench/pg-port/after-pg.json <结果.json>               # 换库后过的，这次不过就列出来
```

九安自带的测试改了九安的数据层才要跑（一轮最多 55 分钟）：2026-11-06 换库后在真 PG 上 264 个文件 2475 过、16 不过、135 跳过，换库前（真 MySQL）过的都还过；16 条不过的和换库前一样，是环境原因（`bench/pg-port/`）。

单元测试用本机的假 A2A 网关（`app/test/unit/helpers/fake-a2a.mjs`），不连 Nexus。`infra/deploy.sh` 动 AWS 之前把前三条都跑一遍。

## 目录

| 路径 | 内容 |
|---|---|
| `app/` | 测试台外壳：组合根 `server.mjs`、前门 `front.mjs`、口令登录、假汇联易、出网守卫、「Agent 接入」页和知识库页的后端、新前端用的接口；`lib/`（A2A 客户端、名片规整、operator 命令行、口令登录、HTTP 小工具）；`test/unit/`、`test/e2e/` |
| `web/` | 新前端（React），构建产物 `dist/` 由外壳在 `/` 给出 |
| `bench/` | `build-jiuan.sh`：从九安开发包按清单复制 → 打 `../patches/jiuan-v0.7.10/` → 装锁定的依赖（`pg` 给九安副本；`mysql2` 只给搬迁工具），输出 `../.build/jiuan/`；`--with-tests` 另带九安自带的测试、打 `patches/…/tests/`（只给 `infra/remote-jiuan-tests.sh` 用，不进构件）。`mysql-to-pg.mjs`：一次性的 MySQL → PostgreSQL 搬迁工具（测试在 `test/`）；`pg-port/`：换库前后九安自带测试的结果（`baseline-mysql.json`、`after-pg.json`、`removed-tests.json`） |
| `infra/` | CloudFormation 模板、部署与清理脚本、测试、密钥文件（只在本机），见 [`infra/README.md`](infra/README.md) |
| `a2a-entry/` | 第四轮的 A2A 调用验证（历史，不再部署） |

九安开发包（`audit-nexus/source/九安自助审核平台-测试环境开发包-v0.7.10/`）只读，不改：服务端跑的是 `bench/build-jiuan.sh` 构建的副本，补丁打不上会报错，不会悄悄漏改。
