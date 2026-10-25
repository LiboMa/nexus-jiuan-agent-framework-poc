/**
 * 「Agent 接入」页的单个 Agent 测试（挂在九安的 platformRoutes 钩子上，只给管理员）：
 *   POST /api/analysis/v1/platform/agent-access/<发布编号>/test {documentId}  选一张对公付款单测这个发布，先回 202
 *   GET  /api/analysis/v1/platform/agent-access/tests/<testId>                 查这次测试：状态、结论、备注、依据、用时
 *   GET  /api/analysis/v1/platform/agent-access/test-documents                 能拿来测试的单据（单据池里的对公付款单）
 * 做法和九安自动初审一样：先读原件，照九安的 review_advice@1 组装请求，经九安的调用中间件发给这个发布（计入限额和调用日志），
 * 但用专用的会话分区（不和自动那一轮共用 A2A 会话），结果不写进单据的 AI 独立建议、不进两档结论，只记进调用记录。
 * 每个管理员每分钟最多 5 次（每次都真实调用 Nexus）。最近 50 次留在内存里，服务重启清空。
 */
import { randomUUID } from 'node:crypto';

const START = /^\/api\/analysis\/v1\/platform\/agent-access\/(pub_[A-Za-z0-9_-]{4,80})\/test$/;
const VIEW = /^\/api\/analysis\/v1\/platform\/agent-access\/tests\/(test_[a-f0-9]{12})$/;
const DOCUMENTS = '/api/analysis/v1/platform/agent-access/test-documents';
const LIMIT = 50;
const MESSAGES = Object.freeze({
  AGENT_TEST_FORBIDDEN: '只有管理员能测试 Agent。',
  AGENT_TEST_INVALID: '请选一张单据再测试。',
  AGENT_TEST_NOT_FOUND: '找不到这张单据或这次测试：刷新页面后再试。',
  AGENT_TEST_UNSUPPORTED: '只能用对公付款单测试（九安的 AI 独立建议只接对公付款单）。',
  AGENT_TEST_RATE_LIMIT: '测试每分钟最多 5 次，请稍后再试。',
});
const fail = (code, status) => { throw Object.assign(new Error(code), { code, status }); };
const codeOf = error => (typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code) ? error.code : 'AI_UNAVAILABLE');
function send(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

export function createAgentTests({ readDocument, listDocuments, prepare, assemble, callAgent, now = Date.now, perMinute = 5 }) {
  const tests = new Map(), windows = new Map();
  const iso = () => new Date(now()).toISOString();
  function spend(userId) {
    const at = now(), entry = windows.get(userId);
    const current = entry && entry.until > at ? entry : { until: at + 60_000, count: 0 };
    if (current.count >= perMinute) fail('AGENT_TEST_RATE_LIMIT', 429);
    current.count += 1;
    windows.set(userId, current);
  }
  async function execute(test, document) {
    try {
      await prepare(document);
      const assembled = await assemble({ tenantId: document.tenantId, companyId: document.companyId, documentId: document.id, version: document.version });
      const answer = await callAgent({ publishId: test.publishId, tenantId: document.tenantId, companyId: document.companyId, assembled, partition: test.partition });
      const output = answer?.output && typeof answer.output === 'object' ? answer.output : {};
      Object.assign(test, { status: answer?.status === 'declined' ? 'declined' : 'completed', result: output.result ?? null, note: typeof output.note === 'string' ? output.note : '',
        basis: (Array.isArray(output.basis) ? output.basis : []).map(item => ({ kind: item?.kind ?? null, ref: item?.ref ?? '', page: Number.isSafeInteger(item?.page) ? item.page : null, note: item?.note ?? '' })),
        declinedReason: answer?.declined?.reason ?? null, agentVersion: answer?.call?.agentVersion ?? null, repaired: answer?.call?.repaired ?? null });
    } catch (error) {
      Object.assign(test, { status: 'failed', errorCode: codeOf(error) });
    } finally {
      test.finishedAt = iso();
      test.latencyMs = Date.parse(test.finishedAt) - Date.parse(test.startedAt);
    }
  }
  async function start(user, publishId, body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(name => name !== 'documentId') || typeof body.documentId !== 'string') fail('AGENT_TEST_INVALID', 400);
    const document = await readDocument(body.documentId);
    if (!document) fail('AGENT_TEST_NOT_FOUND', 404);
    if (document.type !== 'corporate_payment') fail('AGENT_TEST_UNSUPPORTED', 409);
    spend(user.id);
    const testId = `test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const test = { testId, trigger: 'test', task: 'review_advice', contractTask: 'review_advice@1', publishId, documentId: document.id, number: document.number,
      partition: testId, status: 'running', result: null, note: '', basis: [], errorCode: null, declinedReason: null, agentVersion: null, repaired: null,
      startedAt: iso(), finishedAt: null, latencyMs: null, requestedBy: user.id };
    tests.set(testId, test);
    for (const old of [...tests.keys()].slice(0, Math.max(0, tests.size - LIMIT))) tests.delete(old);
    void execute(test, document);
    return test;
  }
  const view = test => { const { partition, ...shown } = test; return { ...shown, at: test.finishedAt ?? test.startedAt }; };
  return {
    rows: () => [...tests.values()].map(view).reverse(),
    async handle({ req, path, session, res, body }) {
      const starting = req.method === 'POST' ? START.exec(path) : null, viewing = req.method === 'GET' ? VIEW.exec(path) : null;
      const listing = req.method === 'GET' && path === DOCUMENTS;
      if (!starting && !viewing && !listing && !(req.method === 'GET' && path.startsWith('/api/analysis/v1/platform/agent-access/tests/'))) return false;
      try {
        if (session?.user?.role !== 'admin') fail('AGENT_TEST_FORBIDDEN', 403);
        if (starting) send(res, 202, { data: view(await start(session.user, starting[1], body)) });
        else if (listing) {
          const items = (await listDocuments()).filter(document => document.type === 'corporate_payment')
            .map(document => ({ id: document.id, number: document.number, title: document.title ?? null, formName: document.formName ?? null, companyName: document.companyName ?? null }));
          send(res, 200, { data: { items } });
        }
        else {
          const test = viewing ? tests.get(viewing[1]) : null;
          if (!test) fail('AGENT_TEST_NOT_FOUND', 404);
          send(res, 200, { data: view(test) });
        }
      } catch (error) {
        const code = Object.hasOwn(MESSAGES, error?.code) ? error.code : 'AGENT_TEST_NOT_FOUND';
        send(res, Number.isInteger(error?.status) ? error.status : 500, { error: { code, message: MESSAGES[code] } });
      }
      return true;
    },
  };
}
