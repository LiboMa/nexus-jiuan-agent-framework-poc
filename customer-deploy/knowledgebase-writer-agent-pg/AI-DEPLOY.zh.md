# 用编码工具经 Nexus Operator 部署：Kiro CLI / Claude Code / Codex

**你负责确认，编码工具负责照手册做。** 编码工具读部署手册 `repo/skills/pg-kb-steward-deploy/SKILL.md`，经 Nexus Operator（以你的身份、权限封顶「编辑者」）和本包的管理员脚本，把「知识库文档管家（PG 版）」部署到你的 Nexus 上。每一个写操作它都先给你看这一条的计划，你同意了这一条才执行；删除类操作每一项单独问，并说出删的是哪一个。

适用 Nexus v0.3.28。下文的路径都相对**交付 zip 解开后的根目录**（有 `START-HERE.md`、`repo/` 的那一层），命令也在那里执行。人自己动手的完整步骤见同目录的 `GUIDE.zh.md`；两条路做的是同一套步骤。

## 一页看懂

| 步骤 | 你做 | 编码工具做 | 大约 |
|---|---|---|---|
| 1 | 解开交付 zip、建管理员密码文件、在 Nexus 网页生成 API 密钥（同时下载 Operator 接入包） | — | 10 分钟 |
| 2 | 把 Operator 接入包装进编码工具 | — | 2 分钟 |
| 3 | 让编码工具加载部署手册 | — | 1 分钟 |
| 4 | 说一句「照 pg-kb-steward-deploy 部署到 <env>」，给它几项信息 | 接入 Operator、查前提、只读盘点，出一份方案 | 10 分钟 |
| 5 | 逐步确认 | 知识库 → Agent → 端到端，每步核对 | 1.5–2.5 小时 |
| 6 | 收下报告，决定待清理的每一项 | 交接：发布编号、核对结果、清单 | 10 分钟 |

## 1　准备（你亲手做）

**解开交付 zip 并核对：**

```bash
unzip knowledgebase-writer-agent-pg-1.0.1.zip
cd knowledgebase-writer-agent-pg-1.0.1
shasum -a 256 -c --quiet SHA256SUMS && echo 全部一致      # Linux：sha256sum -c --quiet SHA256SUMS && echo 全部一致；对不上的文件会列出来
```

**管理员密码文件**（只给管理员脚本读；编码工具只查它的权限，不读内容。管理员密码从没在网页上改过的话，也可以不建这个文件，让脚本经 SSM 密封读取部署机上 `deploy.yaml` 里的 `auth_password`：参考环境用的就是这种方式，见部署手册 3.0）：

```bash
umask 077; cat > ~/.nexus-admin-password       # 输入 Nexus 管理员密码，回车，再按 Ctrl-D
ls -l ~/.nexus-admin-password                  # 应是 -rw-------
```

**Operator 接入包：** 用 Nexus **管理员账号**登录网页 →「个人设置 › API 密钥」→ 生成一把密钥，**权限档位用缺省的「搭建」**。浏览器会同时下载接入包 `nexus-ai-operator`，里面带着这把还没用过的密钥和平台地址。

- 为什么用管理员账号生成：Agent、发布、数据库密钥、密钥绑定都归同一个人。参考环境（v0.3.28）就是这样做的：经 API 密钥的权限封顶「编辑者」，列 Agent / 密钥 / 需要密钥的工具 / 连接器、复制 Agent、绑定密钥、读写提示词、开会话并带附件对话、建 A2A / MCP 发布都做成了；这些写操作只要 `--yes`（不要 `--confirm-destructive`），每一条都先给你看，你同意了它才加上。
- 导入工具、发布工具新版本只对管理员开放，由本包的管理员脚本做。**调用密钥经 API 密钥发不了**（平台只让登录的本人签发这类长期凭证）：由发布的属主在网页发布详情里新建，或由管理员脚本 `issue-call-key` 发。
- 为什么是「搭建」档：每把密钥（一条「连接」）都带权限档位，复制、绑定、存提示词、开会话、发布都要「搭建」；「只读」「日常使用」做不了。「搭建」档不含删除，所以清理时经 Nexus 的删除（停用调用密钥、删测试会话、删工具目录……）由你在网页上做。
- 一个接入包只交给一个编码工具；第一次连接时平台把包里的密钥换新、只存在这台电脑上，包里那把随即作废。要给第二个工具，就在网页上再生成一把。
- 随时可以在同一页停用这把密钥，编码工具立刻无法再访问平台。

**本机工具**：`python3` 3.9+、`bash` 4+（macOS 自带 3.2，`brew install bash`）、[uv](https://docs.astral.sh/uv/)、Node 18.17+（A2A 客户端用到 `AbortSignal.any`）、AWS CLI v2（凭证能管 PG 主机所在的账号）与 session-manager-plugin、`curl`。

**先想好这几项**，开口时一起告诉编码工具：

| 项 | 什么时候要 |
|---|---|
| 知识库现在的情况：全新 / 以前部署过（旧的部署目录在哪）/ 还是 Titan 向量 / 已经是 Cohere | 都要 |
| 制度原文 .docx 的路径（放在 zip 目录之外） | 全新环境 |
| 检索回归题库目录（项目方单独提供，放在 zip 目录之外） | 已有的 Titan 库要换成 Cohere 时 |
| 复制哪个 Agent（首选 `knowbase_writer_agent`；没有就用你的任何一个普通 Agent，不要用审核 Agent。Nexus 上一个都没有时，先在网页上建一个：走「创建 Agent」的引导流程或从模板建） | 都要（不确定就让它建议） |

## 2　把 Operator 装进编码工具

把下载的 `nexus-ai-operator` 整个文件夹放进编码工具的技能目录（个人目录对所有项目生效），然后重启一次编码工具：

| 编码工具 | 个人目录 | 只对一个项目 |
|---|---|---|
| Claude Code | `~/.claude/skills/nexus-ai-operator/` | `<项目>/.claude/skills/nexus-ai-operator/` |
| Kiro CLI | `~/.kiro/skills/nexus-ai-operator/` | `<项目>/.kiro/skills/nexus-ai-operator/` |
| Codex | `~/.agents/skills/nexus-ai-operator/`（较早的版本读 `~/.codex/skills/`） | `<项目>/.agents/skills/nexus-ai-operator/` |

例如 Claude Code：

```bash
mkdir -p ~/.claude/skills && cp -R <下载解开的目录>/nexus-ai-operator ~/.claude/skills/
```

- 这几个位置取自 Operator 接入包自带的 `README.md`。部署手册里的 `<OPERATOR_DIR>` 就是你放的位置。
- Operator 只要 Python 3.9+，不用装依赖。接入包里的 `config/connection.json` 带着密钥：不要拷给别人、不要放进 git。
- 部署手册里调 Operator 一律写成 `python3 -I <OPERATOR_DIR>/scripts/nexus.py …`，所以编码工具即使不把它当技能加载，只要知道接入包在哪就能用。

## 3　让编码工具加载部署手册

部署手册只有一份：`repo/skills/pg-kb-steward-deploy/SKILL.md`（Claude Code Skill 格式；Kiro CLI、Codex 也照它做）。在 zip 解开的根目录里：

**Claude Code**：把手册放进项目的技能目录，再在这个目录里启动 Claude Code。

```bash
mkdir -p .claude/skills && cp -R repo/skills/pg-kb-steward-deploy .claude/skills/
claude
```

Claude Code 从项目的 `.claude/skills/<名字>/SKILL.md`（以及个人的 `~/.claude/skills/`）加载技能，按描述自动选用；你在开口时点名 `pg-kb-steward-deploy` 最稳。

**Kiro CLI**：把指针文件放进工作区的 steering 目录，再在这个目录里启动。

```bash
mkdir -p .kiro/steering && cp kiro/steering/pg-kb-steward-deploy.md .kiro/steering/
kiro-cli chat
```

- Steering 是放在 `.kiro/steering/`（工作区）或 `~/.kiro/steering/`（全局）下的 Markdown 文件，Kiro 把它们当作常驻说明放进对话上下文。这个文件只是一个指针，告诉 Kiro 先读部署手册，不复制手册的内容。
- 本机核对过（kiro-cli 2.35.1）：默认 Agent 的上下文还包括工作区的 `AGENTS.md`、`README.md`，并把 `.kiro/skills/*/SKILL.md` 当技能加载；本包根目录已经有一份指向手册的 `AGENTS.md`。进入对话后用 `/context show` 看实际载入了哪些文件。
- 用自定义 Agent（`kiro-cli chat --agent <名字>`）时，只有它配置里 `resources` 列的文件会载入：给它加上 `"file://.kiro/steering/**/*.md"`（或 `"file://AGENTS.md"`）。

**Codex**：根目录已经有 `AGENTS.md`（指向部署手册），在这个目录里启动 Codex 即可，它会读工作目录的 `AGENTS.md`。

```bash
codex
```

**别的编码工具**：开口时让它「先完整读 `repo/skills/pg-kb-steward-deploy/SKILL.md`，再照它做」。

**保留编码工具自己的审批**：不要用跳过确认的启动方式（Claude Code 的 `--dangerously-skip-permissions`、Kiro CLI 的 `-a` / `--trust-all-tools`；Codex 保留默认的审批设置）。手册里的确认是第一道闸，编码工具对每条命令的审批是第二道。

## 4　对话怎么开头

照这个样子说（尖括号换成你的值；这些都不是机密，密码和密钥不要写进来）：

```text
照 pg-kb-steward-deploy 部署到 <env>。
- Nexus：https://<env>.<domain>；Operator 接入包在 <OPERATOR_DIR>，profile 用 <PROFILE>
- 管理员密码：文件 <ADMIN_PW_FILE>（600，你只查权限，不要读内容）；或经 SSM 读：部署机 <实例 ID>、deploy.yaml 在 <绝对路径>
- 知识库：<全新 / 以前部署过，旧目录在 …，现在是 Titan / 已经是 Cohere>
- 复制来源：knowbase_writer_agent（没有就建议一个；不要用审核 Agent）
- 回归题库：<QDIR>（只有 Titan 库要换模型才要）
- 制度原文：<路径>（只有全新环境才要）
先做阶段 0 和阶段 1，把盘点结果和方案给我看。
```

它会先接入 Operator（`login --client kiro|claude_code|codex`、`whoami`：平台版本、用户、权限档位），检查本机工具和密码文件的权限，再只读地盘点：平台版本、可以复制的 Agent、`database_credentials` 类型的密钥、连接器、已有的发布与工具目录、PG 知识库的状态和库里登记的向量模型。然后给你一张表和一份方案，等你确认。

## 5　它会在哪些地方停下来问你

| 阶段 | 它给你看什么 | 你看什么 |
|---|---|---|
| 0 接入与前提 | `whoami`、工具版本、密码文件权限 | 平台是 v0.3.28（不是就停，先预演再说）；身份是你预期的那个账号；权限档位是 `builder`（「搭建」） |
| 1 盘点 | 盘点表、要走的分支、复制来源、密钥、新 Agent 的名字 | 有没有已经部署过的同名 Agent / 工具目录 / 发布 |
| 2A 新知识库 | `deploy.sh all --dry-run` 的 `~` 行；`verify --e2e` 之前再问一次 | 只该有你预期的改动（主机、容器、网络、连接器、入库条数、审核 Agent 补丁） |
| 2B Titan 换 Cohere | 每次 `regress`（会往检索日志里记题目）；先装新版检索函数；IAM 变更集或内联策略；主机上的探测；`db --dry-run --migrate-embeddings`；`--compare` 的结果；清检索日志 | 变更集只改那一条策略；前 5 命中不降；已知问题都过。降了它会停，给你回退的办法 |
| 3 Agent | 复制请求；导入计划（6 个文件、3 个工具都声明 `pg_kb` 密钥）；绑定请求；保存提示词；冒烟会话（两条只读的消息）；发布（对外开放）；发自测调用密钥 | `verify` 3 个 `configured=True`、6 个文件一致；对话能列出制度；公开名片的输入类型有 docx / xlsx / pdf / markdown；A2A `describe` 合格 |
| 4 端到端 | 先把整个计划给你看一遍（会往共用规则表里临时写虚构规则，几分钟后删掉，挑没人审单的时间）：A2A 预览；在测试会话里上传虚构矩阵当附件、说「入库」，Agent 先预览并等确认，再「确认写入」；A2A 检索、下线、恢复、冲突、正文三种格式、校验；可选的真实制度再入库（先预览）。之后每一条写操作在轮到它时再单独问你；删除 4 份虚构制度是 4 次单独的确认，每次说出 `source_id` | 对话里 Agent 没确认前一条不写；每一步的计数对得上；最后 `list` 与开始时完全一样、`check` 通过 |
| 5 交接 | 报告；待清理清单 | 每一项清理单独决定 |

它还会在这些情况下停下来：结果和手册写的对不上、出现手册列的停止条件（比如变更集里多了别的资源、回归变差、`credentials_missing`、刚改完 IAM 就 403）、或者需要它读出某个密码。你说「停」，它就停。

## 6　它绝不会做的事

- 没经你同意这一条就执行写操作；预先或批量加上 `--yes`；把好几个删除合在一起问（每个删除单独问，说出删的是哪一个）。
- 读出、打印、复述任何密码或密钥：管理员密码只在你的 600 文件里，调用密钥直接写进 600 文件，数据库密码由知识库脚本加密读取后存进 Nexus。
- 用网页「导入工具」导入这三个工具（会被登记成「不需要密钥」，调用时报 `credentials_missing`，事后补不了）；用「项目备份」恢复来交付 Agent。
- 对真实制度执行下线或删除；把制度原文、回归题目贴进对话。
- 改审核 Agent 提示词里知识库脚本受管范围之外的内容。
- 删除备份表 `<RULES_TABLE>_titan_backup`（缺省 `approval_rules_titan_backup`；留给项目负责人决定）。
- 提交或推送 git。

## 7　要你亲手做的

- 在 Nexus 网页生成 API 密钥（「搭建」档，下载接入包）；建管理员密码文件。Nexus 上没有可以复制的 Agent 时，先在网页上建一个。
- 接入包里没有密钥时，自己在终端里运行 `login … --token-stdin` 粘贴密钥（不要贴进对话）。
- 编码工具每条命令的审批。
- 把前端用的调用密钥经安全渠道交给前端团队（另发一把，不用自测那把）。
- 决定待清理清单里的每一项、备份表的去留；经 Nexus 的删除（停用调用密钥、删测试会话、删旧工具目录）在网页上做。

## 8　出问题时

| 现象 | 怎么办 |
|---|---|
| 编码工具说没找到部署手册 | 确认在 zip 解开的根目录里启动；Claude Code 看 `.claude/skills/pg-kb-steward-deploy/SKILL.md` 在不在；Kiro CLI 用 `/context show` 看 |
| Operator 退出码 3（要重新连接） | 在网页上重新生成一把 API 密钥，把新的接入包交给它 |
| Operator 退出码 9 | 正常：它在等你确认 |
| Operator 退出码 4（权限不足） | 多半是这把 API 密钥的权限档位不是「搭建」：在网页「个人设置 › API 密钥」改成「搭建」（约 30 秒后生效）。删除时报的：「搭建」档不含删除，在网页上删。绑定时报 `key_not_usable`：这把数据库密钥对你这个账号不可用 |
| 它想跳过确认、或要你把密码贴进对话 | 说「停」，提醒它照手册第 0 节；必要时结束会话 |
| 部署中途断了 | 重新开口时说「接着照 pg-kb-steward-deploy 做，上次做到 …」：它会先只读地核对现状（`.state/import.json`、`verify`、`list`），不重复做写操作 |
| 工具报错码 | 手册「附　出错时」；完整的错误码表在 `repo/knowledgebase-writer-agent-pg/README.md` 第 15 节 |
