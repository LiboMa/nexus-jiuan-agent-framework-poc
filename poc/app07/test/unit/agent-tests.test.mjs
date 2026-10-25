import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentTests } from '../../agent-tests.mjs';

const BASE = '/api/analysis/v1/platform/agent-access';
const DOCS = new Map([['d1', { id: 'd1', number: 'DGZF-F07-001', tenantId: 't1', companyId: 'co-a', version: 'v1', type: 'corporate_payment' }],
  ['d9', { id: 'd9', number: 'CLBX-F07-005', tenantId: 't1', companyId: 'co-a', version: 'v9', type: 'employee_expense' }]]);
const tick = () => new Promise(resolve => setImmediate(resolve));

function harness({ answer = async () => ({ status: 'completed', output: { result: 'pass', note: '核对一致', basis: [{ kind: 'rule', ref: 'C05-3.4', note: '…' }] },
  call: { agentVersion: 'v-test', repaired: false } }) } = {}) {
  const calls = [];
  let clock = Date.parse('2026-10-26T03:00:00Z');
  const tests = createAgentTests({ readDocument: async id => DOCS.get(id) ?? null, listDocuments: async () => [...DOCS.values()], now: () => (clock += 1000),
    prepare: async document => { calls.push(`prepare ${document.number}`); },
    assemble: async subject => { calls.push(`assemble ${subject.documentId}@${subject.version}`); return { request: { requestId: 'r' }, inputFingerprint: 'fp' }; },
    callAgent: async input => { calls.push(`call ${input.publishId} ${input.partition}`); return answer(input); } });
  const ask = async (method, path, { role = 'admin', body } = {}) => {
    let status = null, payload = null;
    const res = { writeHead(code) { status = code; return this; }, setHeader() {}, end(text) { payload = JSON.parse(text); } };
    const handled = await tests.handle({ req: { method }, path, session: { user: { id: 'poc-reviewer', role } }, res, body });
    return { handled, status, payload };
  };
  return { tests, calls, ask };
}

test('测试某个 Agent：先读原件、照九安组装请求，用专用会话发给这个发布；接口先回 202，跑完能查到结论、备注和依据', async () => {
  const { tests, calls, ask } = harness();
  const started = await ask('POST', `${BASE}/pub_audit0001/test`, { body: { documentId: 'd1' } });
  assert.equal(started.status, 202);
  assert.equal(started.payload.data.status, 'running');
  const id = started.payload.data.testId;
  await tick(); await tick();
  const done = (await ask('GET', `${BASE}/tests/${id}`)).payload.data;
  assert.deepEqual([done.status, done.result, done.note, done.publishId, done.number, done.agentVersion], ['completed', 'pass', '核对一致', 'pub_audit0001', 'DGZF-F07-001', 'v-test']);
  assert.equal(done.basis[0].ref, 'C05-3.4');
  assert.ok(Number.isFinite(done.latencyMs));
  assert.deepEqual(calls, ['prepare DGZF-F07-001', 'assemble d1@v1', `call pub_audit0001 ${id}`]);
  assert.deepEqual(tests.rows().map(row => [row.trigger, row.number, row.status]), [['test', 'DGZF-F07-001', 'completed']]);
});

test('调用失败如实记下错误码；不是对公付款单、单据不存在、不是管理员、请求不完整都拒绝；每分钟最多 5 次', async () => {
  const { ask } = harness({ answer: async () => { throw Object.assign(new Error('x'), { code: 'AI_AUTH_INVALID' }); } });
  const started = await ask('POST', `${BASE}/pub_audit0001/test`, { body: { documentId: 'd1' } });
  await tick(); await tick();
  const failed = (await ask('GET', `${BASE}/tests/${started.payload.data.testId}`)).payload.data;
  assert.deepEqual([failed.status, failed.errorCode], ['failed', 'AI_AUTH_INVALID']);
  assert.equal((await ask('POST', `${BASE}/pub_audit0001/test`, { body: { documentId: 'd9' } })).status, 409);
  assert.equal((await ask('POST', `${BASE}/pub_audit0001/test`, { body: { documentId: 'nope' } })).status, 404);
  assert.equal((await ask('POST', `${BASE}/pub_audit0001/test`, { body: { documentId: 'd1' }, role: 'analyst' })).status, 403);
  assert.equal((await ask('POST', `${BASE}/pub_audit0001/test`, { body: { documentId: 'd1', extra: 1 } })).status, 400);
  assert.equal((await ask('GET', `${BASE}/tests/test_nosuch`)).status, 404);
  for (let index = 0; index < 4; index += 1) await ask('POST', `${BASE}/pub_audit0001/test`, { body: { documentId: 'd1' } });
  assert.equal((await ask('POST', `${BASE}/pub_audit0001/test`, { body: { documentId: 'd1' } })).status, 429);
  assert.equal((await ask('POST', `${BASE}/pub_audit0001/rotate`, { body: {} })).handled, false);
});

test('测试用的单据：只列对公付款单（单据号、标题），只给管理员', async () => {
  const { ask } = harness();
  const listed = await ask('GET', `${BASE}/test-documents`);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.payload.data.items.map(item => [item.id, item.number]), [['d1', 'DGZF-F07-001']]);
  assert.equal((await ask('GET', `${BASE}/test-documents`, { role: 'analyst' })).status, 403);
});
