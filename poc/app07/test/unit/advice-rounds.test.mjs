import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { adviceRoundsRoutes, documentRoundsReader, readAdviceRounds } from '../../advice-rounds.mjs';
import { scopedDocument } from '../../user-scope.mjs';
import { benchScope } from './scope-fixture.mjs';

// 单据抽屉的「历史」页签：一张单的 AI 独立建议各轮（当前一轮 + 九安存的最近几轮历史），新的在前。
// 轮次照九安 agent-task-service.mjs 存的样子造：history 按先后追加（旧的在前），current 是最新的一轮。
const PATH = '/api/analysis/v1/poc/advice-rounds';
const agentTaskKey = ({ tenantId, companyId, task, subject }) => 'agent-task:v1:' + createHash('sha256').update([tenantId, companyId, task, subject.kind, subject.id].join('|')).digest('hex');
const keyOf = (document, task = 'review_advice') => agentTaskKey({ tenantId: 't1', companyId: document.companyId, task, subject: { kind: 'document', id: document.id } });
const SCOPE = ['co-a', 'co-b'];   // 测试台的公司
// 登录的人：九安里能看的汇联易公司（会话里的 companyIds）；外壳按它 ∩ 测试台的公司读单据（Ruling FR1）
const ADMIN = { id: 'poc-reviewer', role: 'admin', companyIds: ['co-a', 'co-z'] };
const NARROW = { id: 'poc-narrow', role: 'analyst', companyIds: ['co-b', 'co-z'] };   // 测试台里只有 co-b
const POLICY = { id: 'poc-policy', role: 'policy_reviewer', companyIds: [] }; // 九安不许规则发布复核人有公司
const DOCS = new Map([
  ['d1', { id: 'd1', companyId: 'co-a', version: 'v2' }],
  ['d2', { id: 'd2', companyId: 'co-a', version: 'v1' }],
  ['d3', { id: 'd3', companyId: 'co-b', version: 'v1' }],
  ['dx', { id: 'dx', companyId: 'co-z', version: 'v1' }], // 不在测试台的公司里：当它不存在
]);
const round = (n, extra = {}) => ({ round: n, task: 'review_advice', contractTask: 'review_advice@1', subjectVersion: 'v1', trigger: 'upstream', requestedBy: 'system:pipeline',
  startedAt: `2026-10-30T0${n}:00:00.000Z`, basis: { assembled: true }, attempts: 1, ...extra });
const done = (n, result, extra = {}) => round(n, { status: 'completed', finishedAt: `2026-10-30T0${n}:01:41.000Z`,
  output: { result, note: '虚构的核对说明', basis: [{ kind: 'rule', ref: 'R-01 虚构规则', note: '虚构依据' }] }, ...extra });

function harness({ states = new Map(), readState } = {}) {
  const reads = [], logs = [];
  const readRounds = documentRoundsReader({ tenantId: 't1', agentTaskKey,
    readState: readState ?? (async key => { reads.push(key); return states.get(key) ?? null; }),
    readDocument: scopedDocument(benchScope(SCOPE), async ({ id, companyIds }) => { const document = DOCS.get(id); return document && companyIds.includes(document.companyId) ? { ...document } : null; }) });
  const routes = adviceRoundsRoutes({ readRounds, log: line => logs.push(line) });
  const ask = async (search = '', { user = ADMIN, method = 'GET', path = PATH } = {}) => {
    let status = null, payload = null;
    const res = { writeHead(code) { status = code; return this; }, setHeader() {}, end(text) { payload = text ? JSON.parse(text) : null; } };
    const url = new URL(`${path}${search}`, 'http://localhost');
    const handled = await routes.handle({ req: { method, headers: {} }, url, path: url.pathname, session: user ? { user } : null, res, body: undefined });
    return { handled, status, payload };
  };
  return { reads, logs, readRounds, routes, ask };
}
const refusedWith = (answer, status, code) => {
  assert.equal(answer.handled, true);
  assert.equal(answer.status, status, JSON.stringify(answer.payload));
  assert.equal(answer.payload.error.code, code);
  assert.match(answer.payload.error.message, /[一-鿿]/u, '错误说明是中文');
};

test('documentRoundsReader：只读这一张单的状态（不扫单据池），整理得和 readAdviceRounds 一样，新的一轮在前；带上单据现在的版本', async () => {
  const d1 = DOCS.get('d1');
  const states = new Map([[keyOf(d1), {
    current: done(3, 'fail', { subjectVersion: 'v2', trigger: 'manual', requestedBy: 'poc-reviewer' }),
    // 九安按先后追加：旧的在前
    history: [round(1, { status: 'failed', errorCode: 'AGENT_TASK_UNROUTED', finishedAt: '2026-10-30T01:00:00.500Z' }), done(2, 'pass')],
  }], [keyOf(d1, 'first_review'), { current: done(9, 'pass'), history: [] }]]);
  const h = harness({ states });
  const answer = await h.readRounds('d1', ADMIN);
  assert.deepEqual(h.reads, [keyOf(d1)], '只读 review_advice 这一个任务、这一张单');
  assert.equal(answer.documentId, 'd1');
  assert.equal(answer.documentVersion, 'v2');
  assert.deepEqual(answer.items.map(item => [item.round, item.status, item.result, item.current]), [[3, 'completed', 'fail', true], [2, 'completed', 'pass', false], [1, 'failed', null, false]]);
  // 每一轮的样子和工作台读的那份（readAdviceRounds）完全一样
  const same = await readAdviceRounds({ tenantId: 't1', agentTaskKey, readState: async key => states.get(key) ?? null, listDocuments: async () => [d1] });
  assert.deepEqual([...answer.items].sort((a, b) => a.round - b.round), [...same].sort((a, b) => a.round - b.round));
  assert.deepEqual(answer.items[0], { documentId: 'd1', companyId: 'co-a', documentVersion: 'v2', round: 3, trigger: 'manual', requestedBy: 'poc-reviewer', status: 'completed',
    result: 'fail', basis: [{ kind: 'rule', ref: 'R-01 虚构规则', page: null, note: '虚构依据' }], errorCode: null,
    startedAt: '2026-10-30T03:00:00.000Z', finishedAt: '2026-10-30T03:01:41.000Z', current: true });
  assert.equal(answer.items[2].errorCode, 'AGENT_TASK_UNROUTED');
});

test('documentRoundsReader：没跑过 AI 建议 → 空列表；单据不在范围里或不存在 → null', async () => {
  const h = harness();
  assert.deepEqual(await h.readRounds('d2', ADMIN), { documentId: 'd2', documentVersion: 'v1', items: [] });
  assert.equal(await h.readRounds('dx', ADMIN), null, '这个人有 co-z，可 co-z 不是测试台的公司');
  assert.equal(await h.readRounds('nope', ADMIN), null);
});

test('GET advice-rounds?documentId=：管理员、分析员、（有公司的话）规则发布复核人都能看，新的在前', async () => {
  const states = new Map([[keyOf(DOCS.get('d2')), { current: round(2, { status: 'running' }), history: [done(1, 'pass')] }]]);
  for (const role of ['admin', 'analyst', 'policy_reviewer']) {
    const h = harness({ states });
    // 规则发布复核人：九安现在不许他有公司（见下一条），这里只证明角色这一关放他过去
    const answer = await h.ask('?documentId=d2', { user: { id: `u-${role}`, role, companyIds: ['co-a'] } });
    assert.equal(answer.handled, true);
    assert.equal(answer.status, 200, JSON.stringify(answer.payload));
    assert.equal(answer.payload.data.documentVersion, 'v1');
    assert.deepEqual(answer.payload.data.items.map(item => [item.round, item.status]), [[2, 'running'], [1, 'completed']]);
  }
});

test('别的角色、没登录 → 403；不在范围里或不存在的单据 → 404，和复核接口一个写法', async () => {
  const h = harness();
  refusedWith(await h.ask('?documentId=d1', { user: { id: 'x', role: 'owner' } }), 403, 'ADVICE_ROUNDS_FORBIDDEN');
  refusedWith(await h.ask('?documentId=d1', { user: null }), 403, 'ADVICE_ROUNDS_FORBIDDEN');
  refusedWith(await h.ask('?documentId=dx'), 404, 'ADVICE_ROUNDS_NOT_FOUND');
  refusedWith(await h.ask('?documentId=nope'), 404, 'ADVICE_ROUNDS_NOT_FOUND');
  assert.deepEqual(h.reads, [], '范围外的单据不去读它的轮次');
});

test('Ruling FR1：按登录的人的公司读——公司不在这个人范围里的单据 404，和不存在一样；规则发布复核人没有公司，一张也看不到', async () => {
  const states = new Map([[keyOf(DOCS.get('d1')), { current: done(1, 'pass'), history: [] }]]);
  const h = harness({ states });
  assert.equal((await h.ask('?documentId=d1')).status, 200, '同一张单，范围里有 co-a 的人看得到');
  refusedWith(await h.ask('?documentId=d1', { user: NARROW }), 404, 'ADVICE_ROUNDS_NOT_FOUND');
  assert.equal((await h.ask('?documentId=d3', { user: NARROW })).status, 200, '他自己公司（co-b）的单照样看得到');
  refusedWith(await h.ask('?documentId=d1', { user: POLICY }), 404, 'ADVICE_ROUNDS_NOT_FOUND');
  refusedWith(await h.ask('?documentId=d3', { user: POLICY }), 404, 'ADVICE_ROUNDS_NOT_FOUND');
  refusedWith(await h.ask('?documentId=d1', { user: { id: 'poc-odd', role: 'analyst' } }), 404, 'ADVICE_ROUNDS_NOT_FOUND');
  assert.deepEqual(h.reads, [keyOf(DOCS.get('d1')), keyOf(DOCS.get('d3'))], '范围外的单据不去读它的轮次');
});

test('参数不对 → 400：缺 documentId、空的、重复的、带别的参数、控制字符、太长', async () => {
  const h = harness();
  for (const search of ['', '?documentId=', '?documentId=d1&documentId=d2', '?documentId=d1&x=1', '?documentId=d%01', `?documentId=${'a'.repeat(192)}`, '?documentId=%20d1']) {
    refusedWith(await h.ask(search), 400, 'ADVICE_ROUNDS_INVALID');
  }
});

test('只接 GET 这一个路径；别的方法、别的路径交给后面的路由', async () => {
  const h = harness();
  assert.equal((await h.ask('?documentId=d1', { method: 'POST' })).handled, false);
  assert.equal((await h.ask('?documentId=d1', { path: `${PATH}/x` })).handled, false);
  assert.equal((await h.ask('', { path: '/api/analysis/v1/poc/reviews' })).handled, false);
});

test('读状态出错 → 503，日志只记错误码，不记消息', async () => {
  const h = harness({ readState: async () => { throw Object.assign(new Error('库里有 秘密 文字'), { code: 'ER_CON_COUNT_ERROR' }); } });
  refusedWith(await h.ask('?documentId=d1'), 503, 'ADVICE_ROUNDS_UNAVAILABLE');
  assert.deepEqual(h.logs, ['POC_ADVICE_ROUNDS_FAILED ER_CON_COUNT_ERROR']);
});
