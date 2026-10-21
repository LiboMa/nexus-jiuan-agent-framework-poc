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
| 线上 PoC（栈 `andon-finance-poc`） | 演示、端到端测试；2026-10-19 起是测试台（t3.large，本机 MySQL 8.0，九安的真实运行时） | 可用；只有这一套 |
| 预发（建议） | 并入九安之前，用同一模板另建一个栈（不同栈名和域名）先验证 | 未建 |

线上只有一套环境，所以：端到端测试会**重置测试台**（`bench-reset.sh` 删掉并重建九安的库，单据回到 8 张种子；审批记录、登录状态、运行记录清空；各账号的连接与启用在磁盘上，不受影响），跑之前通知正在用的人。

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
3. **部署**：`poc/infra/deploy.sh --code-only`（改了模板才去掉 `--code-only`）。脚本会先跑单元测试、构建九安副本（`poc/bench/build-jiuan.sh`）、生成前端副本、补上缺的 `REGISTRY_KEY` 和测试台密钥，再打包上传、让实例拉取、配置测试台（`bench-configure.sh`）、重启并做健康检查。
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

### 6.2 其他回滚

- **栈参数**：改回原值，再 `deploy.sh --code-only`。
- **模板**：CloudFormation 更新失败会自动回滚；更新成功但有问题的，用上一版模板跑 `deploy.sh`。
- **Agent 提示词**：用上一版提示词经 Operator 再更新一次；发布跟随最新版本，所以立即生效。
- **各账号的数据**（`/var/lib/andon-finance/users/`）：没有备份；回滚代码不会动它。

## 7. 测试规范

| 测试 | 跑在哪 | 花费 | 什么时候跑 |
|---|---|---|---|
| 单元测试 `test/unit/`（275 个） | 本机，假 A2A 网关；要 MySQL 的 11 个本机跳过 | 免费 | 每次改代码；`deploy.sh` 每次都先跑 |
| 要 MySQL 的单元测试（`bench-*.test.mjs`，11 个） | 测试台，经 `poc/infra/bench-test.sh`；只用 `jiuan_bench_test` 库 | 免费 | 改了测试台的代码或脚本 |
| 命令行测试 `skills/agent-access/tests`（6 个） | 本机 | 免费 | 改了 `agent_access.py` |
| `poc.e2e.mjs` | 线上 | 约 0.15 美元 | 改了审批流、九安锚点、模型客户端 |
| `attachments.e2e.mjs` | 线上 | 约 0.15 美元 | 改了附件、调用测试、A2A 客户端、提示词 |
| `access.e2e.mjs` | 线上 | 约 0.06 美元 | 改了「我的 Nexus」、命令行、加密存储 |

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
