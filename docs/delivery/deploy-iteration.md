---
subtitle: 九安审核平台 × Nexus AI · Finance-Audit-Nexus-PoC v0.1.0
date: 2026-10-19
status: 交付版 v2（加了测试台：九安副本、本机 MySQL）
scope: poc/app、poc/bench、poc/infra、skills/agent-access、knowledge-agent、contract、docs
audience: 应用开发、Agent 开发、运维
---

# 部署与迭代规范

## 1. 六条原则

1. **只有一条发布路径**：`poc/infra/deploy.sh`。不手工改实例上的文件，不手工上传构件。
2. **先测再发，确认再推**：单元测试 → 部署 → 端到端测试 → 项目负责人确认 → 推送、打标签。开发完、测完不等于可以提交。
3. **密钥不进构件、不进仓库、不进文档、不进对话**：只在本机的 `poc/infra/secrets.env`（0600），由 `deploy.sh` 经加密的构件桶装到实例。现在整个文件都会传上去，包括只给测试用的密钥；改成按白名单生成服务端的文件之前，不用的测试密钥别留在文件里（评审 I3，[交接文档](handover.md)第 6.1 节）。
4. **九安开发包只读**：前端改动只靠 `scripts/build-public.mjs` 的锚点补丁生成；服务端只经九安自己的扩展点接入（见[并入九安](integration.md)）。
5. **接口只增不改**：`agent-access-v1` 的接口、错误码、命令行退出码，只能加，不能改含义；要改就出 v2，v1 并存一个版本周期。
6. **Markdown 是文档的唯一来源**：HTML 由 `docs/build-html.sh` 生成；推送前跑 `docs/build-html.sh --check`。

**2026-11-02 起（分支 `feat/pg-kb-steward` 已合进 main）**：本仓库的 `kb/` 和栈模板都是 Cohere Embed v4（连同 `KbBedrockPolicy`），从本仓库跑知识库的 db 阶段、整栈部署都不会再把 Titan 装回去。跑 db 阶段前确认 `kb/deploy.env` 的 `EMBED_MODEL_ID` 是 Cohere v4（缺省就是），否则防混用检查（`kb/GUIDE.md` 7.6）会停下。测试台的日常发布照旧用 `deploy.sh --code-only`。

## 2. 代码托管与版本

2026-10-19 起有两个私有仓库。交接仓库的封板标签是 `v0.1`（2026-10-19）和 `v0.1.0`（2026-10-21）；开发仓库停在 `v0.1`：

- **交接仓库** <https://github.com/LiboMa/nexus-jiuan-agent-framework-poc-guide>：只有交接内容，给客户用。不要直接在里面改，改开发目录，再用 `docs/delivery/make-package.sh --export <交接仓库的工作副本>` 同步过去（白名单在脚本里，和交付包用同一份），提交、推送。
- **开发仓库** <https://github.com/LiboMa/nexus-jiuan-agent-framework-poc>：完整的开发目录，另外还有设计稿、实现计划、进度看板、历次评估和评审记录。

交接仓库里哪些有、哪些没有：

| 在交接仓库里 | 不在交接仓库里 |
|---|---|
| `poc/app/`（除生成物）、`poc/bench/`（除 `node_modules/`）、`poc/infra/*.yaml`、`poc/infra/*.sh`、`poc/infra/bench/`、`poc/infra/README.md` | `poc/infra/secrets.env` |
| `skills/`、`knowledge-agent/`、`contract/`、`docs/`（含生成的 HTML） | `poc/app/public/`（`build-public.mjs` 生成）、`.build/`（九安副本，`build-jiuan.sh` 生成）、`dist/`（交付包） |
| `poc/tools/`、`patches/`（打进九安副本的补丁） | `source/`（九安开发包，另行存放、按版本号引用） |
| | `evidence/`（测试证据，只随交付包走） |
| `README.md`、`VERSION`、`CHANGELOG.md` | 设计稿、实现计划、进度看板、历次评估、评审记录（在开发仓库）；`archive/`（旧证据、旧包，只在本机） |
| | `node_modules/`、`__pycache__/`、`.DS_Store` |

- **分支**：`main` 受保护，只经合并请求进；功能分支 `feat/…`、修复分支 `fix/…`。
- **标签**：每次线上发布打一个标签 `poc-YYYYMMDD-N`，合并请求里附上端到端测试结果。
- **构件与版本对应**：`deploy.sh` 现在用 UTC 时间命名归档包（`releases/archive/20261017T094000Z.tgz`）。接入 Git 后，把提交号也写进包名和健康检查的返回里，线上跑的是哪个版本一查就知道（评审 C1，[交接文档](handover.md)第 6.1 节）。
- **变更记录**：仓库根目录放 `CHANGELOG.md`，每次发布一节：改了什么、跑了哪些测试、谁确认的。

## 3. 环境

| 环境 | 用途 | 现状 |
|---|---|---|
| 本机 | 开发、单元测试（假 A2A 网关，不连 Nexus）、命令行测试 | 可用 |
| 线上 PoC（栈 `andon-finance-poc`） | 演示、端到端测试；2026-10-19 起是测试台（t3.large，本机 MySQL 8.0，九安的真实运行时） | 可用；正式域名还在这里 |
| m7g 测试环境（栈 `andon-finance-m7g`，2026-11-02 起） | 一台 m7g.xlarge（arm64）装前端、MySQL、知识库的 PG，经 SSH 管理（`poc/infra/README.md`「经 SSH 管理」）；数据从线上 PoC 搬来（`migrate-data.sh`） | 临时域名 `andon-finance-m7g` / `jiuan-v0710-m7g`（.tinyboat.blog）；域名迁移还没定 |
| 预发（建议） | 并入九安之前，用同一模板另建一个栈（不同栈名和域名）先验证 | 未建 |

**部署分三块**，各有各的工具，以后各有各的人：

| 块 | 内容 | 工具 | 次序 |
|---|---|---|---|
| PG 与知识库后端 | PG + pgvector 容器、库内检索 `kb_search`、规则入库；PG 的地址和密码登记进 Nexus（数据连接器、数据库凭证密钥） | `kb/deploy.sh`（测试台上由 `poc/infra/kb.sh` 驱动）；PG 主机经 SSM 或部署人自己的 SSH 密钥（kb/GUIDE.md 第 4 节） | 先部署 |
| 前端 | 测试台外壳、两套九安站点、新前端 `poc/web07`、九安的 MySQL | `poc/infra/deploy.sh`；测试阶段和 PG 放在同一台机器上，以后由专人部署、可以分批 | PG 之后 |
| Nexus 上的 Agent 与发布 | 审核 Agent、PG 知识库 Agent 的工具、提示词、发布 | `audit-agent/`、`knowledgebase-writer-agent-pg/`（客户部署件在 `customer-deploy/`）、`skills/nexus-ai-operator` | 和 PG 一起或之后；换 PG 主机不用动它们 |

线上的测试台是一套共用的环境，所以：端到端测试会**重置测试台**（`bench-reset.sh` 删掉并重建九安的库，单据回到 8 张种子；审批记录、登录状态、运行记录清空；各账号的连接与启用在磁盘上，不受影响），跑之前通知正在用的人。

## 4. 每类变更怎么做

| 变更 | 改哪里 | 必跑的测试 | 怎么发布 | 怎么回滚 | 谁确认 |
|---|---|---|---|---|---|
| 应用代码（服务端、前端扩展） | `poc/app/` | 单元测试；相关的端到端测试 | `deploy.sh --code-only` | 第 6.1 节 | 项目负责人 |
| 前端锚点（九安页面上的插入点） | `scripts/build-public.mjs` | 单元测试（含锚点检查）；`poc.e2e.mjs` 和 `attachments.e2e.mjs` 的界面部分 | `deploy.sh --code-only` | 第 6.1 节 | 项目负责人 |
| agent-access Skill 与命令行 | `skills/agent-access/` | Python 测试 13 个；`agent-access-cli.test.mjs`；`access.e2e.mjs` | 不随服务部署；告诉用的人更新 | 用上一个版本的文件 | 应用开发 |
| Agent 提示词、能力清单 | `knowledge-agent/prompt.yaml`，经 Operator 写到 Nexus | 先在 Nexus 上试用；`attachments.e2e.mjs` 的知识 Agent 部分；版本号 `knowledge-agent-YYYY-MM-DD.N` 要加一 | Operator 更新 Agent（发布跟随最新版本，立即生效） | 用上一版的提示词（如 `prompt-v1.yaml`）再更新一次 | Agent 开发 + 应用开发 |
| 栈参数（审批用哪个发布、Nexus 地址、端口） | `aws cloudformation deploy --parameter-overrides …` | 健康检查；`poc.e2e.mjs` | 改完参数再 `deploy.sh --code-only`（它会按参数重写实例的 `/etc/andon-finance/env`） | 参数改回去，再部署一次 | 运维 + 项目负责人 |
| 基础设施模板 | `poc/infra/andon-finance-poc.yaml` | `infra.test.mjs`；`validate-template`；全部端到端测试 | `deploy.sh`（不带 `--code-only`） | CloudFormation 失败会自动回滚；成功但有问题的，用仓库里上一版模板再部署 | 运维 + 项目负责人 |
| 启动配置（口令、`REGISTRY_KEY`、测试台密钥） | `poc/infra/secrets.env` | 健康检查；端到端测试 | `deploy.sh --code-only` | 换回旧值（测试台的三项只补不换） | 运维 |
| Agent 调用密钥、Nexus 连接 | 不在文件里：用户在前端「Nexus Agent」页加载 | 页面上当场验证（`tasks/get`） | 「我的 Agent」里启用、换密钥、停用，不部署、不重启 | 换回上一把密钥 | 用户本人 |
| 测试台（MySQL、九安副本、补丁） | `poc/bench/`（副本构建、锁定的依赖）、`poc/infra/bench/`、`patches/jiuan-v0.5.3/`（补丁，按文件名顺序打进副本） | 单元测试；`poc/infra/bench-test.sh`（在实例上跑要 MySQL 的测试）；全部端到端测试 | `deploy.sh --code-only`（构件里的九安是 `.build/jiuan`，带 node_modules）；三项测试台密钥只补不换，实例上已有的只认原值（不一样就在重启前失败，服务照旧跑） | 第 6.1 节；`POC_STORE=memory deploy.sh --code-only` 回到内存存储 | 应用开发 + 项目负责人 |
| 九安开发包升级 | `source/` 换成新版本，再跑 `poc/bench/build-jiuan.sh`（补丁要能打上） | 全部单元测试；全部端到端测试 | `deploy.sh --code-only` | 指回旧版本再部署 | 应用开发 + 项目负责人 |
| Nexus 平台升级 | Nexus 那边 | 全部端到端测试；必要时更新 `verify.mjs` 里记录的实测行为 | — | — | 应用开发 |
| 九安 v0.7.10 测试台（外壳、新前端、补丁） | `poc/app07/`、`poc/web07/`、`patches/jiuan-v0.7.10/`（`poc/bench/build-jiuan07.sh` 打进副本） | 新前端 `npm test`、外壳的单元测试（`deploy.sh` 都会先跑）；`run07.sh` 里相关的几条（第 7 节） | `deploy.sh --code-only`：动 AWS 之前先在 `poc/web07` 里 `npm ci`、测试、构建，`dist/` 随构件发出；外壳启动时读一次 `dist/` | 第 6.1 节（构件里带着那一版的 `dist/`） | 应用开发 + 项目负责人 |
| 审核 Agent 提示词（「九安审核AI」） | `audit-agent/prompt.yaml`，`audit-agent/apply.py` 写到 Nexus 并重存发布的动态配置 | `audit-agent/tests` 的单元测试；`apply.py --dry-run`；`run07.sh`（自动出建议的几条） | 第 6.3 节 | 第 6.3 节 | Agent 开发 + 项目负责人 |
| 换机器（另建一个栈，搬数据） | 新环境的配置 `poc/infra/env/<环境名>.env`；`poc/infra/migrate-data.sh` | `infra.test.mjs`；新栈 `deploy.sh` 的健康检查；`migrate-data.sh --dry-run`，实搬后它自己逐表核对；`kb.sh verify`；`run07.sh` | `deploy.sh`（新栈）→ `kb.sh db` → `migrate-data.sh` → `kb.sh connector`（把 Nexus 指到新 PG，先 `--dry-run`）→ 端到端 → 域名迁移前 `migrate-data.sh --skip-pg` 再同步一次 | 旧栈一直不动：`kb.sh connector` 用旧环境的配置再跑一次，Nexus 就指回旧 PG；域名没迁就不影响用户 | 运维 + 项目负责人 |
| 文档 | `docs/**/*.md` | `docs/build-html.sh --check` | 随代码推送 | 随代码回退 | 改的人 |

## 5. 发布清单

每次发布按顺序做完，任何一步失败就停下来。

![发布流水线：本机检查 → 评审 → deploy.sh → 三道关（SSM 是 Success、健康检查 200、端到端测试全部通过）→ 项目负责人确认 → 推送、打标签；任何一道没过就回滚](../assets/diagrams/deploy-pipeline.svg)

1. **本机检查**
   - `cd poc/app && node --test "test/unit/**/*.test.mjs"`：0 失败（现在 275 个，本机有 11 个要 MySQL 的跳过）；
   - 改了测试台（`poc/app/bench/`、`server.mjs`、`poc/bench/`、`poc/infra/bench/`）：`poc/infra/bench-test.sh` 在测试台上把那 11 个跑一遍，全部通过；
   - `python3 -m unittest discover -s ../../skills/agent-access/tests`：全部通过（13 个）；
   - `docs/build-html.sh --check`：HTML 都是最新的。
2. **评审**：合并请求有人看过；涉及接口、密钥、权限的改动，按[交接文档](handover.md)第 6.1 节逐条核对。
3. **部署**：`poc/infra/deploy.sh --code-only`（改了模板才去掉 `--code-only`）。脚本会先跑单元测试、构建九安副本（`poc/bench/build-jiuan.sh`、`build-jiuan07.sh`）、生成前端副本、构建九安 v0.7.10 的新前端（`poc/web07`）并跑外壳的单元测试、补上缺的 `REGISTRY_KEY` 和测试台密钥，再打包上传、让实例拉取、配置测试台（`bench-configure.sh`）、重启并做健康检查。
   - SSM 的结果不是 `Success`，脚本就报失败（2026-10-19 起，评审 I1）；健康检查还分不出新旧版本，要靠第 6.1 节回滚。
4. **端到端测试**：按改动选文件（第 7 节），用 `poc/app/test/e2e/run.sh <文件…>` 运行。
5. **确认**：把端到端测试结果（`evidence/e2e/last-run.jsonl`）和截图（`evidence/round5/e2e/`、`evidence/round6/e2e/`）交项目负责人。
6. **推送与标签**：确认之后再推送，打 `poc-YYYYMMDD-N` 标签，写 `CHANGELOG.md`；交接内容有变化时，用 `make-package.sh --export` 同步到交接仓库。

## 6. 回滚

![回滚怎么选：代码、密钥、栈参数、模板、提示词各有各的回法；不要只换实例上的 current 或 previous](../assets/diagrams/rollback-decision.svg)

### 6.1 应用代码回滚（最常用）

实例每次启动服务前都会从构件桶拉 `releases/current.tgz`；所以回滚就是把旧的归档包放回 `current.tgz`，再重启。归档包只保留 14 天（桶的生命周期规则）。

```bash
REGION=us-east-1; STACK=andon-finance-poc
out() { aws cloudformation describe-stacks --region $REGION --stack-name $STACK --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
BUCKET=$(out ArtifactBucketName); INSTANCE=$(out InstanceId); SITE=$(out SiteUrl)
aws s3 ls s3://$BUCKET/releases/archive/ --region $REGION                    # 找到要回到的那一版
aws s3 cp s3://$BUCKET/releases/archive/<时间>.tgz s3://$BUCKET/releases/current.tgz --region $REGION
aws ssm send-command --region $REGION --instance-ids $INSTANCE --document-name AWS-RunShellScript \
  --parameters 'commands=["systemctl restart andon-finance-poc.service","sleep 5","systemctl is-active andon-finance-poc.service"]'
curl -fsS $SITE/api/health
```

注意：
- 只替换实例上的 `/opt/andon-finance/current` 没有用，下次重启又会拉回 `current.tgz`；实例上的 `previous` 也不可靠，服务崩溃循环时会被坏版本覆盖（评审 I2）；
- 回滚不动 `secrets.env`；如果问题出在密钥，按第 4 节「密钥」那一行处理；
- 回滚后在 `CHANGELOG.md` 记一笔，下一次正常发布会覆盖 `current.tgz`。
- 九安 v0.7.10 测试台在同一个构件里（外壳 `app07/`、副本 `jiuan07/`、新前端 `web07/dist/`）：PoC 服务重启拉完包以后，再 `systemctl restart andon-jiuan07.service`（外壳启动时才读一次新前端的 `dist/`），看 `https://jiuan-v0710.tinyboat.blog/poc/healthz`；
- 回滚代码不动 Nexus 上的东西：审核 Agent 的提示词按第 6.3 节回退，知识库里的规则在知识库 Agent 那边（下线的制度可以恢复）。

### 6.2 其他回滚

- **栈参数**：改回原值，再 `deploy.sh --code-only`。
- **模板**：CloudFormation 更新失败会自动回滚；更新成功但有问题的，用上一版模板跑 `deploy.sh`。
- **Agent 提示词**：用上一版提示词经 Operator 再更新一次；发布跟随最新版本，所以立即生效。
- **各账号的数据**（`/var/lib/andon-finance/users/`）：没有备份；回滚代码不会动它。

### 6.3 审核 Agent 提示词：怎么下发、怎么留底、怎么回退

「九安审核AI」的提示词只经 `audit-agent/apply.py` 改（细节见 [`audit-agent/README.md`](../../audit-agent/README.md)「怎么改」）：

1. **先存底稿**：把线上现在的提示词存下来（网页上改过的话尤其要存）。
2. **改 `prompt.yaml`**，`agentVersion` 的日期和序号加一；更新 `audit-agent/tests/fixtures/` 里的期望文件，跑 `python3 -B -m unittest discover -s audit-agent/tests`。
3. **先演练再下发**：`python3 audit-agent/apply.py --env poc/infra/env/<环境>.env --base <底稿> --dry-run` 看线上到新版的比对（提示词和动态配置里的工具），确认后去掉 `--dry-run`。`apply.py` 每次都重存发布的动态配置：只改提示词不重存，A2A 调用用的还是旧快照。
4. **验证**：在测试台上发起一轮 AI 独立建议，或跑 `run07.sh`；量时长要换一张单（同一张单重发会落进 Nexus 上同一段对话，回得很快）。
5. **留底**：每次改线上都在 `audit-agent/prompt-history/<日期>/` 留一个目录，和已有的 `2026-10-31/`、`2026-11-01/`、`2026-11-01b/` 一样：`prompt-before-<旧版本>.yaml`（回退用的底稿）、`prompt-after-<新版本>.yaml`、`diff-before-apply.txt`（演练的输出）、`apply-log.txt`（下发的输出）、`README.md`（为什么改、项目负责人怎么定的、线上核对：发布修订号、工具个数、effort、agentVersion、源文件的提交）。和提示词改动一起提交。

**回退**：把 `prompt.yaml` 换回上一版的提交（每个 `prompt-history/<目录>/README.md` 写了是哪个提交），用 `--base` 指向这次的 `prompt-after-*.yaml`（线上现在那份）再下发一次。动态配置里清掉的工具不在本仓库，要恢复只能在 Nexus 网页上重新加；`apply.py` 在 pg 方式下每次都按 `CONFIG_TOOLS`（现在是空的）重写工具清单，加回去以后要先改它。

## 7. 测试规范

| 测试 | 跑在哪 | 花费 | 什么时候跑 |
|---|---|---|---|
| 单元测试 `test/unit/`（275 个） | 本机，假 A2A 网关；要 MySQL 的 11 个本机跳过 | 免费 | 每次改代码；`deploy.sh` 每次都先跑 |
| 要 MySQL 的单元测试（`bench-*.test.mjs`，11 个） | 测试台，经 `poc/infra/bench-test.sh`；只用 `jiuan_bench_test` 库 | 免费 | 改了测试台的代码或脚本 |
| 命令行测试 `skills/agent-access/tests`（6 个） | 本机 | 免费 | 改了 `agent_access.py` |
| `poc.e2e.mjs` | 线上 | 约 0.15 美元 | 改了审批流、九安锚点、模型客户端 |
| `attachments.e2e.mjs` | 线上 | 约 0.15 美元 | 改了附件、调用测试、A2A 客户端、提示词 |
| `access.e2e.mjs` | 线上 | 约 0.06 美元 | 改了「我的 Nexus」、命令行、加密存储 |
| 九安 v0.7.10：新前端 `poc/web07` 的 `npm test`、外壳 `poc/app07` 的单元测试 | 本机 | 免费 | 每次改代码；`deploy.sh` 每次都先跑 |
| 九安 v0.7.10：`run07.sh`（先 `web07.e2e.mjs`，再 `jiuan07.e2e.mjs`） | 线上（jiuan-v0710）；开始前重置 `jiuan07` 库，保留「Agent 接入」的启用记录 | 完整一次约 1–3 美元 | 改了外壳、新前端、补丁、审核 Agent 提示词、知识库。只跑一部分：`E2E07_FILES=<文件>`，再加 node 的 `--test-name-pattern`；`KB_E2E_DOCX=<转好的风险判断卡 .docx>` 时跑知识库上传那条 |

写测试和跑测试的规矩：
- **先写会失败的测试**，看着它失败，再写实现；修 bug 也一样，先写能复现的测试。
- **单元测试不连网**：Nexus 一律用 `test/unit/helpers/fake-a2a.mjs` 和假的 CLI。
- **端到端测试用的线上账号是真人也在用的**：不替换、不停用账号本人启用的 Agent，只清理测试自己建的东西；跳过时写明原因。
- **端到端测试输出里不能出现密钥**：`access.e2e.mjs` 会逐条检查。
- 端到端测试的截图存到 `evidence/<轮次>/e2e/`，交付时一并给项目负责人。

## 8. 接口与版本号

| 对象 | 规则 |
|---|---|
| `agent-access-v1`（`/api/analysis/v1/poc/nexus/me*`） | 只增不改：可以加字段、加错误码、加接口；不能改已有字段和错误码的含义。见 `skills/agent-access/references/interface.md` |
| 命令行退出码（0、2–9） | 和 nexus-ai-operator 一致，只增不改。见 `skills/agent-access/SKILL.md` 第 6 节 |
| 知识 Agent 返回的 `version` | `knowledge-agent-YYYY-MM-DD.N`，改了提示词就加一；能力清单（`describe`）随之更新 |
| 九安开发包 | 用目录名里的版本号（现在 v0.5.3）；升级时在 `CHANGELOG.md` 写明 |

## 9. 评审建议、还没做到的规则

交付前代码评审建议的规则，等对应的改动做完再生效（编号见[交接文档](handover.md)第 6.1 节）：

| 规则 | 依赖的改动 |
|---|---|
| `deploy.sh` 拒绝从有未提交改动的目录发布；版本号 = 短提交号 + 包的 sha256 | 代码进 Git（C1） |
| `/poc/healthz` 版本不对，部署失败并打印回滚命令（SSM 不是 Success 就失败，2026-10-19 已做） | 健康检查带版本号（C1） |
| 实例只装部署指定的版本，崩溃重启不重新下载 | 改模板的拉包方式（I2） |
| 单元测试在 Node 24、命令行测试在 Python 3.9 上跑 | 容器化的测试关卡（I9） |
| 先上预发，发布那次端到端测试里「跳过」算失败 | 预发环境、栈名参数化（I10） |
| 服务端密钥文件按白名单生成，测试密钥不离开本机 | 改 `deploy.sh`（I3） |
| operator CLI 只和通过的合同测试一起升级 | 已放进仓库并固定为 1.1.0（`deploy.sh` 默认用它）；还差合同测试（I8） |

## 10. 九安开发包升级的步骤

1. 新版本解压到 `source/` 下的新目录，老版本保留。
2. `JIUAN_CODE_DIR=<新目录>/code node scripts/build-public.mjs`：哪个锚点对不上，脚本会直接报错，不会悄悄漏改。
3. 服务端跑的是 `poc/bench/build-jiuan.sh` 构建的副本：把脚本里的开发包路径和补丁目录（`patches/jiuan-v0.5.3/`）改成新版本，再跑一次；补丁打不上会报错，不留半成品。
4. 逐个修锚点和补丁，跑全部单元测试，再用 `poc/infra/bench-test.sh` 在测试台上跑要 MySQL 的测试。
5. 用新目录部署（`JIUAN_CODE_DIR=<新目录>/code poc/infra/deploy.sh --code-only`），跑全部端到端测试。
6. 确认后在 `CHANGELOG.md` 写明九安版本变化；老目录再保留一个发布周期。
