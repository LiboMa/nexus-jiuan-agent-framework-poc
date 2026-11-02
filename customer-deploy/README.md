# 客户部署交付件

给客户环境部署用的成品，原样从交付仓库 `nexus-customer-deploy` 收进来，随交付包发出。这里不改它们；要改就在交付仓库改好、重新打包，再整个目录拷回来。

| 目录 | 是什么 | 版本 |
|---|---|---|
| `knowledgebase-writer-agent-pg/` | 「知识库文档管家（PG 版）」的客户部署交付件：部署指南 `GUIDE.zh.md`、编码工具部署说明 `AI-DEPLOY.zh.md`、交付说明 `DELIVERY.zh.md`、部署手册 `skill/SKILL.md`、发布 zip `release/knowledgebase-writer-agent-pg-1.0.1.zip`（和单独的工具包 `release/pg_kb_tools.zip`）、打包脚本 `make_release.sh`。从它的 [README.md](knowledgebase-writer-agent-pg/README.md) 读起 | 1.0.1，工具包来源提交 `ec280c1` |

和仓库根目录的 `knowledgebase-writer-agent-pg/` 的关系：根目录那个是这个 Agent 的源码（工具、提示词、管理员脚本、测试）；这里的是给客户的成品，能运行的代码在发布 zip 里，是用 `docs/delivery/make-package.sh --export` 导出的去敏源码打的。交付件里说的「交付仓库的 `knowledgebase-writer-agent-pg/` 目录」指的就是这里。

`make-package.sh` 出包前用 `release/SHA256SUMS` 核对两个 zip，对不上就不出包。
