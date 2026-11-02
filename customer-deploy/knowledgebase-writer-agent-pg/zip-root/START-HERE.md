# 知识库文档管家（PG 版）· 交付包 @VERSION@

**先看这一页。** 它告诉你包里有什么、从哪一步开始、怎么核对这个包没被改过。

「知识库文档管家（PG 版）」（`knowledgebase_writer_agent_pg`）是 Nexus 上的一个 Agent：把制度文档（Word / Excel / PDF / Markdown）写进审核 Agent 共用的 PostgreSQL 规则库，并提供检索与管理；发布成 A2A / MCP，给前端的「制度知识库」页调用，人也可以在 Nexus 对话里直接用。它只经三个工具做事：`rules_writer`（入库，可只预览）、`rules_search`（检索）、`rules_manager`（清单、详情、下线、恢复、删除、校验）。向量只在库里算（Cohere Embed v4，1024 维），工具不调 Bedrock。

适用 Nexus v0.3.28 · us-east-1。下文的路径都相对本目录（解开后有 `START-HERE.md`、`docs/`、`nexus/`、`repo/` 的这一层），**命令也都在这里执行**。

## 三分钟选路

| 你是 | 从这里开始 | 大约 |
|---|---|---|
| **自己动手部署的人** | [`docs/GUIDE.zh.md`](docs/GUIDE.zh.md)：真实环境部署指南，一步一步照着做 | 2–3 小时（含知识库与端到端） |
| **让编码工具（Kiro CLI、Claude Code、Codex）经 Nexus Operator 部署** | [`docs/AI-DEPLOY.zh.md`](docs/AI-DEPLOY.zh.md)：怎么接入 Operator、怎么让工具加载部署手册、对话怎么开头、它会在哪些地方停下来问你 | 同上，你只需逐步确认 |
| **只想把工具包导入 Nexus** | [`nexus/IMPORT.md`](nexus/IMPORT.md)：管理员脚本一条命令、纯 API 脚本 `nexus/import-api.sh` 两种做法，以及网页「导入工具」为什么不行 | 5 分钟 |
| **想先了解做了什么、实测结果、已知限制** | [`docs/DELIVERY.zh.md`](docs/DELIVERY.zh.md) | 10 分钟阅读 |

不管走哪条路，有三件事先知道：

1. **工具只能经脚本或 API 导入**，不能用网页「导入工具」：网页导入不会声明数据库密钥，调用时报 `credentials_missing`，事后也补不了（[`nexus/IMPORT.md`](nexus/IMPORT.md) 第 ③ 节）。
2. **Agent 不随包导入**：在你的 Nexus 上复制一个现有 Agent，再保存本包的提示词（两次 Operator 调用）。不用「项目备份」恢复：备份带着原环境的密钥引用。
3. **每一个写操作先看这一条的计划、确认后再执行**，删除类操作每一项单独确认；密码、密钥只放本机 600 文件，不贴进对话、不进命令行。

## 包里有什么

```
START-HERE.md                 本页
SHA256SUMS                    包里每个文件的 sha256
AGENTS.md                     给编码工具的指针（Codex、Kiro CLI 会自动读）→ 部署手册
kiro/steering/                Kiro CLI 的 steering 文件（拷进 .kiro/steering/ 用）→ 部署手册
docs/
  GUIDE.zh.md                 真实环境部署指南（人照着做）
  AI-DEPLOY.zh.md             用编码工具经 Operator 部署
  DELIVERY.zh.md              交付说明：做了什么、为什么这样设计、实测数字、已知限制
  assets/*.svg                配图
nexus/
  pg_kb_tools.zip             预打好的工具包：入口 pg_kb_tools.py + 5 个核心模块，直接导入 Nexus
  MANIFEST.json               工具包逐文件 sha256 与来源提交
  IMPORT.md                   这个工具包怎么导入
  import-api.sh               纯 API 导入的脚本（管理员脚本跑不了时用；只要 bash、curl、python3）
repo/                         源码与脚本（保持原仓库的相对路径，脚本靠它互相找到）
  kb/                         PG 知识库：deploy.sh 一条命令部署、检索回归、换向量模型；GUIDE.md 是它的完整说明
  knowledgebase-writer-agent-pg/   工具源码、提示词模板、包描述、管理员脚本、A2A 自测、端到端文档生成器、本机测试
  knowbase-s3vectors-agent/   两个文档管家共用的管理员脚本（nexus_admin.py、render.py、admin_run.sh）、上传会话附件的 e2e_upload.py、包描述
  poc/                        A2A 自测用到的前端客户端（3 个文件）
  skills/pg-kb-steward-deploy/SKILL.md   部署手册：编码工具照它做（人也可以读）
```

不在包里、要你自己准备的（逐项说明见 [`docs/GUIDE.zh.md`](docs/GUIDE.zh.md) 第 0 节「准备」）：

| 什么 | 从哪来 |
|---|---|
| Nexus v0.3.28 和一个管理员账号 | 你的环境。只在 v0.3.28 上验证过：别的版本先停下、先跑预演 |
| 一个可以复制的 Agent | Nexus 上已有的任何一个普通 Agent（不要用审核 Agent）。一个都没有就先在网页上建一个（「创建 Agent」的引导流程或模板） |
| Nexus Operator 接入包（`nexus-ai-operator`） | 你的 Nexus 网页「个人设置 › API 密钥」生成密钥时下载；权限档位用缺省的「搭建」 |
| Nexus 管理员密码 | 存进本机一个 600 文件（`umask 077` 后自己写入），只给管理员脚本读 |
| AWS 权限 | 本机的 AWS 身份要能查 EC2、经 SSM 远程执行与端口转发、建 CloudFormation 栈与变更集；新建 PG 主机还要能建 EC2、安全组、IAM 角色；改已有主机的实例角色要 `iam:PutRolePolicy`（清单见 GUIDE 附录 B） |
| Bedrock 模型访问 | 区域里开通 **Cohere Embed v4**（`us.cohere.embed-v4:0`，路由到 us-east-1 / us-east-2 / us-west-2） |
| PG 主机 | 二选一：一台已有的 EC2（SSM 在线、与 Nexus 私网互通），或 Nexus VPC 里一个有 NAT 出网的私有子网（由脚本新建主机） |
| 制度原文（.docx） | 你们自己的文件，放在本目录之外 |
| 检索回归题库（只有「已有 Titan 库换模型」才要） | 项目方单独提供，放在本目录之外 |
| 本机工具 | `python3` 3.9+、`bash` 4+（macOS 用 Homebrew 的 bash）、[uv](https://docs.astral.sh/uv/)、Node 18.17+（A2A 客户端用到 `AbortSignal.any`）、AWS CLI v2 与 session-manager-plugin、`curl` |

## 版本与校验

| 项 | 值 |
|---|---|
| 交付版本 | @VERSION@ |
| 工具包来源提交 | `@SOURCE_COMMIT@`（`nexus/MANIFEST.json` 的 `source_commit`；导入后 `describe` 回复里的 `build` 也是它） |
| `nexus/pg_kb_tools.zip` 的 sha256 | `@TOOLS_SHA256@` |

```bash
shasum -a 256 -c --quiet SHA256SUMS && echo 全部一致      # Linux：sha256sum -c --quiet SHA256SUMS && echo 全部一致；对不上的文件会列出来
```

这个包由交付仓库的 `make_release.sh` 组装：文件按路径排序、时间戳固定，同样的输入打出同样的字节；组装时已在干净的临时目录里解开自检过（脚本能运行、提示词能渲染、工具包能重新打出与 `MANIFEST.json` 相同的文件），并扫描过不含真实环境的编号与密钥。
