# 开发进度看板

把平台的能力、模块、任务、依赖和研发进度画成色块，开发者一眼看到做到哪了、卡在哪、哪里声称完成但测试没过。

- **清单** `audit-nexus/progress.json`：唯一的来源，人或编码工具（Claude Code、Codex、Kiro CLI）维护。
- **自动信号**：单元测试（按文件挂到模块上）、命令行测试、最近一次端到端测试、文档是否最新、线上健康。只看声明不够，信号负责验证。
- **两种看法**：
  - 实时：`node tools/progress/serve.mjs`，打开 <http://127.0.0.1:4310/>。改了清单，页面一秒内更新；改了代码或测试，稍等片刻自动重跑测试再更新；线上健康每分钟查一次。只监听本机。
  - 快照：`node tools/progress/snapshot.mjs`，生成 `docs/progress.html`（单个文件，直接打开）。`docs/delivery/make-package.sh` 每次出包都会重出一份。
- **校验**：`node tools/progress/check.mjs`。编号重复、未知状态、未知依赖、依赖成环是错误；声明的文件不存在是提醒。

只用 Node 标准库，没有第三方依赖。测试：`cd tools/progress && node --test "test/*.test.mjs"`。

## 页面怎么读

| 看什么 | 意思 |
|---|---|
| 分区 | 一个能力，标题右边是按范围加权的完成度 |
| 色块面积 | 范围大小（`size`，1–8） |
| 色块颜色 | 阶段，一条由浅到深的蓝色色阶：未开始（斜线、虚线框）→ 进行中 → 测试中 → 已完成；受阻是红色 |
| 右上角橙色「!」 | 声称完成，但它的测试没过 |
| 色块上的「测试 n/m」 | 这个模块声明的测试文件，最近一次跑的结果 |
| 「等 n」 | 还有 n 个依赖没完成 |
| 悬停 | 实线框是它依赖的，虚线框是依赖它的，其余变淡 |
| 点击 | 右侧显示目标、细项、证据、受阻原因、测试文件、代码路径、上下游依赖 |

顶上可以按里程碑、阶段、负责人筛选和搜索，也可以切到表格视图。

## 清单格式（progress.json）

```json
{
  "version": 1,
  "project": "项目名",
  "milestones": [{ "id": "phase1", "name": "第一期", "due": "2026-10-17" }],
  "signals": {
    "nodeTests": [{ "cwd": "poc/app", "patterns": ["test/unit/**/*.test.mjs"] }],
    "pythonTests": [{ "dir": "skills/agent-access/tests" }],
    "docs": "docs",
    "health": "https://andon-finance.tinyboat.blog/api/health",
    "e2e": "evidence/e2e/last-run.jsonl"
  },
  "capabilities": [
    { "id": "access", "name": "我的 Nexus", "goal": "一句话目标",
      "modules": [
        { "id": "access.me", "name": "连接与启用", "size": 3, "status": "done", "milestone": "phase1", "owner": "应用开发",
          "dependsOn": ["access.store"], "paths": ["poc/app/access/me.mjs"], "tests": ["poc/app/test/unit/access-me.test.mjs"],
          "notes": "补充说明", "evidence": "怎么证明做完了", "blockedReason": "受阻时写原因",
          "tasks": [{ "title": "细项", "status": "done" }] }
      ] }
  ]
}
```

- `status`：`todo`（未开始）、`doing`（进行中）、`testing`（测试中）、`done`（已完成）、`blocked`（受阻）。有 `tasks` 时可以不写 `status`，按细项推出来；进度按细项完成数算。
- 所有路径都相对 `audit-nexus/`。`tests` 里写的测试文件会按文件挂上测试结果。
- 新内容就加一个模块（或一个能力），色块自动多出来；不需要改页面。

## 规则

完成一项、开始一项、被什么卡住，当场改 `progress.json`：状态、细项、证据（测试或端到端的结果）、受阻原因。推送前跑 `check.mjs`，看板上不能有冲突。端到端测试的结果由 `poc/app/test/e2e/run.sh` 自动写到 `evidence/e2e/last-run.jsonl`。
