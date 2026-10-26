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
- **组成**：九安 v0.7.10 开发包的副本（`bench/build-jiuan07.sh`，按清单复制，再打 `../patches/jiuan-v0.7.10/` 下的补丁，`source/` 不动）+ 外壳 `app07/`（口令登录、进程内的假汇联易、出网只放行 Nexus）。单据存在本机 MySQL 的 `jiuan07` 库。
- **后台配置 › Agent 接入**（补丁 0001–0003，后端在 `app07/`）：
  - 连一次 Nexus：贴你自己的 Nexus API 密钥。页面列出你在 Nexus 上开了 A2A 的发布，和已启用的合在一张表里，每个 Agent 一张卡；
  - 启用：点卡上的「启用」，只贴这个发布的调用密钥。启用后 Agent「就绪」，供前端工作流调用；名片说明里有没有「契约 / 任务」两行都不挡启用。列表里没有的发布用「手动添加」（A2A 地址 + 调用密钥）；
  - 审批流只调「审批 Agent」：在一个就绪的卡上点「设为审批 Agent」（同一时间只有一个，替换前先确认），卡片上方一行写着审批流现在调谁。现在是「九安审核AI（PoC）」（补丁 0003 上线时按它名片声明的 review_advice@1 迁移过来的）；
  - 就绪的卡上有「测试」，三种测法：文本（一段话原样发过去看回复）、请求信封（按契约预填 jiuan.agent/v1 示例请求，回答按契约判合格 / 不合格，原始回答也能看）、单据（选一张对公付款单，照自动初审组装请求）。测试只记进调用记录，不改单据的结论；每分钟最多 5 次；
  - 另有「停用」（先确认）、「复核」，密钥失效的有「换钥匙」；
  - 下方是调用记录：审批流的每一轮（自动初审、单据页发起）和每次测试一行，「查看反馈」看 Agent 返回了什么。操作记录折叠在最下面。
- **规则库 › 制度知识库**（补丁 0004，后端在 `app07/kb-routes.mjs`、`app07/kb-runner.mjs`，只给管理员）：上传审批矩阵格式的制度 .docx → 解析报告和入库预览（新增 · 重算向量 · 只更新说明 · 不变 · 删除；要删的琥珀色列出，规则编号和库里另一份文档冲突时红字列出、不能入库）→ 确认入库（向量在知识库的 PG 里由 `kb_embed()` 生成）；上传历史；按问题检索（`kb_search`，和审核 Agent 经 Nexus 连接器用的同一个；关键词用空格隔开更准）；检索日志（审核 Agent、页面、部署核对都查了什么）。同一份制度用同一个标签（现在是 `finance-approval-v4`）。知识库本身（PG 容器、连接器、Agent 提示词）用 `infra/kb.sh` 部署和核对，见 [`../kb/README.md`](../kb/README.md) 与 [`../kb/GUIDE.md`](../kb/GUIDE.md) 7.5。
- **模拟来单**：https://jiuan-v0710.tinyboat.blog/poc/intake（管理员）。九安下一轮同步（约 1 分钟）把新单拉进单据池，读完原件后自动发起 AI 独立建议。
- **端到端测试**：`bash app/test/e2e/run07.sh`。先重建 `jiuan07` 库（保留 Agent 接入的启用记录和 Nexus 连接），只从 `infra/secrets.env` 读两个账号的口令，不读任何调用密钥。加 `KB_E2E_DOCX=<本机的制度 .docx>` 时多一条制度知识库用例（上传、预览不删不冲突、入库、检索命中、检索日志里有审核 Agent 的调用；这一页不截图，制度原文不进仓库）；没给就跳过。

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
