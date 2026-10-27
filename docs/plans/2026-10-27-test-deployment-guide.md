# 测试部署指南 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一份 Claude Code / Codex / Kiro CLI 照着就能执行的测试部署指南：先在现有环境上跑通，之后九安在自己的 AWS 账号和 Nexus 上照同一份指南从零部署。

**Architecture:** 一个环境一份配置文件 `poc/infra/env/<环境名>.env`，所有脚本经 `DEPLOY_ENV` 读它（不给就是现有环境，用法不变）。Nexus 一侧加幂等的 `audit-agent/setup.py`（找或建 Agent、A2A 发布、绑连接器），和 `apply.py` 共用一个小模块。指南 `docs/delivery/test-deployment.md` 分 A（已有环境）、B（从零），根目录 `AGENTS.md` / `CLAUDE.md` 给编码工具读。

**Tech Stack:** bash（AWS CLI v2、CloudFormation、SSM）、Python 3.9 标准库（`audit-agent/`，经 `skills/nexus-ai-operator/scripts/nexus.py` 调 Nexus）、Node 24（单元测试、端到端测试）。

**Spec:** `docs/specs/2026-10-27-test-deployment-guide-design.md`

## Global Constraints

- 不给 `DEPLOY_ENV` 时，每个脚本的行为和现在逐字一致（栈名 `andon-finance-poc`、区域 `us-east-1`、模板默认值、`apply.py` 现有的编号）。
- 配置文件只按 `KEY=VALUE` 逐行读，**不 `source`、不 `eval`**：值原样取（可以用一对 `"` 或 `'` 包起来），不展开 `$`、反引号；不认识的键、重复的键、格式不对的行都报错并给出行号。文件里写了的键以文件为准（压过同名环境变量），每个脚本开头打印「环境：<文件>（栈 <名>，区域 <区>）」。
- 配置文件不进仓库：`.gitignore` 忽略 `poc/infra/env/*.env`，只放行 `poc/infra/env/example.env`；`example.env` 的示例值用 AWS 文档的示例写法（账号 `123456789012`、`vpc-0123456789abcdef0`、域名 `example.com`）；导出交接仓库、出交付包时同样只带 `example.env`。
- 密钥：配置文件里不放任何密码和密钥；Agent 的调用密钥只由人在九安「Agent 接入」页上粘贴；测试和脚本不读 `secrets.env` 里的 Agent 密钥、不打印口令；不用假密钥。
- 改 Nexus 上的东西（提示词、发布、动态配置、建 / 删演练资源）之前先 `--dry-run`，把改动给项目负责人看，同意后才写。
- 制度原文和从它派生的东西不进仓库、交付包、日志、截图。
- 文档的每条流程说法都要和代码一致（固定规则）。
- 本地提交用 `--no-verify`；端到端测试通过并经项目负责人确认后才推送。

## Review Focus

1. `DEPLOY_ENV` 指向的文件不存在、写错了键名：必须报错退出，不能悄悄退回现有环境去改现有的栈（Task 1）。
2. 配置值里有空格、引号、`$(…)`、反引号：原样当字符串，不执行（Task 1）。
3. 本机 shell 里已经 export 了别的 `AWS_REGION` / `STACK`，同时给了 `DEPLOY_ENV`：以文件为准，并打印要动的是哪个栈、哪个区域（Task 1、Task 2）。
4. `setup.py` 跑到一半失败（Agent 建好了、发布没建成）再跑一次：接着做，不重复建 Agent；在已有环境上跑：一次写都没有（Task 4）。
5. Nexus 上有两个同名 Agent，或配置里的 `AGENT_ID` / `PUBLICATION_ID` 和 Nexus 上按名字找到的不一致：拒绝继续并说清楚，不挑一个往下做（Task 4）。

---

### Task 1: 配置文件格式与读取

**Files:**
- Create: `poc/infra/env/example.env`、`poc/infra/lib/deploy-env.sh`、`audit-agent/deploy_env.py`、`audit-agent/tests/test_deploy_env.py`、`poc/app/test/unit/deploy-env.test.mjs`、`poc/app/test/fixtures/deploy-env/`（几份测试用的 .env）
- Modify: `.gitignore`

**Interfaces:**
- Produces（键，全部可选；空值 = 没写）：
  - 栈与网络：`STACK`（默认 `andon-finance-poc`）、`AWS_REGION`（默认 `us-east-1`）、`VPC_ID`、`SUBNET_ID`、`INSTANCE_TYPE`
  - 站点：`DOMAIN_NAME`、`ORIGIN_DOMAIN_NAME`、`JIUAN07_DOMAIN_NAME`、`HOSTED_ZONE_ID`、`CERTIFICATE_ARN`、`CLOUDFRONT_PREFIX_LIST_ID`
  - Nexus：`NEXUS_ORIGIN`、`NEXUS_PROFILE`（operator 的配置名）、`ADVISORY_PUBLICATION_ID`（v0.5.3 PoC 用）
  - 知识库：`KB_ALLOWED_CIDR`、`KB_SETTINGS`（kb.sh 的个人设置文件，相对仓库根目录；默认 `poc/infra/kb.env`）、`CONNECTOR_ID`（`kb.sh connector` 建好后填）
  - 审核 Agent：`AGENT_NAME`（默认 `jiuan_audit_ai_poc`）、`AGENT_DISPLAY_NAME`（默认 `九安审核AI（PoC）`）、`AGENT_MODEL`（默认 `global.anthropic.claude-opus-5-5`）、`AGENT_ID`、`PUBLICATION_ID`（`setup.py` 建好后填）
- Produces（bash）：`poc/infra/lib/deploy-env.sh` 里 `load_deploy_env`：`DEPLOY_ENV` 为空时什么都不做；否则按 Global Constraints 的规则读文件，把写了值的键设成 shell 变量并 `export`，然后打印「环境：…」到 stderr；出错时打印行号和原因、`exit 2`。另有 `deploy_env_overrides`：每个写了值的栈参数打印一行 `Param=Value`，对照表 `VPC_ID→VpcId`、`SUBNET_ID→SubnetId`、`INSTANCE_TYPE→InstanceType`、`DOMAIN_NAME→DomainName`、`ORIGIN_DOMAIN_NAME→OriginDomainName`、`JIUAN07_DOMAIN_NAME→Jiuan07DomainName`、`HOSTED_ZONE_ID→HostedZoneId`、`CERTIFICATE_ARN→CertificateArn`、`CLOUDFRONT_PREFIX_LIST_ID→CloudFrontPrefixListId`、`NEXUS_ORIGIN→NexusOrigin`、`ADVISORY_PUBLICATION_ID→AdvisoryPublicationId`、`KB_ALLOWED_CIDR→KbAllowedCidr`。
- Produces（Python）：`audit-agent/deploy_env.py` 里 `read_deploy_env(path: str) -> dict[str, str]`（同一套规则，出错抛 `ValueError("<文件>:<行号>：<原因>")`）和 `KEYS: tuple[str, ...]`。

- [ ] **Step 1:** 写测试。`deploy-env.test.mjs` 用 `bash -c 'source poc/infra/lib/deploy-env.sh; load_deploy_env; …'` 跑 fixtures，`test_deploy_env.py` 跑同一组 fixtures，两边结果逐键相同：
  - `basic.env`：注释、空行、`"带 空格"`、`'单引号'`、空值 → 读出的字典；
  - `literal.env`：`DOMAIN_NAME=$(touch /tmp/pwned)` 和反引号 → 原样字符串，`/tmp/pwned` 不存在；
  - `unknown.env`（`DOMIAN_NAME=…`）、`dup.env`、`bad-line.env`（`export STACK=x`、没有 `=`）→ bash `exit 2`、Python `ValueError`，信息里有行号和键名；
  - `DEPLOY_ENV` 指向不存在的文件 → 报错退出，不回退；
  - 环境里先 `export AWS_REGION=eu-west-1 STACK=other`，文件写 `us-east-1` / `andon-finance-rehearsal` → 以文件为准，stderr 有「环境：…（栈 andon-finance-rehearsal，区域 us-east-1）」；
  - `deploy_env_overrides` 只输出写了值的栈参数，顺序按对照表；
  - `KEYS` 和 `example.env` 里的键一一对应（文档和代码一致）；`git check-ignore` 忽略 `poc/infra/env/x.env`、不忽略 `example.env`。
- [ ] **Step 2:** 跑 `cd poc/app && node --test test/unit/deploy-env.test.mjs` 和 `python3 -B -m unittest discover -s audit-agent/tests`，FAIL。
- [ ] **Step 3:** 写 `deploy-env.sh`（`while IFS= read -r line`，正则逐行匹配；只 `printf -v` 赋值）、`deploy_env.py`、`example.env`（每个键一行注释：是什么、从哪来、什么时候填）、`.gitignore`。
- [ ] **Step 4:** 测试 PASS；提交 `feat(infra): per-environment config file (DEPLOY_ENV), read without sourcing`。

### Task 2: 各脚本读配置文件

**Files:**
- Modify: `poc/infra/deploy.sh`、`destroy.sh`、`backup.sh`、`upgrade-instance.sh`、`bench-test.sh`、`kb.sh`、`poc/app/test/e2e/run07.sh`、`poc/app/test/e2e/jiuan07.e2e.mjs`、`docs/delivery/make-package.sh`
- Test: `poc/app/test/unit/infra.test.mjs`、`kb-infra.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `load_deploy_env`、`deploy_env_overrides`。
- Produces：`run07.sh` 向测试导出 `E2E07_REGION`、`E2E07_NEXUS_HOST`（`NEXUS_ORIGIN` 的主机名；没给配置时取栈参数 `NexusOrigin`）。

- [ ] **Step 1:** 写测试：
  - 七个脚本都在用 `STACK` / `REGION` 之前 `source "$…/lib/deploy-env.sh"` 并调用 `load_deploy_env`；`STACK="${STACK:-andon-finance-poc}"`、`REGION="${AWS_REGION:-us-east-1}"`；不再有写死的 `STACK="andon-finance-poc"`；
  - `deploy.sh` 把 `deploy_env_overrides` 的输出并进 `--parameter-overrides`（和建栈时的 `ImageId`、原有的 `KB_ALLOWED_CIDR` 一起；配置文件写了 `KB_ALLOWED_CIDR` 时以文件为准）；
  - `kb.sh`（用 `kb-infra.test.mjs` 的假 aws）：给 `DEPLOY_ENV` 时 `KB_SETTINGS` 取自配置文件；配置文件写了 `AGENT_NAME` 时生成的 kb 配置里 `AGENT_NAME` 以它为准；栈名、区域都传给了 aws；
  - `jiuan07.e2e.mjs`：不再有写死的 `--region us-east-1` 和 `nxs-beine1013`（改用 `E2E07_REGION`、`E2E07_NEXUS_HOST`）；
  - `make-package.sh`：`copy poc/infra` 带 `--include /infra/env/example.env --exclude '/infra/env/*.env'`；检查里加 `audit-agent/tests` 和 `kb/tests` 的单元测试。
- [ ] **Step 2:** 跑 `cd poc/app && node --test test/unit/infra.test.mjs test/unit/kb-infra.test.mjs`，FAIL。
- [ ] **Step 3:** 改脚本。
- [ ] **Step 4:** 测试 PASS；`bash poc/infra/deploy.sh --code-only` 在不给 `DEPLOY_ENV` 时照常部署、健康检查通过（现有环境行为不变）；提交 `feat(infra): every deploy script and the E2E read DEPLOY_ENV`。

### Task 3: 提示词去掉环境值；`apply.py` 读配置

**Files:**
- Create: `audit-agent/nexus_common.py`、`audit-agent/tests/test_apply.py`
- Modify: `audit-agent/prompt.yaml`、`audit-agent/apply.py`、`audit-agent/README.md`

**Interfaces:**
- Consumes: Task 1 的 `read_deploy_env`、`KEYS`。
- Produces（`nexus_common.py`）：
  - `Target`（dataclass：`origin, profile, agent_name, display_name, model, agent_id, publication_id, connector_id`）和 `target_from(env_path: str | None) -> Target`：没给文件时用现有环境的值（`https://nxs-beine1013.tinyboat.blog`、`beine1013`、`jiuan_audit_ai_poc`、`agent_56d44dd9350f4a568bca387319e12ae4`、`pub_5c53e70d8dc7ddea`、`conn-f0c7233959d9`）；给了文件时 `NEXUS_ORIGIN`、`NEXUS_PROFILE`、`CONNECTOR_ID` 必填（缺了报错并说填什么），`AGENT_NAME`、`AGENT_DISPLAY_NAME`、`AGENT_MODEL` 有默认值，`AGENT_ID`、`PUBLICATION_ID` 只在 `apply.py` 里必填；
  - `render_prompt(text: str, target: Target) -> str`：替换 `${CONNECTOR_ID}`、`${AGENT_NAME}`、`${AGENT_MODEL}`，替换后还有 `${` 就抛错；
  - `nexus(method, path, params=(), body=None, write=False, dry_run=False, *, target)`：现在 `apply.py` 里那个，profile 取自 `target`；
  - `DESCRIPTION`、`CONFIG_FIELDS`（从 `apply.py` 搬过来）。
- `apply.py --env <文件> --base <底稿> [--dry-run]`：`--env` 不给时取 `DEPLOY_ENV`，再没有就是现有环境。

- [ ] **Step 1:** 写测试 `test_apply.py`（假的 `nexus`，记录调用）：`render_prompt` 对现有环境的结果和**改之前**的线上提示词逐字一致，只差去掉的那一行杂项（把改前的 `prompt.yaml` 存成 `audit-agent/tests/fixtures/prompt-2026-10-26.yaml` 作对照）；`prompt.yaml` 源文件里没有 `conn-`、`agent_`、`pub_` 编号和私网 IP；渲染后没有 `${`；`target_from(None)` 等于现有环境；配置文件缺 `PUBLICATION_ID` 时 `apply.py` 退出并提示「先跑 setup.py」；`apply.py` 用的 profile、Agent、发布都来自 `target`。
- [ ] **Step 2:** 跑 `python3 -B -m unittest discover -s audit-agent/tests`，FAIL。
- [ ] **Step 3:** `prompt.yaml`：第 2 行 `name: ${AGENT_NAME}`，第 4、7、9 条里的 `conn-f0c7233959d9` 换成 `${CONNECTOR_ID}`，`supported_models` 换成 `${AGENT_MODEL}`，删掉「请将：pgvector-andon …」那一行；写 `nexus_common.py`，`apply.py` 改用它。
- [ ] **Step 4:** 测试 PASS；提交 `feat(audit-agent): prompt without environment values; apply.py reads DEPLOY_ENV`。
- [ ] **Step 5:** 把线上要改的那一处（删掉杂项那一行）给项目负责人看（`apply.py --dry-run` 的输出 + 渲染结果与线上的 diff）；同意后 `apply.py --base <线上现版本>`，再 `bash poc/infra/kb.sh agent --dry-run`（应全是 `=`）、`bash poc/infra/kb.sh verify --e2e`。

### Task 4: `setup.py`：Nexus 上的审核 Agent、发布、连接器（幂等）

**Files:**
- Create: `audit-agent/setup.py`、`audit-agent/tests/test_setup.py`
- Modify: `audit-agent/README.md`

**Interfaces:**
- Consumes: Task 3 的 `target_from`、`render_prompt`、`nexus`、`DESCRIPTION`；Task 1 的配置文件。
- Produces：`python3 audit-agent/setup.py --env <文件> [--dry-run] [--delete]`（`--env` 不给时取 `DEPLOY_ENV`，两个都没有就报错：建东西必须明确是哪个环境）：
  1. 按 `agent_name` 找 Agent：0 个 → 克隆（`POST /api/v2/agents/featured_general_assistant/clone`，`{name_cn: display_name, name_en: agent_name, description, locale: "zh-CN"}`，轮询 `GET /api/v2/agents/{id}/clone-status` 到 `completed`）后写入 `render_prompt(prompt.yaml)`；1 个 → 不动提示词（改提示词归 `apply.py`）；多于 1 个 → 报错；
  2. 按 Agent 找 A2A 发布：没有 → `POST /api/v2/publications`（`{agent_id, channels: ["a2a"], display_name, description: DESCRIPTION, follow_updates}`，不带 `issue_initial_key`）；有 → 描述不对就 PATCH；
  3. 发布的动态配置里有 `connector_id` → 跳过；没有 → 建 / 改动态配置把它绑上（请求体在 Step 1 用 `nexus.py describe` 核对后定）；
  4. 每步打印 `=`（已是目标状态）/ `+`（新建）/ `~`（修改）；`--dry-run` 只读；最后打印 `AGENT_ID=…`、`PUBLICATION_ID=…`，配置文件里这两项为空时写回，不为空又和 Nexus 上不一致时报错；
  5. `--delete`：只在 `agent_name` 以 `_rehearsal` 结尾时允许；删发布、删 Agent；之后按名字再找一遍，确认没有残留。
  - 调用密钥不签发（接口回 403，归人在 Nexus 网页上做）；结尾提示下一步去网页签发、去九安「Agent 接入」页启用。

- [ ] **Step 1:** 用 `python3 skills/nexus-ai-operator/scripts/nexus.py --profile beine1013 describe <方法> <路径>` 核对克隆、克隆状态、建发布、改发布、动态配置（建、改、绑定）、删发布、删 Agent 的请求体和返回；读现有发布 `pub_5c53e70d8dc7ddea` 的 `follow_updates`、`channels`、动态配置（只读），定 `setup.py` 新建时用的值。把结论记进 ledger。
- [ ] **Step 2:** 写测试 `test_setup.py`（假的 `nexus`：按路径回预设的 Nexus 状态，记录写操作）：
  - 已有环境（Agent、发布、绑好的连接器都在）→ 全是 `=`，零次写；
  - 什么都没有 → 克隆、轮询、写提示词、建发布、绑连接器，顺序如上；
  - Agent 在、发布没有（上次中途失败）→ 不再克隆，只建发布和绑连接器；
  - 两个同名 Agent → 报错，零次写；配置里的 `AGENT_ID` 和 Nexus 上的不一致 → 报错，零次写；
  - `--dry-run` 零次写；`--delete` 对不以 `_rehearsal` 结尾的名字拒绝；删完再找一遍为空；
  - 配置文件里 `AGENT_ID`、`PUBLICATION_ID` 为空时写回，其他行原样不动。
- [ ] **Step 3:** 跑，FAIL。
- [ ] **Step 4:** 写 `setup.py`。
- [ ] **Step 5:** 测试 PASS；在现有环境上 `python3 audit-agent/setup.py --env poc/infra/env/<现有环境>.env --dry-run`（本机建这份配置，不进仓库）→ 全是 `=`；提交 `feat(audit-agent): setup.py creates or finds the audit Agent, its A2A publication and connector binding`。

### Task 5: 从零的路径实测（演练）

**Files:** 无代码改动（发现问题回到对应 Task 修）；本机建 `poc/infra/env/rehearsal.env`（不进仓库）。

- [ ] **Step 1:** 建栈这条路：`rehearsal.env` 复制现有环境的配置，换 `STACK=andon-finance-rehearsal`、三个域名换成 `rehearsal-*.tinyboat.blog`；用 `aws cloudformation create-change-set --change-set-type CREATE`（参数取 `deploy_env_overrides`）只预览：核对每个参数都来自配置文件、资源全是 `Add`；然后删掉变更集和处于 `REVIEW_IN_PROGRESS` 的空栈，`describe-stacks` 确认没有残留。
- [ ] **Step 2:** Nexus 这条路：`rehearsal.env` 里 `AGENT_NAME=jiuan_audit_ai_rehearsal`、`AGENT_DISPLAY_NAME=九安审核AI（演练）`、`AGENT_ID` / `PUBLICATION_ID` 留空、`CONNECTOR_ID` 用现有的。`setup.py --dry-run` 的输出给项目负责人看，同意后实跑：读回名片（`/a2a/<发布>/.well-known/agent-card.json`）有「契约」「任务」两行，动态配置里有连接器，Agent 的提示词与 `render_prompt` 的结果一致；再跑一次 → 全是 `=`；然后 `setup.py --delete`，确认没有残留。不签发调用密钥、不在九安上启用。
- [ ] **Step 3:** 结果记进 ledger 和本计划的执行记录。

### Task 6: 指南、`AGENTS.md`、`CLAUDE.md`

**Files:**
- Create: `docs/delivery/test-deployment.md`、`AGENTS.md`、`CLAUDE.md`（仓库根目录）
- Modify: `docs/delivery/README.md`（索引）、`README.md`（根目录表格）、`docs/delivery/package-guide.md`（第 4 节包里有什么）、`docs/delivery/make-package.sh`（白名单带上 `AGENTS.md`、`CLAUDE.md`）、`docs/build-html.sh` 的清单（如需）
- Test: `poc/app/test/unit/delivery-docs.test.mjs`（新）

- [ ] **Step 1:** 写测试：指南里出现的每条命令的脚本路径都存在；出现的每个配置键都在 `KEYS` 里；`AGENTS.md` 指向指南并含硬规则（密钥、制度原文、先 dry-run 后改动、没确认不提交不推送）；`CLAUDE.md` 用 `@AGENTS.md` 引用；`make-package.sh` 带上两份文件。
- [ ] **Step 2:** 跑，FAIL。
- [ ] **Step 3:** 写指南（对照代码逐条写）：
  - 开头一张表：步骤、谁做（编码工具 / 人）、大约多久、会不会改线上、怎么核对；
  - **A 部分（已有环境）**：建这份环境的配置文件 → 单元测试 → `deploy.sh`（变更集先预览）→ `kb.sh` 的 `preflight`、`all --dry-run`、`verify` → `setup.py --dry-run`（全 `=`）→ `apply.py --dry-run` → 九安上看「Agent 接入」状态 → `kb.sh verify --e2e` → `run07.sh`；
  - **B 部分（从零）**：两个九安开发包放进 `source/`、AWS 与 Nexus 的前提（Bedrock 模型访问、Nexus 管理员、operator 配置）→ 写配置文件 → `KB_ALLOWED_CIDR=… deploy.sh` 建栈 → `kb.sh config`、`db`、`network`、`egress`（约 5 分钟生效）、`connector` → 把连接器编号填进配置 → `setup.py`（建 Agent、发布、绑连接器，编号写回配置）→ `kb.sh agent`、`ingest` 或页面上传 → `deploy.sh --code-only`（打开制度知识库页）→ **人**：Nexus 网页签发调用密钥、九安「Agent 接入」连接 Nexus、启用、设为审批 Agent → `kb.sh verify --e2e` → `run07.sh`；
  - 每一步：要做什么、命令、期望输出、出错看哪里（链到 `kb/GUIDE.md` 第 9 节、`operations.md`）；改线上之前先 dry-run、把改动给人看；
  - 回滚与清理：`destroy.sh`、`kb.sh destroy`、`setup.py --delete`（只限演练）。
  `AGENTS.md`：这是什么仓库、部署去读哪份指南、硬规则、测试命令；`CLAUDE.md`：一行 `@AGENTS.md` 加 Claude Code 特有的提示（zsh 注意事项）。
- [ ] **Step 4:** 测试 PASS；`bash docs/build-html.sh`；提交 `docs: test deployment guide (existing environment, from zero); AGENTS.md and CLAUDE.md for coding tools`。

### Task 7: 过时的部署说法

**Files:** `poc/infra/README.md`、`poc/infra/secrets.env.example`、`docs/delivery/handover.md`、`docs/delivery/deploy-iteration.md`、`docs/delivery/operations.md`、`docs/delivery/skills-guide.md`、`docs/delivery/package-guide.md`、`docs/delivery/customer-rollout.md`、`kb/GUIDE.md`

- [ ] **Step 1:** 逐条改（每条对照代码核对后再写）：
  - 要两个九安开发包（v0.5.3、v0.7.10），路径写死在 `build-jiuan.sh` / `build-jiuan07.sh`，`JIUAN_CODE_DIR` 只做存在性检查；
  - 实例类型：模板默认 t3.small，现有环境是 t3.large，配置文件的 `INSTANCE_TYPE`；
  - `AdvisoryPublicationId` 只管 v0.5.3 PoC，v0.7.10 的审批 Agent 在「Agent 接入」页上指定；
  - `secrets.env` 的样例和交接文档补上 `JIUAN07_MYSQL_APP_PASSWORD`、`JIUAN07_DATA_KEY`；
  - 「启用要填发布编号、名片要有契约两行」改成补丁 0003 之后的样子；
  - 提示词改了要重存发布的动态配置（`apply.py` 每次都做），「改了立刻生效」只对会话成立；
  - `agent-access` 命令行只对 v0.5.3 PoC 有效；
  - `kb/GUIDE.md` 7.5 的顺序：已有环境「先 `kb.sh db` 再 `deploy.sh`」，从零「先 `deploy.sh` 建栈，再 `kb.sh db`，再 `deploy.sh --code-only`」；
  - Nexus 地址：`nxs-beine1013.tinyboat.blog` 和 `d3u3hj2us186y.cloudfront.net` 的关系先核实（只读：比较两个地址的版本接口和名片），核实不了就问项目负责人，再改 `handover.md`、`operations.md`、`poc/infra/README.md`、`customer-rollout.md` 里矛盾的说法；
  - `customer-rollout.md` 开头加一段：现状（`review_advice@1`、v0.7.10 补丁 0001–0004）与本文计划的差别。
- [ ] **Step 2:** `bash docs/build-html.sh`；单元测试照常通过；提交 `docs: deployment statements match the code (v0.7.10, secrets, Nexus address, order)`。

### Task 8: 新会话照指南演练（A 部分，现有环境）

**Files:** 无代码改动（发现问题回到对应 Task 修）。

- [ ] **Step 1:** 派一个全新的子 Agent（不带本次对话的上下文），只告诉它：仓库路径、读 `AGENTS.md`、用 `DEPLOY_ENV=poc/infra/env/<现有环境>.env` 照 `docs/delivery/test-deployment.md` 的 A 部分执行；遇到任何 `~`（会改线上的步骤）就停下报告，不执行；人做的步骤只核对状态。可以跑 `kb.sh verify --e2e` 和 `run07.sh`。
- [ ] **Step 2:** 它报告的每个卡住、看不懂、和指南不符的地方：改指南或代码（代码改动照 TDD），再让它从卡住的那一步接着跑，直到 A 部分全部走完：各步是 `=`，`verify --e2e` 通过，端到端 9/9（带 `KB_E2E_DOCX` 时）。
- [ ] **Step 3:** 结果记进 ledger 和本计划的执行记录；提交 `docs: test deployment guide rehearsed on the existing environment`。

### Task 9: 交接仓库同步

- [ ] **Step 1:** 终审（整条分支，最强的模型）和一轮修复之后，`docs/delivery/make-package.sh --export ../nexus-jiuan-agent-framework-poc-guide`；核对没有真实环境值、没有 `poc/infra/env/` 下除 `example.env` 以外的文件、没有制度原文；在 `release/v0.7.10` 上提交，`v0.7.10` 标签移到新提交（项目负责人已同意移标签；不推送）。
