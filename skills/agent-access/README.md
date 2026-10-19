# agent-access Skill

让 Claude Code、Codex、Kiro CLI 这类编码工具，以你的身份把你在 Nexus 上发布的 Agent 接入九安 PoC（或任何实现了 `agent-access-v1` 的应用）：连接、启用、调用测试、停用。编码工具读 `SKILL.md`；这份写给安装它的人。

## 1. 安装

把整个 `agent-access` 文件夹放进编码工具的技能目录，再重启一次编码工具：

| 编码工具 | 个人目录（对所有项目生效） | 项目目录（只对这个项目生效） |
|---|---|---|
| Claude Code | `~/.claude/skills/agent-access/` | `<项目>/.claude/skills/agent-access/` |
| Codex | `~/.agents/skills/agent-access/`（较早的版本是 `~/.codex/skills/`） | `<项目>/.agents/skills/agent-access/` |
| Kiro CLI | `~/.kiro/skills/agent-access/` | `<项目>/.kiro/skills/agent-access/` |

例如装到 Claude Code：

```bash
mkdir -p ~/.claude/skills
cp -R skills/agent-access ~/.claude/skills/agent-access
```

- 只要 Python 3.9 及以上，不装任何依赖。
- 不支持 Skills 的工具：把 `SKILL.md` 交给它当说明，它照着运行 `scripts/agent_access.py` 就行。
- 通常和 `nexus-ai-operator` 一起装：那个 Skill 在 Nexus 上建 Agent、发布；这个在应用里启用、测试。

## 2. 第一次用

对编码工具说「用 agent-access 登录九安 PoC」，它会请你给：
1. 应用地址（`https://andon-finance.tinyboat.blog`）、账号和口令。口令只经标准输入交给脚本，本机只存 8 小时的会话。
2. 连接 Nexus 用的 API 密钥：在 Nexus「个人设置 › API 密钥」新建一把。第一次连接后 Nexus 会把它换成新的，你给的那串随即作废。
3. 要启用某个发布时，这个发布的调用密钥：只有你本人能在 Nexus 网页「互联中心 › 对外发布」签发。

## 3. 本机文件与停用

- 会话：`~/.agent-access/credentials.json`（0600，目录 0700，按 `--profile` 分开；可用环境变量 `AGENT_ACCESS_HOME` 换位置）。删掉它或运行 `agent_access.py logout --yes` 就退出登录。
- 应用里的连接与启用：在应用的「Nexus Agent」页上断开、停用，或用 `nexus disconnect`、`disable`。

## 4. 测试

```bash
python3 -m unittest discover -s skills/agent-access/tests
```
