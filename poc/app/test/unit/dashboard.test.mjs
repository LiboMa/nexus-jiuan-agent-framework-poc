import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { basisGroup, createDashboard, dashboardRoutes, refreshOnRounds, windowOf } from '../../dashboard.mjs';
import { createKbStewardRoutes } from '../../kb-steward-routes.mjs';
import { benchScope } from './scope-fixture.mjs';

// 工作台统计：轮次照九安 agent-task-service.mjs 存的样子造（假的状态表），复核、「我的规则」是假的；知识库用真的 kb-steward-routes（上传历史写在临时目录），
// 它的 client 是假的：describe / request 一被调到就失败（不为看板调 Agent）。时钟是假的：现在 = 2026-10-30 12:00（上海）。
const PATH = '/api/analysis/v1/poc/dashboard';
const NOW = Date.parse('2026-10-30T04:00:00.000Z');
// 登录的人（会话里的 companyIds）；工作台只数这个人范围里（∩ 测试台的公司 co-a、co-b）的单据（Ruling FR1）
const BENCH = ['co-a', 'co-b'];
const ADMIN = { id: 'poc-reviewer', role: 'admin', companyIds: ['co-a', 'co-b'] };
const ANALYST = { id: 'poc-checker', role: 'analyst', companyIds: ['co-a', 'co-b'] };
const POLICY = { id: 'poc-policy', role: 'policy_reviewer', companyIds: [] };   // 九安不许规则发布复核人有公司
const ACCOUNTS = [{ id: 'poc-reviewer', name: '审核员（虚构）', role: 'admin' }, { id: 'poc-checker', name: '复核人（虚构）', role: 'analyst' },
  { id: 'poc-policy', name: '规则复核（虚构）', role: 'policy_reviewer' }];
const agentTaskKey = ({ tenantId, companyId, task, subject }) => 'agent-task:v1:' + createHash('sha256').update([tenantId, companyId, task, subject.kind, subject.id].join('|')).digest('hex');
const keyOf = (document, task = 'review_advice') => agentTaskKey({ tenantId: 't1', companyId: document.companyId, task, subject: { kind: 'document', id: document.id } });
const doc = (id, version = 'v1', companyId = 'co-a') => ({ id, companyId, version, type: 'corporate_payment' });
/** 一轮：startedAt / finishedAt 是 UTC；done 是完成了的一轮（Agent 的结论和依据在 output 里）。 */
const round = (n, extra = {}) => ({ round: n, task: 'review_advice', subjectVersion: 'v1', trigger: 'upstream', requestedBy: 'system:pipeline', basis: { assembled: true }, ...extra });
const done = (n, result, startedAt, finishedAt, basis = [], extra = {}) => round(n, { status: 'completed', startedAt, finishedAt, output: { result, note: '虚构', basis }, ...extra });
const rule = ref => ({ kind: 'rule', ref, note: '适用审批路径：虚构；最终审批人：虚构' });
const LONG = `虚构规则：未写编号的一条很长的规则${'很长'.repeat(40)}`;

/**
 * 各单据的轮次（时间是 UTC，括号里是上海日期）：
 *   d1 当前 r2 fail（10-30 00:00:30，用时 30 s）；历史 r1 pass（10-29 23:59:59.999，59.999 s）
 *   d2 当前 r1 pass（10-30 11:00，10 s）
 *   d3 当前 r3 running（10-30 11:30 开始）；历史 r2 fail（10-20，120 s）、r1 failed
 *   d4 当前 r1 fail（09-30 23:59，60 s）——本月之前，但还没复核：待复核
 *   d5 当前 r1 pass（10-01 00:00，60 s）
 *   d6 没跑过
 *   d7 单据已是 v2，当前 r1 pass 审的是 v1（10-30 09:00，60 s）——不能复核
 *   d8 当前 r2 fail（10-25 08:00，60 s）；历史 r1 pass（10-24 07:00，60 s）——复核的是 r1：outdated
 *   d9 当前 r1 pass（10-30 10:00，60 s），没复核：待复核
 */
function roundsOf() {
  return {
    d1: { current: done(2, 'fail', '2026-10-29T16:00:00.000Z', '2026-10-29T16:00:30.000Z', [rule('C05-2.3 费控报销 · 九安 · 2 万以下'), rule('C05-3.4 费控报销特殊事项'),
      rule('自定义：九安房租补充要求.md'), { kind: 'field', ref: '收款方' }, { kind: 'evidence', ref: 'file-001', page: 2 }, rule('C05-2.3 同一轮又引一次'),
      { kind: null, ref: '没有 kind' }, { kind: 'field', ref: '   ' }]),
    history: [done(1, 'pass', '2026-10-29T15:59:00.000Z', '2026-10-29T15:59:59.999Z')] },
    d2: { current: done(1, 'pass', '2026-10-30T02:59:50.000Z', '2026-10-30T03:00:00.000Z', [rule('C05-2.3 费控报销'), rule('C05-5.2 虚构事项'), { kind: 'field', ref: '发票' }]) },
    d3: { current: round(3, { status: 'running', startedAt: '2026-10-30T03:30:00.000Z' }), history: [
      done(2, 'fail', '2026-10-20T01:58:00.000Z', '2026-10-20T02:00:00.000Z', [rule('C05-2.3 费控报销'), rule('  自定义： 九安房租补充要求.md  '), { kind: 'field', ref: ' 收款方 ' }, rule(LONG)]),
      round(1, { status: 'failed', errorCode: 'AGENT_TASK_UNROUTED', startedAt: '2026-10-19T00:00:00.000Z', finishedAt: '2026-10-19T00:00:01.000Z' })] },
    d4: { current: done(1, 'fail', '2026-09-30T15:58:00.000Z', '2026-09-30T15:59:00.000Z', [rule('C09-1.1 本月之前')]) },
    d5: { current: done(1, 'pass', '2026-09-30T15:59:00.000Z', '2026-09-30T16:00:00.000Z', [rule('C05-9.9 本月第一天')]) },
    d7: { current: done(1, 'pass', '2026-10-30T00:59:00.000Z', '2026-10-30T01:00:00.000Z', [rule('C01-1.1 立项')]) },
    d8: { current: done(2, 'fail', '2026-10-24T23:59:00.000Z', '2026-10-25T00:00:00.000Z', [rule('C07-7.11 虚构事项'), { kind: 'field', ref: '金额' },
      { kind: 'evidence', ref: 'file-001', page: 1 }, rule('G-02 适用范围'), rule('C05-NOTE 付款审批形式')]),
    history: [done(1, 'pass', '2026-10-23T22:59:00.000Z', '2026-10-23T23:00:00.000Z', [rule('C05-5.2')])] },
    d9: { current: done(1, 'pass', '2026-10-30T01:59:00.000Z', '2026-10-30T02:00:00.000Z', [rule('C05-5.2 虚构事项'), rule('C05-5.2')]) },
  };
}
let reviewId = 0;
const review = (documentId, adviceRound, decision, actor, createdAt) => ({ id: ++reviewId, documentId, documentVersion: 'v1', adviceRound, aiResult: 'pass', decision,
  finalResult: 'pass', reason: decision === 'override' ? 'other' : null, note: null, actor, createdAt });
/** 复核（上海日期）：d1 r2 被复核两次（10-30，最后是改判）；d2 r1 同一人两次（最后是采纳）；d5 r1 是不在设置里的人（10-01）；d8 r1 改判（10-24）；d1 r1 采纳（10-29 23:59:59.999）。 */
const reviewsOf = () => [
  review('d5', 1, 'adopt', 'poc-gone', '2026-10-01T02:00:00.000Z'),
  review('d8', 1, 'override', 'poc-reviewer', '2026-10-24T00:00:00.000Z'),
  review('d1', 1, 'adopt', 'poc-reviewer', '2026-10-29T15:59:59.999Z'),
  review('d2', 1, 'override', 'poc-checker', '2026-10-30T03:05:00.000Z'),
  review('d2', 1, 'adopt', 'poc-checker', '2026-10-30T03:06:00.000Z'),
  review('d1', 2, 'adopt', 'poc-checker', '2026-10-30T03:10:00.000Z'),
  review('d1', 2, 'override', 'poc-reviewer', '2026-10-30T03:20:00.000Z'),
];
const HISTORY = { nextId: 8, items: [
  { id: 1, sourceId: 'sample-matrix', status: 'ingested', rulesTotal: 18, finishedAt: '2026-10-20T01:00:00.000Z' },
  { id: 2, sourceId: 'sample-matrix', status: 'ingested', rulesTotal: 20, finishedAt: '2026-10-21T01:00:00.000Z' },
  { id: 3, sourceId: 'fin-rules', status: 'skipped', rulesTotal: 7, finishedAt: '2026-10-22T01:00:00.000Z' },
  { id: 4, sourceId: 'old-policy', status: 'ingested', rulesTotal: 5, finishedAt: '2026-10-23T01:00:00.000Z', removedAt: '2026-10-24T00:00:00.000Z' },
  { id: 5, sourceId: 'broken', status: 'ingested', rulesTotal: 3, finishedAt: '2026-10-19T01:00:00.000Z' },
  { id: 6, sourceId: 'broken', status: 'failed', rulesTotal: null, finishedAt: '2026-10-25T01:00:00.000Z' },
  { id: 7, sourceId: 'sample-matrix', status: 'ingesting', rulesTotal: null, finishedAt: null },
] };
const RULES = { 'poc-reviewer': { files: 2, usedChars: 1200 }, 'poc-checker': { files: 1, usedChars: 300 } };
const LONG_TITLE = `九安房租补充要求${'很长的标题'.repeat(15)}`;
const cap = text => [...text].slice(0, 60).join('');

/** companies：单据 → 公司（不写就是 co-a）。 */
async function harness({ documents = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9'], rounds = roundsOf(), reviews = reviewsOf(), history = HISTORY,
  configured = true, ready = true, rules = RULES, accounts = ACCOUNTS, companies = {} } = {}) {
  const docs = documents.map(id => doc(id, id === 'd7' ? 'v2' : 'v1', companies[id]));
  const states = new Map(Object.entries(rounds).filter(([id]) => documents.includes(id)).map(([id, state]) => [keyOf(doc(id, 'v1', companies[id])), { revision: 1, version: 1, history: [], ...state }]));
  const dir = await mkdtemp(path.join(tmpdir(), 'dashboard-'));
  if (history) { await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, 'history.json'), JSON.stringify(history)); }
  const agentCalls = [], readyCalls = [], listCalls = [], ruleCalls = [], logs = [];
  const client = { configured, async ready() { readyCalls.push(1); return configured && ready; },
    describe() { agentCalls.push('describe'); throw new Error('工作台不该调 describe'); },
    request(op) { agentCalls.push(op); throw new Error(`工作台不该调 ${op}`); } };
  const kb = createKbStewardRoutes({ mode: 's3vectors', client, uploadsDir: dir, log: line => logs.push(line) });
  const state = { clock: NOW, reviews, broken: null, brokenRounds: null };
  const customRules = {
    async list(accountId) {
      ruleCalls.push(accountId);
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(accountId)) throw Object.assign(new Error('账号编号不合格'), { code: 'CUSTOM_RULES_ACCOUNT_INVALID' });
      const mine = rules[accountId] ?? { files: 0, usedChars: 0 };
      return { items: Array.from({ length: mine.files }, (_, index) => ({ id: `r${index}`, title: `规则${index}.md`, format: 'md', chars: 1, uploadedAt: '' })),
        usedChars: mine.usedChars, limitChars: null, limitFiles: 10 };
    },
  };
  const fakeReviews = { async all(options = {}) { if (state.broken) throw state.broken; assert.deepEqual(options, {}, '待复核要全部复核：不带 since'); return [...state.reviews]; } };
  const dashboard = createDashboard({ tenantId: 't1', agentTaskKey, reviews: fakeReviews, customRules, kb, accounts: () => accounts, now: () => state.clock,
    readState: async key => { if (state.brokenRounds) throw state.brokenRounds; return states.get(key) ?? null; },
    scopeOf: benchScope(BENCH),
    listDocuments: async companyIds => { listCalls.push(companyIds); return docs.filter(item => companyIds.includes(item.companyId)).map(item => ({ ...item })); } });
  const routes = dashboardRoutes({ dashboard, log: line => logs.push(line) });
  const ask = async (query, user = ADMIN, method = 'GET') => {
    let status = null, payload = null;
    const res = { writeHead(code) { status = code; return this; }, setHeader() {}, end(text) { payload = text ? JSON.parse(text) : null; } };
    const url = new URL(`${PATH}${query}`, 'http://localhost');
    const handled = await routes.handle({ req: { method, headers: {} }, url, path: url.pathname, session: user ? { user } : null, res, body: undefined });
    return { handled, status, payload };
  };
  const read = async (window, user = ADMIN) => {
    const answer = await ask(`?window=${window}`, user);
    assert.equal(answer.status, 200, JSON.stringify(answer.payload));
    return answer.payload.data;
  };
  return { dir, states, state, logs, agentCalls, readyCalls, listCalls, ruleCalls, kb, dashboard, routes, ask, read, done: () => rm(dir, { recursive: true, force: true }) };
}
const zeros = dates => dates.map(date => ({ date, pass: 0, fail: 0, running: 0 }));
const days = (first, count) => Array.from({ length: count }, (_, index) => new Date(Date.parse(`${first}T00:00:00Z`) + index * 86_400_000).toISOString().slice(0, 10));
const refusedWith = (answer, status, code) => {
  assert.equal(answer.status, status, JSON.stringify(answer.payload));
  assert.equal(answer.payload.error.code, code);
  assert.match(answer.payload.error.message, /[一-鿿]/u, '错误说明是中文');
};

test('窗口按上海时间：today 是今天 0 点到现在，14d 是今天和前 13 天，month 是本月 1 日起；每个上海日期一项，从早到晚', () => {
  assert.deepEqual(windowOf('today', NOW), { from: Date.parse('2026-10-29T16:00:00.000Z'), to: NOW, days: ['2026-10-30'] });
  const fortnight = windowOf('14d', NOW);
  assert.equal(fortnight.from, Date.parse('2026-10-16T16:00:00.000Z'));
  assert.deepEqual(fortnight.days, days('2026-10-17', 14));
  const month = windowOf('month', NOW);
  assert.equal(month.from, Date.parse('2026-09-30T16:00:00.000Z'));
  assert.deepEqual(month.days, days('2026-10-01', 30));
  // UTC 10-31 16:00 是上海 11-01 0 点：新的一天、新的一个月……
  const midnight = Date.parse('2026-10-31T16:00:00.000Z');
  assert.deepEqual(windowOf('today', midnight), { from: midnight, to: midnight, days: ['2026-11-01'] });
  assert.deepEqual(windowOf('month', midnight).days, ['2026-11-01']);
  // ……前一毫秒还是旧的一天
  assert.deepEqual(windowOf('today', midnight - 1).days, ['2026-10-31']);
  assert.equal(windowOf('month', midnight - 1).days.length, 31);
  assert.deepEqual(windowOf('14d', Date.parse('2026-03-05T00:00:00.000Z')).days.slice(0, 3), ['2026-02-20', '2026-02-21', '2026-02-22'], '跨月');
});

test('Review Focus 4：没有任何数据时全为 0 / null，结构完整；每天一项照样给', async t => {
  const h = await harness({ documents: [], reviews: [], history: null, configured: false, rules: {} });
  t.after(h.done);
  for (const [window, dates] of [['today', ['2026-10-30']], ['14d', days('2026-10-17', 14)], ['month', days('2026-10-01', 30)]]) {
    const data = await h.read(window);
    assert.deepEqual(data, {
      window, from: new Date(windowOf(window, NOW).from).toISOString(), to: '2026-10-30T04:00:00.000Z',
      pendingReview: { count: 0, failCount: 0 },
      advice: { completed: 0, pass: 0, fail: 0, overrides: 0, passRate: null, avgDurationMs: null, maxDurationMs: null },
      daily: zeros(dates), topBasis: [], overrideRate: dates.map(date => ({ date, reviews: 0, overrides: 0 })),
      reviewers: [{ account: 'poc-checker', name: '复核人（虚构）', reviews: 0, overrides: 0, customRules: 0 },
        { account: 'poc-reviewer', name: '审核员（虚构）', reviews: 0, overrides: 0, customRules: 0 }],
      knowledge: { mode: 's3vectors', configured: false, ready: false, sources: 0, rules: 0, lastIngestAt: null },
      topRules: [], myRules: { files: 0, usedChars: 0, limitChars: null },
    }, window);
  }
  assert.deepEqual(h.agentCalls, [], '不调 Agent');
});

test('advice 和 daily：完成的轮次按 finishedAt 落在窗口里（上海跨天的边界），running 按 startedAt；passRate 是 0–1 的小数，用时取 finishedAt − startedAt', async t => {
  const h = await harness();
  t.after(h.done);
  const today = await h.read('today');
  assert.equal(today.from, '2026-10-29T16:00:00.000Z');
  assert.equal(today.to, '2026-10-30T04:00:00.000Z');
  // d1 r2（00:00:30）、d2、d7、d9；d1 r1 是 10-29 23:59:59.999，不算今天
  assert.deepEqual(today.advice, { completed: 4, pass: 3, fail: 1, overrides: 1, passRate: 0.75, avgDurationMs: 40_000, maxDurationMs: 60_000 });
  assert.deepEqual(today.daily, [{ date: '2026-10-30', pass: 3, fail: 1, running: 1 }]);

  const fortnight = await h.read('14d');
  assert.equal(fortnight.from, '2026-10-16T16:00:00.000Z');
  assert.deepEqual(fortnight.advice, { completed: 8, pass: 5, fail: 3, overrides: 2, passRate: 0.625, avgDurationMs: 57_500, maxDurationMs: 120_000 });
  const expected = Object.fromEntries(days('2026-10-17', 14).map(date => [date, { date, pass: 0, fail: 0, running: 0 }]));
  Object.assign(expected['2026-10-20'], { fail: 1 });
  Object.assign(expected['2026-10-24'], { pass: 1 });
  Object.assign(expected['2026-10-25'], { fail: 1 });
  Object.assign(expected['2026-10-29'], { pass: 1 });
  Object.assign(expected['2026-10-30'], { pass: 3, fail: 1, running: 1 });
  assert.deepEqual(fortnight.daily, Object.values(expected));

  // 本月：多了 d5（10-01 00:00）；d4 是 09-30 23:59，不算
  const month = await h.read('month');
  assert.equal(month.from, '2026-09-30T16:00:00.000Z');
  assert.deepEqual(month.advice, { completed: 9, pass: 6, fail: 3, overrides: 2, passRate: 6 / 9, avgDurationMs: 57_778, maxDurationMs: 120_000 });
  assert.equal(month.daily.length, 30);
  assert.deepEqual(month.daily[0], { date: '2026-10-01', pass: 1, fail: 0, running: 0 });
  assert.ok(month.advice.passRate > 0 && month.advice.passRate < 1, 'passRate 是 0–1 的小数，不是百分数');
  assert.deepEqual(h.agentCalls, []);
});

test('时间缺了或读不出的轮次：没有 startedAt 的照样算完成、不算用时；finishedAt 读不出的不算完成；finishedAt 早于 startedAt 的不算用时；不出 NaN、不抛错', async t => {
  const rounds = {
    e1: { current: done(1, 'pass', undefined, '2026-10-30T01:00:00.000Z', [rule('C05-2.3')]) },
    e2: { current: done(1, 'fail', '2026-10-30T01:00:00.000Z', 'not-a-time', [rule('C07-7.1')]) },
    e3: { current: round(1, { status: 'running', startedAt: 'garbage' }) },
    e4: { current: done(1, 'pass', '2026-10-30T00:59:30.000Z', '2026-10-30T01:00:00.000Z') },
    e5: { current: done(1, 'fail', '2026-10-30T02:00:00.000Z', '2026-10-30T01:59:00.000Z') },
  };
  const h = await harness({ documents: ['e1', 'e2', 'e3', 'e4', 'e5'], rounds, reviews: [] });
  t.after(h.done);
  const data = await h.dashboard.read({ window: 'today', user: ADMIN });
  const numbers = [];
  (function walk(value) { if (typeof value === 'number') numbers.push(value); else if (value && typeof value === 'object') Object.values(value).forEach(walk); })(data);
  assert.ok(numbers.every(Number.isFinite), '没有 NaN、Infinity');
  assert.deepEqual(data.advice, { completed: 3, pass: 2, fail: 1, overrides: 0, passRate: 2 / 3, avgDurationMs: 30_000, maxDurationMs: 30_000 });
  assert.deepEqual(data.daily, [{ date: '2026-10-30', pass: 2, fail: 1, running: 0 }]);
  assert.deepEqual(data.topRules, [{ ruleId: 'C05-2.3', count: 1 }], 'finishedAt 读不出的那轮不进来');
  assert.deepEqual(data.pendingReview, { count: 4, failCount: 2 }, '待复核看状态，不看时间');
  const only = await harness({ documents: ['e1'], rounds, reviews: [] });
  t.after(only.done);
  assert.deepEqual((await only.read('today')).advice, { completed: 1, pass: 1, fail: 0, overrides: 0, passRate: 1, avgDurationMs: null, maxDurationMs: null });
});

test('pendingReview：不按窗口，按单据现在的状态（reviews.mjs 的 stateOf）——pending 和 outdated 的单数，failCount 是其中当前一轮 fail 的', async t => {
  const h = await harness();
  t.after(h.done);
  // d4（pending fail，本月之前完成的也算）、d8（outdated fail）、d9（pending pass）；d1、d2、d5 已复核当前一轮，d3 在跑，d6 没跑过，d7 审的是旧版本
  for (const window of ['today', '14d', 'month']) assert.deepEqual((await h.read(window)).pendingReview, { count: 3, failCount: 2 }, window);
  // 复核了 d9 的当前一轮：离开待复核；d8 复核了当前的 r2：也离开
  const more = await harness({ reviews: [...reviewsOf(), review('d9', 1, 'adopt', 'poc-checker', '2026-10-30T03:30:00.000Z'), review('d8', 2, 'override', 'poc-reviewer', '2026-10-30T03:31:00.000Z')] });
  t.after(more.done);
  assert.deepEqual((await more.read('today')).pendingReview, { count: 1, failCount: 1 });
});

test('复核：每张单每一轮只算最后一次（不管是谁），按那次复核的上海日期；改判率每天 {reviews, overrides}，没有复核的日子是 0', async t => {
  const h = await harness();
  t.after(h.done);
  const today = await h.read('today');
  // d1 r2 两次（最后是 poc-reviewer 改判）、d2 r1 两次（最后是采纳）
  assert.equal(today.advice.overrides, 1);
  assert.deepEqual(today.overrideRate, [{ date: '2026-10-30', reviews: 2, overrides: 1 }]);
  const fortnight = await h.read('14d');
  assert.equal(fortnight.advice.overrides, 2);
  const rate = Object.fromEntries(fortnight.overrideRate.map(item => [item.date, item]));
  assert.equal(fortnight.overrideRate.length, 14);
  assert.deepEqual(fortnight.overrideRate.map(item => item.date), days('2026-10-17', 14));
  assert.deepEqual([rate['2026-10-24'], rate['2026-10-29'], rate['2026-10-30'], rate['2026-10-23']],
    [{ date: '2026-10-24', reviews: 1, overrides: 1 }, { date: '2026-10-29', reviews: 1, overrides: 0 }, { date: '2026-10-30', reviews: 2, overrides: 1 }, { date: '2026-10-23', reviews: 0, overrides: 0 }]);
  const month = await h.read('month');
  assert.deepEqual(month.overrideRate[0], { date: '2026-10-01', reviews: 1, overrides: 0 });
  assert.equal(month.advice.overrides, 2);
});

test('reviewers：每个人每张单每一轮只算自己的最后一次；行 = 设置里的管理员、分析员 + 复核里出现的人；分析员只有自己一行，规则发布复核人没有行', async t => {
  const h = await harness();
  t.after(h.done);
  assert.deepEqual((await h.read('today')).reviewers, [
    { account: 'poc-checker', name: '复核人（虚构）', reviews: 2, overrides: 0, customRules: 1 },
    { account: 'poc-reviewer', name: '审核员（虚构）', reviews: 1, overrides: 1, customRules: 2 },
  ]);
  assert.deepEqual((await h.read('14d')).reviewers, [
    { account: 'poc-reviewer', name: '审核员（虚构）', reviews: 3, overrides: 2, customRules: 2 },
    { account: 'poc-checker', name: '复核人（虚构）', reviews: 2, overrides: 0, customRules: 1 },
  ]);
  // 不在设置里的人：名字用账号
  assert.deepEqual((await h.read('month')).reviewers, [
    { account: 'poc-reviewer', name: '审核员（虚构）', reviews: 3, overrides: 2, customRules: 2 },
    { account: 'poc-checker', name: '复核人（虚构）', reviews: 2, overrides: 0, customRules: 1 },
    { account: 'poc-gone', name: 'poc-gone', reviews: 1, overrides: 0, customRules: 0 },
  ]);
  const analyst = await h.read('month', ANALYST);
  assert.deepEqual(analyst.reviewers, [{ account: 'poc-checker', name: '复核人（虚构）', reviews: 2, overrides: 0, customRules: 1 }]);
  assert.deepEqual(analyst.myRules, { files: 1, usedChars: 300, limitChars: null });
  assert.equal(analyst.advice.overrides, 2, '全局的数分析员也看得到');
  const policy = await h.read('month', POLICY);
  assert.deepEqual(policy.reviewers, []);
  assert.deepEqual(policy.myRules, { files: 0, usedChars: 0, limitChars: null }, '规则发布复核人没有「我的规则」');
  assert.deepEqual(policy.pendingReview, { count: 0, failCount: 0 }, '规则发布复核人没有公司（Ruling FR1）：一张单也数不到');
  // 设置里停用的账号（enabled: false）：窗口里没有复核就不给行；有复核的照样给，名字取设置里的
  const disabled = await harness({ accounts: [...ACCOUNTS, { id: 'poc-old', name: '停用的人（虚构）', role: 'analyst', enabled: false },
    { id: 'poc-gone', name: '已离开的人（虚构）', role: 'admin', enabled: false }] });
  t.after(disabled.done);
  assert.deepEqual((await disabled.read('today')).reviewers.map(row => row.account), ['poc-checker', 'poc-reviewer']);
  assert.deepEqual((await disabled.read('month')).reviewers.map(row => [row.account, row.name, row.reviews]),
    [['poc-reviewer', '审核员（虚构）', 3], ['poc-checker', '复核人（虚构）', 2], ['poc-gone', '已离开的人（虚构）', 1]]);
  // 复核人的编号存不了「我的规则」（不合格的账号）：份数记 0，不报错
  const odd = await harness({ reviews: [review('d9', 1, 'adopt', 'Odd Actor', '2026-10-30T03:30:00.000Z')] });
  t.after(odd.done);
  assert.deepEqual((await odd.read('today')).reviewers.find(row => row.account === 'Odd Actor'), { account: 'Odd Actor', name: 'Odd Actor', reviews: 1, overrides: 0, customRules: 0 });
});

test('topBasis：不通过的那几轮的依据，按规则编号 / 我的规则标题 / 字段 / 原件归并，一轮里同一项只算一次，前 6；同数按标签', async t => {
  const h = await harness();
  t.after(h.done);
  assert.deepEqual((await h.read('today')).topBasis, [
    { kind: 'rule', label: 'C05-2.3', count: 1 }, { kind: 'rule', label: 'C05-3.4', count: 1 }, { kind: 'evidence', label: 'file-001', count: 1 },
    { kind: 'custom', label: '九安房租补充要求.md', count: 1 }, { kind: 'field', label: '收款方', count: 1 },
  ]);
  // 14 天：d1 r2、d3 r2、d8 r2 三轮不通过；pass 的轮次（d2 的「发票」、C05-5.2）不进来
  assert.deepEqual((await h.read('14d')).topBasis, [
    { kind: 'rule', label: 'C05-2.3', count: 2 }, { kind: 'evidence', label: 'file-001', count: 2 }, { kind: 'custom', label: '九安房租补充要求.md', count: 2 },
    { kind: 'field', label: '收款方', count: 2 }, { kind: 'rule', label: 'C05-3.4', count: 1 }, { kind: 'rule', label: 'C05-NOTE', count: 1 },
  ]);
});

test('长的依据：按完整的 ref / 标题归并，只截显示的标签（60 字）；截完一样的两组各算各的，顺序固定', async t => {
  const rounds = {
    f1: { current: done(1, 'fail', '2026-10-30T01:00:00.000Z', '2026-10-30T01:00:10.000Z', [rule(`${LONG}甲`), rule(`${LONG}乙`), rule(`自定义：${LONG_TITLE}一`)]) },
    f2: { current: done(1, 'fail', '2026-10-30T02:00:00.000Z', '2026-10-30T02:00:10.000Z', [rule(`${LONG}乙`), rule(`自定义：${LONG_TITLE}二`)]) },
  };
  const h = await harness({ documents: ['f1', 'f2'], rounds, reviews: [] });
  t.after(h.done);
  assert.deepEqual((await h.read('today')).topBasis, [
    { kind: 'rule', label: cap(LONG), count: 2 },
    { kind: 'custom', label: cap(LONG_TITLE), count: 1 }, { kind: 'custom', label: cap(LONG_TITLE), count: 1 },
    { kind: 'rule', label: cap(LONG), count: 1 },
  ]);
  assert.equal([...cap(LONG_TITLE)].length, 60);
});

test('basisGroup：按条入库的编号（风险判断卡 risk-cards-T1.266、条款 travel-policy-A12 等）也是规则编号，后面的文字进 detail', () => {
  const ruleOf = ref => basisGroup({ kind: 'rule', ref });
  assert.deepEqual(ruleOf('risk-cards-T1.266 EXP783199-财务 增值税 · 财务线'),
    { kind: 'rule', key: 'risk-cards-T1.266', label: 'risk-cards-T1.266 EXP783199-财务 增值税 · 财务线', ruleId: 'risk-cards-T1.266', detail: 'EXP783199-财务 增值税 · 财务线' });
  assert.deepEqual(ruleOf('risk-cards-T1.73'), { kind: 'rule', key: 'risk-cards-T1.73', label: 'risk-cards-T1.73', ruleId: 'risk-cards-T1.73' }, '只有编号');
  for (const id of ['travel-policy-A12', 'fin-approval-S3.2', 'x9-N1.2.3', 'abc-CH3', 'abc-H2.3', 'abc-P001', 'abc-A12-b', 'abc-A12~2', 'risk-cards-H1']) {
    assert.equal(ruleOf(`${id} 虚构`).ruleId, id, id);
  }
  for (const ref of ['risk-cards-T1 少了行号', 'Risk-cards-T1.4 大写', 'risk-cards-T1.4x 粘着字母', 'risk-cards-X1.4 不认识的条号']) {
    assert.equal(ruleOf(ref).ruleId, undefined, ref);
  }
});

test('topRules：引用风险判断卡的轮次按卡的编号计数，带 detail（卡片编号、费用类型、审核线）；公司制度的矩阵编号不带 detail', async t => {
  const card = 'risk-cards-T1.266 EXP783199-财务 增值税 · 财务线';
  const h = await harness({ documents: ['d1', 'd2', 'd3'], reviews: [], rounds: {
    d1: { current: done(1, 'pass', '2026-10-30T01:00:00.000Z', '2026-10-30T01:00:20.000Z', [rule(card), rule('risk-cards-T1.73 EXP783174-业务 房租 · 业务线')]) },
    d2: { current: done(1, 'fail', '2026-10-30T02:00:00.000Z', '2026-10-30T02:00:20.000Z', [rule(card), rule('C05-2.3 费控报销')]) },
    d3: { current: done(1, 'pass', '2026-10-30T03:00:00.000Z', '2026-10-30T03:00:20.000Z', [rule(card)]) },
  } });
  t.after(h.done);
  assert.deepEqual((await h.read('today')).topRules, [
    { ruleId: 'risk-cards-T1.266', detail: 'EXP783199-财务 增值税 · 财务线', count: 3 },
    { ruleId: 'C05-2.3', count: 1 },
    { ruleId: 'risk-cards-T1.73', detail: 'EXP783174-业务 房租 · 业务线', count: 1 },
  ]);
});

test('topRules：窗口里完成的全部轮次引用的规则编号（不含我的规则、认不出编号的），一轮里同一编号只算一次，前 5；同数按编号', async t => {
  const h = await harness();
  t.after(h.done);
  assert.deepEqual((await h.read('today')).topRules, [
    { ruleId: 'C05-2.3', count: 2 }, { ruleId: 'C05-5.2', count: 2 }, { ruleId: 'C01-1.1', count: 1 }, { ruleId: 'C05-3.4', count: 1 },
  ]);
  assert.deepEqual((await h.read('14d')).topRules, [
    { ruleId: 'C05-2.3', count: 3 }, { ruleId: 'C05-5.2', count: 3 }, { ruleId: 'C01-1.1', count: 1 }, { ruleId: 'C05-3.4', count: 1 }, { ruleId: 'C05-NOTE', count: 1 },
  ]);
});

test('basisGroup：规则编号是 ref 开头的知识库编号（C<章号>-<序号>、C<章号>-NOTE、G-<序号>）；认不出就用整个 ref（去空白、最多 60 字）；「自定义：」后的标题', () => {
  const ruleOf = ref => basisGroup({ kind: 'rule', ref });
  for (const [ref, id] of [['C05-2.3 费控报销 · 九安 · 2 万以下', 'C05-2.3'], ['C05-2.3', 'C05-2.3'], ['  C05-2.3  ', 'C05-2.3'], ['C07-7.11 虚构', 'C07-7.11'],
    ['C05-2.3：费控报销', 'C05-2.3'], ['C05-2.3（升级）', 'C05-2.3'], ['C05-2.3. 句末有点', 'C05-2.3'], ['C05-NOTE 付款审批形式', 'C05-NOTE'], ['G-02 适用范围', 'G-02'],
    ['C01-1', 'C01-1'], ['C12-10.2.1 三级序号', 'C12-10.2.1']]) {
    assert.deepEqual(ruleOf(ref), { kind: 'rule', key: id, label: id, ruleId: id }, ref);
  }
  for (const ref of ['C05-2.3a 粘着字母', 'C5-2.3 章号一位', 'c05-2.3 小写', 'R-01 虚构规则', 'C05-2.3-1', 'KA-C01', '费控报销 C05-2.3', 'C05-', 'G-2']) {
    assert.deepEqual(ruleOf(ref), { kind: 'rule', key: ref.trim(), label: ref.trim() }, ref);
  }
  assert.deepEqual(ruleOf(`  ${LONG}  `), { kind: 'rule', key: LONG, label: cap(LONG) }, '按完整的 ref 归并，只截显示的标签');
  assert.equal([...ruleOf(LONG).label].length, 60);
  assert.deepEqual(ruleOf('自定义：九安房租补充要求.md'), { kind: 'custom', key: '九安房租补充要求.md', label: '九安房租补充要求.md' });
  assert.deepEqual(ruleOf(' 自定义：  标题 '), { kind: 'custom', key: '标题', label: '标题' });
  assert.deepEqual(ruleOf(`自定义：${LONG_TITLE}`), { kind: 'custom', key: LONG_TITLE, label: cap(LONG_TITLE) }, '我的规则的标题也最多 60 字');
  assert.equal(ruleOf('自定义：  '), null, '没有标题');
  assert.equal(ruleOf(''), null);
  assert.deepEqual(basisGroup({ kind: 'field', ref: ' 收款方 ' }), { kind: 'field', key: '收款方', label: '收款方' });
  assert.deepEqual(basisGroup({ kind: 'evidence', ref: 'file-001', page: 2 }), { kind: 'evidence', key: 'file-001', label: 'file-001' });
  assert.deepEqual(basisGroup({ kind: 'field', ref: '自定义：不是规则' }), { kind: 'field', key: '自定义：不是规则', label: '自定义：不是规则' }, '只有 rule 才看「自定义：」');
  for (const item of [{ kind: 'field', ref: '' }, { kind: null, ref: 'x' }, { kind: 'other', ref: 'x' }]) assert.equal(basisGroup(item), null, JSON.stringify(item));
});

test('knowledge：方式、配置、就绪来自 kb.status()（不调 Agent）；每个制度标识取最近一次成功（ingested / skipped）的入库，没删的算一份，规则条数取它的 rulesTotal', async t => {
  const h = await harness();
  t.after(h.done);
  // sample-matrix 最近一次成功的是 20 条（之后那条还在入库）；fin-rules 7 条；broken 最近一次失败了，库里还是之前那份 3 条；old-policy 删了
  assert.deepEqual((await h.read('today')).knowledge, { mode: 's3vectors', configured: true, ready: true, sources: 3, rules: 30, lastIngestAt: '2026-10-23T01:00:00.000Z' });
  assert.deepEqual(h.agentCalls, [], '不调 describe / request');
  assert.ok(h.readyCalls.length >= 1, '就绪只看「Agent 接入」页有没有钥匙');
  // 删掉之后又传了一次：又算上
  const again = await harness({ history: { nextId: 9, items: [...HISTORY.items, { id: 8, sourceId: 'old-policy', status: 'ingested', rulesTotal: 6, finishedAt: '2026-10-26T01:00:00.000Z' }] }, ready: false });
  t.after(again.done);
  assert.deepEqual((await again.read('today')).knowledge, { mode: 's3vectors', configured: true, ready: false, sources: 4, rules: 36, lastIngestAt: '2026-10-26T01:00:00.000Z' });
  assert.deepEqual(again.agentCalls, []);
  // kb.status() / historyList() 本身
  assert.deepEqual(await h.kb.status(), { mode: 's3vectors', configured: true, ready: true });
  assert.deepEqual((await h.kb.historyList()).map(item => item.id), [7, 6, 5, 4, 3, 2, 1], '新的在前');
});

test('角色：管理员、分析员、规则发布复核人能看；别的角色、没登录 403；window 只认 today / 14d / month，别的 400；别的路径和方法交还九安', async t => {
  const h = await harness();
  t.after(h.done);
  for (const user of [ADMIN, ANALYST, POLICY]) assert.equal((await h.ask('?window=today', user)).status, 200, user.role);
  for (const user of [{ id: 'x', role: 'viewer' }, { id: 'x' }, null]) refusedWith(await h.ask('?window=today', user), 403, 'DASHBOARD_FORBIDDEN');
  for (const query of ['', '?window=', '?window=week', '?window=TODAY', '?window=today&window=14d', '?window=today&x=1', '?x=1']) {
    refusedWith(await h.ask(query), 400, 'DASHBOARD_INVALID');
  }
  assert.equal((await h.ask('?window=today', ADMIN, 'POST')).handled, false);
  const other = await h.routes.handle({ req: { method: 'GET' }, url: new URL('/api/analysis/v1/poc/dashboard/x?window=today', 'http://localhost'), session: { user: ADMIN }, res: {} });
  assert.equal(other, false);
});

test('缓存：按（窗口、角色、账号）缓存 60 秒，时钟可注入；到 60 秒重新算；同一角色的两个账号各算各的', async t => {
  const h = await harness({ accounts: [...ACCOUNTS, { id: 'poc-admin2', name: '管理员二（虚构）', role: 'admin' }], rules: { ...RULES, 'poc-admin2': { files: 3, usedChars: 900 } } });
  t.after(h.done);
  const first = await h.read('today');
  assert.equal(h.listCalls.length, 1);
  h.state.reviews = [...reviewsOf(), review('d9', 1, 'override', 'poc-reviewer', '2026-10-30T03:59:00.000Z')];
  h.state.clock += 59_999;
  assert.deepEqual(await h.read('today'), first, '60 秒内同一个人同一个窗口：缓存');
  assert.equal(h.listCalls.length, 1);
  const analyst = await h.read('today', ANALYST);
  assert.equal(analyst.advice.overrides, 2, '另一个账号：自己算');
  assert.equal((await h.read('14d')).advice.overrides, 3, '另一个窗口：自己算');
  assert.equal(h.listCalls.length, 3);
  h.state.clock += 1;
  const fresh = await h.read('today');
  assert.equal(fresh.advice.overrides, 2);
  assert.equal(fresh.to, new Date(NOW + 60_000).toISOString());
  assert.equal(h.listCalls.length, 4);
  // 另一个管理员：同一窗口、同一角色，也自己算；之后两人各拿各的缓存，不串
  const admin2 = { id: 'poc-admin2', role: 'admin', companyIds: ['co-a'] };
  assert.deepEqual((await h.read('today', admin2)).myRules, { files: 3, usedChars: 900, limitChars: null });
  assert.equal(h.listCalls.length, 5);
  h.state.clock += 30_000;
  assert.deepEqual((await h.read('today')).myRules, { files: 2, usedChars: 1200, limitChars: null });
  assert.deepEqual((await h.read('today', admin2)).myRules, { files: 3, usedChars: 900, limitChars: null });
  assert.equal(h.listCalls.length, 5, '两人都是缓存');
});

test('Ruling FR1：只数登录的人范围里的单据（九安里能看的公司 ∩ 测试台的公司）——轮次、待复核、复核都一样；规则发布复核人没有公司，全是 0', async t => {
  // d2、d9 在 co-b，别的在 co-a
  const h = await harness({ companies: { d2: 'co-b', d9: 'co-b' } });
  t.after(h.done);
  const everyone = await h.read('today');
  assert.equal(everyone.advice.completed, 4);
  const narrow = { id: 'poc-checker', role: 'analyst', companyIds: ['co-b', 'co-z'] };
  const mine = await h.read('today', narrow);
  assert.deepEqual(h.listCalls.at(-1), ['co-b'], '只按这个人在测试台里的公司列单据');
  assert.deepEqual(mine.advice, { completed: 2, pass: 2, fail: 0, overrides: 0, passRate: 1, avgDurationMs: 35_000, maxDurationMs: 60_000 },
    'd2（10 s）、d9（60 s）；d1 的改判在 co-a，不算');
  assert.deepEqual(mine.pendingReview, { count: 1, failCount: 0 }, 'd9 待复核；co-a 的 d1、d4、d8 不算');
  assert.deepEqual(mine.daily, [{ date: '2026-10-30', pass: 2, fail: 0, running: 0 }], 'd3 在跑的那一轮在 co-a');
  assert.deepEqual(mine.overrideRate, [{ date: '2026-10-30', reviews: 1, overrides: 0 }], '只有 d2 的复核');
  assert.deepEqual(mine.reviewers, [{ account: 'poc-checker', name: '复核人（虚构）', reviews: 1, overrides: 0, customRules: 1 }]);
  assert.deepEqual(mine.topBasis, []);
  const coA = await h.read('today', { ...ADMIN, companyIds: ['co-a'] });
  assert.equal(coA.advice.completed, 2, 'd1、d7');
  assert.deepEqual(coA.reviewers.map(row => [row.account, row.reviews]), [['poc-checker', 1], ['poc-reviewer', 1]], 'd2 的复核在 co-b，不算');

  const policy = await h.read('14d', POLICY);
  const calls = h.listCalls.length;
  assert.deepEqual(policy.pendingReview, { count: 0, failCount: 0 });
  assert.deepEqual(policy.advice, { completed: 0, pass: 0, fail: 0, overrides: 0, passRate: null, avgDurationMs: null, maxDurationMs: null });
  assert.ok(policy.daily.every(day => day.pass === 0 && day.fail === 0 && day.running === 0));
  assert.ok(policy.overrideRate.every(day => day.reviews === 0 && day.overrides === 0));
  assert.deepEqual([policy.topBasis, policy.topRules, policy.reviewers], [[], [], []]);
  assert.equal(policy.knowledge.sources, 3, '知识库不分公司，照常给');
  await h.read('today', POLICY);
  assert.equal(h.listCalls.length, calls, '范围是空的：不去列单据');
});

test('缓存的键里有范围：同一个账号换了公司（设置改过）不拿旧的那份', async t => {
  const h = await harness({ companies: { d2: 'co-b', d9: 'co-b' } });
  t.after(h.done);
  assert.equal((await h.read('today', { ...ADMIN, companyIds: ['co-a'] })).advice.completed, 2);
  assert.equal((await h.read('today', { ...ADMIN, companyIds: ['co-b'] })).advice.completed, 2);
  assert.deepEqual(h.listCalls, [['co-a'], ['co-b']]);
  assert.equal((await h.read('today', { ...ADMIN, companyIds: ['co-b', 'co-a'] })).advice.completed, 4);
  await h.read('today', { ...ADMIN, companyIds: ['co-a', 'co-b'] });
  assert.equal(h.listCalls.length, 3, '同一范围（顺序不同）还是同一份');
});

test('F3：invalidate() 之后下一次读重新算（60 秒内也是）；只清缓存，正在算的那一份照样回给等它的人', async t => {
  const h = await harness();
  t.after(h.done);
  assert.equal((await h.read('today')).advice.overrides, 1);
  h.state.reviews = [...reviewsOf(), review('d9', 1, 'override', 'poc-reviewer', '2026-10-30T03:59:00.000Z')];
  h.state.clock += 1_000;
  assert.equal((await h.read('today')).advice.overrides, 1, '没清：60 秒内是缓存');
  h.dashboard.invalidate();
  assert.equal((await h.read('today')).advice.overrides, 2, '清了：马上是新的');
  assert.equal((await h.read('today', ANALYST)).advice.overrides, 2);
  assert.equal(h.listCalls.length, 3);
  const pending = h.dashboard.read({ window: '14d', user: ADMIN });
  h.dashboard.invalidate();
  assert.equal((await pending).advice.overrides, 3);
  assert.equal(h.listCalls.length, 4);
});

test('refreshOnRounds：人从单据页发起一轮（start 成功）就清工作台的缓存，这一轮结束（done 不管成败）再清一次；start 失败不清；list、view 原样', async () => {
  let calls = 0, finish, abort;
  const rounds = [];
  const inner = {
    list: async () => 'list', view: async () => 'view',
    async start(args) {
      rounds.push(args);
      if (args.fail) throw Object.assign(new Error('x'), { code: 'RATE_LIMIT' });
      return { round: rounds.length, done: new Promise((resolve, reject) => { finish = resolve; abort = reject; }) };
    },
  };
  const wrapped = refreshOnRounds(inner, { invalidate: () => { calls += 1; } });
  assert.equal(await wrapped.list(), 'list');
  assert.equal(await wrapped.view(), 'view');
  const started = await wrapped.start({ actor: { id: 'u1' }, document: { id: 'd1' } });
  assert.equal(started.round, 1);
  assert.equal(calls, 1, '发起成功：清一次');
  finish({ status: 'completed' });
  await started.done;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2, '这一轮结束：再清一次');
  const second = await wrapped.start({ document: { id: 'd2' } });
  abort(new Error('round failed'));
  await assert.rejects(second.done);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 4, '这一轮失败也算结束');
  await assert.rejects(wrapped.start({ fail: true }), error => error.code === 'RATE_LIMIT');
  assert.equal(calls, 4, '没发起成功：不清');
  assert.equal(refreshOnRounds(null, { invalidate() {} }), null, '没开 AI 独立建议：原样是 null');
});

test('读轮次或复核失败：503 DASHBOARD_UNAVAILABLE（中文），日志一行 POC_DASHBOARD_FAILED <错误码或错误名>，不记消息；失败不缓存', async t => {
  const h = await harness();
  t.after(h.done);
  h.state.broken = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3306'), { code: 'ECONNREFUSED' });
  refusedWith(await h.ask('?window=today'), 503, 'DASHBOARD_UNAVAILABLE');
  assert.deepEqual(h.logs, ['POC_DASHBOARD_FAILED ECONNREFUSED']);
  h.state.broken = null;
  h.state.brokenRounds = new TypeError('rows is not iterable: 虚构的内容');
  refusedWith(await h.ask('?window=today'), 503, 'DASHBOARD_UNAVAILABLE');
  assert.deepEqual(h.logs, ['POC_DASHBOARD_FAILED ECONNREFUSED', 'POC_DASHBOARD_FAILED TypeError']);
  h.state.brokenRounds = Object.assign(new Error('x'), { code: 'bad code with spaces 虚构' });
  refusedWith(await h.ask('?window=today'), 503, 'DASHBOARD_UNAVAILABLE');
  assert.equal(h.logs[2], 'POC_DASHBOARD_FAILED Error', '不合格的错误码不进日志');
  assert.ok(h.logs.every(line => !line.includes('虚构') && !line.includes('127.0.0.1')), '不记消息');
  h.state.brokenRounds = null;
  assert.equal((await h.read('today')).advice.completed, 4, '恢复后照常（失败没进缓存）');
});

test('server_wiring：外壳把工作台挂在 platformRoutes 上，按登录的人的范围只读对公付款单，用同一个复核、「我的规则」和知识库；复核、发起一轮后清它的缓存', async () => {
  const server = await readFile(fileURLToPath(new URL('../../server.mjs', import.meta.url)), 'utf8');
  assert.match(server, /\|\| \(await dashboard\.handle\(args\)\) \|\|/);
  assert.match(server, /createDashboard\(\{[\s\S]*?scopeOf: userScope, listDocuments: scope => everyDocument\(page => store\.listDocuments\(\{ companyIds: scope, type: 'corporate_payment', \.\.\.page \}\)\)/s);
  assert.match(server, /createDashboard\(\{[\s\S]*?reviews, customRules, kb, accounts: \(\) => config\.accounts/);
  assert.match(server, /reviewsRoutes\(\{ reviews, log, onReviewed: \(\) => dashboardStats\.invalidate\(\) \}\)/);
  assert.match(server, /reviewAdvice: nexusAdvice \? refreshOnRounds\(withAdviceActor\(J\.reviewAdviceState\.createReviewAdviceState\(\{ tasks: agentTasks \}\)\), dashboardStats\) : null/);
});
