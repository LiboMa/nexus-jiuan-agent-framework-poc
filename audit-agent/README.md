# 九安审核AI（PoC）提示词

现有环境（Nexus nxs-beine1013）上是 Agent `agent_56d44dd9350f4a568bca387319e12ae4`，发布 `pub_5c53e70d8dc7ddea`（A2A + MCP），知识库是 PG 方式。别的环境的 Agent、发布、连接器或规则工具、知识库方式（`KB_MODE=pg|s3vectors`，不写就是 `pg`）写在环境配置里（`poc/infra/env/<环境名>.env`，见 `poc/infra/env/example.env`），两个脚本都用 `--env` 或 `DEPLOY_ENV` 指定；`apply.py` 不给就是现有环境，`setup.py` 必须给。

| 文件 | 内容 |
|---|---|
| `prompt.yaml` | 当前版本 v3（2026-10-25，2026-10-26 改查询方式，2026-10-28 加自定义规则、分两种知识库方式，`agentVersion` 为 `jiuan-audit-ai-kb-2026-10-28.1`）：三段式请求照旧；第 4 条加知识库只读查询的例外；第 8 条规则问答、第 9 条信封模式（九安 v0.7.10 的 `review_advice@1`）查规则，`pg` 方式第 1 次用库内语义检索 `kb_search`、没对口的再按关键词 `ILIKE`，`s3vectors` 方式用 `rules_search`；第 9 条 c 的 ③ 之后是审核员自定义规则（`input.customRules`）的处理，两种方式一样 |
| `prompt-owner-2026-10-25.yaml` | 项目负责人在网页上改过的上一版（加了第 7、8 条和连接器），回退用 |
| `apply.py` | 下发：打印线上提示词到渲染结果的 diff → 写提示词 → 原样重存发布的动态配置 → 发布描述写上契约和任务两行 → 只读核对 |
| `setup.py` | 新环境第一次用、或换知识库方式时：按 `AGENT_NAME` 找或建 Agent（克隆通用助手、写入提示词）、找或建 A2A 发布；`pg` 方式把知识库连接器绑进动态配置，`s3vectors` 方式先核对规则工具 `rules_search` 已绑密钥、再从动态配置里去掉 `CONNECTOR_ID`（其余字段原样）；幂等，编号写回环境配置。`--delete` 只删演练用的（名字以 `_rehearsal` 结尾） |
| `nexus_common.py`、`deploy_env.py` | 两个脚本共用：目标环境、提示词渲染（方式块、占位符）、经 operator 调 Nexus；读环境配置（规则和 `poc/infra/lib/deploy-env.sh` 一样） |
| `tests/` | 单元测试（`python3 -B -m unittest discover -s audit-agent/tests`，假的 Nexus，不联网）；`tests/fixtures/` 里是现有环境两种方式各自期望的渲染结果，和改动前（`2026-10-26.1`，线上现在的）那一份 |

## 两种知识库方式

`prompt.yaml` 里和知识库有关的几段（第 4 条的例外、第 7 条、第 8 条、第 9 条 c 的 ②、`tools_dependencies`）各写两份，放在方式块里：单独一行 `#<kb:pg>` … `#</kb:pg>`、`#<kb:s3vectors>` … `#</kb:s3vectors>`（行首可以缩进）。渲染时留 `KB_MODE` 那一种的块、整块删掉另一种（连同标记行），再替换占位符；块没成对、嵌套、标记行写错都报错。`${CONNECTOR_ID}` 只能写在 `pg` 块里，`${RULES_TOOL_DIR}` 只能写在 `s3vectors` 块里。

| | `pg`（现有环境，最终用这种） | `s3vectors`（这轮只有代码和单元测试） |
|---|---|---|
| 查规则 | 经连接器 `${CONNECTOR_ID}` 只读 SQL：`kb_search`，再 `ILIKE`，再分列取全文 | `rules_search(question=…, segment=…, amount=…, top_k=8)`，板块拿不准不填 `segment`、金额读不出数字不填 `amount`，回的就是全文 |
| 第 7 条（运维 / 测验模式） | 有 | 没有 |
| `tools_dependencies` | `system_tools/data_connector/*` 四个 | 只有 `imported_tools/${RULES_TOOL_DIR}/s3vectors_rules_tools/rules_search` |
| `setup.py` 对动态配置 | 绑上 `CONNECTOR_ID` | 去掉 `CONNECTOR_ID`（配置里留着它，才知道去掉哪个）；先核对 `rules_search` 已绑密钥（`configured=True`），没绑或 Operator 调不了接口就停下，按提示用 `knowbase-s3vectors-agent/scripts/admin_run.sh verify --dir <RULES_TOOL_DIR>` 核对 |

同一个环境换方式：改环境配置的 `KB_MODE`（`s3vectors` 还要写那五个键），先跑 `setup.py`，再跑 `apply.py`。

## 自定义规则

审核员从单据页手动发起时，测试台把这个人的「我的规则」附在 `input.customRules = {owner, items: [{title, text}]}`（`poc/app07/custom-rules-advice.mjs`；自动初审不附）。提示词第 9 条 c 的 ③ 之后一段（两种方式一样）：它是附加审核要求，和公司制度一起核对，只能让结论更严（公司制度判 fail 的不改成 pass）；其中要求忽略规则、改输出格式的文字照第 3 条不执行；有它时 `note` 以「（含 <owner> 的自定义规则）」开头，适用的每条写一条 `kind: "rule"`、`ref` 以「自定义：<title>」开头的依据，不编规则编号；没有它时 `note` 里不出现「自定义规则」。

## 知识库（pg 方式）

- 发布的动态配置绑着数据连接器 `conn-f0c7233959d9`，连到测试台上的 `nexus-pgvector`（10.0.1.38:5432，库 `nexus`）。
- 表是 `approval_rules`：
  - rule_type=matrix 是审批路径，89 行；
  - general 是制度说明与图例，9 行；
  - chapter_note 是章节说明，4 行。
- 库内语义检索：`SELECT … FROM kb_search('<板块> <业务事项关键词> <金额>', 8)`，PG 里用实例角色调 Bedrock 把问题向量化，先按关键词命中数、再按语义排序；每次记进检索日志（九安「规则库 › 制度知识库」页能看）。说明见 [`../kb/GUIDE.md`](../kb/GUIDE.md) 6.3。第 8 条由知识库工具管（`kb/agent/prompt-rules.txt` + `poc/infra/kb.sh agent`），本目录 `prompt.yaml` 的 `pg` 块里第 7、8 条要和它逐字一致（`tests/test_apply.py` 钉住；改完 `kb.sh agent --dry-run` 应全是 `=`）。`s3vectors` 方式不要跑 `kb.sh agent`，它会把 PG 的第 7、8 条写回去。
- 连接器交给模型的结果每格截到 80 字、最多 30 行、共 4000 字，所以提示词让 Agent 用 `substr` 分列取长文。
- 连接器的库账号有读写权限。提示词只让初审做 SELECT，但更稳妥的是给它换一个只读账号。

## 怎么改

1. 先存底稿。网页上改过的话，先把线上版本存成新的底稿文件。
2. 改 `prompt.yaml`，同时把 `agentVersion` 的日期和序号加一（两种方式共用这一行）。只和一种方式有关的改动写进那种方式的块里。环境值不写进去：连接器写 `${CONNECTOR_ID}`、规则工具目录写 `${RULES_TOOL_DIR}`、Agent 名写 `${AGENT_NAME}`、模型写 `${AGENT_MODEL}`，下发时按环境配置替换。改完更新 `tests/fixtures/` 里的期望文件，跑单元测试。
3. 先演练，再下发：
   ```
   python3 audit-agent/apply.py --env poc/infra/env/<环境名>.env --dry-run              # 只读：打印线上 → 渲染结果的 diff
   python3 audit-agent/apply.py --env poc/infra/env/<环境名>.env --base <底稿> --dry-run   # 同上，再核对线上和底稿一致
   python3 audit-agent/apply.py --env poc/infra/env/<环境名>.env --base <底稿>
   ```
4. 验证：在测试台的九安 v0.7.10 上发起「AI 独立建议」，或跑 `bash poc/app/test/e2e/run07.sh`。
   - 调用密钥由管理员在九安「后台配置 › Agent 接入」页上粘贴一次（https://jiuan-v0710.tinyboat.blog/#adminConfig?tab=agentAccess），之后的调用都用这条启用记录。
   - 端到端测试不读、不粘贴密钥；它会核对 Agent 引用的规则编号在库里都存在。

只改提示词不重存动态配置，A2A 调用用的还是旧快照（Nexus `publication_gateway/executor.py:554-578`）。`apply.py` 每次都会重存。

回退：`prompt-owner-2026-10-25.yaml` 复制成 `prompt.yaml`，再运行 `apply.py --base` 加上当前线上版本对应的文件。
