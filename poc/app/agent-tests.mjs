/**
 * 「Agent 接入」页的单个 Agent 测试（挂在九安的 platformRoutes 钩子上，只给管理员）：
 *   POST /api/analysis/v1/platform/agent-access/<发布编号>/test   测这个发布，先回 202；请求体按测法三选一：
 *        { mode: 'text', text }           文本：一段话原样发过去（一个文字 Part），看它怎么回
 *        { mode: 'envelope', request }    请求信封：九安的 jiuan.agent/v1 请求（页面按契约里的任务预填示例），先按契约查请求，
 *                                         查不过不发；发出去和九安一样（一行说明 + 信封 DataPart），回答按契约判合格 / 不合格，原文留下
 *        { mode: 'document', documentId } 单据：选一张对公付款单，照九安自动初审的做法组装 review_advice@1（先读原件），
 *                                         经九安的调用中间件发出（计入限额和调用日志）；旧的 { documentId } 也认
 *   GET  /api/analysis/v1/platform/agent-access/tests/<testId>      查这次测试：状态、回复或结论、备注、依据、用时
 *   GET  /api/analysis/v1/platform/agent-access/test-documents      能拿来做单据测试的单据（单据池里的对公付款单）
 *   GET  /api/analysis/v1/platform/agent-access/test-templates      请求信封测试的模板（契约里的每个任务一份示例请求）
 * 每个发布都能测，不管是不是审批 Agent：测试只记进调用记录，不写单据的 AI 独立建议、不进两档结论。每次用新的会话，不和审批流的那一轮共用。
 * 文本和请求信封两种测法要看到 Agent 的原始回答，所以不经九安的适配层（它只给检查过的结果），直接用这个发布已启用的调用密钥发
 * （callRaw，由组合根注入）；九安的调用中间件里因此没有这两种的记录，这里的调用记录里有。
 * 每个管理员每分钟最多 5 次（每次都真实调用 Nexus）。最近 50 次留在内存里，服务重启清空。
 */
import { randomUUID } from 'node:crypto';

const START = /^\/api\/analysis\/v1\/platform\/agent-access\/(pub_[A-Za-z0-9_-]{4,80})\/test$/;
const VIEW = /^\/api\/analysis\/v1\/platform\/agent-access\/tests\/(test_[a-f0-9]{12})$/;
const DOCUMENTS = '/api/analysis/v1/platform/agent-access/test-documents';
const TEMPLATES = '/api/analysis/v1/platform/agent-access/test-templates';
const LIMIT = 50, TEXT_MAX = 4000, REPLY_MAX = 20_000, TEXT_TIMEOUT_MS = 120_000;
const MESSAGES = Object.freeze({
  AGENT_TEST_FORBIDDEN: '只有管理员能测试 Agent。',
  AGENT_TEST_INVALID: '测试内容不完整：文本测试要写一段话（最多 4000 字），单据测试要选一张单据。',
  AGENT_TEST_REQUEST_INVALID: '这个请求信封不合契约，没有发出去：按下面列出的地方改好再发。',
  AGENT_TEST_NOT_FOUND: '找不到这张单据或这次测试：刷新页面后再试。',
  AGENT_TEST_UNSUPPORTED: '单据测试只能用对公付款单（九安的 AI 独立建议只接对公付款单）。',
  AGENT_TEST_RATE_LIMIT: '测试每分钟最多 5 次，请稍后再试。',
});
const fail = (code, status, details) => { throw Object.assign(new Error(code), { code, status, details }); };
const codeOf = error => (typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code) ? error.code : 'AI_UNAVAILABLE');
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function send(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}
const basisOf = output => (Array.isArray(output?.basis) ? output.basis : [])
  .map(item => ({ kind: item?.kind ?? null, ref: item?.ref ?? '', page: Number.isSafeInteger(item?.page) ? item.page : null, note: item?.note ?? '' }));

/** 请求体 → { mode, … }；不合规的直接 400。 */
function parse(body, checkRequest) {
  if (!isObject(body)) fail('AGENT_TEST_INVALID', 400);
  const mode = body.mode ?? (Object.hasOwn(body, 'documentId') ? 'document' : null);
  const only = names => { if (Object.keys(body).some(name => name !== 'mode' && !names.includes(name))) fail('AGENT_TEST_INVALID', 400); };
  if (mode === 'text') {
    only(['text']);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text || [...text].length > TEXT_MAX) fail('AGENT_TEST_INVALID', 400);
    return { mode, text };
  }
  if (mode === 'envelope') {
    only(['request']);
    if (!isObject(body.request)) fail('AGENT_TEST_REQUEST_INVALID', 400, { problems: [{ path: '/', message: '请求信封要是一个 JSON 对象' }] });
    const problems = checkRequest(body.request);
    if (problems.length) fail('AGENT_TEST_REQUEST_INVALID', 400, { problems: problems.slice(0, 20) });
    return { mode, request: body.request };
  }
  if (mode === 'document') {
    only(['documentId']);
    if (typeof body.documentId !== 'string') fail('AGENT_TEST_INVALID', 400);
    return { mode, documentId: body.documentId };
  }
  return fail('AGENT_TEST_INVALID', 400);
}

export function createAgentTests({ readDocument, listDocuments, prepare, assemble, callAgent, templates = () => [], checkRequest = () => [],
  judge = () => ({ ok: false, problems: [], value: null }), callRaw, now = Date.now, perMinute = 5 }) {
  const tests = new Map(), windows = new Map();
  const iso = () => new Date(now()).toISOString();
  function spend(userId) {
    const at = now(), entry = windows.get(userId);
    const current = entry && entry.until > at ? entry : { until: at + 60_000, count: 0 };
    if (current.count >= perMinute) fail('AGENT_TEST_RATE_LIMIT', 429);
    current.count += 1;
    windows.set(userId, current);
  }
  const template = task => templates().find(item => item.task === task) ?? null;

  async function runDocument(test, document) {
    await prepare(document);
    const assembled = await assemble({ tenantId: document.tenantId, companyId: document.companyId, documentId: document.id, version: document.version });
    const answer = await callAgent({ publishId: test.publishId, tenantId: document.tenantId, companyId: document.companyId, assembled, partition: test.partition });
    const output = isObject(answer?.output) ? answer.output : {};
    Object.assign(test, { status: answer?.status === 'declined' ? 'declined' : 'completed', result: output.result ?? null, note: typeof output.note === 'string' ? output.note : '',
      basis: basisOf(output), declinedReason: answer?.declined?.reason ?? null, agentVersion: answer?.call?.agentVersion ?? null, repaired: answer?.call?.repaired ?? null });
  }
  async function runText(test, text) {
    const answer = await callRaw({ publishId: test.publishId, parts: [{ kind: 'text', text }], timeoutMs: TEXT_TIMEOUT_MS });
    Object.assign(test, { status: 'completed', reply: String(answer?.text ?? '').slice(0, REPLY_MAX) });
  }
  async function runEnvelope(test, request) {
    const task = `${request.task}@${request.taskVersion}`;
    const answer = await callRaw({ publishId: test.publishId, timeoutMs: template(task)?.timeoutMs ?? TEXT_TIMEOUT_MS,
      parts: [{ kind: 'text', text: `jiuan.agent/v1 · ${task}：按任务契约处理下面的请求，只返回结果信封 JSON。` }, { kind: 'data', data: request }] });
    const text = String(answer?.text ?? '');
    const verdict = judge(request, text);
    Object.assign(test, { status: 'completed', reply: text.slice(0, REPLY_MAX), conforms: verdict.ok === true,
      problems: (verdict.problems ?? []).slice(0, 20).map(problem => ({ code: problem.code ?? null, path: problem.path ?? '', message: problem.message ?? '' })),
      envelope: verdict.ok ? verdict.value : null, agentVersion: verdict.ok ? verdict.value?.agentVersion ?? null : null,
      result: verdict.ok ? verdict.value?.output?.result ?? null : null });
  }
  async function execute(test, work) {
    try { await work(); } catch (error) {
      Object.assign(test, { status: 'failed', errorCode: codeOf(error) });
    } finally {
      test.finishedAt = iso();
      test.latencyMs = Date.parse(test.finishedAt) - Date.parse(test.startedAt);
    }
  }
  async function start(user, publishId, body) {
    const input = parse(body, checkRequest);
    const document = input.mode === 'document' ? await readDocument(input.documentId) : null;
    if (input.mode === 'document' && !document) fail('AGENT_TEST_NOT_FOUND', 404);
    if (document && document.type !== 'corporate_payment') fail('AGENT_TEST_UNSUPPORTED', 409);
    spend(user.id);
    const testId = `test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const test = { testId, trigger: 'test', mode: input.mode, publishId, partition: testId, status: 'running',
      task: input.mode === 'document' ? 'review_advice@1' : input.mode === 'envelope' ? `${input.request.task}@${input.request.taskVersion}` : null,
      input: input.mode === 'text' ? input.text : null, documentId: document?.id ?? null, number: document?.number ?? null,
      result: null, note: '', basis: [], reply: null, conforms: null, problems: [], envelope: null, errorCode: null, declinedReason: null, agentVersion: null, repaired: null,
      startedAt: iso(), finishedAt: null, latencyMs: null, requestedBy: user.id };
    tests.set(testId, test);
    for (const old of [...tests.keys()].slice(0, Math.max(0, tests.size - LIMIT))) tests.delete(old);
    void execute(test, () => (input.mode === 'document' ? runDocument(test, document) : input.mode === 'text' ? runText(test, input.text) : runEnvelope(test, input.request)));
    return test;
  }
  const view = test => { const { partition, ...shown } = test; return { ...shown, at: test.finishedAt ?? test.startedAt }; };
  return {
    rows: () => [...tests.values()].map(view).reverse(),
    async handle({ req, path, session, res, body }) {
      const starting = req.method === 'POST' ? START.exec(path) : null, viewing = req.method === 'GET' ? VIEW.exec(path) : null;
      const listing = req.method === 'GET' && path === DOCUMENTS, offering = req.method === 'GET' && path === TEMPLATES;
      if (!starting && !viewing && !listing && !offering && !(req.method === 'GET' && path.startsWith('/api/analysis/v1/platform/agent-access/tests/'))) return false;
      try {
        if (session?.user?.role !== 'admin') fail('AGENT_TEST_FORBIDDEN', 403);
        if (starting) send(res, 202, { data: view(await start(session.user, starting[1], body)) });
        else if (listing) {
          const items = (await listDocuments()).filter(document => document.type === 'corporate_payment')
            .map(document => ({ id: document.id, number: document.number, title: document.title ?? null, formName: document.formName ?? null, companyName: document.companyName ?? null }));
          send(res, 200, { data: { items } });
        } else if (offering) send(res, 200, { data: { items: templates().map(({ task, title, request }) => ({ task, title, request })) } });
        else {
          const test = viewing ? tests.get(viewing[1]) : null;
          if (!test) fail('AGENT_TEST_NOT_FOUND', 404);
          send(res, 200, { data: view(test) });
        }
      } catch (error) {
        const code = Object.hasOwn(MESSAGES, error?.code) ? error.code : 'AGENT_TEST_NOT_FOUND';
        send(res, Number.isInteger(error?.status) ? error.status : 500, { error: { code, message: MESSAGES[code], ...(error?.details ? { details: error.details } : {}) } });
      }
      return true;
    },
  };
}
