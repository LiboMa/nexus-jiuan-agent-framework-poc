---
subtitle: 九安审核平台 × Nexus AI · Finance-Audit-Nexus-PoC v0.1.0
date: 2026-10-19
status: 封板 Finance-Audit-Nexus-PoC v0.1.0（交付包由 make-package.sh 生成）
stamp: 交付
scope: audit-nexus/ 下的代码、文档、测试与证据；不含密钥和九安开发包
audience: 项目负责人、接手的应用开发、运维、Agent 开发
---

# 交付包指南（Delivery Package Guide）

## 1. 一句话

交付包是一个压缩包，加一个校验文件：**Finance-Audit-Nexus-PoC v0.1.0**，九安 × Nexus PoC 的交接内容：全部代码（含测试台）、测试、两个 Skill（nexus-ai-operator、agent-access）、Agent 接入框架的契约、交接文档（Markdown 和 HTML）、图、截图、参考补丁，再加上测试证据 `evidence/`。除了 `evidence/`，包里的内容和交接仓库 <https://github.com/LiboMa/nexus-jiuan-agent-framework-poc-guide> 一致，两边由同一份白名单生成（第 9 节）。设计稿、实现计划、进度看板、历次评估、评审记录不在包里，在开发仓库。密钥和九安开发包也不在包里，另行交接（第 5 节）。拿到之后按第 6 节验收，按第 8 节签收。

![交付包里有什么：docs、poc/app、poc/bench、contract、poc/infra、skills、knowledge-agent、poc/tools、evidence；不在包里的另行交接](../assets/diagrams/package-contents.svg)

## 2. 生成与校验

**生成**（在维护人的电脑上，`audit-nexus/` 目录下）：

```bash
docs/delivery/make-package.sh
```

脚本按顺序做这些事，任何一步失败就停下来，不出包：

1. 跑单元测试（275 个；本机没有 MySQL，其中 11 个会跳过，它们在测试台上用 `poc/infra/bench-test.sh` 跑）和 Skill 与命令行测试（13 个）；
2. `docs/build-html.sh --check`：图和 HTML 都是最新的；
3. 重新生成参考补丁，并在干净的九安副本上 `patch --dry-run --fuzz=0`；
4. 按白名单把文件拷到暂存目录（第 4 节），排除生成物、依赖、杂物和密钥；
5. **脱敏**：`docs/delivery/sanitize.py` 按对照表 `sanitize.conf`（只在开发目录）把 AWS 账号和 EC2 的标识换成 AWS 文档的示例值，再按格式补一遍；还留着对照表里的真实值就停下；
6. **密钥检查**：暂存目录里不能有 `secrets.env`，不能有像 `nxa_` / `nxc_` / `nxp_` / `afp_` 密钥、AWS 访问密钥或私钥的字符串，也不能出现本机 `secrets.env` 里任何一个真实的值（只报文件名，不打印值）；
7. 写 `MANIFEST.txt`（每个文件的 sha256）；
8. 打包成 `dist/<版本>.tar.gz`（版本取自根目录的 `VERSION`，空格换成 `-`：`dist/Finance-Audit-Nexus-PoC-v0.1.0.tar.gz`），并写同名的 `.sha256`。

**校验**（拿到包的人）：

```bash
shasum -a 256 -c Finance-Audit-Nexus-PoC-v0.1.0.tar.gz.sha256        # 包没被改过
tar -xzf Finance-Audit-Nexus-PoC-v0.1.0.tar.gz
cd Finance-Audit-Nexus-PoC-v0.1.0 && shasum -a 256 -c MANIFEST.txt --quiet   # 每个文件都对得上
open docs/delivery/README.html                                          # 从文档索引开始
```

## 3. 按角色从哪读起

![四种角色的阅读路线：项目负责人、应用开发、运维 / 值班、Agent 开发；每条路线最后一步是动手验证](../assets/diagrams/package-roles.svg)

| 角色 | 先读 | 然后动手 |
|---|---|---|
| 前端用户（审核员、复核人） | [快速上手](quick-guide.md) | 照着做一遍：连接 Nexus、启用 Agent、调用测试、在审批流里用 |
| 九安的前后端开发 | [开发者快速对接指南](developer-guide.md) → [Agent 接口](agent-interface.md) → [Agent 接入框架](agent-framework.md)第 6 节 | 拿一个业务需求，按指南的提示词 P1–P5 在 Claude Code 里走一遍 |
| 项目负责人 | 本文 → [交接文档](handover.md)第 1、6 节（含 6.1 上生产前必须改的）→ [客户部署路线](customer-rollout.md) | 按第 6 节验收，第 8 节签收 |
| 应用开发 | [交接文档](handover.md) → [Skills 配置指南](skills-guide.md) → [架构、模块与工作流](../architecture.md) → [Agent 接入框架](agent-framework.md) → [Agent 接口](agent-interface.md) → [单据初审](first-review-contract.md) → [并入九安](integration.md) → [部署与迭代规范](deploy-iteration.md) | 跑单元测试；装好两个 Skill；在页面上走一遍连接、启用、调用测试 |
| 运维 / 值班 | [交接文档](handover.md)第 2、5 节 → [运维与后续迭代](operations.md) → [部署与迭代规范](deploy-iteration.md)第 6 节 | 练一次 `deploy.sh --code-only` 和一次回滚 |
| Agent 开发 | [Skills 配置指南](skills-guide.md) → [开发者工作流](../agent-developer-workflow.md) → [知识 Agent 说明](../../knowledge-agent/README.md) → [运维](operations.md)第 2.1 节 | 改一版提示词，用调用测试面板验证 |

## 4. 包里有什么

| 目录 | 内容 | 看哪份文档 |
|---|---|---|
| `docs/delivery/` | 交付文档（本文、快速上手、Skills 配置指南、客户部署路线、交接、并入九安、部署与迭代、运维、Agent 接入框架、Agent 接口、单据初审契约、调用链、客户规则与 AI 初审），每份有 `.md` 和 `.html`；一页总览 `agent-framework-overview.html`（手写）；`patches/` 参考补丁与生成脚本；`make-package.sh`（打包、导出交接仓库）与 `sanitize.py`（脱敏） | [交付文档索引](README.md) |
| `docs/assets/` | `diagrams/`：图（`.mmd` 是源，`.svg` 由 `build-html.sh` 生成；`arch-overview.svg` 是手工画的）；`screens/`：线上截图 | 第 7 节 |
| `docs/`（其余） | 架构文档、开发者工作流、`build-html.sh` 与 `html-kit/` | [架构](../architecture.md) |
| `poc/app/` | PoC 服务端、测试台组合根（`bench/`、`jiuan-mysql.mjs`）、前端扩展（`public-src/`）、示例附件、单元测试与端到端测试、截图脚本 | [架构](../architecture.md)第 8、11 节 |
| `poc/bench/` | `build-jiuan.sh`（九安副本 + 补丁 + 依赖）与锁定的依赖清单（`mysql2` 3.14.3；不带 `node_modules`，构建时 `npm ci --ignore-scripts`） | [交接文档](handover.md)第 2.1 节 |
| `poc/infra/` | CloudFormation 模板、`deploy.sh`、`destroy.sh`、`backup.sh`、`upgrade-instance.sh`、`bench-test.sh`、`bench/`（实例上的 MySQL 脚本与 systemd 片段）、部署说明（**不含 `secrets.env`**） | [部署与迭代规范](deploy-iteration.md)、[运维](operations.md)第 2.7 节 |
| `poc/tools/`、`poc/README.md` | 示例附件生成脚本；PoC 使用说明 | [PoC 说明](../../poc/README.md) |
| `skills/nexus-ai-operator/` | Nexus 一侧的 Skill（1.1.0，不带任何密钥）：在 Nexus 上建 Agent、发布 | [Skills 配置指南](skills-guide.md)第 3 节 |
| `skills/agent-access/` | 应用自己的 Skill：`SKILL.md`、`README.md`、`scripts/agent_access.py`、`references/`、测试 | [Skills 配置指南](skills-guide.md) |
| `README.md`、`VERSION`、`CHANGELOG.md`（根目录） | 包的入口说明、版本号、这个版本改了什么 | — |
| `contract/` | Agent 接入框架的契约：`envelope/v1/`（信封、名片要求、错误码、例子）、`tasks/`（任务目录、`first_review`、`describe`、新任务模板）、`workflows/`（审批流接口） | [Agent 接口](agent-interface.md)、[Agent 接入框架](agent-framework.md) |
| `knowledge-agent/` | 知识 Agent 的提示词（`prompt.yaml` v2，`prompt-v1.yaml`）与说明 | [知识 Agent 说明](../../knowledge-agent/README.md) |
| `evidence/` | 各轮的测试证据与截图；`evidence/e2e/last-run.jsonl` 是最近一次端到端测试的结果；`evidence/bench/` 是测试台升级的记录与日志 | — |
| `MANIFEST.txt`、`PACKAGE-INFO.txt` | 每个文件的 sha256；生成时间与检查结果 | 第 2 节 |

**特意不放进包的**：`node_modules/`、生成的 `poc/app/public/` 和 `.build/`（九安副本，`deploy.sh` 每次重建）、`dist/`、`archive/`（旧证据、旧包）、`__pycache__/`、`.DS_Store`；设计稿、实现计划、进度看板、历次评估、评审记录（在开发仓库）；和这个 PoC 无关或已过时的 `get_passwd.sh`、`poc/a2a-entry/`（第四轮的旧验证，不再部署）、`poc/infra/design-jiuan-nexus-integrate.md`（原始笔记）。这些都还留在维护人的电脑上。

## 5. 不在包里、另行交接的

| 东西 | 为什么不在包里 | 怎么交接 |
|---|---|---|
| `poc/infra/secrets.env`（包里有样例 `secrets.env.example`，没有真实的值） | 有两条口令、`REGISTRY_KEY` 和测试台的三项密钥（`BENCH_*`）。Agent 的调用密钥不在这里：各账号在前端启用，加密存在实例上。**`BENCH_DATA_KEY` 丢了，测试台的库就打不开** | **当面交接**（不经聊天工具、邮件、网盘）；接手后放回 `poc/infra/`，权限 0600 |
| 九安开发包 `source/审核平台-测试环境开发包-v0.5.3/` | 第三方代码，按版本号引用 | 从九安按版本号取，解压到包根目录下的同名路径（或用 `JIUAN_CODE_DIR` 指向它的 `code/`）；单元测试、`build-jiuan.sh`、`deploy.sh`、参考补丁都要用到它 |
| `~/.nexus/`（operator 凭证） | 个人凭证 | 不交接；接手的人用自己的 Nexus 账号和 API 密钥 |
| 各人的 Nexus API 密钥 | 个人凭证；每把只能给一个地方用 | 接手的人在自己的 Nexus 网页「个人设置 › API 密钥」生成，交给编码工具里的 nexus-ai-operator（[Skills 配置指南](skills-guide.md)第 3 节）；另生成一把，在应用「Nexus Agent」页「我的 Nexus 连接」里连接（或 agent-access `nexus connect`）。包里的 `skills/nexus-ai-operator/` 不带任何密钥 |
| 实例上的各账号数据（`/var/lib/andon-finance/users/`） | 在线上，里面有加密的调用密钥和 CLI 凭证 | 留在实例上；实例替换前的备份方法见[运维](operations.md)第 2.6 节 |
| 测试台的 MySQL 数据（`/var/lib/jiuan-mysql`） | 在线上；虚构单据，端到端测试每次都会重建 | 留在实例上；`backup.sh` 的根卷快照里有一份 |
| AWS 与 Nexus 的访问权限 | 账号权限 | 由项目负责人另行授予（[交接文档](handover.md)第 5 节） |

## 6. 验收清单

| # | 验收项 | 怎么做 | 通过的样子 |
|---|---|---|---|
| 1 | 包完整 | 第 2 节的两条 `shasum` | 两条都 OK |
| 2 | 文档能打开 | 浏览器打开 `docs/delivery/README.html`，点进每一份 | 每份都有图、表、目录；图能点开看原尺寸 |
| 3 | 单元测试 | 先放好九安开发包（第 5 节），再 `cd poc/app && node --test "test/unit/**/*.test.mjs"` | 275 个：264 通过、11 个要 MySQL 的跳过、0 失败（没有九安开发包时有一部分会失败，因为它们要导入九安的代码） |
| 3a | 要 MySQL 的单元测试 | `poc/infra/bench-test.sh`（在测试台上跑，只用 `jiuan_bench_test` 库） | 11 个全部通过 |
| 4 | Skill 与命令行测试 | `python3 -m unittest discover -s skills/agent-access/tests` | 13 个全部通过 |
| 4a | 两个 Skill 能装上 | 按 [Skills 配置指南](skills-guide.md)第 3、4 节装进自己的编码工具，各用一把 API 密钥连接 | `nexus.py whoami` 是自己；`agent_access.py status` 显示 Nexus 已连接 |
| 5 | 文档是最新的 | `docs/build-html.sh --check`（需要 pandoc、mmdc、Chrome） | 「图和 HTML 都是最新的」 |
| 6 | 参考补丁 | `docs/delivery/patches/make-reference-patch.sh`（需要九安开发包） | 「--dry-run --fuzz=0 通过」 |
| 7 | 线上可用 | `curl -fsS https://andon-finance.tinyboat.blog/api/health` | HTTP 200；`database` 是 `ok`，`source` 是 `poc-bench` |
| 8 | 页面走一遍 | 审核员登录 → Agent 页 → 调用测试（知识 Agent，`answer`） | 返回带引用的回答 |
| 9 | 完整端到端测试 | `poc/app/test/e2e/run.sh`（第一次会自动 `npm install` Playwright；开始前会重建测试台的库，约 0.36 美元；需要 `secrets.env` 里的两个口令；调用密钥用审核员在页面上启用的） | 0 失败；跳过的只有按设计跳过的那一个（不停用本人启用的知识 Agent）；截图交项目负责人 |
| 10 | 未完成事项知情 | 读[交接文档](handover.md)第 6 节 | 每一条都有负责人和时间 |


## 7. 封板时的状态（v0.1.0，2026-10-21）

**已完成**
- **开发者快速对接指南**（v0.1.0 新增）：给九安的前后端开发，一个业务需求从写契约、在 Nexus 上开发 Agent，做到后端调用、前端可用，每一步配可以直接贴进 Claude Code 的提示词。提示词 P1、P3、P3b、P4、P5 在九安开发包 v0.5.3 的副本上按顺序演习过，发现的问题都改进了提示词；P2 和签发调用密钥要在线上写入、花钱、本人操作，没有演习。
- 契约补了单据初审的检查代码 `checks.mjs`；envelope 例子的 contextId 按规则重算；接口文档补了 contextId、断线轮询、时限、错误对象这些细节（[变更记录](../../CHANGELOG.md)）。
- PoC 第一期上线：审批流、「我的 Nexus」（连接、启用、换密钥、停用）、调用测试（带附件）、命令行 `agent_access.py`；审批流的调用密钥从系统里读（页面上的启用记录）。
- **测试台**（2026-10-19）：实例换到 t3.large，本机 MySQL 8.0；服务端跑九安开发包的副本和九安自己的运行时（MySQL 存储、平台存储、连接器、调用中间件、流水线运行器），汇联易和钉钉不接。升级前做了根卷快照和账号目录打包；各账号的连接与启用都没变。
- **Agent 接入框架设计稿 v2**：通用信封 `jiuan.agent/v1`、任务目录、第一个任务单据初审 `first_review@1`；契约文件在 `contract/`，已校验。
- 测试：单元测试 280 个（本机 269 通过、11 个要 MySQL 的跳过；这 11 个 2026-10-19 在测试台上 11/11，之后没改）；Skill 与命令行测试 13 个；2026-10-21 完整端到端测试 15 个全部通过（0 失败、0 跳过；测试只用审核员本人在前端的连接和启用）。
- 测试台的最终评审：3 个 Important 已修好（实例上的测试台密钥只认原值；健康检查真的去查库；回到内存存储不依赖 MySQL），每个都先有失败的测试；2026-10-19 已部署。
- 两个 Skill 都在包里：应用自己的 agent-access 打包成可以安装的形式，nexus-ai-operator 固定为 1.1.0；[Skills 配置指南](skills-guide.md)写了怎么导入、怎么连到自己的 Nexus。
- 交接仓库 <https://github.com/LiboMa/nexus-jiuan-agent-framework-poc-guide>：只有交接内容；封板标签 `v0.1`（2026-10-19）和 `v0.1.0`（本版）。
- 旧证据、旧包、建 Agent 时的调用记录移进 `archive/`（不进包）。
- 交付文档 14 份加索引、一页总览、架构文档，Markdown 和 HTML 两个版本；由源码生成的图、1 张手工图（系统总览）、线上截图和开发者指南演习的截图。
- 参考补丁可重复生成、可在干净副本上验证。

**还没完成**（详见[交接文档](handover.md)第 6 节）
1. 构件和健康检查还不带提交号（评审 C1 的后一半；代码已进交接仓库（标签 `v0.1.0`）和开发仓库（标签 `v0.1`）；源站还是明文 HTTP（评审 C2）。
2. 部署脚本还剩一个缺口（评审 I2）；值班看不到 Nexus 调用的问题（评审 I6）。
3. 初审 MVP：设计稿待批准，九安补丁 0001–0006 是下一份计划；审批记录还在内存里。
4. 上生产前的密钥事项：审核员连接 Nexus 的档位改只读（I4）、清理不再用的凭证。开发测试阶段不用动。
5. 上生产前必须改的，见[交接文档](handover.md)第 6.1 节；测试台评审的 12 个 Minor 见同一份文档第 6 节第 11 条。

## 8. 签收

| 项 | 交出 | 接收 | 日期 | 备注 |
|---|---|---|---|---|
| 交付包（文件名与 sha256） | | | | |
| 测试台（MySQL、三项测试台密钥、升级前快照） | | | | |
| `secrets.env`（当面） | | | | |
| AWS 与 Nexus 权限 | | | | |
| 验收清单第 1–8 项（含 3a、4a） | | | | |
| 验收清单第 9 项（完整端到端测试） | | | | |
| 未完成事项（第 7 节）的负责人与时间 | | | | |

## 9. 以后怎么更新这个包和交接仓库

1. 改代码按[部署与迭代规范](deploy-iteration.md)走完；
2. 改文档改 `.md`、改图改 `assets/diagrams/*.mmd`，再运行 `docs/build-html.sh`；截图过期了运行 `poc/app/test/e2e/capture-screens.mjs`（只看不改，不花钱）；
3. 改根目录的 `VERSION`（比如 `Finance-Audit-Nexus-PoC v0.2`），在 `CHANGELOG.md` 加一节；
4. 同步交接仓库：`docs/delivery/make-package.sh --export <交接仓库的工作副本>`。跑完全部检查和密钥检查后，把白名单里的文件同步过去（`.git` 保留，白名单外的旧文件删掉），再在那边提交、打标签、推送；
5. 出新包：`docs/delivery/make-package.sh`，文件名就是版本；旧包和它的 `.sha256` 一起移进 `archive/dist/`。

白名单写在 `make-package.sh` 里，交付包和交接仓库共用：要加一类交接内容，就加一行 `copy`；设计、过程类的文件放进 `NOT_HANDOVER`。
