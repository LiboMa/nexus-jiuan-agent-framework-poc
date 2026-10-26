# pgvector-rules-kb

> 来源：`nexus-customer-deploy/pgvector-rules-kb`（2026-10-26 复制进本仓库，此后在这里维护）。在本仓库里和测试台共用一套 IaC：PG 跑在测试台实例上（existing 模式），PG 端口的入站规则由测试台的栈管，用 `poc/infra/kb.sh` 驱动本工具（它从栈里取实例、网段和 Nexus 地址，生成配置后调用 `kb/deploy.sh --config`）。单独部署到别的环境时照本文和 [GUIDE.md](GUIDE.md) 用 `deploy.env`。

把制度文档（审批矩阵格式的 .docx）做成规则库，存进 **PostgreSQL + pgvector**，经 **Nexus 数据连接器**接到**审核 Agent**：用户在 Nexus 对话里按制度查询审批规则、对单据做初审（通过 / 不通过，附规则编号与原文依据）。库里有**库内语义检索** `kb_search(问题, k)`：PG 里的 PL/Python 用主机的实例角色调 Bedrock 把问题向量化，Agent 经同一个连接器一条 SQL 就能检索。九安 v0.7.10 测试台的「规则库 › 制度知识库」页可以上传制度、看历史、检索、看检索日志（GUIDE 7.5）。

一份配置（`deploy.env`）+ 一条命令（`./deploy.sh all`）完成部署；全程幂等，可对已部署的环境重跑来接管或对齐。

```
用户 ─ Nexus 对话 ─ 审核 Agent（Sandbox VM）─ data_connector_* ─┐
                    Nexus API Server（测试连接 / Schema）──────────┼─→ PG 主机 <私网IP>:5432
                                                     VPC 内网，不经公网 ┘   pgvector · approval_rules
                                                                              kb_search() ── 实例角色 ──→ Bedrock
```

## 快速开始

```bash
cp deploy.env.example deploy.env && chmod 600 deploy.env
vi deploy.env                    # NEXUS_URL、管理员密码来源、PG 主机、RULES_DOCX
./deploy.sh preflight            # 只读预检
./deploy.sh all --dry-run        # 只读：看每个阶段会改什么
./deploy.sh all                  # 部署
./deploy.sh verify --e2e         # 端到端：规则问答 + A2A 三段式回归
```

阶段：`preflight → host → db → network → egress → connector → ingest → agent → verify`，可单独跑（`./deploy.sh ingest`）；另有 `status`、`destroy`、`rotate-db-password`（轮换数据库密码）、`api <path>`（调试）。

## 部署了什么

| 层 | 内容 |
|---|---|
| PG 主机 | 已有 EC2（existing）或 CloudFormation 新建的私网 EC2（create） |
| 数据库 | Docker `pgvector/pgvector:pg17`，只绑私网 IP；库 / 用户 / `vector` 扩展；容器里装 PL/Python（不重启），建 `kb_embed` / `kb_search`、上传历史、检索日志 |
| 网络 | 安全组放行 PG 端口 ← 私网段（独立 CloudFormation 栈） |
| Sandbox 出站 | Nexus `vm_egress.allow_cidrs` 并入 PG 网段（VM 默认丢弃所有私网目标） |
| Nexus | 数据库凭证密钥 + PostgreSQL 数据连接器 |
| 规则库 | `approval_rules`：每条审批路径一行，带检索全文与 1024 维向量（Titan v2） |
| 审核 Agent | 提示词第 7 条（运维 / 测验模式）、第 8 条（规则查询模式：先 `kb_search` 取候选） |

## 文档

- **[GUIDE.md](GUIDE.md)**：完整的配置参考、阶段详解、使用方法、规则库维护、排错手册、回滚、安全说明、给 Claude Code 的操作守则。
- [CLAUDE.md](CLAUDE.md)：Claude Code 在本目录工作的要点。

## 目录

```
deploy.sh               编排入口
deploy.env.example      配置模板（复制为 deploy.env；deploy.env 不进仓库）
lib/                    common.sh · nexus_api.py · parse_rules.py · ingest_rules.py · kb_admin.py（页面用的管理命令）
host/                   在 PG 主机上经 SSM 执行的脚本
cfn/                    CloudFormation：安全组入站规则 / 专用 PG 主机
sql/approval_rules.sql  规则表 DDL
sql/kb_search.sql       库内语义检索、上传历史、检索日志
agent/prompt-rules.txt  审核 Agent 提示词受管规则
tests/                  单元测试（只用仿真文档 fixtures/sample-matrix.docx）
```

## 依赖

本机：bash、AWS CLI v2、session-manager-plugin、uv、python3。AWS：EC2 / SSM / CloudFormation / Bedrock（Titan Embed Text v2）权限。PG 主机：实例角色能调这个嵌入模型、IMDS 跳数 ≥ 2、容器能连 Debian 软件源（GUIDE 2.4）。Nexus：管理员账号（在 v0.3.28 Enterprise 上验证）。
