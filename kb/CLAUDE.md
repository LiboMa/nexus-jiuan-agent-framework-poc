# pgvector-rules-kb：给 Claude Code 的工作说明

在这个目录里部署或调试「规则库（PostgreSQL + pgvector）→ Nexus 连接器 → 审核 Agent」时，先读 `GUIDE.md`：第 1 节看架构，第 5 节看各阶段做什么，第 9 节排错，第 12 节是操作守则。下面是最容易出错的几条，摘出来放在这里。

## 硬规则

- 先只读：`./deploy.sh preflight` → `./deploy.sh <阶段> --dry-run`，把 `~` 行（将要做的改动）告诉用户，确认后再实跑。对线上环境的 `destroy`、重建容器、重启 Sandbox 节点逐项确认。
- 不打印机密：不 `cat` 主机上的 `<PG_BASE_DIR>/.env`、本机 `.build/secrets.*`，不调密钥的 `/secret` 接口给人看。看 Nexus 数据用 `./deploy.sh api <path>`。
- 说「通了」之前要有证据：`./deploy.sh verify` 的 ✓ 行，或 `verify --e2e` 写出的 `.build/e2e-result.json`。
- Agent 提示词只经 `agent/prompt-rules.txt` + `./deploy.sh agent` 修改；受管范围是第 4 条括注、第 7、8 条。提示词里别的内容（参考环境有第 9 条「信封模式」等）原样保留，不要整份覆盖。改完必须跑 `verify --e2e`。
- 仓库里不写环境信息：`deploy.env`、`.state/`、`.build/`、`*.docx` 已被忽略；文档只用占位符。
- 提交前先完成 E2E 并经用户确认。
- 2026-10-31 起参考环境的 PG 知识库已由分支 `feat/pg-kb-steward` 换成 Cohere Embed v4（1024 维），Bedrock 权限（`KbBedrockPolicy`）也跟着改了。这个分支合并之前：不从本目录跑 `db` / `all` / `ingest` 阶段（这里的 `sql/kb_search.sql` 会把 Titan 的 `kb_embed` 装回去），测试台只用 `poc/infra/deploy.sh --code-only` 部署（整栈部署会把 Bedrock 权限改回去）。现在在线的规则是「审批风险判断卡」（`risk-cards`），旧的 `finance-approval-v4` 已下线（可恢复）。

## 排错捷径

| 症状 | 先看 |
|---|---|
| 「测试连接」失败 | `verify` 的 `[db]` / `[network]` 行；主机 `docker logs nexus-pgvector` |
| 测试连接正常、Agent 连不上 | Sandbox 节点 `nft list set inet nexus_vm egress_allow`（配置改动约 5 分钟生效） |
| `Query execution failed` | PG 日志 `docker logs --since 15m nexus-pgvector \| grep -E "ERROR\|STATEMENT"`；常见原因是工具自动追加 `LIMIT`（向量要写 `'[…]'::vector`，DDL 要预先建表） |
| Agent 不调工具 / 用了旧规则 | 会话是否绑了连接器；改过提示词后要新建会话重新绑定 |

## 环境

本机 shell 是 zsh（`deploy.sh` 由 bash 执行，不受影响）。在 zsh 里直接拼命令：变量后接 `:` 写 `${var}:`；不要用 `path` 做变量名；通配参数加引号。
