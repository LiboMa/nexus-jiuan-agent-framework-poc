# 九安审核AI（PoC）提示词

Nexus 测试环境 nxs-beine1013 上的 Agent `agent_56d44dd9350f4a568bca387319e12ae4`，发布 `pub_5c53e70d8dc7ddea`（A2A）。

| 文件 | 内容 |
|---|---|
| `prompt.yaml` | 当前版本 v3（2026-10-25，2026-10-26 改查询方式，`agentVersion` 为 `jiuan-audit-ai-kb-2026-10-26.1`）：三段式请求照旧；第 4 条加知识库只读查询的例外；第 8 条规则问答、第 9 条信封模式（九安 v0.7.10 的 `review_advice@1`）的第 1 次查询都用库内语义检索 `kb_search`，没对口的再按关键词 `ILIKE` |
| `prompt-owner-2026-10-25.yaml` | 项目负责人在网页上改过的上一版（加了第 7、8 条和连接器），回退用 |
| `apply.py` | 下发：写提示词 → 原样重存发布的动态配置 → 发布描述写上契约和任务两行 → 只读核对 |

## 知识库

- 发布的动态配置绑着数据连接器 `conn-f0c7233959d9`，连到测试台上的 `nexus-pgvector`（10.0.1.38:5432，库 `nexus`）。
- 表是 `approval_rules`：
  - rule_type=matrix 是审批路径，89 行；
  - general 是制度说明与图例，9 行；
  - chapter_note 是章节说明，4 行。
- 库内语义检索：`SELECT … FROM kb_search('<板块> <业务事项关键词> <金额>', 8)`，PG 里用实例角色调 Bedrock 把问题向量化，先按关键词命中数、再按语义排序；每次记进检索日志（九安「规则库 › 制度知识库」页能看）。说明见 [`../kb/GUIDE.md`](../kb/GUIDE.md) 6.3。第 8 条由知识库工具管（`kb/agent/prompt-rules.txt` + `poc/infra/kb.sh agent`），本目录的 `prompt.yaml` 里那一条要和它逐字一致（改完 `kb.sh agent --dry-run` 应全是 `=`）。
- 连接器交给模型的结果每格截到 80 字、最多 30 行、共 4000 字，所以提示词让 Agent 用 `substr` 分列取长文。
- 连接器的库账号有读写权限。提示词只让初审做 SELECT，但更稳妥的是给它换一个只读账号。

## 怎么改

1. 先存底稿。网页上改过的话，先把线上版本存成新的底稿文件。
2. 改 `prompt.yaml`，同时把 `agentVersion` 的日期和序号加一。
3. 先演练，再下发：
   ```
   python3 audit-agent/apply.py --base <底稿> --dry-run
   python3 audit-agent/apply.py --base <底稿>
   ```
4. 验证：在测试台的九安 v0.7.10 上发起「AI 独立建议」，或跑 `bash poc/app/test/e2e/run07.sh`。
   - 调用密钥由管理员在九安「后台配置 › Agent 接入」页上粘贴一次（https://jiuan-v0710.tinyboat.blog/#adminConfig?tab=agentAccess），之后的调用都用这条启用记录。
   - 端到端测试不读、不粘贴密钥；它会核对 Agent 引用的规则编号在库里都存在。

只改提示词不重存动态配置，A2A 调用用的还是旧快照（Nexus `publication_gateway/executor.py:554-578`）。`apply.py` 每次都会重存。

回退：`prompt-owner-2026-10-25.yaml` 复制成 `prompt.yaml`，再运行 `apply.py --base` 加上当前线上版本对应的文件。
