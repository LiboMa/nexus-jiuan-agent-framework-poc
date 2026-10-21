# nexus-ai-operator 接入包

让 Codex、Claude Code、Kiro 等 Agent 以你的身份、按你给的权限操作 Nexus-AI 平台。
Agent 读的是 `SKILL.md`；本文件写给把接入包交给 Agent 的人。

## 1. 安装

把整个 `nexus-ai-operator` 文件夹放进 Agent 的技能目录（个人目录对所有项目生效，项目目录只对该项目生效）：

| Agent | 个人目录 | 项目目录 |
|---|---|---|
| Claude Code | `~/.claude/skills/nexus-ai-operator/` | `<项目>/.claude/skills/nexus-ai-operator/` |
| Codex | `~/.agents/skills/nexus-ai-operator/` | `<项目>/.agents/skills/nexus-ai-operator/` |
| Kiro | `~/.kiro/skills/nexus-ai-operator/` | `<项目>/.kiro/skills/nexus-ai-operator/` |

较早的 Codex 版本读的是 `~/.codex/skills/`。其它支持 Agent Skills 的工具同理；不支持的，把 `SKILL.md` 交给它当说明即可。
运行环境只需要 Python 3.9 及以上，不用安装任何依赖。放好后重启一次 Agent，让它重新扫描技能目录。

## 2. 连接

- **网页生成 API 密钥时下载的接入包**：已经带着平台地址和这把密钥，对 Agent 说「用 nexus-ai-operator 连接 Nexus」即可。
  第一次连接时平台会把包里的密钥换成新的、只保存在 Agent 所在的电脑上，包里那把随即失效并被删除。
  **一个接入包只交给一个 Agent**；要给第二个 Agent，请在网页上再生成一把。
- **从技能库下载的接入包**：只带平台地址，不带密钥。另外在网页「个人设置 › API 密钥」生成一把，把密钥交给 Agent。

## 3. 停用

在网页「个人设置 › API 密钥」里随时停用这把密钥，Agent 立刻无法再访问平台；也可以在那里改它能做的事（权限档位）。

---

**English.** Put the whole `nexus-ai-operator` folder into your agent's skills folder (Claude Code `~/.claude/skills/`,
Codex `~/.agents/skills/`, Kiro `~/.kiro/skills/`, or the same path inside a project) and restart the agent.
A package downloaded while creating an API key already contains the platform address and that key: ask the agent to
"connect to Nexus with nexus-ai-operator". The key is replaced on first connection and removed from the package, so give each
package to one agent only. A package downloaded from the skill library contains only the platform address; create an
API key on the web page and give it to the agent. Disable the key on the same page at any time.
