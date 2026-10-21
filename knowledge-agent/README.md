# 九安知识Agent（PoC）

在 Nexus 上提供审批知识：问知识库、按单据挑选相关知识与冲突、推荐九安规则草稿、从制度原文整理知识。全部能力都在 Nexus 上，调用方只管调用。知识全部虚构。

| | |
|---|---|
| Nexus | https://nxs-beine1013.tinyboat.blog（v0.3.28）（线上 Nexus AI 的实际地址：d3u3hj2us186y.cloudfront.net） |
| Agent | `agent_949d9bc407b9430aae20f26326ef6fca`，2026-10-17 从内置「通用助手」复制，没有工具 |
| 发布 | `pub_2cc24c29d2e5b2c9`，A2A 与 MCP 都已打开，跟随最新版本 |
| A2A | `https://nxs-beine1013.tinyboat.blog/a2a/pub_2cc24c29d2e5b2c9`（名片：`…/.well-known/agent-card.json`） |
| MCP | `https://nxs-beine1013.tinyboat.blog/mcp/pub_2cc24c29d2e5b2c9` |

| 调用密钥 | 由本人在 Nexus 网页「互联中心 › 对外发布」签发；在九安 PoC「Nexus Agent」页的「我的 Agent」里启用（粘贴调用密钥），或用 agent-access `enable --key-stdin`。不放进 `secrets.env`；端到端测试直接用审核员本人在页面上的启用 |
| 提示词 | 本目录的 `prompt.yaml`（当前 v2），v1 留在 `prompt-v1.yaml` |

上表的 A2A、MCP 地址都在 nxs-beine1013 这套上；线上 Nexus AI 的实际地址：d3u3hj2us186y.cloudfront.net。

## 约定

请求是一个 JSON 对象：`{"task": "<任务名>", "input": {...}}`。直接发一句话的，按 `answer` 处理。返回也是一个 JSON 对象，带 `task` 和 `version` 两个字段。完整的输入输出格式发 `{"task": "describe"}` 就能取到。

| 任务 | 做什么 |
|---|---|
| `describe` | 返回能力清单：任务列表、输入输出格式、接受的附件、后续计划 |
| `answer` | 问知识库，引用知识编号，摘录逐字取自原文；返回把握程度和还缺哪些知识 |
| `select` | 按单据识别部门（申请部门、成本中心、表单字段），挑出相关知识、标出冲突，给出可以直接交给审核 Agent 的关注点（≤17 条） |
| `suggest_rules` | 按九安规则草稿的字段推荐公司范围的规则草稿（≤5 条） |
| `propose` | 从 `input.text` 的制度原文整理新增或修改建议，暂时不保存 |

- **附件**：只作辅助数据，各任务都可以读。有附件时，返回里会多一个 `attachmentsRead: [{name, summary}]`。
- **后续提供**（待 Nexus 支持存储）：
  - `ingest`：把 JSON、Markdown、PDF、Excel 等资料转成知识库条目；
  - `upsert_knowledge`：写入和修改知识；
  - `remember`：长期记忆；
  - `personal_layer`：个人层知识。

## 修改提示词

建这个 Agent 时经 operator 发出的请求和返回（`*-body.json`、`*-result.json`）在 2026-10-19 移进了 `../archive/knowledge-agent/`，不在交付包里；下面第一步会重新生成 `prompt-body.json`。

用 nexus-ai-operator 写回整份 YAML（在本目录下运行）。`--profile` 用你自己 `login` 时建的那个；维护人电脑上测试 Nexus 的 profile 是 `beine1013`。发布开着「跟随最新版本」，写回后立即生效。

```bash
OP=../skills/nexus-ai-operator/scripts/nexus.py   # 或装好的 ~/.claude/skills/nexus-ai-operator/scripts/nexus.py
python3 - <<'EOF'   # 生成请求体：{content, file_type: "prompt", notes}
import json; json.dump({'content': open('prompt.yaml', encoding='utf-8').read(), 'file_type': 'prompt', 'notes': '说明这次改了什么'},
  open('prompt-body.json', 'w', encoding='utf-8'), ensure_ascii=False)
EOF
python3 "$OP" --profile <你的 profile> call PUT /api/v2/agents/{agent_id}/files/prompt -p agent_id=agent_949d9bc407b9430aae20f26326ef6fca --data-file prompt-body.json
```

- **确认**：先不加 `--yes`，看一眼 CLI 打印的请求，确认无误后再加 `--yes` 执行。
- **每次改都要做**：
  - 把提示词里的版本号 `knowledge-agent-…` 改大，能力清单里的那一处也要一起改；
  - 写回之后，用 `node poc/app/scripts/try-agent.mjs --publication pub_2cc24c29d2e5b2c9 --task describe` 确认线上已经是新版本，再在「我的 Agent」卡片上点「重新读能力清单」。
- **提示词里的 JSON 块**：能力清单、知识、部门目录都写成 JSON，必须能解析；能力清单要和各任务的说明一致。

## 撤销与清理

- **暂停对外调用**：在 Nexus 网页暂停发布，或者经 operator 调 `PATCH /api/v2/publications/pub_2cc24c29d2e5b2c9`。
- **调用密钥**：开发测试阶段一直用到过期，不主动停用；需要停用时在网页「互联中心 › 对外发布」里操作。
- **删除 Agent**：要本人在网页上删，API 密钥的档位删不了。
