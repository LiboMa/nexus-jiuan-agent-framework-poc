---
subtitle: 九安审核平台 × Nexus AI · Agent 接入框架
date: 2026-10-19
status: 设计稿 v2（待批准后实施）
scope: 任务 first_review@1：单据初审；契约目录 contract/tasks/first_review/v1/
audience: 九安开发者（含他们的编码工具）、Agent 开发
---

# 任务契约：单据初审 first_review@1

框架里的第一个任务，属于业务流程类。九安在审批流里发一次请求，审核 Agent 按对这张单据有效的已发布规则逐条判断，回「通过 / 不通过」和备注，九安据此把审批推进到人工复核。

通用的部分（信封、发现、调用、状态、错误码、限制、版本）见[Agent 接口：jiuan.agent/v1](agent-interface.md)，本文只写这个任务自己的。机器可读的文件在 `audit-nexus/contract/tasks/first_review/v1/`；一页总览见[Agent 接入框架总览（HTML）](agent-framework-overview.html)。

下文 `J/` 指九安开发包的 `code/` 目录，`C/` 指 `audit-nexus/contract/`。

## 1. 任务清单（task.json）

| 项 | 值 |
|---|---|
| 家族 | `process` 业务流程 |
| 调用方式 | `oneshot` 一问一答；不带文件；不是长任务 |
| 对象 | `document`：一张单据，`context.subject.version` 是单据版本；`context.scope` 是 `company` |
| 谁能发起 | 审批流以系统身份自动发起；人（九安的 admin 或 analyst）也可以在单据上手动发起 |
| 结果怎么存 | 一张单据一份（`per_subject`），本期不分区 |
| 路由用的事实 | `documentType`、`expenseType`：以后按费用类型拆成几个审核 Agent，只在路由表里加条件 |
| 结果怎么推进流程 | `output.result`：`pass` 通过、`fail` 不通过；**不论哪个都进入人工复核** |
| 什么变了就作废 | 单据版本（`subject.version`） |
| 什么变了只标记 | 规则（`rulesFingerprint`）、原件：标「规则已更新」或「原件已更新」，由人决定重跑 |
| 限制 | 请求 9 万字以内；回答 3 万字以内；一次调用 180 秒 |
| 发给 Agent 的数据 | 单据字段与明细、已发布规则原文、原件的脱敏页文字 |
| 会不会改东西 | 不会 |
| `declined` | 不用：拿不准也要给结论，判「不通过」并写原因。只有请求明显不该发给它（例如单据类型和规则完全对不上）才回 `declined` |

## 2. 分工

| | 做什么 | 不做什么 |
|---|---|---|
| **九安** | 取单、入库、读原件、规则引擎试跑；按公司、单据类型、生效期挑出有效的已发布规则；组装输入、调用、检查；记审批状态；人工复核 | — |
| **审核 Agent**（只给九安用） | 判断每条规则和单据内容有没有关系；逐条判通过或不通过、写备注；给出综合结论 | 不判断票据真伪（票据进平台前已在上游验证过）；不推翻字段核对类规则的引擎结论；不做最终决定 |

## 3. 输入

Schema：`input.schema.json`（放在信封的 `input` 里）。例子：`examples/request.json`（对公付款，三条规则，三种检查方式各一条）。单据编号和版本在信封的 `context.subject` 里，不在 `input` 里重复。

| 字段 | 内容 | 九安怎么填（组装器负责，Agent 不需要知道） |
|---|---|---|
| `document` | 单据：编号、类型（`employee_reimbursement` 员工报销 / `corporate_payment` 对公付款）、公司名、提交时间、金额、事由；其余表头字段放 `fields`，明细放 `lines`，都是「名称 + 值」 | 从 `analysisDocumentToReviewReport` 的结果取（`J/src/analysis-review-bridge.mjs`），名称用九安页面上的中文名。**九安以后加字段，只往 `fields` 里加，契约不变** |
| `rules` | 对这张单据有效的已发布规则，可以是空表。每条有编号、版本、名称、检查方式、**规则原文** `text`、引擎结论 `engine` | 用 `resolvePublishedPolicies` 挑（`J/src/policy-lifecycle.mjs:89`：公司相同或是集团规则、单据类型相符、提交日期在生效期内）。`text` 由说明、依据、所需资料、比较基准、差异处理拼成。只有字段核对类（`field_match`）带 `engine`：引擎判「符合」→ `pass`，「不适用」→ `not_applicable`，其余 → `fail` |
| `rulesFingerprint` | 这批规则的指纹 | 规则一发布就变 |
| `evidence` | 原件的脱敏页文字，最多 10 份文件 | 九安读原件的结果。取不到就是 `not_acquired`，要原件的规则会判「缺材料」；为放进上限截过的，`truncated` 置为 `true` |

**大小**：超过 9 万字时，先截原件页文字，从每份文件的后面往前截；规则和单据不截。还超就不发，按 `AI_REQUEST_INVALID` 处理，直接转人工复核，并记下「规则太多，一次初审放不下」。

## 4. 输出

Schema：`output.schema.json`（放在结果信封的 `output` 里）。例子：`examples/result-pass.json`（对应 `request.json`）、`examples/result-fail.json`（对应 `request-no-evidence.json`）、`examples/result-declined.json`。

```json
{ "result": "pass | fail",
  "note": "综合备注",
  "rules": [ { "ruleId": "…", "ruleVersion": 2, "result": "pass | fail", "note": "原因和依据" } ] }
```

### 4.1 两个状态怎么归

| 情况 | 结果 | 备注写什么 |
|---|---|---|
| 规则满足 | 通过 | 依据：哪个字段、哪份原件第几页、引用的原文 |
| 规则与这张单据无关（例如单据里没有住宿） | 通过 | 「不适用：单据里没有住宿」 |
| 规则不满足 | 不通过 | 哪里不符合 |
| 缺材料，或拿不准 | 不通过 | 缺什么、哪里拿不准。宁可让人多看一眼 |
| 字段核对类，引擎已判 | 和引擎一致（`fail` → 不通过，`pass` / `not_applicable` → 通过） | 可以解释，不能改结论 |
| **综合结论** | 有任何一条不通过就不通过；全部通过时，综合分析发现别的问题也可以不通过 | 不通过时写清原因和要补什么 |

### 4.2 任务检查

信封检查之后（[通用接口](agent-interface.md)第 5.3 节），再做三条：
1. 请求里的每条规则（按编号 + 版本）都有、且只有一条结果，不多不少；
2. 字段核对类的结果和引擎一致；
3. 有任何一条不通过，综合结论就必须是不通过。

这三条和信封检查在 `examples/` 的三对例子上都验证过。

## 5. 在审批流里

审批流是第一个用到框架的业务流程：九安预审 → AI 步骤（本任务）→ 人工复核。状态机、自动重试、失效和存储见[Agent 接入框架：架构、工作流与交付接口](agent-framework.md)第 5 节。

## 6. Agent 一侧要做到的

在[通用要求](agent-interface.md)第 10 节之外：
1. 名片描述写「任务：first_review@1」。
2. 提示词里写清：
   - 对每条规则先判断它和单据内容有没有关系，再判通过或不通过，按第 4.1 节归类，备注写原因和依据；
   - 字段核对类和引擎一致；
   - 不判断票据真伪；
   - 不读别的知识库，只用请求里的信息。
3. 改完提示词，先用 `examples/request.json` 和 `request-no-evidence.json` 各调一次，结果必须过信封检查和第 4.2 节的三条检查。
