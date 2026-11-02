# AGENTS.md

本目录用来把「知识库文档管家（PG 版）」（Nexus Agent `knowledgebase_writer_agent_pg`）部署到真实环境。

**部署手册只有一份，先完整读完再动手，然后照它一步一步做：**

- 在交付 zip 解开的目录里：`repo/skills/pg-kb-steward-deploy/SKILL.md`
- 在交付仓库的 `knowledgebase-writer-agent-pg/` 目录里：`skill/SKILL.md`（同一份；这里只有文档，能运行的代码在交付 zip 里）

最要紧的几条（细节以手册为准）：

- 命令都在交付 zip 解开后的根目录执行（有 `START-HERE.md`、`repo/` 的那一层）。
- 每个写操作先给人看计划或 dry-run 的输出，人明确同意这一步后才执行；删除类操作单独确认。
- 不读出、不打印、不粘贴任何密码或密钥；它们只在本机 600 文件里。
- 遇到手册里列的停止条件就停下来问人。
