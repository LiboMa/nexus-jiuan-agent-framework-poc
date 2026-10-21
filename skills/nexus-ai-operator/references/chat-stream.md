# 会话流：事件、续播与结束判定

`chat` 封装了与平台上 Agent 对话的全部协议细节。一般只需要：

```bash
python3 scripts/nexus.py chat --agent-id <Agent id> --message-stdin <<'EOF'
<要说的话>
EOF
```

- 正文写到 stdout（边收边打印），工具调用等过程提示写到 stderr；最后一行是 `[会话 <id> · …]`。
- `--json`：结束后输出一个 JSON 文档：`reply`、`tools[]`（名称、输入、结果，已脱敏截断）、`warnings[]`、`errors[]`、
  `persisted`、`interrupted`、`model_id`、`session_id`、`session_created`、`resumed`（续播次数）、`queued_retries`（排队次数）、
  `reconciled`（是否与会话历史核对过）、`from_history`（`reply` 是否取自会话历史）。
- 默认接着这个 Agent 上次的会话（记在 `~/.nexus/cache/<profile>/chat-sessions.json`）；`--new-session` 开新会话；
  `--session-id` 指定会话。
- `--timeout` 是这一轮的总等待时间（默认 1800 秒）；全局 `--timeout`（写在 `chat` 前面）是单个请求的超时。

## 协议（供排查）

| 步骤 | 接口 | 说明 |
|---|---|---|
| 建会话 | `POST /api/v2/agents/{agent_id}/sessions` | 没有可接着用的会话时 |
| 发消息 | `POST /api/v2/sessions/{session_id}/stream` | 请求体 `{content, client_turn_id[, model_id]}`；返回 SSE，响应头 `X-Stream-Key` 标识这一轮 |
| 核对这一轮 | `GET /api/v2/sessions/{session_id}/stream/status` | 续播前确认会话当前的 `stream_key` 仍是这一轮 |
| 续播 | `GET /api/v2/sessions/{session_id}/stream/events?after=<事件 id>` | 断线后从断点继续；`after=0` 从头回放这一轮 |
| 读历史 | `GET /api/v2/sessions/{session_id}/messages` | 流已过期、或需要核对时取最新的回复 |

SSE 每帧是 `data: {json}`。`event` 字段：

| event | 含义 |
|---|---|
| `connected` / `agent_info` | 开始；`agent_info.model_id` 是这一轮实际使用的模型 |
| `message` | 内容，按 `type` 区分：`text`（正文片段）、`tool_use`（开始调用工具）、`tool_input`（工具输入片段）、`tool_end`（工具结束，可能带 `tool_result`）、`message_stop` |
| `warning` | 提示，例如 `model_not_permitted`（要求的模型不在可用范围内，改用默认模型） |
| `error` | 这一轮出错（随后仍会有 `done`）；平台中继读流失败时也会发一条 `error` 再断开，这种不算 Agent 出错，CLI 接着续播 |
| `interrupted` | 这一轮被停止（有人在网页上点了停止） |
| `persist_failed` | 某条消息没能保存到会话历史 |
| `heartbeat` / `catchup_done` | 保活 / 回放追上实时，忽略即可 |
| `done` | **唯一的结束信号**。`persisted`：`true` 已保存；`false` 保存失败；没有该字段 = 平台中继合成的结束，保存状态未知 |

每帧带 `_event_id`（平台的主路径）；断线后用最后一个 `_event_id` 续播，正文不会重复。

## 异常情况怎么处理（CLI 已自动处理）

| 情况 | 平台返回 | CLI 的处理 |
|---|---|---|
| 会话里已有一轮在进行 | 409 `CHAT_BUSY`（消息没有被受理） | 排队等待后重发（5 / 10 / 15 秒退避），直到总时长用完（退出码 6） |
| 平台安全重启维护中 | 503 + `Retry-After` | 等待后重试 |
| 限流 | 429 | 按 `Retry-After` 退避重试，最多 5 次 |
| 发消息时网络中断，或平台返回 500 / 502 / 504 | 没有确定的响应 | **不自动重发**（平台可能已经收到并开始执行）：退出码 8 `chat_send_uncertain`，先 `--attach` 查看 |
| 流中途断开 | 连接被关闭、读超时 | 先核对会话当前的 `stream_key` 仍是这一轮，再按最后的 `_event_id` 续播；连续失败 5 次放弃（退出码 8，提示 `--attach`） |
| 续播前发现会话已开始新的一轮 | `stream_key` 不一致（例如网页上又发了消息） | 停止续播：退出码 6 `turn_superseded`，这一轮的回复以会话历史为准 |
| 流已过期 | 续播返回 410 | 读会话历史里最新的回复 |
| 续播 / 回放缺了内容 | 平台在一轮结束后会裁短流 | 结束后读会话历史核对，以历史里保存的回复为准补齐（`reconciled` / `from_history`） |
| 流不带事件 id（内联运行方式）时断线 | 无法续播；这种运行方式下平台会在断线时停止这一轮 | 退出码 8 `stream_lost`，`partial: true`，回复取会话历史里已保存的部分 |
| 上次的会话已不在 | 404 / 410 | 自动新建会话（只在没有指定 `--session-id` 时） |
| 等太久 | — | 退出码 6；稍后 `chat --agent-id <id> --attach` 接着看，不会重发消息 |

超过 8 MB 的单个事件不是正常的平台事件，会被整帧丢弃；`--json` 输出里每个工具的输入 / 结果最多保留 2000 个字符（已脱敏）。

## 结束判定

- 收到 `done` 才算这一轮结束；有 Agent 的 `error` 事件时退出码 8（已收到的正文仍会输出）。
- 续播过、`--attach` 回放、或结束时保存状态未知（`persisted` 缺失）时，CLI 会再读一次会话历史核对；
  流里缺了内容就以历史为准，并提示「中途有部分输出没有收到」。
- `persisted=false`：回复给你了，但会话历史里没有，用户在网页上可能看不到——必要时告诉用户。
- `interrupted`：这一轮被人为停止，回复可能不完整。
