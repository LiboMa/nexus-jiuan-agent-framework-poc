# 知识库文档管家（PG 版）：交付件

**一页看懂。** 「知识库文档管家（PG 版）」（`knowledgebase_writer_agent_pg`）是 Nexus 上的一个 Agent：把制度文档（Word / Excel / PDF / Markdown）写进审核 Agent 共用的 PostgreSQL + pgvector 规则库，并提供检索与管理；发布成 A2A / MCP，给前端的「制度知识库」页调用，人也可以在 Nexus 对话里直接用。

适用 Nexus v0.3.28 · us-east-1 · 交付版本 1.0.1 · 工具包来源提交 `ec280c1`

| 它做什么 | 怎么做 |
|---|---|
| 入库 | `rules_writer`：审批矩阵一行一条，正文按条一条；同一份再传一条不写；新版本只写变了的；编号撞上别的制度整份拒绝；可以只预览 |
| 检索 | `rules_search`：调库里的 `kb_search`，与审核 Agent 同一个函数 |
| 管理 | `rules_manager`：支持的操作、清单、详情、下线、恢复、删除、一致性校验 |
| 向量 | 只在库里算：PG 主机的实例角色调 Bedrock Cohere Embed v4（1024 维）；工具不调 Bedrock |
| 凭证 | Nexus 密钥 `pg_kb`（`database_credentials`）由平台注入，工具经私网直连 PG |

**能运行的代码在交付 zip 里。** 本目录只放文档、部署手册和发布产物；部署时解开 `release/knowledgebase-writer-agent-pg-1.0.1.zip`，**所有命令都在 zip 解开后的根目录执行**（它的 `repo/` 保持了脚本互相查找的相对路径）。

## 从哪里开始

| 你要 | 看 |
|---|---|
| 自己动手部署 | [`GUIDE.zh.md`](GUIDE.zh.md)：真实环境部署指南，一步一步照着做 |
| 让编码工具（Kiro CLI、Claude Code、Codex）经 Nexus Operator 部署 | [`AI-DEPLOY.zh.md`](AI-DEPLOY.zh.md)：怎么接入 Operator、怎么加载部署手册、对话怎么开头、它会在哪里停下来问你 |
| 只把工具包导入 Nexus | 交付 zip 里的 `nexus/IMPORT.md`（源文件 [`zip-root/nexus/IMPORT.md`](zip-root/nexus/IMPORT.md)）：管理员脚本一条命令、纯 API 脚本 `nexus/import-api.sh`，以及网页「导入工具」为什么不行 |
| 了解做了什么、实测结果、已知限制 | [`DELIVERY.zh.md`](DELIVERY.zh.md) |

两条部署路做的是同一套步骤，只是谁来敲命令不同：

```
人  ── GUIDE.zh.md ──────────────────────┐
                                          ├─→ 0 前提 → 1 盘点 → 2 PG 知识库 → 3 Agent（复制 · 导入工具 · 绑密钥 · 提示词 · 发布）→ 4 端到端 → 5 交接
编码工具 ── AI-DEPLOY.zh.md → SKILL.md ──┘     每个写操作先给人看这一条的计划，人确认后才执行；删除每项单独确认
            （经 Nexus Operator + 管理员脚本）
```

先知道三件事：

1. **工具只能经脚本或 API 导入。** 网页「导入工具」不会声明数据库密钥，工具会被登记成「不需要密钥」，调用时报 `credentials_missing`；v0.3.28 也没有事后补登记的接口。
2. **Agent 不随包导入。** 在客户的 Nexus 上复制一个现有 Agent，再保存本包的提示词。不用「项目备份」恢复：备份带着原环境的密钥引用。
3. **密码、密钥不进对话、不进命令行。** 管理员密码放本机 600 文件，调用密钥由脚本直接写进 600 文件，数据库密码由知识库脚本加密读取后存进 Nexus。

## 交付 zip 里有什么

```
knowledgebase-writer-agent-pg-1.0.1/
  START-HERE.md     先看：三分钟选路、清单、版本与校验
  SHA256SUMS        每个文件的 sha256
  AGENTS.md         给编码工具的指针 → 部署手册（Codex、Kiro CLI 会自动读）
  kiro/steering/    Kiro CLI 的 steering 指针（拷进 .kiro/steering/）
  docs/             GUIDE.zh.md、AI-DEPLOY.zh.md、DELIVERY.zh.md、assets/*.svg
  nexus/            pg_kb_tools.zip（预打好的工具包）、MANIFEST.json（逐文件 sha256）、IMPORT.md、import-api.sh（纯 API 导入脚本）
  repo/             kb/（PG 知识库）、knowledgebase-writer-agent-pg/（工具、提示词、管理员脚本、A2A 自测、测试）、
                    knowbase-s3vectors-agent/（共用的管理员脚本、上传会话附件的 e2e_upload.py）、poc/（A2A 客户端 3 个文件）、
                    skills/pg-kb-steward-deploy/SKILL.md（部署手册）
```

## 本目录的文件

| 文件 | 内容 |
|---|---|
| `README.md` | 本页 |
| `GUIDE.zh.md` | 真实环境部署指南（人照着做） |
| `AI-DEPLOY.zh.md` | 用 Kiro CLI / Claude Code / Codex 经 Operator 部署 |
| `DELIVERY.zh.md` | 交付说明：做了什么、为什么这样设计、怎么证明能用、已知限制 |
| `skill/SKILL.md` | 部署手册本体（Claude Code Skill 格式）；打包时放到 zip 的 `repo/skills/pg-kb-steward-deploy/SKILL.md` |
| `AGENTS.md`、`kiro/steering/pg-kb-steward-deploy.md` | 指向部署手册的薄指针，不复制内容；打包时放到 zip 根目录 |
| `zip-root/` | 放到 zip 根目录的 `START-HERE.md`、`nexus/IMPORT.md` 与 `nexus/import-api.sh` |
| `assets/*.svg`、`build/figures.py` | 配图与生成它们的脚本 |
| `make_release.sh` | 组装交付 zip 并自检 |
| `release/` | 产物：`knowledgebase-writer-agent-pg-1.0.1.zip`、`pg_kb_tools.zip`（单独一份，方便直接导入）、`SHA256SUMS` |

## 重新打包

```bash
bash make_release.sh --source <去敏后的源码目录> \
  --tools-zip <开发仓库>/knowledgebase-writer-agent-pg/.build/pg_kb_tools.zip \
  --manifest  <开发仓库>/knowledgebase-writer-agent-pg/.build/MANIFEST.json \
  --version 1.0.1
```

- `--source` 是开发仓库 `docs/delivery/make-package.sh --export` 产出的去敏源码；代码只从这里取。
- 只收白名单里的文件；工具包与 `MANIFEST.json` 逐文件 sha256 对不上、暂存目录里（含 zip / docx / xlsx 里的每个成员）出现真实环境的编号（域名、账号、实例、私网 IP、密钥 / 发布 / Agent / 工具目录编号、测试台的主机路径与服务名）或形似密钥的串、或混进 `.build/`、`.state/`、`deploy.env`、缓存、虚构样例之外的 `.docx`，就拒绝打包，只打印文件名。去敏词表以加盐哈希内置，脚本里不写明文；另加的词用 `--deny-file`（放在交付仓库之外）。
- 文件按路径排序、时间戳固定：同样的输入打出同样的字节。
- 打完在一个干净的临时目录里解开自检（不连任何服务）：`SHA256SUMS`；工具包与 `MANIFEST.json`；`kb/deploy.sh --help`、`admin_run.sh --help`；`bash -n nexus/import-api.sh` 与它的 `--help`；`nexus/IMPORT.md` 的确认请求模板与 `nexus_admin.py` 实际发的声明逐字相同；`render.py prompt` 引用 3 个工具；`build_tools.py` 重打出与 `MANIFEST.json` 相同的 6 个文件（解开的目录不是 git 仓库，重打时记的提交号是 `unknown`，换回 `MANIFEST.json` 的提交号后逐字节相同）；`node --check a2a_rules.mjs`；解析虚构样例；重新打包与发布的 zip 逐字节相同。
- 交付文档（`GUIDE.zh.md`、`DELIVERY.zh.md`、`assets/*.svg`）还没写好时跳过并提示，写好后重跑一次。

校验产物：

```bash
cd release && shasum -a 256 -c --quiet SHA256SUMS && echo 全部一致      # Linux：sha256sum -c --quiet SHA256SUMS && echo 全部一致
```
