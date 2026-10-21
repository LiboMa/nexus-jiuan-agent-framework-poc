# 接口约定 agent-access-v1

`agent_access.py` 和应用页面走的是同一套接口。这一份就是接口约定的正式说明。

- **版本**：`GET /me` 的返回里带 `interfaceVersion: "agent-access-v1"`。
- **只加不改**：以后只加字段，不改已有字段的含义，也不删字段。
- **返回格式**：成功 `{"data": …}`；失败 `{"error": {"code", "message"}}`，按 `code` 判断怎么处理。
- **登录**：应用会话加 CSRF（`/api/analysis/v1/poc/login` → `/auth/exchange` → `/session`）。以后加个人令牌 `Authorization: Bearer afp_…`，路径一一对应。

## 资源

前缀 `/api/analysis/v1/poc/nexus`。

| 方法与路径 | 请求 | 成功返回 | 错误码 |
|---|---|---|---|
| `GET /me` | — | 我的视图 | — |
| `POST /me/connect` | `{apiKey}` | 我的视图 | `POC_NEXUS_API_KEY_INVALID`（400）、`POC_NEXUS_UNREACHABLE`（502）、`POC_ME_RATE_LIMIT`（429） |
| `POST /me/disconnect` | `{}` | 我的视图（重复调用也成功） | — |
| `POST /me/refresh` | `{}` | 我的视图 | `POC_NEXUS_NOT_CONNECTED`（409）、`POC_NEXUS_UNREACHABLE`（502） |
| `POST /me/agents/:publishId/enable` | `{token?, loadCapabilities?, issue?, client?}`；`loadCapabilities` 默认 `true`；`issue` 预留，现在一律 403；`client` 只记进留痕 | 这个发布的视图 | `POC_NEXUS_NOT_CONNECTED`（409）、`POC_PUBLICATION_NOT_MINE`（404）、`POC_CARD_UNAVAILABLE`（409）、`POC_CALL_KEY_INVALID`（400）、`POC_AGENT_NOT_ENABLED`（409）、`POC_ISSUE_NOT_ALLOWED`（403）、`POC_ME_RATE_LIMIT`（429） |
| `POST /me/agents/:publishId/disable` | `{}` | 我的视图（重复调用也成功） | — |
| `POST /invoke` | `{publishId, mode, text?, documentId?, attachments?}`；`mode` 是 `text`（`--text`，或 `--task` 加 `--input` 拼成的任务请求）或 `advisory`（按单据出审批建议）；`attachments` 是 base64 附件，合计不超过 6 MB | `{runId}` | `POC_AGENT_NOT_ENABLED`（409）、`POC_INVOKE_RATE_LIMIT`（429） |
| `GET /runs`、`GET /runs/:runId` | — | 调用记录（最多 50 条，重启清空） | `NOT_FOUND`（404） |

启用的三种情况：
- **带新的 `token`**：验证通过才保存；已经启用过的，用新密钥替换旧的。
- **不带 `token`、已经启用过**：用已保存的那把重新验证，并刷新能力清单。
- **`issue: true`**（预留）：等 Nexus 支持由应用签发调用密钥之后再开放。

## 我的视图

- `connection.status`：`connected`、`not_connected`、`error`。
- `publications[]`：用户自己的发布；没启用的 `enablement` 为 `null`；启用的只带密钥指纹（`fingerprint`），从不带密钥。
- `unpublished[]`：还没发布的 Agent。
- `system[]`：旧的兜底配置，通常为空。审批流的调用密钥不从这里来，从各账号的启用里读（先发起人，再别的账号）。
