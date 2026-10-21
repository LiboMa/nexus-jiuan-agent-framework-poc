# 退出码与错误码 → 处置

所有命令失败时：人类可读模式把原因与建议写到 stderr；`--json` 模式在 stdout 输出
`{"ok": false, "exit_code": N, "error": {"code", "message", "hint", "http_status"}, …}`，
调用接口失败时还带 `response`（平台的原始响应体，已脱敏）。

## 退出码

| 码 | 含义 | 处置 |
|---|---|---|
| 0 | 成功 | — |
| 2 | 用法错误：参数、路径、请求体不对；平台返回 400 / 422 | 按提示修正；`describe` 看参数与 schema；不要原样重试 |
| 3 | 需要重新连接：还没 login、连接密钥失效、API 密钥被停用 / 暂停 / 过期 | 请用户在「个人设置 › API 密钥」重新生成（或新生成）一把密钥后再 `login` |
| 4 | 权限不足（403） | 告诉用户缺什么（`--include-denied` 的原因）；不要换路子绕过 |
| 5 | 不存在（404 / 410） | 用发现或只读调用重新确认 id / 路径 |
| 6 | 冲突或忙（409 / 412 / 423）、`wait` / `chat` 等待超时 | 稍后再试；超时的长任务用 `wait` 或 `chat --attach` 接着等 |
| 7 | 额度或限流（402 / 429、`QUOTA_EXCEEDED`） | 按 `Retry-After` 等待；额度用完请用户联系管理员 |
| 8 | 平台错误或不可用（5xx）、网络不通、TLS 失败 | 稍后重试只读操作；写操作先查清上一次是否已生效 |
| 9 | 需要用户确认（写操作缺 `--yes`，高风险缺 `--confirm-destructive`） | 把 CLI 打印的「将要执行的请求」给用户看，按确认规则处理 |
| 130 | 被中断（Ctrl-C） | — |

## 常见错误码

| 错误码 | 退出码 | 含义 | 处置 |
|---|---|---|---|
| `not_connected` | 3 | 这个 profile 还没 login | 向用户要平台地址与连接密钥 |
| `connection_key_invalid` / `connection_key_revoked` | 3 | 连接密钥不对或已作废 | 请用户重新生成 |
| `connection_revoked` / `connection_expired` | 3 | API 密钥已被停用 / 闲置失效 | 请用户生成一把新的 |
| `connection_key_reused` / `connection_suspended` | 3 | 已轮换掉的旧连接密钥被再次使用，连接被暂停 | 请用户到网页查看告警并重新生成；不要复制凭证文件 |
| `credential_expired` / `credential_revoked` | — | 访问密钥过期，或被同一连接新签发的访问密钥挤掉 | CLI 强制续期一次后重试，一般看不到 |
| `credential_forbidden_path` | 4 | 这类操作不允许经 API 密钥进行 | 请用户本人在网页上操作 |
| `endpoint_auth_required` | 4 | 业务接口自己要求另外的验证（例如应用的访问验证），不是连接的问题 | 不需要重新生成连接密钥；用 `describe` 看这个接口的要求 |
| `lock_timeout` | 6 | 等本机凭证文件锁超时（另一个 CLI 进程正在续期或轮换） | 稍后重试；**不要**删锁文件 |
| `home_not_owned` | 2 | 配置目录不属于当前用户 | 把环境变量 `NEXUS_HOME` 指向自己拥有的目录 |
| `credentials_unwritable` | 8 | 新的凭证没能写进本机（磁盘满 / 权限不对） | 修正后重试；若这次换了连接密钥，旧的约 10 分钟后失效，届时请用户重新生成 |
| `token_response_invalid` | 8 | 兑换结果不完整（带回了新的连接密钥时 CLI 已先保存） | 稍后重试 |
| `QUOTA_EXCEEDED` | 7 | 本月模型额度用完 | 请用户联系管理员 |
| `rate_limited` | 7 | 请求太频繁 | 按提示等待 |
| `credential_unavailable` / `rate_limit_unavailable` | 8 | 平台暂时无法校验凭证 / 限流计数暂不可用 | 稍后重试 |
| `not_available` | 8 | 平台没有开放 API 密钥访问 | 请管理员开启 |
| `discovery_unavailable` | 8 | 平台没有能力发现（版本较旧） | 只按用户给的具体路径 `call` |
| `confirmation_required` | 9 | 缺确认参数 | 见确认规则 |
| `wait_timeout` | 6 | `wait` 超时 | 再次 `wait` |
| `chat_busy` | 6 | 会话一直有一轮在进行 | 稍后再发，或 `--new-session` |
| `chat_timeout` | 6 | 等回复超时 | `chat --attach` 接着看，不要重发 |
| `turn_superseded` | 6 | 续播前发现会话里已经开始了新的一轮 | 这一轮以会话历史为准；到网页查看，或稍后 `chat --attach` |
| `chat_send_uncertain` | 8 | 发消息时网络中断，或平台返回 500 / 502 / 504，不确定是否收到 | 先 `chat --attach` 查看，再决定是否重发 |
| `stream_lost` | 8 | 续播反复失败；或流不带事件 id 时断线（`partial: true`，回复取会话历史里已保存的部分） | 稍后 `chat --attach`，或到网页查看 |
| `agent_error` | 8 | 平台上的 Agent 这一轮出错 | 换个说法重试，或请用户到网页查看会话 |
| `session_not_found` / `session_in_trash` | 5 | 会话不存在或在回收站 | 不带 `--session-id` 重新开始 |
| `skill_checksum_mismatch` / `skill_package_invalid` | 8 | `skill-update` 下载的接入包校验不通过 | 没有替换任何文件；稍后重试 `skill-update` |
| `network_error` | 8 | 连不上平台 | 检查地址与网络；自签证书设 `NEXUS_CA_BUNDLE` |

## 写操作失败后的原则

退出码 8（尤其是网络中断）时，写操作**可能已经生效**。先用只读调用确认状态，再决定是否重做；不要循环重试写操作。
