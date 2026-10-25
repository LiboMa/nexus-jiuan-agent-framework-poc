/**
 * 「Agent 接入」页的调用记录（挂在九安的 platformRoutes 钩子上，只给管理员）：
 *   GET /api/analysis/v1/platform/agent-access/calls  最近的 AI 任务轮次，新的在前：单据号、任务、发给哪个发布、触发方式、状态、结论、
 *                                                      用时、错误码，以及 Agent 返回的备注和逐条依据（模型自评，未核实）。
 * 九安把每张单每个任务的轮次存在状态表 agent-task:v1:<哈希>（当前一轮 + 最近 5 轮历史），键由租户、公司、任务、单据编号算出
 * （agentTaskKey，组合根注入九安自己的那个），所以这里从单据池的单据反查。只读。
 */
const PATH = '/api/analysis/v1/platform/agent-access/calls';
const LIMIT = 50;

function send(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}
const elapsed = (from, to) => { const ms = Date.parse(to) - Date.parse(from); return Number.isFinite(ms) && ms >= 0 ? ms : null; };

function rowOf(document, task, record) {
  const output = record.output && typeof record.output === 'object' ? record.output : {};
  return {
    at: record.finishedAt ?? record.startedAt ?? null, documentId: document.id, number: document.number, task, round: record.round ?? null,
    trigger: record.trigger ?? null, publishId: record.publishId ?? null, status: record.status ?? null, result: output.result ?? null,
    errorCode: record.errorCode ?? null, declinedReason: record.declined?.reason ?? null, startedAt: record.startedAt ?? null, finishedAt: record.finishedAt ?? null,
    latencyMs: record.finishedAt ? elapsed(record.startedAt, record.finishedAt) : null, attempts: record.attempts ?? null,
    agentVersion: record.call?.agentVersion ?? null, repaired: record.call?.repaired ?? null, note: typeof output.note === 'string' ? output.note : '',
    basis: (Array.isArray(output.basis) ? output.basis : []).map(item => ({ kind: item?.kind ?? null, ref: item?.ref ?? '', page: Number.isSafeInteger(item?.page) ? item.page : null, note: item?.note ?? '' })),
  };
}

/** extraRows：别处产生的调用（「Agent 接入」页的手动测试，agent-tests.mjs），和九安存的轮次合在一起按时间排。 */
export function agentCallRoutes({ tenantId, tasks, agentTaskKey, listDocuments, readState, extraRows = () => [] }) {
  async function calls() {
    const rows = [];
    for (const document of await listDocuments()) {
      for (const task of tasks) {
        const state = await readState(agentTaskKey({ tenantId, companyId: document.companyId, task, subject: { kind: 'document', id: document.id } }));
        for (const record of [state?.current, ...(Array.isArray(state?.history) ? state.history : [])]) if (record) rows.push(rowOf(document, task, record));
      }
    }
    rows.push(...extraRows());
    rows.sort((left, right) => String(right.at ?? '').localeCompare(String(left.at ?? '')));
    return { items: rows.slice(0, LIMIT) };
  }
  return {
    async handle({ req, path, session, res }) {
      if (req.method !== 'GET' || path !== PATH) return false;
      if (session?.user?.role !== 'admin') send(res, 403, { error: { code: 'AGENT_CALLS_FORBIDDEN', message: '只有管理员能查看 Agent 调用记录。' } });
      else {
        try { send(res, 200, { data: await calls() }); }
        catch { send(res, 503, { error: { code: 'AGENT_CALLS_UNAVAILABLE', message: '调用记录暂时读不到，稍后刷新。' } }); }
      }
      return true;
    },
  };
}
