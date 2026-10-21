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
