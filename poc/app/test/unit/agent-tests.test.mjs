import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentTests } from '../../agent-tests.mjs';

const BASE = '/api/analysis/v1/platform/agent-access';
const DOCS = new Map([['d1', { id: 'd1', number: 'DGZF-F07-001', tenantId: 't1', companyId: 'co-a', version: 'v1', type: 'corporate_payment' }],
  ['d9', { id: 'd9', number: 'CLBX-F07-005', tenantId: 't1', companyId: 'co-a', version: 'v9', type: 'employee_expense' }]]);
const REQUEST = Object.freeze({ envelope: 'jiuan.agent/v1', task: 'describe', taskVersion: 1, requestId: '6f1d2b4e-0c8a-4f7e-9a51-2d3c4b5a6e7f',
  context: { tenantId: 't1', scope: 'company', companyId: 'co-a', subject: null, locale: 'zh-CN' }, input: {} });
const tick = async () => { for (let index = 0; index < 4; index += 1) await new Promise(resolve => setImmediate(resolve)); };

function harness({ answer = async () => ({ status: 'completed', output: { result: 'pass', note: '核对一致', basis: [{ kind: 'rule', ref: 'C05-3.4', note: '…' }] },
  call: { agentVersion: 'v-test', repaired: false } }), reply = async () => ({ text: '你好，我是九安审核AI。' }),
  judge = () => ({ ok: true, problems: [], value: { status: 'completed', output: { tasks: [] }, agentVersion: 'v-d' } }) } = {}) {
  const calls = [];
  let clock = Date.parse('2026-10-26T03:00:00Z');
  const tests = createAgentTests({ readDocument: async id => DOCS.get(id) ?? null, listDocuments: async () => [...DOCS.values()], now: () => (clock += 1000),
    prepare: async document => { calls.push(`prepare ${document.number}`); },
    assemble: async subject => { calls.push(`assemble ${subject.documentId}@${subject.version}`); return { request: { requestId: 'r' }, inputFingerprint: 'fp' }; },
    callAgent: async input => { calls.push(`call ${input.publishId} ${input.partition}`); return answer(input); },
    templates: () => [{ task: 'describe@1', title: '能力清单', timeoutMs: 60000, request: REQUEST }],
    checkRequest: request => (request.task === 'describe' ? [] : [{ path: '/task', message: '不认识的任务' }]),
    judge: (request, text) => judge(request, text),
    callRaw: async ({ publishId, parts, timeoutMs }) => { calls.push(['raw', publishId, parts, timeoutMs]); return reply(); } });
  const ask = async (method, path, { role = 'admin', body } = {}) => {
    let status = null, payload = null;
    const res = { writeHead(code) { status = code; return this; }, setHeader() {}, end(text) { payload = JSON.parse(text); } };
    const handled = await tests.handle({ req: { method }, path, session: { user: { id: 'poc-reviewer', role } }, res, body });
    return { handled, status, payload };
  };
  const finished = async id => { await tick(); return (await ask('GET', `${BASE}/tests/${id}`)).payload.data; };
  return { tests, calls, ask, finished };
}

test('单据测试：先读原件、照九安组装请求，用专用会话发给这个发布；接口先回 202，跑完能查到结论、备注和依据（旧的 { documentId } 也认）', async () => {
  const { tests, calls, ask, finished } = harness();
  const started = await ask('POST', `${BASE}/pub_audit0001/test`, { body: { mode: 'document', documentId: 'd1' } });
  assert.equal(started.status, 202);
  assert.equal(started.payload.data.status, 'running');
  const done = await finished(started.payload.data.testId);
  assert.deepEqual([done.mode, done.status, done.result, done.note, done.publishId, done.number, done.agentVersion], ['document', 'completed', 'pass', '核对一致', 'pub_audit0001', 'DGZF-F07-001', 'v-test']);
  assert.equal(done.basis[0].ref, 'C05-3.4');
  assert.ok(Number.isFinite(done.latencyMs));
  assert.deepEqual(calls, ['prepare DGZF-F07-001', 'assemble d1@v1', `call pub_audit0001 ${done.testId}`]);
  assert.equal((await ask('POST', `${BASE}/pub_audit0001/test`, { body: { documentId: 'd1' } })).status, 202);
  assert.deepEqual(tests.rows().map(row => [row.trigger, row.mode, row.number]), [['test', 'document', 'DGZF-F07-001'], ['test', 'document', 'DGZF-F07-001']]);
});

test('文本测试：把一段话原样发给这个 Agent（只有一个文字 Part），记下它的回复', async () => {
  const { calls, ask, finished } = harness();
  const started = await ask('POST', `${BASE}/pub_knowledge1/test`, { body: { mode: 'text', text: '  你好，你能做什么？ ' } });
  assert.equal(started.status, 202);
  const done = await finished(started.payload.data.testId);
  assert.deepEqual([done.mode, done.status, done.reply, done.input, done.number], ['text', 'completed', '你好，我是九安审核AI。', '你好，你能做什么？', null]);
  assert.deepEqual(calls, [['raw', 'pub_knowledge1', [{ kind: 'text', text: '你好，你能做什么？' }], 120000]]);
  for (const text of ['', '   ', 'x'.repeat(4001), 42]) assert.equal((await ask('POST', `${BASE}/pub_knowledge1/test`, { body: { mode: 'text', text } })).status, 400, JSON.stringify(text).slice(0, 20));
});

test('请求信封测试：模板来自契约；先按契约查请求，查不过不发；发出去的和九安一样（一行说明 + 信封 DataPart），回答按契约判合格，原样留下', async () => {
  const { calls, ask, finished } = harness({ reply: async () => ({ text: '```json\n{"status":"completed"}\n```' }) });
  const templates = (await ask('GET', `${BASE}/test-templates`)).payload.data.items;
  assert.deepEqual(templates.map(item => [item.task, item.title]), [['describe@1', '能力清单']]);
  const refused = await ask('POST', `${BASE}/pub_audit0001/test`, { body: { mode: 'envelope', request: { ...REQUEST, task: 'nope' } } });
  assert.equal(refused.status, 400);
  assert.equal(refused.payload.error.code, 'AGENT_TEST_REQUEST_INVALID');
  assert.deepEqual(refused.payload.error.details.problems, [{ path: '/task', message: '不认识的任务' }]);
  assert.equal(calls.length, 0, '请求不合契约：不发给 Agent');
  const done = await finished((await ask('POST', `${BASE}/pub_audit0001/test`, { body: { mode: 'envelope', request: REQUEST } })).payload.data.testId);
  assert.deepEqual([done.mode, done.status, done.task, done.conforms, done.agentVersion], ['envelope', 'completed', 'describe@1', true, 'v-d']);
  assert.equal(done.reply, '```json\n{"status":"completed"}\n```');
  assert.deepEqual(done.envelope, { status: 'completed', output: { tasks: [] }, agentVersion: 'v-d' });
  assert.deepEqual(calls, [['raw', 'pub_audit0001', [{ kind: 'text', text: 'jiuan.agent/v1 · describe@1：按任务契约处理下面的请求，只返回结果信封 JSON。' }, { kind: 'data', data: REQUEST }], 60000]]);
});

test('请求信封测试：回答不合契约时记成「不合格」并列出问题，回答原文照样留下（这一轮算完成，不是调用失败）', async () => {
  const { ask, finished } = harness({ reply: async () => ({ text: '好的，我看了一下。' }),
    judge: () => ({ ok: false, problems: [{ code: 'ANSWER_NOT_JSON', path: '', message: '回答里必须恰好是一个 JSON 对象' }], value: null }) });
  const done = await finished((await ask('POST', `${BASE}/pub_knowledge1/test`, { body: { mode: 'envelope', request: REQUEST } })).payload.data.testId);
  assert.deepEqual([done.status, done.conforms, done.reply, done.envelope], ['completed', false, '好的，我看了一下。', null]);
  assert.deepEqual(done.problems, [{ code: 'ANSWER_NOT_JSON', path: '', message: '回答里必须恰好是一个 JSON 对象' }]);
});

test('调用失败如实记下错误码；不是对公付款单、单据不存在、不是管理员、请求不完整都拒绝；每分钟最多 5 次', async () => {
  const { ask, finished } = harness({ answer: async () => { throw Object.assign(new Error('x'), { code: 'AI_AUTH_INVALID' }); },
    reply: async () => { throw Object.assign(new Error('x'), { code: 'AI_UNAVAILABLE' }); } });
  const failed = await finished((await ask('POST', `${BASE}/pub_audit0001/test`, { body: { documentId: 'd1' } })).payload.data.testId);
  assert.deepEqual([failed.status, failed.errorCode], ['failed', 'AI_AUTH_INVALID']);
  const textFailed = await finished((await ask('POST', `${BASE}/pub_audit0001/test`, { body: { mode: 'text', text: '你好' } })).payload.data.testId);
  assert.deepEqual([textFailed.status, textFailed.errorCode], ['failed', 'AI_UNAVAILABLE']);
  assert.equal((await ask('POST', `${BASE}/pub_audit0001/test`, { body: { documentId: 'd9' } })).status, 409);
  assert.equal((await ask('POST', `${BASE}/pub_audit0001/test`, { body: { documentId: 'nope' } })).status, 404);
  assert.equal((await ask('POST', `${BASE}/pub_audit0001/test`, { body: { documentId: 'd1' }, role: 'analyst' })).status, 403);
  assert.equal((await ask('POST', `${BASE}/pub_audit0001/test`, { body: { documentId: 'd1', extra: 1 } })).status, 400);
  assert.equal((await ask('POST', `${BASE}/pub_audit0001/test`, { body: { mode: 'other' } })).status, 400);
  assert.equal((await ask('GET', `${BASE}/tests/test_nosuch`)).status, 404);
  for (let index = 0; index < 3; index += 1) await ask('POST', `${BASE}/pub_audit0001/test`, { body: { documentId: 'd1' } });
  assert.equal((await ask('POST', `${BASE}/pub_audit0001/test`, { body: { documentId: 'd1' } })).status, 429);
  assert.equal((await ask('POST', `${BASE}/pub_audit0001/rotate`, { body: {} })).handled, false);
});

test('测试用的单据：只列对公付款单（单据号、标题）；模板和单据都只给管理员', async () => {
  const { ask } = harness();
  const listed = await ask('GET', `${BASE}/test-documents`);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.payload.data.items.map(item => [item.id, item.number]), [['d1', 'DGZF-F07-001']]);
  assert.equal((await ask('GET', `${BASE}/test-documents`, { role: 'analyst' })).status, 403);
  assert.equal((await ask('GET', `${BASE}/test-templates`, { role: 'analyst' })).status, 403);
});
