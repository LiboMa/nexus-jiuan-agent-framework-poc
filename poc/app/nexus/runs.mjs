/** 最近的 Agent 调用记录（内存，最多 limit 条，重启清空）。审批流、单据详情里的 AI 建议和调用测试都记在这里。 */
export const RAW_TEXT_LIMIT = 20_000;

export function createRunLog({ limit = 50, now = () => new Date().toISOString() } = {}) {
  const runs = [];
  let sequence = 0;
  const find = id => runs.find(run => run.id === id);
  return {
    start(fields) {
      sequence += 1;
      const run = { id: `run_${Date.now().toString(36)}_${sequence.toString(36)}`, startedAt: now(), finishedAt: null, status: 'running', ...fields };
      runs.unshift(run);
      if (runs.length > limit) runs.length = limit;
      return run.id;
    },
    finish(id, fields) {
      const run = find(id);
      if (run) Object.assign(run, fields, { finishedAt: now() });
    },
    get(id) {
      const run = find(id);
      return run ? structuredClone(run) : null;
    },
    list(max = limit) {
      return runs.slice(0, Math.max(0, max)).map(({ rawText, detail, ...summary }) => ({
        ...structuredClone(summary), hasRawText: typeof rawText === 'string' && rawText.length > 0,
      }));
    },
  };
}
