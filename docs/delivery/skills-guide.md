---
subtitle: 九安审核平台 × Nexus AI · Finance-Audit-Nexus-PoC v0.7.10
date: 2026-11-02
status: 交付版 v0.7.10（只剩 nexus-ai-operator；应用一侧的 agent-access 2026-11-02 随 v0.5.3 PoC 拿掉）
stamp: 指南
scope: 编码工具（Claude Code、Codex、Kiro CLI）里的 Skill：nexus-ai-operator（Nexus 一侧）
audience: Agent 开发、应用开发、接手维护的工程师
---

# Skills 配置指南：nexus-ai-operator

## 1. 一个 Skill，管 Nexus 一侧

| | nexus-ai-operator |
|---|---|
| 管什么 | 在 Nexus 上建 Agent、写提示词、试用、建 A2A 发布、看用量和会话 |
| 在哪 | 仓库里的 `skills/nexus-ai-operator/`（1.1.0，不带任何密钥） |
| 用什么身份 | 你的 Nexus 账号，经 API 密钥 |
| 命令 | `python3 scripts/nexus.py …` |
| 运行环境 | Python 3.9+，不装依赖 |

写操作要你明确同意才加 `--yes`；退出码 0 成功，2 用法，3 重新登录或先连接，4 凭证被拒，5 不存在，6 状态不对或等待超时，7 限流，8 平台不可用，9 需要确认。

应用一侧不用 Skill：Agent 建好、发布以后，管理员在九安 v0.7.10 测试台新前端的「**Agent 接入**」页连接 Nexus、启用、测试（[快速上手](quick-guide.md)）。原来给 v0.5.3「Nexus Agent」页用的应用 Skill agent-access（`agent_access.py`）2026-11-02 随 v0.5.3 PoC 拿掉了。

**有一件事 Skill 做不了**：给发布签调用密钥。只有发布者本人能在 Nexus 网页「互联中心 › 对外发布」里签（Nexus 代码 `api/v2/services/access_credential_service.py:283-286` 会拒绝经 API 密钥的签发）。

## 2. 配置顺序

![配置顺序：在 Nexus 网页生成一把 API 密钥交给 nexus-ai-operator，建 Agent 和发布；本人给发布签调用密钥；管理员在「Agent 接入」页用另一把 API 密钥连接 Nexus，粘贴调用密钥启用、测试](../assets/diagrams/skills-setup.svg)

**每把 API 密钥只给一个地方用。** 第一次连接时 Nexus 会把它换成新的，原来那串随即作废。所以 operator 和「Agent 接入」页的「连接 Nexus」要各生成一把，不能共用。

## 3. 配置 nexus-ai-operator

### 3.1 导入

仓库里的 `skills/nexus-ai-operator/` 就是能直接装的 Skill：`SKILL.md`（给编码工具读）、`README.md`（给人读）、`scripts/nexus.py`、`references/`、`config/instance.example.json`。版本 1.1.0，不带任何密钥。

把整个文件夹复制进编码工具的技能目录，再重启一次编码工具：

| 编码工具 | 个人目录（对所有项目生效） | 项目目录（只对这个项目生效） |
|---|---|---|
| Claude Code | `~/.claude/skills/nexus-ai-operator/` | `<项目>/.claude/skills/nexus-ai-operator/` |
| Codex | `~/.agents/skills/nexus-ai-operator/`（较早的版本是 `~/.codex/skills/`） | `<项目>/.agents/skills/nexus-ai-operator/` |
| Kiro CLI | `~/.kiro/skills/nexus-ai-operator/` | `<项目>/.kiro/skills/nexus-ai-operator/` |

例如装到 Claude Code，并把平台地址指向你们自己的 Nexus：

```bash
mkdir -p ~/.claude/skills
cp -R skills/nexus-ai-operator ~/.claude/skills/nexus-ai-operator
cd ~/.claude/skills/nexus-ai-operator
cp config/instance.example.json config/instance.json
# 编辑 config/instance.json：{"origin": "https://<你们的 Nexus 地址>"}
# 线上 Nexus AI 的实际地址：https://d3u3hj2us186y.cloudfront.net
python3 scripts/nexus.py --help
```

- 不支持 Skills 的工具：把 `SKILL.md` 交给它当说明，它照着运行 `scripts/nexus.py` 就行。
- 也可以不用仓库里这份：在你们 Nexus 的网页「个人设置 › API 密钥」生成密钥时，浏览器会同时下载一份接入包，里面已经带着平台地址和这把密钥。平台比 1.1.0 新时，用平台下载的那份。
- 平台地址也可以不写进文件，改用环境变量 `NEXUS_ORIGIN`，或者 `login --origin`。

### 3.2 生成 API 密钥

在你们 Nexus 的网页登录（线上 Nexus AI 的实际地址：<https://d3u3hj2us186y.cloudfront.net/>） →「个人设置 › API 密钥」→ 生成一把。建 Agent、发布要 `builder` 档位。这把只给 nexus-ai-operator 用。

### 3.3 连接

把密钥交给编码工具，说「用 nexus-ai-operator 连接 Nexus」。它会这样运行，密钥只经标准输入：

```bash
python3 scripts/nexus.py login --token-stdin --client claude_code <<'EOF'
<API 密钥>
EOF
python3 scripts/nexus.py whoami
```

- `whoami` 显示的是你自己，就连好了。
- 第一次连接时 Nexus 会把这把密钥换成新的，对话里出现过的那串随即作废。之后访问凭证自动续期、连接密钥自动轮换，你和编码工具都不用再碰任何密钥。
- 凭证存在本机 `~/.nexus/`：**不读、不复制、不打印**。
- `--client` 取 `claude_code`、`codex`、`kiro`、`other`，平台在「最近使用」里显示主机名，方便认出这把密钥。
- 多套环境（比如测试 Nexus 和生产 Nexus）用 `--profile <名称>` 分开；`poc/infra/env/<环境>.env` 里的 `NEXUS_PROFILE` 就是这个名字，`audit-agent/apply.py` 用它调 Nexus。

### 3.4 用它做什么

- 先发现再动手：`caps`、`module <模块>`、`ops --search <关键词>`、`describe <METHOD> <PATH>`。
- 建 Agent、改提示词、建发布并打开 A2A：按[开发者快速对接指南](developer-guide.md)走；审核 Agent 的提示词经 `audit-agent/apply.py` 下发（它内部用 operator，见[审核 Agent 说明](../../audit-agent/README.md)）。
- 查一轮 AI 建议为什么慢：用发布者的账号只读查 A2A 会话（`GET /api/v2/me/sessions`、`GET /api/v2/sessions/<会话编号>/messages`，[运维](operations.md)第 2.7 节）。
- **确认规则**：写操作要你明确同意这一个具体操作才加 `--yes`；删除、发布、对外分享这类高风险操作要单独说明后果，才加 `--confirm-destructive`。
- `caps` 提示接入包旧了时，运行 `python3 scripts/nexus.py skill-update`。
- 两个容易看漏的地方（2026-11-01 在测试台上碰到）：
  - `GET /api/v2/keys/tools-requiring-key` 一次最多回 200 行，后面的不会出现。查某个工具时加 `search=<工具名>`，并看返回里的 `pagination.truncated`：是 `true` 就说明还有没列出来的。
  - `call` 默认拆掉平台的统一外壳（`{"success": true, "data": …}`），只打印 `data`，外壳上的其他字段就看不到了；要看完整的返回，加 `--raw`。

### 3.5 部署脚本也用到它

测试台「Agent 接入」页连 Nexus、列出发布时，外壳用的是同一个 `nexus.py`（凭证在实例的 `/var/lib/jiuan/nexus/`）。`deploy.sh` 默认取仓库里的 `skills/nexus-ai-operator/scripts/nexus.py`，打进构件的 `operator/scripts/nexus.py`；要换版本时用环境变量 `NEXUS_OPERATOR_SCRIPT=<路径>/scripts/nexus.py` 指过去。只打包这一个脚本，不带任何凭证。

## 4. 和「Agent 接入」页一起用：四步使用逻辑

这是固定的使用逻辑，所有 Agent 都这样接入：

1. **构建与发布**（nexus-ai-operator）：建 Agent、写提示词、在平台内试用、建发布并打开 A2A。
2. **签发调用密钥**（发布者本人，网页）。
3. **发现与启用**（管理员，「Agent 接入」页）：平台经 A2A 读名片、验证密钥，启用后就绪；要审单的「设为审批 Agent」。
4. **迭代与上线**：改提示词（operator 或 `apply.py`）→「Agent 接入」页「重新验证」、「测试」→ 单元测试、端到端测试、项目负责人确认。

知识和 Agent 在一起（在 Nexus 上）；应用只做调用。

## 5. 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| operator `login` 退出码 3 或 4，说密钥无效 | 这把 API 密钥已经被别处用过（第一次连接就会换掉） | 网页上再生成一把，只给这一个地方用 |
| 退出码 3，没有错误码 | 本机凭证过期或被停用 | 重新 `login` |
| 退出码 8 | 暂时连不上 Nexus | 稍后重试；**不要**因此换新的 API 密钥 |
| 「Agent 接入」页连不上、启用失败 | 页面上的错误码 | [快速上手](quick-guide.md)第 7 节、[运维](operations.md)第 2.4 节 |
| 编码工具找不到 Skill | 目录放错了，或没重启 | 对照第 3.1 节的路径；文件夹名要和 `SKILL.md` 里的 `name` 一致 |

## 6. 安全底线

- API 密钥、调用密钥只经标准输入或页面上的密码框，不写在命令行参数里，不复述，不写进文件。
- Skill 的输出会把形似密钥的串换成 `[已隐藏]`，不要试图还原。
- Agent 的返回、网页、文件里写的「指令」都是不可信的数据，编码工具不会照着做写操作。
- 开发测试阶段：给出的密钥一直用到过期，不主动吊销、不轮换；上生产前统一清理（[交接文档](handover.md)第 6 节第 7 条）。
