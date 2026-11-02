import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { agentCallRoutes } from '../../agent-calls.mjs';

const PATH = '/api/analysis/v1/platform/agent-access/calls';
// 和九安 agent-task-service.mjs 的 agentTaskKey 同一个算法（组合根注入九安自己的那个）
const agentTaskKey = ({ tenantId, companyId, task, subject }) => 'agent-task:v1:' + createHash('sha256').update([tenantId, companyId, task, subject.kind, subject.id].join('|')).digest('hex');
const DOCS = [{ id: 'd1', number: 'DGZF-F07-001', companyId: 'co-a', tenantId: 't1', type: 'corporate_payment' },
  { id: 'd2', number: 'DGZF-F07-002', companyId: 'co-b', tenantId: 't1', type: 'corporate_payment' },
  { id: 'd9', number: 'CLBX-F07-005', companyId: 'co-a', tenantId: 't1', type: 'employee_expense' }];
const round = (n, extra) => ({ round: n, task: 'review_advice', trigger: 'upstream', publishId: 'pub_a', startedAt: '2026-10-26T01:00:00.000Z', attempts: 1, ...extra });
const STATES = new Map([
  [agentTaskKey({ tenantId: 't1', companyId: 'co-a', task: 'review_advice', subject: { kind: 'document', id: 'd1' } }), { current: round(2, {
    status: 'completed', startedAt: '2026-10-26T02:00:00.000Z', finishedAt: '2026-10-26T02:01:10.000Z',
    output: { result: 'pass', note: '核对一致', basis: [{ kind: 'rule', ref: 'C05-3.4 费控报销特殊事项', note: '适用审批路径…' }] },
    call: { agentVersion: 'jiuan-audit-ai-kb-2026-10-25.1', repaired: false, contextId: 'jag-1', taskId: 't-1' } }),
  history: [round(1, { status: 'failed', errorCode: 'AGENT_TASK_UNROUTED', finishedAt: '2026-10-26T01:00:00.500Z' })] }],
  [agentTaskKey({ tenantId: 't1', companyId: 'co-b', task: 'review_advice', subject: { kind: 'document', id: 'd2' } }), { current: round(1, { status: 'running', startedAt: '2026-10-26T02:05:00.000Z' }), history: [] }],
]);

async function call(routes, { role = 'admin', path = PATH } = {}) {
  let status = null, payload = null;
  const res = { writeHead(code) { status = code; return this; }, setHeader() {}, end(text) { payload = JSON.parse(text); } };
  const handled = await routes.handle({ req: { method: 'GET' }, path, session: { user: { role } }, res });
  return { handled, status, payload };
}
const TEST_ROW = { at: '2026-10-26T02:03:00.000Z', trigger: 'test', number: 'DGZF-F07-001', status: 'completed', result: 'fail', publishId: 'pub_b' };
const routes = agentCallRoutes({ tenantId: 't1', tasks: ['review_advice'], agentTaskKey, listDocuments: async () => DOCS, readState: async key => STATES.get(key) ?? null,
  extraRows: () => [TEST_ROW] });

test('调用记录：每张单的当前一轮和历史都列出来，新的在前；带单据号、发给哪个发布、结论、用时和 Agent 返回的备注与依据', async () => {
  const { status, payload } = await call(routes);
  assert.equal(status, 200);
  const items = payload.data.items;
  assert.deepEqual(items.map(item => [item.number, item.trigger, item.status]), [['DGZF-F07-002', 'upstream', 'running'], ['DGZF-F07-001', 'test', 'completed'],
    ['DGZF-F07-001', 'upstream', 'completed'], ['DGZF-F07-001', 'upstream', 'failed']], '手动测试的结果也在调用记录里，按时间排');
  const done = items[2];
  assert.equal(done.result, 'pass');
  assert.equal(done.latencyMs, 70_000);
  assert.equal(done.publishId, 'pub_a');
  assert.equal(done.agentVersion, 'jiuan-audit-ai-kb-2026-10-25.1');
  assert.equal(done.note, '核对一致');
  assert.deepEqual(done.basis, [{ kind: 'rule', ref: 'C05-3.4 费控报销特殊事项', page: null, note: '适用审批路径…' }]);
  assert.equal(items[3].errorCode, 'AGENT_TASK_UNROUTED');
  assert.equal(items[0].latencyMs, null);
});

test('调用记录只给管理员；别的路径交还九安', async () => {
  assert.equal((await call(routes, { role: 'analyst' })).status, 403);
  assert.equal((await call(routes, { path: '/api/analysis/v1/platform/agent-access' })).handled, false);
});

test('单据池按页读全（九安每页最多 50 张），读到不满一页为止', async () => {
  const { everyDocument } = await import('../../agent-calls.mjs');
  const pool = Array.from({ length: 120 }, (_, index) => ({ id: `d${index}` }));
  const asked = [];
  const listPage = async ({ limit, offset }) => { asked.push([limit, offset]); if (limit > 50) throw new Error('ANALYSIS_VALIDATION'); return { items: pool.slice(offset, offset + limit) }; };
  assert.equal((await everyDocument(listPage)).length, 120);
  assert.deepEqual(asked, [[50, 0], [50, 50], [50, 100]]);
});
