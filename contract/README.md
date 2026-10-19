# 九安 Agent 接入框架的契约：jiuan.agent/v1

九安平台上所有类型的 Agent（业务流程、财务、知识库……）都用这一套接口。两层：

- **通用层** `envelope/v1/`：请求和结果的信封、名片要求、错误码、A2A 例子。所有任务共用，不认识任何具体任务。
- **任务层** `tasks/<任务>/v<版本>/`：每个任务一份契约：`task.json`（家族、调用方式、对象、检查、结果怎么推进流程、限制、数据类别）、输入和输出的 JSON Schema、例子。新增一类 Agent，就加一个任务目录，在 `tasks/index.json` 里登记一行；通用层不动。

| 目录 | 是什么 |
|---|---|
| `envelope/v1/request.schema.json`、`result.schema.json` | 信封：任务名、任务版本、请求编号、上下文（公司、对象、会话）、输入；结果的状态（完成 / 拒绝）、输出、Agent 版本 |
| `envelope/v1/card-requirements.json` | 名片描述里必须有「契约：jiuan.agent/v1」和「任务：名@版本」两行 |
| `envelope/v1/error-map.json` | Nexus 错误 → 九安模型错误码 → AI 步骤要不要自动重试 |
| `envelope/v1/examples/` | 一条完整的 A2A 请求；一次流式返回 |
| `tasks/index.json` | 任务目录 |
| `tasks/first_review/v1/` | 第一个任务：单据初审（通过 / 不通过 + 备注） |
| `tasks/describe/v1/` | 能力清单（建议所有 Agent 都支持，可选） |
| `tasks/_template/v1/task.json` | 新任务的模板 |
| `workflows/approval.openapi.yaml` | 审批流（第一个用到框架的业务流程）给九安前端的接口，参考实现 |

说明文档：`docs/delivery/agent-interface.md`（通用接口）、`docs/delivery/first-review-contract.md`（任务：单据初审）、`docs/delivery/agent-framework.md`（架构、工作流与交付接口）、`docs/delivery/agent-framework-overview.html`（一页总览）。

版本分三层：信封 `jiuan.agent/v1` 很少变；每个任务各自有主版本，输入只增加可选字段，输出一改就升版本；Agent 自报 `agentVersion`。
