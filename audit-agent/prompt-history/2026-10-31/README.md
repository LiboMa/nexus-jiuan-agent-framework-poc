# 审单 Agent 提示词 · 2026-10-31 更新留存

**这次为什么改**：知识库的规则换成了「审批风险判断卡」（`risk-cards`，449 条）。旧制度 `finance-approval-v4` 已下线，可恢复。旧提示词只认审批矩阵，换卡后每轮 AI 建议都超过九安的 120 秒上限。这一版让审单 Agent 既认审批矩阵，也认风险判断卡。

**负责人的决定（10-31）**：
- 判断依据写着「一期不上线」的卡，不能单凭这一张卡判不通过。
- 确认更新到 Nexus。
- 相关文件在本地留存一份。

**线上状态**：Nexus `nxs-beine1013`，审单 Agent 的发布修订号从 14 升到 15。更新后核对通过：线上提示词与 `prompt.yaml` 的 pg 方式渲染结果一致。

| 文件 | 内容 |
|---|---|
| `prompt-before-2026-10-28.1.yaml` | 更新前线上的提示词（pg 方式渲染结果），也是回退用的底稿 |
| `prompt-after-2026-10-31.1.yaml` | 更新后的提示词（pg 方式渲染结果，和线上一致） |
| `diff-before-apply.txt` | 更新前做的只读比对：线上 → 新提示词，共 23 行差异 |
| `apply-log.txt` | 执行 `apply.py` 的输出 |
| `logic-report.html` | 改动前后处理逻辑的对照说明（给人看） |

源文件是 `audit-agent/prompt.yaml`，提交 94b36e5。

**回退**：用 `prompt-before-2026-10-28.1.yaml` 作底稿的那一版重新下发。把 `audit-agent/prompt.yaml` 换回提交 94b36e5 之前的版本，再运行：

```
python3 audit-agent/apply.py --env poc/infra/env/beine1013.env --base audit-agent/prompt-history/2026-10-31/prompt-after-2026-10-31.1.yaml
```
