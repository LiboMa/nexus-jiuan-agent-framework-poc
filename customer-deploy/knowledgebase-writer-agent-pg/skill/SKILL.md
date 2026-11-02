---
name: pg-kb-steward-deploy
description: "Deploy the Nexus agent 知识库文档管家（PG 版） / knowledgebase_writer_agent_pg to a real Nexus v0.3.28 environment from its delivery zip, via the Nexus AI Operator plus admin scripts: prerequisites, read-only inventory, the PostgreSQL + pgvector rules KB (new with Cohere Embed v4, or an existing Titan KB migrated behind a regression gate), clone the agent, import pg_kb_tools.zip with its pg_kb key declaration, bind the key, save the prompt, smoke-test, publish A2A + MCP, end-to-end test with fictional documents, hand over. Every write is shown first and confirmed by the user. TRIGGER when asked to deploy, install, upgrade, verify or hand over the PG knowledge-base steward, knowledgebase_writer_agent_pg, pg_kb_tools, kb_pg_steward or the PG rules KB, or 照 pg-kb-steward-deploy 部署. 中文触发词：部署知识库文档管家、PG 版文档管家、制度知识库 Agent、导入 pg_kb_tools、PG 规则库、换 Cohere v4、照 pg-kb-steward-deploy 部署到。"
---

# pg-kb-steward-deploy：把「知识库文档管家（PG 版）」部署到真实环境

本手册给编码工具（Claude Code、Kiro CLI、Codex……）照着做，人也可以读。它把交付 zip 里的东西部署到用户的 Nexus v0.3.28 上：

- PG 知识库（`repo/kb/`，PostgreSQL + pgvector，向量在库里由 Cohere Embed v4 算）；
- Agent「知识库文档管家（PG 版）」（`knowledgebase_writer_agent_pg`），三个工具 `rules_writer` / `rules_search` / `rules_manager`；
- A2A + MCP 发布，交给前端调用。

做完时用户手里有：一个能用的 Agent、它的发布编号 `<PUBLISH_ID>`、一份核对结果、一张待清理清单。全程大约 2–3 小时，其中大半是等用户确认、等平台。

## 0. 规则（每一步都适用，先读）

**工作目录。** 所有命令都在 `<ROOT>` 执行：交付 zip 解开后的根目录（有 `START-HERE.md`、`nexus/`、`repo/` 的那一层）。每条命令都写成能单独运行的完整形式，不依赖上一条留下的 shell 变量（编码工具的 shell 常常每次都是新的）。用户的 shell 是 zsh 时，变量后面紧跟中文或 `:` 要写成 `${var}`。

**写操作的闸门（硬性；与 Operator 接入包 `references/safety.md` 的「确认」一致）。** 任何会改动 Nexus、AWS、数据库或主机的命令（含会话里发消息、管理员脚本、`a2a_rules.mjs` 的 `ingest` / `deactivate` / `restore` / `delete`），**一条一确认**：

1. 先拿到这一条的计划：Operator 的写操作先不加 `--yes` 运行（CLI 打印「将要执行的请求」并以退出码 9 停下），或加 `--dry-run`；`repo/kb/deploy.sh` 先加 `--dry-run`；管理员脚本、`aws`、`a2a_rules.mjs` 这类没有预演的，就把这条命令、它会建 / 改什么、怎么撤销写成一段话。
2. 原样给用户看，问「要执行这一条吗？」。
3. 用户**明确同意这一条**之后才执行：Operator 这时才加 `--yes`；CLI 在「需要的确认」里列了 `--confirm-destructive` 的，还要再单独说明后果、单独得到同意才加。

- **不预先、不批量加 `--yes` / `--confirm-destructive`。** 本手册里的 Operator 写命令一律不带它们，用户同意这一条后由你加上；被退出码 9 拦下时，把 CLI 打印的请求交给用户判断。
- 「都帮我弄好」「继续」「照计划做」不等于同意后面每一个写操作。可以先把一个阶段的整个计划给用户看（让他心里有数），但计划里的每一条写操作仍在轮到它时单独确认。
- **删除类操作**（删工具目录、删发布、停用调用密钥、删会话、`delete` 一份制度、删备份表、删 IAM 策略……）**每一项单独确认，问的时候说出确切的对象**（例如「删除虚构制度 `e2e-prose-md`（7 条）吗？」），不和别的步骤、别的删除一起问。
- 只读操作可以直接做：`GET`、`whoami`、`status`、`verify` 不带 `--e2e`、`--dry-run`、`a2a_rules.mjs` 的 `describe` / `list` / `detail` / `search` / `check` / `preview`（都不改知识库）。

**机密（硬性）。** 不读出、不打印、不粘贴、不放进命令行参数：管理员密码（只在用户建的 600 文件 `<ADMIN_PW_FILE>` 里，只有管理员脚本读它）、Operator 的连接密钥与 `~/.nexus/credentials.json`、调用密钥（`nxa_…`，只写进 600 文件）、PG 主机上的 `.env`、`repo/kb/.build/secrets.*`、Nexus 密钥的值。不要用 `aws ssm send-command` 去 `cat` 任何密码（明文会留在 SSM 历史里，删不掉）。需要密码的地方只经脚本的文件传递。数据库密钥（`database_credentials`）由 `repo/kb/deploy.sh connector` 经加密读取建在 Nexus 里，你不经手它的值。

**对话里只报计数、编号、状态。** 不贴制度原文、不贴回归题目的文字。

**停下来问用户的情况**（不要自己绕过去）：

| 情况 | 为什么停 |
|---|---|
| `whoami` 的平台版本不是 v0.3.28 | 接口与行为只在 v0.3.28 上核实过：请用户决定要不要继续；继续也先只跑只读的 `preflight` 和各个 `--dry-run`，看有没有接口报 404 / 422 |
| `whoami` 的权限档位不是 `builder`（网页上叫「搭建」） | 复制、绑定、保存提示词、开会话、发布都会被拒（退出码 4）：请用户在网页「个人设置 › API 密钥」把这条连接的档位改成「搭建」（约 30 秒后生效），或重新生成一把「搭建」档的密钥 |
| Nexus 上没有可以复制的 Agent | 请用户先在网页上建一个（见 3.1），再回到 1.1 |
| 盘点时发现已经有 `knowledgebase_writer_agent_pg`、`kb_pg_steward_*` 工具目录或它的发布 | 可能已经部署过：问是核对 / 更新，还是另起一套 |
| `--dry-run` 或计划里出现意料之外的改动（要新建主机、要重建容器、迁移计划不对、备份表已存在、要删的规则编号……） | 先弄清楚原因 |
| CloudFormation 变更集里不止那一条策略，或有 `Replacement` | 只许改实例角色调 Bedrock 的那一条 |
| `regress --compare` 退出码 1（哪一套题的前 5 命中下降、已知问题不过） | 换模型要用户拍板；给出回退办法 |
| 改完 IAM 后 Bedrock 报 403 | IAM 生效有延迟（实测约 9 分钟内间歇 403）：等 5–10 分钟再探，不要重复写操作 |
| 导入回复的 `errors` 不是 `[]`，或 `verify` 有「不一致」 | 不要接着绑定 |
| 工具报 `credentials_missing` | 回到绑定那一步；不要换工具、换参数绕过 |
| `repo/kb/deploy.env` 的 `RULES_TABLE` 不是 `approval_rules` | 预打好的工具包写死了 `approval_rules`，要重打（阶段 3.2） |
| Operator 退出码 4（权限不足） | 如实告诉用户是哪一种，不要换接口绕过：权限档位不够（看 `whoami`，要 `builder`）；绑定回 `key_not_usable`（这把密钥对这个用户不可用，1.1、3.4）；删除类（「搭建」档不含删除：请用户在网页上删）；`credential_forbidden_path`（凭证管理之类只能本人在网页上做） |
| 任何一步要你读出或转述一个密码 / 密钥 | 换成经文件传递的做法，做不到就停 |
| 端到端要用的虚构编号（`C11-…`、`C12-…`）或标识（`e2e-…`）已在库里 | 虚构文档会撞上真实数据 |

**绝不做的事**：不用网页「导入工具」导入这三个工具；不用「项目备份」恢复来交付 Agent；不对真实制度执行 `deactivate` / `delete`；不加 `--again` / `--force-new` 重复导入；不用旧版本的知识库工具（不是 `repo/kb/` 的那份）跑 `db`；不改审核 Agent 提示词里受管范围之外的内容；不把题库、回归结果、制度原文放进 `<ROOT>`；不提交、不推送 git。

**占位符**（照抄命令时换成实际值；值都不是机密）：

| 占位 | 是什么 | 从哪来 |
|---|---|---|
| `<ROOT>` | 交付 zip 解开后的根目录 | 用户 |
| `<OPERATOR_DIR>` | Operator 接入包 `nexus-ai-operator` 所在目录（里面有 `scripts/nexus.py`） | 用户装在哪（如 `~/.claude/skills/nexus-ai-operator`） |
| `<PROFILE>` | Operator 的 profile 名，一套环境一个 | 与用户约定（如环境名） |
| `<env>.<domain>` | Nexus 的地址 | 用户 |
| `<ADMIN_PW_FILE>` | 管理员密码的 600 文件（绝对路径） | 用户自己建 |
| `<WORKDIR>` | `<ROOT>` 之外的工作目录，放提示词备份、IAM 策略、SSM 参数 | 你建：`mkdir -p -m 700 <WORKDIR>` |
| `<AWS_REGION>`、`<ACCOUNT_ID>` | 区域、AWS 账号 | `repo/kb/deploy.env`、`aws sts get-caller-identity` |
| `<DEPLOY_NAME>`、`<PG_CONTAINER_NAME>`、`<PG_DB_NAME>` | `repo/kb/deploy.env` 的 `DEPLOY_NAME`、`PG_CONTAINER_NAME`（缺省 `nexus-pgvector`）、`PG_DB_NAME`（缺省 `nexus`） | `repo/kb/deploy.env` |
| `<PG_INSTANCE_ID>`、`<PG_PRIVATE_IP>`、`<PG_ROLE_NAME>` | PG 主机的实例 ID、私网 IP、实例角色名 | 阶段 1、2C |
| `<KEY_ID>` | 数据库凭证密钥的 ID（`key-…`） | 阶段 1 / 2 |
| `<SRC_AGENT_ID>`、`<AGENT_ID>` | 复制来源的 Agent、复制出的新 Agent | 阶段 1、3.1 |
| `<DIR_NAME>`、`<TOOL_ID>` | 导入后的工具目录名（`kb_pg_steward_<8 位十六进制>`）、其中任一个工具的 ID | 阶段 3.2 的输出 |
| `<CONNECTOR_ID>` | 审核 Agent 的 PG 连接器 ID（`conn-…`） | 阶段 1.1 |
| `<SESSION_ID>`、`<ATTACHMENT_ID>` | 测试会话、会话附件的 ID | 阶段 3.6、4.3 的输出 |
| `<PUBLISH_ID>`、`<CREDENTIAL_ID>` | 发布编号、自测调用密钥的 ID | 阶段 3.7、3.8 |
| `<QDIR>` | 检索回归题库目录（`questions.json`、`questions_robust.json`），在 `<ROOT>` 之外 | 项目方单独提供 |
| `<SOURCE_ID>` | 库里已有的一份制度的标识（`source_id`） | 阶段 4.1 的 `list` |
| `<旧目录>` | 以前部署知识库用的目录（有 `deploy.env`、`.state/`） | 用户 |

下文 Operator 命令的前缀一律是 `python3 -I <OPERATOR_DIR>/scripts/nexus.py --profile <PROFILE>`。

## 阶段 0　接入 Operator，检查前提（只读）

**0.1 找到 `<ROOT>` 并核对包没被改过：**

```bash
ls <ROOT>/START-HERE.md <ROOT>/repo/kb/deploy.sh <ROOT>/nexus/pg_kb_tools.zip
cd <ROOT> && shasum -a 256 -c --quiet SHA256SUMS && echo 全部一致      # Linux：sha256sum -c --quiet SHA256SUMS && echo 全部一致
```

**0.2 接入 Operator。** 连接密钥（`nxc_…`）不经过你：

- 请用户在 Nexus 网页「个人设置 › API 密钥」生成一把密钥（权限档位用缺省的「搭建」），浏览器会同时下载接入包 `nexus-ai-operator`（带着这把还没用过的密钥和平台地址）。建议用将来做管理员操作的**同一个 Nexus 账号**生成：这样 Agent、发布、数据库密钥、密钥绑定都归同一个人（参考环境就是这样验证的；经 API 密钥的权限封顶「编辑者」，管理员的事仍由管理员脚本做）。
- 接入包装好后（见 `docs/AI-DEPLOY.zh.md`），由你运行：

```bash
python3 -I <OPERATOR_DIR>/scripts/nexus.py --profile <PROFILE> login --client <claude_code|kiro|codex>
python3 -I <OPERATOR_DIR>/scripts/nexus.py --profile <PROFILE> whoami
```

- `login` 用接入包里的 `config/connection.json`，成功后它被删除、密钥被平台换新，只存在本机。接入包里没有这个文件时，请用户**在他自己的终端里**运行 `python3 -I <OPERATOR_DIR>/scripts/nexus.py --profile <PROFILE> login --origin https://<env>.<domain> --token-stdin --client <claude_code|kiro|codex>`，在提示处粘贴密钥再按 Ctrl-D；不要让用户把密钥贴进对话。
- `whoami` 要看到：用户、角色上限（编辑者）、`权限档位 builder`、平台版本 **v0.3.28**。每把密钥（一条「连接」）都带一个权限档位：`builder`（网页上叫「搭建」，生成时的缺省）才能复制 Agent、绑定密钥、保存提示词、开会话、建发布；`read_only`（只读）、`standard`（日常使用）做不了这些。「搭建」档不含删除：要经 Nexus 删的东西（调用密钥、会话、工具目录、发布、Agent）都请用户在网页上删。

**0.3 本机工具：**

```bash
python3 --version                      # 3.9 以上
bash --version | head -1               # PATH 上的 bash 要 4 以上：macOS 自带的 3.2 会把「$变量」后紧跟的中文解析错（brew install bash）
uv --version                           # 管理员脚本、知识库脚本用它临时装 boto3 / psycopg 等（第一次要联网）
node --version                         # 18.17 以上（A2A 自测；客户端用到 AbortSignal.any）
aws --version && aws sts get-caller-identity --query Arn --output text
session-manager-plugin --version       # 知识库的 ingest / regress 经 SSM 端口转发连库
curl --version | head -1               # 7.55 以上
```

**0.4 管理员密码来源。** 二选一：本机 600 文件（下面这样建、这样查），或管理员脚本经 SSM 密封读取部署机上 `deploy.yaml` 的 `auth_password`（管理员密码从没在网页上改过时才行；要用户给出部署机实例 ID 和 `deploy.yaml` 的绝对路径，填法见 3.0；知识库脚本也认同样的 SSM 方式，即 `repo/kb/deploy.env` 的 `NEXUS_ADMIN_PASSWORD_SSM`；只有纯 API 的脚本 `nexus/import-api.sh` 必须用密码文件）。密码文件请用户自己建（在他自己的终端里：`umask 077; cat > <ADMIN_PW_FILE>`，输入密码，回车，Ctrl-D），告诉你路径。你只查权限，不读内容：

```bash
python3 -I -c 'import os,stat,sys; m=stat.S_IMODE(os.stat(sys.argv[1]).st_mode); print("权限", oct(m)); sys.exit(1 if m & 0o077 else 0)' <ADMIN_PW_FILE>
```

**闸门 0**：包一致；`whoami` 是 v0.3.28、权限档位 `builder`；本机工具齐；管理员密码来源定了（`<ADMIN_PW_FILE>` 是 600，或 SSM 的两项已给出）。把结果列给用户。

## 阶段 1　只读盘点

**1.1 Nexus 上已有什么：**

```bash
python3 -I <OPERATOR_DIR>/scripts/nexus.py --profile <PROFILE> call GET /api/v2/agents -q limit=100 -q page=1
python3 -I <OPERATOR_DIR>/scripts/nexus.py --profile <PROFILE> call GET /api/v2/connectors
python3 -I <OPERATOR_DIR>/scripts/nexus.py --profile <PROFILE> call GET /api/v2/publications
python3 -I <OPERATOR_DIR>/scripts/nexus.py --profile <PROFILE> call GET /api/v2/keys
python3 -I <OPERATOR_DIR>/scripts/nexus.py --profile <PROFILE> call GET /api/v2/keys/tools-requiring-key -q search=rules_ -q limit=200 --raw
```

- Agent 列表用 `limit`（每页至多 100）和 `page`（从 1 起）翻页，平台不认 `page_size`（会按缺省的 20 个返回）。一页正好 100 个就把 `page` 加 1 再取，直到不满 100 个。找：已有的 `knowledgebase_writer_agent_pg`（有就停）；复制来源（首选 `knowbase_writer_agent`；没有的话，用户自己的任何一个普通 Agent 都行，**不要选审核 Agent**；请用户选定 → `<SRC_AGENT_ID>`）；审核 Agent 的 `agent_name`（知识库的 `AGENT_NAME` 用它）。一个能复制的都没有就停，见 3.1。
- 连接器：审核 Agent 用的 `postgresql` 连接器；它绑的是哪把密钥，用 `python3 -I <OPERATOR_DIR>/scripts/nexus.py --profile <PROFILE> call GET /api/v2/connectors/<CONNECTOR_ID>` 看。
- 密钥：`key_type` 为 `database_credentials` 的那把（一般叫 `pgvector-rules-kb-cred`，由 `kb/deploy.sh connector` 建）→ `<KEY_ID>`。
- 「需要密钥的工具」里已有 `kb_pg_steward_*` 目录就停。平台一次最多回 200 行（`limit` 再大也按 200），所以按工具名搜（`search=rules_`），并加 `--raw` 看完整回复（不加时 Operator 只打印 `data`，看不到 `pagination`）：`pagination.truncated` 是 `true` 时没列全，也停下，请用户在网页「工具」里看。
- 这几条都是只读的，经 API 密钥（管理员账号生成、权限封顶「编辑者」）就能读：参考环境实测过。密钥列表只有名字、类型、ID，没有值。

**1.2 PG 知识库。** 要先有 `repo/kb/deploy.env`：

- 知识库**以前部署过**（用 `kb/` 或交付仓库的 `pgvector-rules-kb/`）：请用户给出那个目录 `<旧目录>`，把它的配置与状态文件拷进来（都不含密码），再把 `repo/kb/deploy.env` 里的 `NEXUS_ADMIN_PASSWORD_FILE` 指向 `<ADMIN_PW_FILE>`：

```bash
cp <旧目录>/deploy.env repo/kb/deploy.env && chmod 600 repo/kb/deploy.env
cp -R <旧目录>/.state repo/kb/.state && chmod 700 repo/kb/.state
```

  以后只用 `repo/kb/` 这一份跑知识库的阶段，旧目录里的旧版本不要再跑 `db`（旧版的 `kb_search.sql` 会把向量函数换回 Titan）。
- **全新环境**：`cp repo/kb/deploy.env.example repo/kb/deploy.env && chmod 600 repo/kb/deploy.env`，和用户逐项填（阶段 2A 列了要填什么）。

然后只读地看：

```bash
bash repo/kb/deploy.sh status
bash repo/kb/deploy.sh verify            # 只读；不加 --e2e
bash repo/kb/deploy.sh db --dry-run      # 看「~ 向量模型：库里登记 …，配置 …」和两张表的行数
```

`db --dry-run` 里「库里登记」的模型决定阶段 2 走哪条：

| 库里登记 | 走 |
|---|---|
| `none`（还没有库或没有向量） | 2A 新环境 |
| `titan-inferred` 或 Titan | 2B 换成 Cohere v4 |
| `cohere.embed-v4:0`，`verify` 全过 | 跳过阶段 2 |

另记下：`RULES_TABLE`（不是 `approval_rules` 要重打工具包）、`<PG_INSTANCE_ID>`、`<KEY_ID>`（也在 `repo/kb/.state/<DEPLOY_NAME>.env` 的 `KEY_ID=`）。

**闸门 1**：把盘点结果写成一张表给用户（平台版本、复制来源、`<KEY_ID>`、连接器、知识库状态与登记的模型、要走的分支、新 Agent 的名字），**用户确认整体方案后**才进阶段 2。

## 阶段 2　PG 知识库

### 2A　新环境（缺省就是 Cohere Embed v4）

1. 和用户填 `repo/kb/deploy.env`（各项说明见 `repo/kb/GUIDE.md` 第 3 节）：`NEXUS_URL`、`NEXUS_ADMIN_USER`、`NEXUS_ADMIN_PASSWORD_FILE=<ADMIN_PW_FILE>` 或 `NEXUS_ADMIN_PASSWORD_SSM`（注意：知识库的密码文件变量叫这个名字，管理员脚本的叫 `NEXUS_PASSWORD_FILE`）、`PG_HOST_MODE`（`existing` 填 `PG_HOST_INSTANCE_ID`；`create` 填 `PG_CREATE_SUBNET_ID`）、`VM_EGRESS_ALLOW_CIDRS`（留空 = 只放行 PG 主机 `/32`）、`RULES_DOCX`（用户的制度原文，放在 `<ROOT>` 之外）、`RULES_SOURCE_TAG` / `RULES_DOC_TITLE` / `RULES_SOURCE_VERSION`、`AGENT_NAME` 与 `AGENT_PATCH_PROMPT`（审核 Agent 的提示词补丁；不要就填 `false`）、`E2E_QUESTION` / `E2E_EXPECT`（要和这份制度对得上）。`EMBED_MODEL_ID=us.cohere.embed-v4:0`、`EMBED_DIM=1024` 保持缺省。
2. `existing` 模式：PG 主机的实例角色要能调 Cohere v4，先做 2C。`create` 模式的模板已经带上这些权限，但新建的角色同样要等 IAM 生效（2C 末尾）：`all` 在 `ingest` 一步因 Bedrock 403 失败时，库不变，等 5–10 分钟重跑 `bash repo/kb/deploy.sh all`（幂等），不要改配置。
3. 预检与预演（只读）：

```bash
bash repo/kb/deploy.sh preflight
bash repo/kb/deploy.sh all --dry-run
```

4. 把 `~` 行（将要做的改动）原样列给用户；同意后实跑（幂等，失败修好后可重跑）：

```bash
bash repo/kb/deploy.sh all
```

5. 端到端（建测试会话、发两条消息，结束后移到回收站；先问用户。`AGENT_PATCH_PROMPT=false` 时它什么都不跑，见闸门 2A）：

```bash
bash repo/kb/deploy.sh verify --e2e
```

**闸门 2A**：`verify` 全部 `✓`；`db --dry-run` 显示登记的模型是 `cohere.embed-v4:0`；规则表行数与解析统计一致；`--e2e` 通过。`AGENT_PATCH_PROMPT=false`（没有审核 Agent，或不改它的提示词）时，`repo/kb/deploy.sh` 不查审核 Agent，`verify --e2e` 也**不跑端到端、不打印任何 `[e2e]` 行**：这一项记成「跳过（`AGENT_PATCH_PROMPT=false`）」，如实告诉用户审核 Agent 这一侧没有测过，不要当成通过。记下 `<KEY_ID>`（`repo/kb/.state/<DEPLOY_NAME>.env` 的 `KEY_ID=`）。刚改过 `egress` 时 Sandbox 节点约 5 分钟才刷新，`verify` 报「还缺 …」就等几分钟重跑。

### 2B　已有的 Titan 库换成 Cohere v4

要先有回归题库 `<QDIR>`（项目方单独提供，放在 `<ROOT>` 之外）。没有就停下问：没有基线就没法证明换模型不变差。

`regress` 内置的两道「已知问题」（「30万合同用印」要 C03-1.2 在前 3；「房租 年度框架合同 九安」要 C05-3.3 与 C05-3.4 都在前 2）是按参考环境的制度写的；库里是别的制度时它们不会过，`--compare` 会报退出码 1：这时停下，请用户判断。

1. **先装新版检索函数（不动向量）**，让基线和切换后用同一版排序：`repo/kb/deploy.env` 暂时改成 `EMBED_MODEL_ID=amazon.titan-embed-text-v2:0`（`EMBED_DIM=1024` 不变），然后

```bash
bash repo/kb/deploy.sh db --dry-run      # 应是「实跑时 apply：照 sql/kb_search.sql（titan…）幂等重建函数，不动向量」
bash repo/kb/deploy.sh db                # 用户同意后
```

2. **基线**（经端口转发逐题调 `kb_search`，约 2 分钟；题目会记进检索日志，所以先问用户）：

```bash
bash repo/kb/deploy.sh regress --questions-dir <QDIR> --label titan
```

结果在 `~/Documents/pgkb-regression/titan.json`（同名不覆盖）。跑完照 2D 清检索日志。

3. **IAM**：照 2C 给 PG 主机的实例角色加上 Cohere v4（Titan 的权限先留着，回退要用），等它生效。
4. **迁移**：`repo/kb/deploy.env` 改回 `EMBED_MODEL_ID=us.cohere.embed-v4:0`，然后

```bash
bash repo/kb/deploy.sh db --dry-run --migrate-embeddings   # 应是「实跑时 migrate（一个事务）…」，备份表 absent
bash repo/kb/deploy.sh db --migrate-embeddings             # 用户同意后
```

一个事务里：新的 `kb_search.sql` → 旧向量备份进 `<RULES_TABLE>_titan_backup` → 规则表与归档表全部用 Cohere 重算 → `kb_meta` 登记 `cohere.embed-v4:0` / `1024`。任何一步失败（含 Bedrock 403）整段回滚，库里还是 Titan：等 IAM 生效后重跑这一步。

5. **对比**（先问用户；跑完照 2D 清检索日志）：

```bash
bash repo/kb/deploy.sh regress --questions-dir <QDIR> --label cohere
bash repo/kb/deploy.sh regress --compare ~/Documents/pgkb-regression/titan.json ~/Documents/pgkb-regression/cohere.json
```

退出码 `0` 才往下走。退出码 `1` 就停：把哪一套题的 `hit5` 变了、哪道已知问题不过列给用户，由用户决定保留 Cohere 还是回退。回退：`EMBED_MODEL_ID` 改回 Titan，`bash repo/kb/deploy.sh db --dry-run --restore-embeddings` 看过、用户同意后 `bash repo/kb/deploy.sh db --restore-embeddings`。

6. **审核 Agent 回归**（建测试会话，先问用户）：`bash repo/kb/deploy.sh verify --e2e`。

**闸门 2B**：`--compare` 退出码 0（或用户明确接受了差异）；`verify --e2e` 通过；`db --dry-run` 显示登记 `cohere.embed-v4:0`；检索日志里 `kb-regression` 的行已清掉。备份表 `<RULES_TABLE>_titan_backup` 留着，删不删由项目负责人定（删了就不能回退）。

### 2C　PG 主机的实例角色调 Cohere v4（IAM）

只读地找到角色，看它归不归 CloudFormation 管：

```bash
aws ec2 describe-instances --region <AWS_REGION> --instance-ids <PG_INSTANCE_ID> --query 'Reservations[0].Instances[0].[IamInstanceProfile.Arn,MetadataOptions.HttpPutResponseHopLimit]' --output text
aws iam get-instance-profile --instance-profile-name <实例配置文件名（上一行 ARN 的最后一段）> --query 'InstanceProfile.Roles[0].RoleName' --output text
aws cloudformation describe-stack-resources --region <AWS_REGION> --physical-resource-id <PG_ROLE_NAME> --query 'StackResources[].[StackName,LogicalResourceId,ResourceType]' --output text
aws iam list-role-policies --role-name <PG_ROLE_NAME>
aws iam list-attached-role-policies --role-name <PG_ROLE_NAME>
```

- 第三条（`describe-stack-resources`）在角色不归任何栈管时**会报错**（`ValidationError`，`Stack for <PG_ROLE_NAME> does not exist`）：这是正常的，说明它不归栈管，走下面「角色不归栈管」那条。
- 第一条输出 `None`（主机没有实例角色）就停：库内向量化用不了，先请用户给主机挂一个实例角色（`repo/kb/GUIDE.md` 2.4）。
- 第一条的跳数（`HttpPutResponseHopLimit`）小于 2 也停：PG 容器经 Docker 网桥多一跳，取不到角色凭证。改它是写操作（`aws ec2 modify-instance-metadata-options --region <AWS_REGION> --instance-id <PG_INSTANCE_ID> --http-put-response-hop-limit 2`，见 `repo/kb/GUIDE.md` 9.10），要用户同意。

要加的权限（`us.` 推理配置文件本身，加上它路由到的三个区域的基础模型）：

```json
{"Version": "2012-10-17", "Statement": [{"Sid": "KbEmbedCohereV4", "Effect": "Allow", "Action": "bedrock:InvokeModel", "Resource": [
  "arn:aws:bedrock:<AWS_REGION>:<ACCOUNT_ID>:inference-profile/us.cohere.embed-v4:0",
  "arn:aws:bedrock:us-east-1::foundation-model/cohere.embed-v4:0",
  "arn:aws:bedrock:us-east-2::foundation-model/cohere.embed-v4:0",
  "arn:aws:bedrock:us-west-2::foundation-model/cohere.embed-v4:0"]}]}
```

- **角色归某个 CloudFormation 栈管**（上面第 3 条命令列出了栈名）：不要直接改角色（会和栈漂移）。请用户或栈的维护人在那个栈的模板里给调 Bedrock 的那条策略加上这 4 个 ARN，以**已部署的模板**为底出变更集，再拿给你看：

```bash
aws cloudformation describe-change-set --region <AWS_REGION> --stack-name <栈名> --change-set-name <变更集名> --query 'Changes[].ResourceChange.[Action,LogicalResourceId,ResourceType,Replacement]' --output text
```

  只许一行：`Modify`、那条策略、`Replacement` 为 `False`。多一行就停。用户同意后再执行变更集（`aws cloudformation execute-change-set --region <AWS_REGION> --stack-name <栈名> --change-set-name <变更集名>`）。

- **角色不归栈管**：把上面的 JSON 写进 `<WORKDIR>/kb-embed-cohere-v4.json`，给用户看，同意后加一条内联策略（只加不删；撤销是 `aws iam delete-role-policy --role-name <PG_ROLE_NAME> --policy-name kb-embed-cohere-v4`，属删除，单独确认）：

```bash
aws iam put-role-policy --role-name <PG_ROLE_NAME> --policy-name kb-embed-cohere-v4 --policy-document file://<WORKDIR>/kb-embed-cohere-v4.json
```

- **等它生效再往下**：至少等 10 分钟（参考环境实测：策略改完后约 9 分钟内 Bedrock 间歇返回 403，之后稳定），然后在主机上用实例角色连调 20 次（经 SSM 跑一段命令，不涉及任何密码；主机上要有 AWS CLI，Amazon Linux 2023 自带；先问用户）。把下面的参数写进 `<WORKDIR>/kb-probe.json`（区域换成 `<AWS_REGION>` 的值）：

```json
{"commands": ["ok=0; for i in $(seq 1 20); do aws bedrock-runtime invoke-model --region us-east-1 --model-id us.cohere.embed-v4:0 --content-type application/json --accept application/json --cli-binary-format raw-in-base64-out --body '{\"texts\":[\"ping\"],\"input_type\":\"search_query\",\"embedding_types\":[\"float\"],\"output_dimension\":1024,\"truncate\":\"END\"}' /tmp/kb-probe.out >/dev/null 2>&1 && ok=$((ok+1)); done; rm -f /tmp/kb-probe.out; echo probe_ok=$ok/20"]}
```

```bash
aws ssm send-command --region <AWS_REGION> --instance-ids <PG_INSTANCE_ID> --document-name AWS-RunShellScript --comment "kb: probe Cohere v4 with the instance role" --parameters file://<WORKDIR>/kb-probe.json --query Command.CommandId --output text
aws ssm get-command-invocation --region <AWS_REGION> --command-id <上一行输出的 CommandId> --instance-id <PG_INSTANCE_ID> --query '[Status,StandardOutputContent]' --output text
```

  要 `probe_ok=20/20`，隔一分钟再探一次还是 20/20，才做迁移或入库。不到 20 就再等 5 分钟重探（这是 IAM 生效延迟，不是配置错；一直是 0 才回头查策略和模型访问）。

### 2D　清掉检索日志里回归留下的行

`regress` 以 `caller='kb-regression'` 调 `kb_search`，问题记进 `kb_search_log`（保留 90 天）。题库由真实制度派生，每次跑完都要以超级用户删掉这批行（只删回归脚本自己的行；先问用户）。把参数写进 `<WORKDIR>/kb-purge.json`（容器名、库名换成 `<PG_CONTAINER_NAME>`、`<PG_DB_NAME>` 的值）：

```json
{"commands": ["docker exec nexus-pgvector psql -U postgres -d nexus -v ON_ERROR_STOP=1 -c \"DELETE FROM kb_search_log WHERE caller = 'kb-regression'\""]}
```

```bash
aws ssm send-command --region <AWS_REGION> --instance-ids <PG_INSTANCE_ID> --document-name AWS-RunShellScript --comment "kb: purge kb-regression search log rows" --parameters file://<WORKDIR>/kb-purge.json --query Command.CommandId --output text
aws ssm get-command-invocation --region <AWS_REGION> --command-id <CommandId> --instance-id <PG_INSTANCE_ID> --query '[Status,StandardOutputContent]' --output text
```

应看到 `Success` 和 `DELETE <行数>`。

## 阶段 3　Agent

**3.0 管理员脚本的配置**（只放不涉密的设置）：

```bash
cp repo/knowledgebase-writer-agent-pg/deploy.env.example repo/knowledgebase-writer-agent-pg/deploy.env
chmod 600 repo/knowledgebase-writer-agent-pg/deploy.env
```

填：`RULES_TABLE`（与 `repo/kb/deploy.env` 相同）、`NEXUS_URL=https://<env>.<domain>`、`NEXUS_ADMIN_USER`，管理员密码来源二选一：

- `NEXUS_PASSWORD_FILE=<ADMIN_PW_FILE>`（`NEXUS_ADMIN_PASSWORD_SSM` 留空）；
- 或 `NEXUS_ADMIN_PASSWORD_SSM=<deployer 实例 ID>:<deploy.yaml 的绝对路径>` 加 `AWS_REGION`（`NEXUS_PASSWORD_FILE` 留空）：脚本借同目录的 `repo/kb` 经 SSM 密封读取部署机上 `deploy.yaml` 里的 `auth_password`，SSM 历史里只有密文，明文只在本次进程的 600 临时文件里。只在管理员密码从没在网页上改过时有效。参考环境用这种方式跑通了 `import` / `verify` / `check` / `publish` / `issue-call-key`。

**3.1 复制一个 Agent**（v0.3.28 没有「空白建 Agent」的接口）。

- **没有可以复制的 Agent**（Nexus 是空的，或只有审核 Agent）：停下，请用户先在网页上随便建一个 Agent（例如走「创建 Agent」的引导流程，或从模板建一个），建好后回到 1.1 重新列出，选它做 `<SRC_AGENT_ID>`。不要拿审核 Agent 当来源。
- 复制会带上什么、不带什么，以 `clone-preview` 回复里的 `will_copy` / `will_not_copy` 为准（参考环境 v0.3.28：`will_copy` 是提示词、工具、子 Agent、依赖（requirements）；`will_not_copy` 是 `sessions`、`build_history`、`shares`、`dynamic_configs`、`foreign_key_bindings`（别人名下的密钥绑定；用户自己名下的随工具复制）。发布不在复制范围内，3.7 另建）。来源是哪个都行：提示词在 3.5 整份替换，工具也只剩新提示词引用的这 3 个（复制来的工具目录不再被加载）。

```bash
python3 -I <OPERATOR_DIR>/scripts/nexus.py --profile <PROFILE> call GET /api/v2/agents/<SRC_AGENT_ID>/clone-preview
python3 -I <OPERATOR_DIR>/scripts/nexus.py --profile <PROFILE> call POST /api/v2/agents/<SRC_AGENT_ID>/clone --data '{"name_cn":"知识库文档管家（PG 版）","name_en":"knowledgebase_writer_agent_pg","locale":"zh-CN","description":"把制度文档写进审核 Agent 共用的 PG 规则库，并提供检索与管理"}'
```

- `clone-preview` 的 `blockers` 不是空的就停。第二条先不加 `--yes`：把 CLI 打印的请求给用户看，同意后加 `--yes` 再运行（只要 `--yes`）。回复的 `data.agent_id` 就是 `<AGENT_ID>`。
- 等复制完成：

```bash
python3 -I <OPERATOR_DIR>/scripts/nexus.py --profile <PROFILE> wait /api/v2/agents/<AGENT_ID>/clone-status --field data.status --until completed,failed --interval 10 --timeout 900
```

  应等到 `completed`；`failed` 就停。源 Agent 的工具目录也会复制一份：提示词不引用就不会加载，记进待清理清单。

**3.2 导入工具包**（管理员脚本；Operator 做不了 multipart 导入）。先本机核对：

```bash
python3 -I -c 'import hashlib,json,sys,zipfile; m=json.load(open(sys.argv[2]))["files"]; z=zipfile.ZipFile(sys.argv[1]); a={i.filename: hashlib.sha256(z.read(i)).hexdigest() for i in z.infolist() if not i.is_dir()}; print("与 MANIFEST 逐文件一致" if a == m else "不一致"); sys.exit(a != m)' nexus/pg_kb_tools.zip nexus/MANIFEST.json
grep '^RULES_TABLE=' repo/kb/deploy.env repo/knowledgebase-writer-agent-pg/deploy.env
test -e repo/knowledgebase-writer-agent-pg/.state/import.json && echo "这台机器导入过：停" || echo "这台机器还没导入过"
```

- `RULES_TABLE` 是 `approval_rules`：用预打好的包（下面的命令）。不是：先 `python3 -I repo/knowledgebase-writer-agent-pg/scripts/build_tools.py`（读 `deploy.env` 的 `RULES_TABLE`，产物在 `repo/knowledgebase-writer-agent-pg/.build/`），下面两条命令都去掉 `--file nexus/pg_kb_tools.zip`。
- 给用户看的计划：上传 6 个文件（`nexus/MANIFEST.json` 里的清单），3 个工具都声明密钥 `pg_kb` / `database_credentials` / 5 个字段，目录标签 `kb_pg_steward`；结果是一个新的工具目录 v1；撤销 = 删除这个工具目录（单独确认；要管理员，Operator 删不了）。同意后：

```bash
bash repo/knowledgebase-writer-agent-pg/scripts/admin_run.sh import --module pg --file nexus/pg_kb_tools.zip
```

- 输出（也写进 `repo/knowledgebase-writer-agent-pg/.state/import.json`）：`dir_name` → `<DIR_NAME>`，`tools` 里任一个 `tool_id` → `<TOOL_ID>`，`errors` 必须是 `[]`。
- 管理员脚本跑不了时（比如本机装不了 uv），用纯 API 的脚本做（`nexus/IMPORT.md` 第 ② 节；同样的请求，同样写 `.state/import.json`，同样给用户看计划、同意后才跑）：

```bash
bash nexus/import-api.sh --nexus https://<env>.<domain> --user <管理员用户名> --password-file <ADMIN_PW_FILE>
```

  重打过的包加 `--zip repo/knowledgebase-writer-agent-pg/.build/pg_kb_tools.zip --manifest repo/knowledgebase-writer-agent-pg/.build/MANIFEST.json`。它退出码 `3` 就停（本机或服务端已经导入过，什么都没写）：问用户，不要自己加 `--force-new`。不要把 `nexus/IMPORT.md` 第 ② 节的逐步命令拆开一条条跑：它们靠同一个 shell 里的变量和令牌文件，你的 shell 每次都是新的。**不要用网页「导入工具」**（`nexus/IMPORT.md` 第 ③ 节）。

**3.3 核对导入：**

```bash
bash repo/knowledgebase-writer-agent-pg/scripts/admin_run.sh verify --module pg --dir <DIR_NAME> --file nexus/pg_kb_tools.zip
```

应当看到 3 个工具 `key_name=pg_kb key_type=database_credentials configured=False`，6 个文件「一致」，最后一行 `服务端与本地逐个文件一致: True`。（重打过的包：去掉 `--file …`。用 `import-api.sh` 导入的，它最后已经核对过同样的内容；管理员脚本跑不了时，`configured` 用 Operator 只读地看：`python3 -I <OPERATOR_DIR>/scripts/nexus.py --profile <PROFILE> call GET /api/v2/keys/tools-requiring-key -q search=rules_ -q limit=200`。）

**3.4 绑定数据库密钥**（以 Agent 与发布的属主身份，就是 Operator 连的这个用户；一个绑定覆盖 3 个工具）：

```bash
python3 -I <OPERATOR_DIR>/scripts/nexus.py --profile <PROFILE> call PUT /api/v2/keys/tool-bindings --data '{"module_path":"imported_tools/<DIR_NAME>/pg_kb_tools","key_name":"pg_kb","key_id":"<KEY_ID>"}'
```

先不加 `--yes`，给用户看，同意后加 `--yes`。回复里有 `data.binding_id` 就是绑上了；报 403 / 404 就停（`key_not_usable`：这把密钥对这个用户不可用，多半是它不归这个用户）。然后再跑一次 3.3 的 `verify`：3 个都应是 `configured=True`。管理员本人就是 Agent 与发布的属主时，也可以用 `bash repo/knowledgebase-writer-agent-pg/scripts/admin_run.sh bind --key-id <KEY_ID>`。

**3.5 保存提示词**（先备份现在的，回滚用）：

```bash
python3 -I <OPERATOR_DIR>/scripts/nexus.py --profile <PROFILE> call GET /api/v2/agents/<AGENT_ID>/files/prompt --output <WORKDIR>/prompt-before.json
python3 -I repo/knowbase-s3vectors-agent/scripts/render.py prompt --package repo/knowledgebase-writer-agent-pg --tool-dir <DIR_NAME>
python3 -I <OPERATOR_DIR>/scripts/nexus.py --profile <PROFILE> call PUT /api/v2/agents/<AGENT_ID>/files/prompt --data-file repo/knowledgebase-writer-agent-pg/.build/prompt-body.json
```

- `--output` 把 GET 的回复原样存下（整个回复，提示词在 `data.content`，没有脱敏），回滚就用它（文末「回滚」）。
- `render.py` 只写本地（`repo/knowledgebase-writer-agent-pg/.build/prompt.yaml` 与 `prompt-body.json`），打印一行 JSON，`tools` 必须是 `3`。
- PUT 先不加 `--yes`，给用户看（请求体是整份提示词，CLI 已脱敏），同意后加 `--yes`。

**3.6 对话冒烟**（在新 Agent 上开一个测试会话、发两条只读的消息。三条都是写操作：每条先不加 `--yes`，给用户看，同意这一条后再加）：

```bash
python3 -I <OPERATOR_DIR>/scripts/nexus.py --profile <PROFILE> call POST /api/v2/agents/<AGENT_ID>/sessions --data '{"title":"pg-kb smoke"}'
python3 -I <OPERATOR_DIR>/scripts/nexus.py --profile <PROFILE> --timeout 600 call POST /api/v2/sessions/<SESSION_ID>/stream --data '{"content":"这个 Agent 支持哪些规则请求？"}'
python3 -I <OPERATOR_DIR>/scripts/nexus.py --profile <PROFILE> --timeout 600 call POST /api/v2/sessions/<SESSION_ID>/stream --data '{"content":"列出知识库里的制度"}'
```

- 第一条回复的 `data.session_id` 就是 `<SESSION_ID>`。发消息的字段是 `content`（写成别的名字平台回 422）。回复是一行一个 JSON 事件（`event=message`，`type` 为 `text` / `tool_use` / `tool_result`）。
- 第一条消息应有 `tool_use` 调 `rules_manager`（`action="describe"`），`tool_result` 里 `protocol=kb.rules/v1`、`backend=pg`、10 个操作。
- 第二条应调 `rules_manager`（`action="list"`），列出已有的制度和条数。能列出来，就说明工具在 VM 里拿到了注入的密钥、连上了 PG。
- 报 `credentials_missing` → 回 3.4；报 `db_unavailable` → 查 `repo/kb/GUIDE.md` 9.1、9.2（安全组、`vm_egress.allow_cidrs`、密钥字段）；报 `kb_not_ready` → 回阶段 2。请求超时就先 `call GET /api/v2/sessions/<SESSION_ID>/messages` 看这一轮是否已经回完，不要重发同一条消息。

**3.7 发布成 A2A + MCP**（对外开放，先问用户）：

```bash
python3 -I <OPERATOR_DIR>/scripts/nexus.py --profile <PROFILE> call POST /api/v2/publications --data '{"agent_id":"<AGENT_ID>","channels":["a2a","mcp"],"follow_updates":true,"display_name":"知识库文档管家（PG 版）","description":"把制度文档（Word / Excel / PDF / Markdown）写进审核 Agent 共用的 PG 规则库；kb.rules/v1"}'
curl -sS https://<env>.<domain>/a2a/<PUBLISH_ID>/.well-known/agent-card.json | head -c 400
```

- 先不加 `--yes` 运行，把 CLI 打印的请求给用户看，同意后加 `--yes`（只要 `--yes`）。回复的 `data.publication.publish_id` 就是 `<PUBLISH_ID>`。
- `follow_updates: true`：发布跟着 Agent 的最新版本走，以后重存提示词不用重新发布。
- 第二条读公开名片（只读，不要密钥）：应是这个 Agent 的名字，输入类型里有 docx / xlsx / pdf / markdown。

**3.8 发一把自测用的调用密钥**（管理员脚本；明文直接写进 600 文件，只打印 `credential_id`；先问用户）：

```bash
bash repo/knowledgebase-writer-agent-pg/scripts/admin_run.sh issue-call-key --publish-id <PUBLISH_ID>
```

输出的 `credential_id` → `<CREDENTIAL_ID>`；文件是 `repo/knowledgebase-writer-agent-pg/.state/a2a-call-key`（不要读它）。这把只给自测用，不交给前端。

**3.9 A2A 自测**（发的请求与前端「制度知识库」页相同，回复按前端客户端的同一套形态校验；约 17 秒）：

```bash
NEXUS_A2A_URL=https://<env>.<domain>/a2a/<PUBLISH_ID> node repo/knowledgebase-writer-agent-pg/scripts/a2a_rules.mjs describe
```

stdout 是工具回的 JSON（`protocol: "kb.rules/v1"`、`backend: "pg"`、10 个 `ops`、`build`）；退出码 `0` 成功，`1` 工具回 `success=false`，`2` 用法或配置不对，`3` 调用失败或回复没过校验（看 stderr）。

**闸门 3**：`configured=True` ×3、6 个文件一致；对话里 `describe`、`list` 正常；A2A `describe` 退出码 0。

## 阶段 4　端到端（虚构文档），然后收拾回只剩真实制度

端到端会往**审核 Agent 共用的规则表**里临时写入虚构规则（几分钟后删掉）。这期间审核 Agent 可能检索到它们：请用户挑一个没人审单的时间，做完马上清理。开始前可以把这一阶段的整个计划给用户看一遍（让他心里有数），但确认照第 0 节一条一条来：**每一条写操作（开会话、上传附件、发消息、`ingest`、`deactivate`、`restore`）在轮到它时单独确认；每一条 `delete` 单独确认，说出确切的 `source_id`。** 下面的命令都不带 `--yes`，用户同意这一条后由你加上。两条路都走：对话（人在 Nexus 里用的那条，先预览、确认后才写）和 A2A（前端用的那条）。

每条命令单独运行，看完它的输出和退出码再运行下一条（`a2a_rules.mjs` 的退出码：`0` 工具回 `success=true`，`1` 工具回 `success=false`，`2` 用法或配置不对，`3` 调用失败或回复没过校验）。

**4.1 先查（只读），记下基准：**

```bash
NEXUS_A2A_URL=https://<env>.<domain>/a2a/<PUBLISH_ID> node repo/knowledgebase-writer-agent-pg/scripts/a2a_rules.mjs list
NEXUS_A2A_URL=https://<env>.<domain>/a2a/<PUBLISH_ID> node repo/knowledgebase-writer-agent-pg/scripts/a2a_rules.mjs detail '{"source_id": "<SOURCE_ID>"}'
```

- 记下每份制度的 `source_id`、`rules_total`、`status`：收尾时要回到完全一样。
- 已有任何 `C11-` / `C12-` 编号，或 `e2e-` 开头的标识：停（虚构矩阵会撞上）。
- 冲突测试要库里有 `C03-1.2` 与 `C03-NOTE`（某份在线制度的 `rule_ids` 里）；没有就跳过 4.4 的冲突那一条（否则它会被真的写进去）。

**4.2 生成虚构文档**（本机，不连任何服务；内容全部虚构）：

```bash
uv run --no-project --python 3.12 --with reportlab python -B -I repo/knowledgebase-writer-agent-pg/scripts/make_e2e_docs.py
```

写到 `repo/knowledgebase-writer-agent-pg/.build/e2e/`：`e2e-matrix.docx`（审批矩阵，章号从「十一、」起，标识 `e2e-matrix-1030`）、`e2e-conflict.docx`（会撞上 `C03-1.2`）、`e2e-prose.md` / `.pdf` / `.xlsx`（正文条款与表格）。

**4.3 虚构矩阵：A2A 预览 → 对话入库（先预览、确认后写）→ A2A 检索 → 下线 → 恢复 → 删除**（最后一条 `delete` 单独确认：「删除虚构制度 `e2e-matrix-1030`（7 条）吗？」）。

先经 A2A 预览一次（不写库、不算向量）：

```bash
NEXUS_A2A_URL=https://<env>.<domain>/a2a/<PUBLISH_ID> node repo/knowledgebase-writer-agent-pg/scripts/a2a_rules.mjs preview '{"source_id": "e2e-matrix-1030", "title": "e2e-matrix.docx"}' repo/knowledgebase-writer-agent-pg/.build/e2e/e2e-matrix.docx
```

应是 `status: "previewed"`、`will_insert` 7 个编号，什么都没写。

再走对话：开一个测试会话，把文档上传成会话附件，让 Agent 入库。附件上传用 `repo/knowbase-s3vectors-agent/scripts/e2e_upload.py`（经 Operator：presign → PUT 到预签名地址 → confirm；预签名地址只在内存里用一次，不打印）：

```bash
python3 -I <OPERATOR_DIR>/scripts/nexus.py --profile <PROFILE> call POST /api/v2/agents/<AGENT_ID>/sessions --data '{"title":"pg-kb e2e"}'
NEXUS_OPERATOR=<OPERATOR_DIR>/scripts/nexus.py NEXUS_PROFILE=<PROFILE> python3 -I repo/knowbase-s3vectors-agent/scripts/e2e_upload.py <SESSION_ID> repo/knowledgebase-writer-agent-pg/.build/e2e/e2e-matrix.docx
python3 -I <OPERATOR_DIR>/scripts/nexus.py --profile <PROFILE> --timeout 600 call POST /api/v2/sessions/<SESSION_ID>/stream --data '{"content":"把附件入库：制度标识 e2e-matrix-1030，版本 V1。","attachment_ids":["<ATTACHMENT_ID>"]}'
python3 -I <OPERATOR_DIR>/scripts/nexus.py --profile <PROFILE> --timeout 600 call POST /api/v2/sessions/<SESSION_ID>/stream --data '{"content":"确认写入"}'
```

- 四条都是写操作，各自单独确认：开会话、发两条消息照第 0 节（先不加 `--yes`）；`e2e_upload.py` 没有预演、内部经 Operator 发两个写请求（presign、confirm，它自己带 `--yes`），所以运行它之前先告诉用户它会把这份虚构文档传成这个会话的附件，同意后才运行。
- 第一条回复的 `data.session_id` → `<SESSION_ID>`；`e2e_upload.py` 打印的 `attachment_id`（一串十六进制，不带前缀）→ `<ATTACHMENT_ID>`，`confirm ok: True`。
- 「把附件入库」那一轮：应有 `tool_use` 调 `rules_writer` 且 `dry_run=true`，`tool_result` 是 `previewed`、将新增 7 条，Agent 把编号列出来并**等你确认，没有写**。它没先预览就直接写了，停下报告。
- 「确认写入」那一轮：`rules_writer` 用同样的参数再调一次（不带预览），`tool_result` 是 `ingested`、`inserted` 7。

然后经 A2A 检索、下线、恢复、删除：

```bash
NEXUS_A2A_URL=https://<env>.<domain>/a2a/<PUBLISH_ID> node repo/knowledgebase-writer-agent-pg/scripts/a2a_rules.mjs search '{"question": "虚构甲板块 国内差旅报销 审批", "top_k": 3}'
NEXUS_A2A_URL=https://<env>.<domain>/a2a/<PUBLISH_ID> node repo/knowledgebase-writer-agent-pg/scripts/a2a_rules.mjs deactivate '{"source_id": "e2e-matrix-1030"}'
NEXUS_A2A_URL=https://<env>.<domain>/a2a/<PUBLISH_ID> node repo/knowledgebase-writer-agent-pg/scripts/a2a_rules.mjs search '{"question": "虚构甲板块 国内差旅报销 审批", "top_k": 3}'
NEXUS_A2A_URL=https://<env>.<domain>/a2a/<PUBLISH_ID> node repo/knowledgebase-writer-agent-pg/scripts/a2a_rules.mjs restore '{"source_id": "e2e-matrix-1030"}'
NEXUS_A2A_URL=https://<env>.<domain>/a2a/<PUBLISH_ID> node repo/knowledgebase-writer-agent-pg/scripts/a2a_rules.mjs search '{"question": "虚构甲板块 国内差旅报销 审批", "top_k": 3}'
NEXUS_A2A_URL=https://<env>.<domain>/a2a/<PUBLISH_ID> node repo/knowledgebase-writer-agent-pg/scripts/a2a_rules.mjs delete '{"source_id": "e2e-matrix-1030"}'
```

应当看到：第一次 `search` 前几名是 `C11-1.x`；`deactivate` → `affected` 7，再检索没有 `C11` / `C12`；`restore` → `affected` 7，检索结果与距离和下线前相同；`delete` → `affected` 7。

**4.4 冲突与正文**（4 条 `ingest`，每条单独确认）：

```bash
NEXUS_A2A_URL=https://<env>.<domain>/a2a/<PUBLISH_ID> node repo/knowledgebase-writer-agent-pg/scripts/a2a_rules.mjs ingest '{"source_id": "e2e-conflict-1030", "source_version": "V1", "title": "e2e-conflict.docx"}' repo/knowledgebase-writer-agent-pg/.build/e2e/e2e-conflict.docx
NEXUS_A2A_URL=https://<env>.<domain>/a2a/<PUBLISH_ID> node repo/knowledgebase-writer-agent-pg/scripts/a2a_rules.mjs ingest '{"source_id": "e2e-prose-md", "source_version": "V1", "title": "e2e-prose.md"}' repo/knowledgebase-writer-agent-pg/.build/e2e/e2e-prose.md
NEXUS_A2A_URL=https://<env>.<domain>/a2a/<PUBLISH_ID> node repo/knowledgebase-writer-agent-pg/scripts/a2a_rules.mjs ingest '{"source_id": "e2e-prose-pdf", "source_version": "V1", "title": "e2e-prose.pdf"}' repo/knowledgebase-writer-agent-pg/.build/e2e/e2e-prose.pdf
NEXUS_A2A_URL=https://<env>.<domain>/a2a/<PUBLISH_ID> node repo/knowledgebase-writer-agent-pg/scripts/a2a_rules.mjs ingest '{"source_id": "e2e-prose-xlsx", "source_version": "V1", "title": "e2e-prose.xlsx"}' repo/knowledgebase-writer-agent-pg/.build/e2e/e2e-prose.xlsx
```

- 冲突那条（4.1 查过库里有 `C03-1.2`、`C03-NOTE` 才跑）应退出码 `1`：`error_type: "rule_conflict"`，`conflicts` 是 `["C03-1.2", "C03-NOTE"]`，一条没写。
- 三份正文应 `ingested`：7 条 `clause` / 7 条 `clause` / 3 条 `table_row`。
- 有 `<QDIR>` 时，可以在三份正文入库之前跑 `bash repo/kb/deploy.sh regress --questions-dir <QDIR> --label before-clauses`、入库之后跑 `bash repo/kb/deploy.sh regress --questions-dir <QDIR> --label with-clauses`，再 `bash repo/kb/deploy.sh regress --compare ~/Documents/pgkb-regression/before-clauses.json ~/Documents/pgkb-regression/with-clauses.json`（退出码 0 = 正文没挤掉矩阵规则）；跑完照 2D 清日志。

**4.5 删掉三份正文**（每一条 `delete` 单独确认，说出 `source_id`），再校验：

```bash
NEXUS_A2A_URL=https://<env>.<domain>/a2a/<PUBLISH_ID> node repo/knowledgebase-writer-agent-pg/scripts/a2a_rules.mjs delete '{"source_id": "e2e-prose-md"}'
NEXUS_A2A_URL=https://<env>.<domain>/a2a/<PUBLISH_ID> node repo/knowledgebase-writer-agent-pg/scripts/a2a_rules.mjs delete '{"source_id": "e2e-prose-pdf"}'
NEXUS_A2A_URL=https://<env>.<domain>/a2a/<PUBLISH_ID> node repo/knowledgebase-writer-agent-pg/scripts/a2a_rules.mjs delete '{"source_id": "e2e-prose-xlsx"}'
NEXUS_A2A_URL=https://<env>.<domain>/a2a/<PUBLISH_ID> node repo/knowledgebase-writer-agent-pg/scripts/a2a_rules.mjs check
NEXUS_A2A_URL=https://<env>.<domain>/a2a/<PUBLISH_ID> node repo/knowledgebase-writer-agent-pg/scripts/a2a_rules.mjs list
```

`delete` → `affected` 7 / 7 / 3；`check` → `ok: true`、`problems: []`；`list` 与 4.1 记下的**完全一样**（同样的制度、同样的条数）。

- 冲突那条（4.4）本应一条不写。`list` 里要是出现了 `e2e-conflict-1030`（被误写进去了），也照样单独确认后删掉：`NEXUS_A2A_URL=https://<env>.<domain>/a2a/<PUBLISH_ID> node repo/knowledgebase-writer-agent-pg/scripts/a2a_rules.mjs delete '{"source_id": "e2e-conflict-1030"}'`。
- 哪一步失败了，也要把已经写进去的虚构制度删掉（`e2e-matrix-1030`、`e2e-conflict-1030`、`e2e-prose-md`、`e2e-prose-pdf`、`e2e-prose-xlsx` 里 `list` 列出的那几份，每一份单独确认），再停下来报告。

**4.6（可选）真实制度再入库，应一条不写。** 要用户提供原文件。预览和入库用**同一组参数**：原来的 `source_id`、`list` 里的 `source_version`，附件用原来的文件名、不传 `title`（每条规则的 `source_doc` 取附件文件名，要与 `list` 里的 `title` 一字不差，可能带 `.docx`）：

```bash
NEXUS_A2A_URL=https://<env>.<domain>/a2a/<PUBLISH_ID> node repo/knowledgebase-writer-agent-pg/scripts/a2a_rules.mjs preview '{"source_id": "<SOURCE_ID>", "source_version": "<list 里的 source_version>"}' <原文件>
NEXUS_A2A_URL=https://<env>.<domain>/a2a/<PUBLISH_ID> node repo/knowledgebase-writer-agent-pg/scripts/a2a_rules.mjs ingest '{"source_id": "<SOURCE_ID>", "source_version": "<list 里的 source_version>"}' <原文件>
```

只有预览的 `will_insert`、`will_update`、`will_remove` 都为空、`unchanged` 等于 `rules_total` 时，才（经同意）跑第二条，应是 `skipped`、`written` 0。预览有任何变化就停。

**闸门 4**：上面每一条的结果都对；`list` 回到基准；`check` 通过；回归跑过的话日志已清。

## 阶段 5　交接

1. **发布编号交给前端团队**：`<PUBLISH_ID>`（例如测试台的配置键 `KB_PG_PUBLICATION_ID`）。
2. **前端用的调用密钥另发一把**，不要用 `.state/a2a-call-key`：请用户在网页发布详情里新建，或（经同意）`bash repo/knowledgebase-writer-agent-pg/scripts/admin_run.sh issue-call-key --publish-id <PUBLISH_ID> --label <标签> --out <另一个 600 文件的路径>`，由用户经安全渠道交给前端。你不读、不转述它。
3. **给用户的报告**：建了什么（`<AGENT_ID>`、`<DIR_NAME>` 与 3 个 `tool_id`、绑定、`<PUBLISH_ID>`、`<CREDENTIAL_ID>`）、每个闸门的结果（数字）、知识库状态（行数、登记的模型）、用了多久。
4. **待清理清单**（每一项单独确认，你不自己删）：

| 项 | 怎么做 |
|---|---|
| 自测调用密钥 | 请用户在网页上停用（发布详情 › 调用密钥，`<CREDENTIAL_ID>` 那一把）。经 Operator 的 `call DELETE /api/v2/publications/<PUBLISH_ID>/keys/<CREDENTIAL_ID>` 多半会被拒（缺省的「搭建」档不含删除，退出码 4），不要换接口绕过。停用后再删本机 `repo/knowledgebase-writer-agent-pg/.state/a2a-call-key` |
| 测试会话（3.6 的 `pg-kb smoke`、4.3 的 `pg-kb e2e` 和它的附件；`verify --e2e` 的已在回收站） | 网页上删 |
| 复制 Agent 时带来的旧工具目录 | 网页上看，确认没被提示词引用后删。删工具目录要**管理员**（Operator 的连接档位没有 `tool:delete`，参考环境实测 403）：请用户在网页「工具」里删，或管理员令牌对每个工具调 `DELETE /api/v2/tools/registered/<TOOL_ID>` |
| `<RULES_TABLE>_titan_backup`（只有 2B） | 留到项目负责人决定；删了就不能回退到 Titan。删时以 postgres 在主机上 `DROP TABLE` |
| 实例角色里的 Titan 权限（只有 2B） | 切换稳定、确认不再回退后再去掉（同样只改那一条） |
| `<WORKDIR>`、`repo/knowledgebase-writer-agent-pg/.build/e2e/` | 本机文件，用户自己删 |

5. **以后**：改了工具代码，重打后先 `bash repo/knowledgebase-writer-agent-pg/scripts/admin_run.sh check --module pg --tool-id <TOOL_ID> --expect-version <N>` 看变化，经同意再把 `check` 换成 `publish` 发新版本（`<TOOL_ID>` 取三个工具里任一个，`<N>` 是服务端现在的版本，对不上脚本就停），然后 `verify`。重存提示词、回滚、整个撤掉见 `repo/knowledgebase-writer-agent-pg/README.md` 第 10、17 节；知识库本身见 `repo/kb/GUIDE.md`。

## 附　出错时

| 现象 | 回到哪 |
|---|---|
| `credentials_missing` | 3.4 绑定（属主身份）；经网页导入过的：3.2 用脚本重导 |
| `db_unavailable` | `repo/kb/GUIDE.md` 9.1、9.2：PG 是否在跑、安全组、`vm_egress.allow_cidrs`、密钥 `pg_kb` 的字段；「知识库正忙」等一两分钟 |
| `kb_not_ready` | 阶段 2：库里还是旧版 `kb_search.sql` |
| `embedding_failed`、Bedrock 403 | 2C：实例角色的权限；刚改过就等几分钟 |
| `rule_conflict`（真实制度） | 编号已属于另一份制度：停，交给用户 |
| `rate_limited` | 全库每分钟上限：等一分钟。这不是「没查到」 |
| Operator 退出码 3 | 重新接入（0.2） |
| Operator 退出码 4 | 第 0 节停止条件表里「退出码 4」那一行：档位、`key_not_usable`、删除类、`credential_forbidden_path` |
| Operator 退出码 9 | 正常：要用户确认（第 0 节的闸门） |
| `a2a_rules.mjs` 退出码 3、`调用密钥被拒` | 3.8 的密钥文件、发布是否还在 |
| 其他错误码 | `repo/knowledgebase-writer-agent-pg/README.md` 第 15 节 |

回滚由轻到重：提示词（3.5 用 `--output` 存下的是整个回复，提示词在 `data.content`：先 `python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1], encoding="utf-8")); d=d.get("data", d); json.dump({"content": d["content"], "file_type": "prompt"}, open(sys.argv[2], "w", encoding="utf-8"), ensure_ascii=False)' <WORKDIR>/prompt-before.json <WORKDIR>/prompt-rollback.json`，再 `python3 -I <OPERATOR_DIR>/scripts/nexus.py --profile <PROFILE> call PUT /api/v2/agents/<AGENT_ID>/files/prompt --data-file <WORKDIR>/prompt-rollback.json`，照第 0 节确认后加 `--yes`）→ 工具版本（管理员 `POST /api/v2/tools/registered/<TOOL_ID>/versions/<N>/activate`）→ 一份制度的数据（`deactivate` 可恢复，`delete` 不可恢复）→ 向量模型（2B 第 5 步的回退）→ 整个撤掉（删发布 → 删绑定 → 删工具目录 → 删 Agent，各自单独确认，请用户在网页上做；PG 里的数据不随之删除）。
