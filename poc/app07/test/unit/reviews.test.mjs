import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { currentAdviceReader, readAdviceRounds } from '../../advice-rounds.mjs';
import { OVERRIDE_REASONS, createReviews, reviewsRoutes } from '../../reviews.mjs';

// 复核记录：审核员对一张单当前那一轮 AI 独立建议「采纳」或「改判」，绑定这一轮。轮次照九安 agent-task-service.mjs 存的样子造（假的状态表），
// 复核表用内存里的假 pool：只认 reviews.mjs 写的那几条 SQL，别的 SQL 直接报错。真 MySQL 的那一条测试要 MYSQL_TEST_URL，没有就跳过。
const BASE = '/api/analysis/v1/poc/reviews';
const ADMIN = { id: 'poc-reviewer', role: 'admin' };
const ANALYST = { id: 'poc-checker', role: 'analyst' };
const POLICY = { id: 'poc-policy', role: 'policy_reviewer' };
// 和九安 agent-task-service.mjs 的 agentTaskKey 同一个算法（组合根注入九安自己的那个）
const agentTaskKey = ({ tenantId, companyId, task, subject }) => 'agent-task:v1:' + createHash('sha256').update([tenantId, companyId, task, subject.kind, subject.id].join('|')).digest('hex');
const keyOf = (document, task = 'review_advice') => agentTaskKey({ tenantId: 't1', companyId: document.companyId, task, subject: { kind: 'document', id: document.id } });
const SCOPE = ['co-a', 'co-b'];
const docsOf = () => new Map([
  ['d1', { id: 'd1', companyId: 'co-a', version: 'v1' }], ['d2', { id: 'd2', companyId: 'co-a', version: 'v1' }],
  ['d3', { id: 'd3', companyId: 'co-b', version: 'v1' }], ['d4', { id: 'd4', companyId: 'co-b', version: 'v1' }],
  ['d5', { id: 'd5', companyId: 'co-a', version: 'v1' }], ['d6', { id: 'd6', companyId: 'co-a', version: 'v1' }],
  ['dx', { id: 'dx', companyId: 'co-z', version: 'v1' }], // 不在测试台的公司里：当它不存在
]);
const round = (n, extra = {}) => ({ round: n, task: 'review_advice', contractTask: 'review_advice@1', subjectVersion: 'v1', trigger: 'upstream', requestedBy: 'system:pipeline',
  startedAt: `2026-10-30T0${n}:00:00.000Z`, basis: { assembled: true }, attempts: 1, ...extra });
const done = (n, result, extra = {}) => round(n, { status: 'completed', finishedAt: `2026-10-30T0${n}:01:00.000Z`,
  output: { result, note: '虚构的核对说明', basis: [{ kind: 'rule', ref: 'R-01 虚构规则', page: 2, note: '虚构依据' }, { kind: 'evidence', ref: '虚构合同.pdf' }] }, ...extra });

/** 内存里的 poc_review_decisions：mysql2 的 pool.query 形状（[rows] / [{ insertId }]），DATETIME 按 timezone 'Z' 回 Date。 */
function fakePool() {
  let table = null, nextId = 0;
  const statements = [];
  const TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/;
  const COLUMNS = 'id, document_id, document_version, advice_round, ai_result, decision, final_result, reason, note, actor, created_at';
  const SELECT = new RegExp(`^SELECT ${COLUMNS} FROM poc_review_decisions WHERE (document_id = \\?|document_id IN \\(\\?(?:, \\?)*\\)|created_at >= \\?) ORDER BY created_at( DESC)?, id( DESC)?$`);
  const asRow = row => ({ ...row, created_at: new Date(`${row.created_at.replace(' ', 'T')}Z`) });
  return {
    statements, table: () => table,
    async query(sql, params = []) {
      const text = sql.replace(/\s+/g, ' ').trim();
      statements.push(text);
      assert.equal((text.match(/\?/g) ?? []).length, params.length, `占位符和参数个数对得上：${text}`);
      if (text.startsWith('CREATE TABLE IF NOT EXISTS poc_review_decisions (')) {
        for (const column of ['id INT UNSIGNED NOT NULL AUTO_INCREMENT', 'document_id VARCHAR(191) NOT NULL', 'advice_round INT UNSIGNED NOT NULL', 'note VARCHAR(200) NULL', 'created_at DATETIME(3) NOT NULL']) {
          assert.ok(text.includes(column), column);
        }
        table ??= [];
        return [{ warningStatus: 0 }];
      }
      if (!table) throw Object.assign(new Error("Table 'jiuan07.poc_review_decisions' doesn't exist"), { code: 'ER_NO_SUCH_TABLE' });
      if (text === 'INSERT INTO poc_review_decisions (document_id, document_version, advice_round, ai_result, decision, final_result, reason, note, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)') {
        const [document_id, document_version, advice_round, ai_result, decision, final_result, reason, note, actor, created_at] = params;
        assert.match(created_at, TIME, 'created_at 按 UTC 的 DATETIME(3) 写');
        assert.ok(note === null || [...note].length <= 200);
        table.push({ id: ++nextId, document_id, document_version, advice_round, ai_result, decision, final_result, reason, note, actor, created_at });
        return [{ insertId: nextId, affectedRows: 1 }];
      }
      const select = SELECT.exec(text);
      if (!select) throw new Error(`假 pool 不认这条 SQL：${text}`);
      const [, where, desc, idDesc] = select;
      assert.equal(Boolean(desc), Boolean(idDesc));
      let rows = table;
      if (where === 'document_id = ?') rows = rows.filter(row => row.document_id === params[0]);
      else if (where.startsWith('document_id IN')) rows = rows.filter(row => params.includes(row.document_id));
      else { assert.match(params[0], TIME); rows = rows.filter(row => row.created_at >= params[0]); }
      rows = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
      if (desc) rows.reverse();
      return [rows.map(asRow)];
    },
  };
}

async function harness({ clock = Date.parse('2026-10-30T08:00:00.000Z'), step = 1000, pool = fakePool() } = {}) {
  const docs = docsOf(), states = new Map(), reads = [];
  let at = clock;
  const readCurrentAdvice = currentAdviceReader({ tenantId: 't1', agentTaskKey, readState: async key => { reads.push(key); return states.get(key) ?? null; },
    readDocument: async id => { const document = docs.get(id); return document && SCOPE.includes(document.companyId) ? { ...document } : null; } });
  const reviews = createReviews({ pool, readCurrentAdvice, now: () => (at += step) });
  await reviews.start();
  const logs = [];
  const routes = reviewsRoutes({ reviews, log: line => logs.push(line) });
  const setRounds = (id, current, history = []) => states.set(keyOf(docs.get(id)), { revision: 1, version: 1, current, history });
  const ask = async (method, route = '', { user = ADMIN, body, raw, headers = { 'content-type': 'application/json' } } = {}) => {
    const bytes = raw ?? (body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)));
    const req = Object.assign(Readable.from([bytes]), { method, headers });
    let status = null, payload = null;
    const res = { writeHead(code) { status = code; return this; }, setHeader() {}, end(text) { payload = text ? JSON.parse(text) : null; } };
    const url = new URL(`${BASE}${route}`, 'http://localhost');
    const handled = await routes.handle({ req, url, path: url.pathname, session: user ? { user } : null, res, body: undefined });
    return { handled, status, payload };
  };
  const post = (body, user = ADMIN) => ask('POST', '', { user, body });
  const latest = async (ids, user = ADMIN) => ask('GET', `/latest?ids=${ids.map(encodeURIComponent).join(',')}`, { user });
  return { docs, states, reads, reviews, routes, logs, pool, ask, post, latest, setRounds, readCurrentAdvice };
}
const adopt = (extra = {}) => ({ documentId: 'd1', sourceVersion: 'v1', round: 1, decision: 'adopt', ...extra });
const override = (reason, extra = {}) => ({ documentId: 'd1', sourceVersion: 'v1', round: 1, decision: 'override', reason, ...extra });
const refusedWith = (answer, status, code) => {
  assert.equal(answer.status, status, JSON.stringify(answer.payload));
  assert.equal(answer.payload.error.code, code);
  assert.match(answer.payload.error.message, /[一-鿿]/u, '错误说明是中文');
};

// ---- 读九安存的轮次（advice-rounds.mjs）----

test('readAdviceRounds：每张单的当前一轮和历史；documentVersion 取这一轮审的版本，result、basis 取 Agent 的回答（不是组装时的 record.basis）', async () => {
  const docs = [{ id: 'd1', companyId: 'co-a', version: 'v2' }, { id: 'd2', companyId: 'co-b', version: 'v1' }, { id: 'd3', companyId: 'co-a', version: 'v1' }];
  const states = new Map([
    [keyOf(docs[0]), { current: done(2, 'fail', { subjectVersion: 'v2', requestedBy: 'poc-reviewer', trigger: 'manual' }),
      history: [round(1, { status: 'failed', errorCode: 'AGENT_TASK_UNROUTED', finishedAt: '2026-10-30T01:00:00.500Z' })] }],
    [keyOf(docs[1]), { current: round(1, { status: 'running' }), history: [] }],
    [keyOf(docs[0], 'first_review'), { current: done(1, 'pass'), history: [] }], // 别的任务不算
  ]);
  const rounds = await readAdviceRounds({ tenantId: 't1', agentTaskKey, readState: async key => states.get(key) ?? null, listDocuments: async () => docs });
  assert.deepEqual(rounds, [
    { documentId: 'd1', companyId: 'co-a', documentVersion: 'v2', round: 2, trigger: 'manual', requestedBy: 'poc-reviewer', status: 'completed', result: 'fail',
      basis: [{ kind: 'rule', ref: 'R-01 虚构规则', page: 2, note: '虚构依据' }, { kind: 'evidence', ref: '虚构合同.pdf', page: null, note: '' }], errorCode: null,
      startedAt: '2026-10-30T02:00:00.000Z', finishedAt: '2026-10-30T02:01:00.000Z', current: true },
    { documentId: 'd1', companyId: 'co-a', documentVersion: 'v1', round: 1, trigger: 'upstream', requestedBy: 'system:pipeline', status: 'failed', result: null, basis: [],
      errorCode: 'AGENT_TASK_UNROUTED', startedAt: '2026-10-30T01:00:00.000Z', finishedAt: '2026-10-30T01:00:00.500Z', current: false },
    { documentId: 'd2', companyId: 'co-b', documentVersion: 'v1', round: 1, trigger: 'upstream', requestedBy: 'system:pipeline', status: 'running', result: null, basis: [],
      errorCode: null, startedAt: '2026-10-30T01:00:00.000Z', finishedAt: null, current: true },
  ]);
});

test('readCurrentAdvice：只读这一张单的状态（不扫单据池）；单据不在范围里是 null，没跑过 AI 建议时轮次各项为 null', async () => {
  const h = await harness();
  h.setRounds('d1', done(3, 'pass'), [done(2, 'fail'), done(1, 'fail')]);
  assert.deepEqual(await h.readCurrentAdvice('d1'), { documentVersion: 'v1', round: 3, status: 'completed', result: 'pass', adviceVersion: 'v1' });
  assert.deepEqual(h.reads, [keyOf(h.docs.get('d1'))]);
  assert.deepEqual(await h.readCurrentAdvice('d2'), { documentVersion: 'v1', round: null, status: null, result: null, adviceVersion: null });
  assert.equal(await h.readCurrentAdvice('dx'), null);
  assert.equal(await h.readCurrentAdvice('nope'), null);
});

// ---- 复核（reviews.mjs）----

test('采纳：201 { review }，finalResult 等于 AI 的结论；备注去掉首尾空白，空的记 null；actor 是登录账号，createdAt 是 ISO 时间', async () => {
  const h = await harness();
  h.setRounds('d1', done(1, 'fail'));
  const first = await h.post(adopt({ note: '  核对过原件  ' }));
  assert.equal(first.status, 201, JSON.stringify(first.payload));
  assert.deepEqual(first.payload.data.review, { id: 1, documentId: 'd1', documentVersion: 'v1', adviceRound: 1, aiResult: 'fail', decision: 'adopt', finalResult: 'fail',
    reason: null, note: '核对过原件', actor: 'poc-reviewer', createdAt: '2026-10-30T08:00:01.000Z' });
  const second = await h.post(adopt({ note: '   ' }), ANALYST);
  assert.equal(second.status, 201);
  assert.equal(second.payload.data.review.note, null);
  assert.equal(second.payload.data.review.actor, 'poc-checker');
  h.setRounds('d2', done(1, 'pass'));
  const pass = await h.post(adopt({ documentId: 'd2', reason: null }));
  assert.equal(pass.status, 201, 'reason: null 当没给');
  assert.equal(pass.payload.data.review.finalResult, 'pass');
  assert.deepEqual(h.pool.table().map(row => row.created_at), ['2026-10-30 08:00:01.000', '2026-10-30 08:00:02.000', '2026-10-30 08:00:03.000']);
});

test('采纳不带改判原因：给了原因 400', async () => {
  const h = await harness();
  h.setRounds('d1', done(1, 'pass'));
  refusedWith(await h.post(adopt({ reason: 'amount_ok' })), 400, 'REVIEW_INVALID');
  assert.equal(h.pool.table().length, 0);
});

test('改判：两个方向各有一组原因（Spec 第 9 节），finalResult 和 AI 的相反；用另一个方向的原因 400', async () => {
  assert.deepEqual(OVERRIDE_REASONS, { fail: ['contract_covers', 'evidence_complete', 'amount_ok', 'rule_not_applicable', 'other'],
    pass: ['evidence_missing', 'amount_mismatch', 'payee_mismatch', 'rule_not_applicable', 'other'] });
  const h = await harness();
  h.setRounds('d1', done(1, 'fail'));   // AI 不建议通过 → 改判为通过
  h.setRounds('d2', done(1, 'pass'));   // AI 建议通过 → 改判为不通过
  for (const reason of ['contract_covers', 'evidence_complete', 'amount_ok', 'rule_not_applicable', 'other']) {
    const answer = await h.post(override(reason, { note: reason === 'other' ? '虚构的说明' : undefined }));
    assert.equal(answer.status, 201, `${reason} ${JSON.stringify(answer.payload)}`);
    assert.deepEqual([answer.payload.data.review.aiResult, answer.payload.data.review.finalResult, answer.payload.data.review.reason], ['fail', 'pass', reason]);
  }
  for (const reason of ['evidence_missing', 'amount_mismatch', 'payee_mismatch', 'rule_not_applicable', 'other']) {
    const answer = await h.post(override(reason, { documentId: 'd2', note: reason === 'other' ? '虚构的说明' : undefined }));
    assert.equal(answer.status, 201, `${reason} ${JSON.stringify(answer.payload)}`);
    assert.deepEqual([answer.payload.data.review.aiResult, answer.payload.data.review.finalResult, answer.payload.data.review.decision], ['pass', 'fail', 'override']);
  }
  const before = h.pool.table().length;
  for (const reason of ['evidence_missing', 'amount_mismatch', 'payee_mismatch']) refusedWith(await h.post(override(reason)), 400, 'REVIEW_INVALID');
  for (const reason of ['contract_covers', 'evidence_complete', 'amount_ok']) refusedWith(await h.post(override(reason, { documentId: 'd2' })), 400, 'REVIEW_INVALID');
  for (const reason of [undefined, null, '', 'made_up', 7]) refusedWith(await h.post(override(reason)), 400, 'REVIEW_INVALID');
  assert.equal(h.pool.table().length, before, '不合格的一条都没写');
});

test('改判原因选 other 必须写备注（空白不算）；备注最多 200 个字（按 Unicode 字符数）', async () => {
  const h = await harness();
  h.setRounds('d1', done(1, 'fail'));
  refusedWith(await h.post(override('other')), 400, 'REVIEW_INVALID');
  refusedWith(await h.post(override('other', { note: ' \n ' })), 400, 'REVIEW_INVALID');
  refusedWith(await h.post(override('other', { note: null })), 400, 'REVIEW_INVALID');
  const longest = `${'虚'.repeat(198)}😀😀`;
  assert.equal([...longest].length, 200);
  const ok = await h.post(override('other', { note: longest }));
  assert.equal(ok.status, 201, JSON.stringify(ok.payload));
  assert.equal(ok.payload.data.review.note, longest);
  refusedWith(await h.post(adopt({ note: `${longest}虚` })), 400, 'REVIEW_INVALID');
  refusedWith(await h.post(adopt({ note: 12 })), 400, 'REVIEW_INVALID');
});

test('请求体不合格 400：缺字段、多字段、结论不认识、轮次不是正整数、不是 JSON 对象', async () => {
  const h = await harness();
  h.setRounds('d1', done(1, 'pass'));
  for (const body of [{}, adopt({ extra: 1 }), adopt({ decision: 'approve' }), adopt({ round: '1' }), adopt({ round: 0 }), adopt({ round: 1.5 }),
    adopt({ documentId: '' }), adopt({ documentId: 5 }), adopt({ sourceVersion: null }), { documentId: 'd1', sourceVersion: 'v1', decision: 'adopt' }, [adopt()], 'adopt']) {
    refusedWith(await h.post(body), 400, 'REVIEW_INVALID');
  }
  const broken = await h.ask('POST', '', { raw: Buffer.from('{"documentId":') });
  assert.equal(broken.status, 400);
  assert.equal(broken.payload.error.code, 'INVALID_JSON');
  assert.equal((await h.ask('POST', '', { body: adopt(), headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal(h.pool.table().length, 0);
});

// 检查顺序（T3h）：① 版本不是单据现在的 → STALE；② 有当前一轮、轮次不是它 → STALE；③ 没有轮次或这一轮不能复核 → NOT_READY。
// 只有真有更新的东西（单据新版本、新一轮）时才说「刚更新」。
test('T3h ①：提交的版本不是单据现在的版本 → 409 REVIEW_STALE（不看轮次；没有轮次时也一样）', async () => {
  const h = await harness();
  h.setRounds('d1', done(1, 'pass'));
  h.docs.get('d1').version = 'v2';
  const stale = await h.post(adopt({ sourceVersion: 'v1' }));
  refusedWith(stale, 409, 'REVIEW_STALE');
  assert.equal(stale.payload.error.message, '这张单的 AI 建议刚更新，请先看新的建议。');
  refusedWith(await h.post(adopt({ sourceVersion: 'v1', round: 9 })), 409, 'REVIEW_STALE');
  refusedWith(await h.post(adopt({ documentId: 'd2', sourceVersion: 'v0' })), 409, 'REVIEW_STALE');
  assert.equal(h.pool.table().length, 0);
});

test('T3h ②：有当前一轮、提交的轮次不是它 → 409 REVIEW_STALE（当前一轮在跑、或是给旧版本做的也一样）', async () => {
  const h = await harness();
  h.setRounds('d1', round(2, { status: 'running' }), [done(1, 'pass')]);
  refusedWith(await h.post(adopt({ round: 1 })), 409, 'REVIEW_STALE');
  h.setRounds('d1', done(2, 'pass'), [done(1, 'pass')]);
  refusedWith(await h.post(adopt({ round: 1 })), 409, 'REVIEW_STALE');
  refusedWith(await h.post(adopt({ round: 3 })), 409, 'REVIEW_STALE');
  h.docs.get('d1').version = 'v2';
  refusedWith(await h.post(adopt({ round: 1, sourceVersion: 'v2' })), 409, 'REVIEW_STALE');
  assert.equal(h.pool.table().length, 0);
});

test('T3h ③：没有轮次、或当前一轮不能复核（在跑、失败、declined、superseded、没有 pass / fail、给旧版本做的）→ 409 REVIEW_ADVICE_NOT_READY', async () => {
  const h = await harness();
  // 从没跑过 AI 建议：没有更新的东西，不说「刚更新」
  const never = await h.post(adopt({ documentId: 'd2', round: 1 }));
  refusedWith(never, 409, 'REVIEW_ADVICE_NOT_READY');
  assert.equal(never.payload.error.message, '这张单还没有完成的 AI 建议，等建议出来再复核。');
  for (const current of [round(2, { status: 'running' }), round(2, { status: 'failed', errorCode: 'AI_UNAVAILABLE' }),
    round(2, { status: 'declined', declined: { reason: 'out_of_scope' } }), round(2, { status: 'superseded' }), done(2, null), done(2, 'unsure')]) {
    h.setRounds('d1', current, [done(1, 'pass')]);
    refusedWith(await h.post(adopt({ round: 2 })), 409, 'REVIEW_ADVICE_NOT_READY');
  }
  // 单据现在是 v2，当前一轮是给 v1 做的：按 v2 提交这一轮
  h.setRounds('d1', done(2, 'pass'));
  h.docs.get('d1').version = 'v2';
  refusedWith(await h.post(adopt({ round: 2, sourceVersion: 'v2' })), 409, 'REVIEW_ADVICE_NOT_READY');
  assert.equal(h.pool.table().length, 0);
});

test('Review Focus 3：两人复核同一轮都成功，以后一次为准；看的是第 N 轮、提交时第 N+1 轮已完成的那个人 409', async () => {
  const h = await harness();
  h.setRounds('d1', done(1, 'fail'));
  assert.equal((await h.post(adopt(), ADMIN)).status, 201);
  assert.equal((await h.post(override('amount_ok'), ANALYST)).status, 201);
  let items = (await h.latest(['d1'])).payload.data.items;
  assert.equal(items.d1.state, 'reviewed');
  assert.deepEqual([items.d1.review.actor, items.d1.review.decision, items.d1.review.finalResult], ['poc-checker', 'override', 'pass']);
  h.setRounds('d1', done(2, 'pass'), [done(1, 'fail')]);
  refusedWith(await h.post(adopt({ round: 1 }), ADMIN), 409, 'REVIEW_STALE');
  items = (await h.latest(['d1'])).payload.data.items;
  assert.equal(items.d1.state, 'outdated');
  assert.equal(h.pool.table().length, 2);
});

test('同一单复核多次：latest 取最后一次（同一毫秒按编号），历史全留着、新的在前', async () => {
  const h = await harness({ step: 0 });   // 时钟不走：三次都是同一毫秒
  h.setRounds('d1', done(1, 'fail'));
  await h.post(adopt());
  await h.post(override('contract_covers'), ANALYST);
  await h.post(override('other', { note: '虚构：以最后一次为准' }));
  const latest = (await h.latest(['d1'])).payload.data.items.d1;
  assert.deepEqual([latest.state, latest.review.id, latest.review.reason, latest.review.note], ['reviewed', 3, 'other', '虚构：以最后一次为准']);
  const history = await h.ask('GET', '?documentId=d1');
  assert.equal(history.status, 200);
  assert.deepEqual(history.payload.data.items.map(item => [item.id, item.decision, item.actor]), [[3, 'override', 'poc-reviewer'], [2, 'override', 'poc-checker'], [1, 'adopt', 'poc-reviewer']]);
  assert.equal((await h.ask('GET', '?documentId=d2')).payload.data.items.length, 0);
});

test('latest 的 state：no_advice / running / pending / reviewed / outdated；current 总是带上（失败、declined 也看得到），不认识的单据也给一项', async () => {
  const h = await harness();
  h.setRounds('d1', done(1, 'pass'));                                   // 完成、没人复核 → pending
  h.setRounds('d2', round(3, { status: 'running' }), [done(2, 'fail')]);  // 新一轮在跑 → running
  h.setRounds('d3', round(1, { status: 'failed', errorCode: 'AI_UNAVAILABLE' }));
  h.setRounds('d4', round(1, { status: 'declined', declined: { reason: 'out_of_scope' } }));
  h.setRounds('d5', done(1, 'fail'));
  await h.post(adopt({ documentId: 'd5' }));                           // 复核过当前一轮 → reviewed
  h.setRounds('d6', done(1, 'fail'));
  await h.post(adopt({ documentId: 'd6' }));
  h.setRounds('d6', done(2, 'pass'), [done(1, 'fail')]);                // 复核过后又跑完一轮 → outdated
  const answer = await h.latest(['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'dx', 'nope', 'd1']);
  assert.equal(answer.status, 200, JSON.stringify(answer.payload));
  const { items } = answer.payload.data;
  assert.deepEqual(Object.keys(items), ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'dx', 'nope']);
  const brief = id => [items[id].state, items[id].current, items[id].review?.adviceRound ?? null];
  assert.deepEqual(brief('d1'), ['pending', { round: 1, result: 'pass', status: 'completed' }, null]);
  assert.deepEqual(brief('d2'), ['running', { round: 3, result: null, status: 'running' }, null]);
  assert.deepEqual(brief('d3'), ['no_advice', { round: 1, result: null, status: 'failed' }, null]);
  assert.deepEqual(brief('d4'), ['no_advice', { round: 1, result: null, status: 'declined' }, null]);
  assert.deepEqual(brief('d5'), ['reviewed', { round: 1, result: 'fail', status: 'completed' }, 1]);
  assert.deepEqual(brief('d6'), ['outdated', { round: 2, result: 'pass', status: 'completed' }, 1]);
  assert.deepEqual(items.dx, { state: 'no_advice', current: null, review: null }, '不在范围里的单据：什么都不给');
  assert.deepEqual(items.nope, { state: 'no_advice', current: null, review: null });
  // 单据出了新版本：旧版本的那一轮不算数（复核过的也一样），回到 no_advice
  h.docs.get('d1').version = 'v2';
  h.docs.get('d5').version = 'v2';
  const after = (await h.latest(['d1', 'd5'])).payload.data.items;
  assert.deepEqual([after.d1.state, after.d5.state, after.d5.current], ['no_advice', 'no_advice', { round: 1, result: 'fail', status: 'completed' }]);
  // 新版本跑完一轮：之前的复核是旧版本的 → outdated
  h.setRounds('d5', done(2, 'pass', { subjectVersion: 'v2' }), [done(1, 'fail')]);
  assert.equal((await h.latest(['d5'])).payload.data.items.d5.state, 'outdated');
  // 没有任何轮次
  h.states.clear();
  assert.deepEqual((await h.latest(['d1'])).payload.data.items.d1, { state: 'no_advice', current: null, review: null });
});

test('latest 一次 1 到 50 张：没有 ids、空的、超过 50 张 400', async () => {
  const h = await harness();
  const fifty = Array.from({ length: 50 }, (_, index) => `d${index}`);
  assert.equal((await h.latest(fifty)).status, 200);
  refusedWith(await h.latest([...fifty, 'd50']), 400, 'REVIEW_INVALID');
  refusedWith(await h.ask('GET', '/latest'), 400, 'REVIEW_INVALID');
  refusedWith(await h.ask('GET', '/latest?ids='), 400, 'REVIEW_INVALID');
  refusedWith(await h.ask('GET', '/latest?ids=d1,,d2'), 400, 'REVIEW_INVALID');
  refusedWith(await h.ask('GET', '/latest?ids=d1&ids=d2'), 400, 'REVIEW_INVALID');
  refusedWith(await h.ask('GET', '/latest?ids=d1&x=1'), 400, 'REVIEW_INVALID');
});

test('复核历史：要 documentId；单据不在范围里或不存在 404，复核也一样', async () => {
  const h = await harness();
  refusedWith(await h.ask('GET', ''), 400, 'REVIEW_INVALID');
  refusedWith(await h.ask('GET', '?documentId=dx'), 404, 'REVIEW_NOT_FOUND');
  refusedWith(await h.ask('GET', '?documentId=nope'), 404, 'REVIEW_NOT_FOUND');
  refusedWith(await h.post(adopt({ documentId: 'dx' })), 404, 'REVIEW_NOT_FOUND');
  refusedWith(await h.post(adopt({ documentId: 'nope' })), 404, 'REVIEW_NOT_FOUND');
});

test('角色：管理员、分析员能复核；policy_reviewer 只能看（复核 403 REVIEW_FORBIDDEN）；别的角色、没登录一律 403', async () => {
  const h = await harness();
  h.setRounds('d1', done(1, 'pass'));
  const denied = await h.post(adopt(), POLICY);
  refusedWith(denied, 403, 'REVIEW_FORBIDDEN');
  assert.match(denied.payload.error.message, /管理员和分析员/);
  assert.equal((await h.post(adopt(), ANALYST)).status, 201);
  assert.equal((await h.ask('GET', '?documentId=d1', { user: POLICY })).status, 200);
  assert.equal((await h.latest(['d1'], POLICY)).payload.data.items.d1.state, 'reviewed');
  for (const user of [{ id: 'someone', role: 'viewer' }, { id: 'someone' }, null]) {
    refusedWith(await h.post(adopt(), user), 403, 'REVIEW_FORBIDDEN');
    refusedWith(await h.ask('GET', '?documentId=d1', { user }), 403, 'REVIEW_FORBIDDEN');
    refusedWith(await h.latest(['d1'], user), 403, 'REVIEW_FORBIDDEN');
  }
  assert.equal(h.pool.table().length, 1);
});

test('别的路径和方法交还九安', async () => {
  const h = await harness();
  assert.equal((await h.ask('PUT', '', { body: adopt() })).handled, false);
  assert.equal((await h.ask('POST', '/latest', { body: {} })).handled, false);
  assert.equal((await h.ask('GET', '/1')).handled, false);
  const other = await h.routes.handle({ req: { method: 'GET' }, url: new URL('http://localhost/api/analysis/v1/poc/reviewsx'), path: '/api/analysis/v1/poc/reviewsx', session: { user: ADMIN }, res: {} });
  assert.equal(other, false);
});

test('all({ since })：给工作台用，按时间先后；建表可以重复跑；表读不了 503（日志只记错误码）', async () => {
  const h = await harness();
  h.setRounds('d1', done(1, 'fail'));
  h.setRounds('d2', done(1, 'pass'));
  await h.post(adopt());                                   // 08:00:01
  await h.post(override('payee_mismatch', { documentId: 'd2' }));   // 08:00:02
  await h.post(override('amount_ok'));                     // 08:00:03
  assert.deepEqual((await h.reviews.all()).map(item => item.id), [1, 2, 3]);
  assert.deepEqual((await h.reviews.all({ since: '2026-10-30T08:00:02.000Z' })).map(item => [item.id, item.documentId, item.finalResult]), [[2, 'd2', 'fail'], [3, 'd1', 'pass']]);
  assert.deepEqual((await h.reviews.all({ since: new Date('2026-10-30T09:00:00Z') })), []);
  assert.deepEqual((await h.reviews.all({ since: '2026-10-30T16:00:02+08:00' })).map(item => item.id), [2, 3], '带时差的 ISO 时间按 UTC 比');
  for (const since of ['yesterday', '2026-10-30', '2026-10-30T08:00:00', '2026-13-01T00:00:00Z', 1_730_000_000_000, new Date('x'), new Date('0999-12-31T00:00:00Z'), {}]) {
    await assert.rejects(h.reviews.all({ since }), error => error.code === 'REVIEW_INVALID', String(since));
  }
  await h.reviews.start();
  assert.equal(h.pool.table().length, 3, '再建一次表不清数据');

  const broken = { async query() { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); } };
  const b = await harness({ pool: { ...fakePool(), query: async (sql, params) => (sql.trim().startsWith('CREATE') ? [{}] : broken.query(sql, params)) } });
  b.setRounds('d1', done(1, 'pass'));
  const answer = await b.post(adopt());
  assert.equal(answer.status, 503);
  assert.equal(answer.payload.error.code, 'REVIEW_UNAVAILABLE');
  assert.deepEqual(b.logs, ['POC_REVIEWS_FAILED ECONNREFUSED']);
  // 程序错误没有 code：记错误名，不记消息
  const t = await harness({ pool: { ...fakePool(), query: async sql => { if (sql.trim().startsWith('CREATE')) return [{}]; throw new TypeError('rows is not iterable: 虚构的内容'); } } });
  t.setRounds('d1', done(1, 'pass'));
  assert.equal((await t.post(adopt())).status, 503);
  assert.deepEqual(t.logs, ['POC_REVIEWS_FAILED TypeError']);
});

// ---- 真 MySQL 8（要 MYSQL_TEST_URL，库名以 _test 结尾；mysql2 取九安 v0.7.10 副本里的）----
const MYSQL_TEST_URL = process.env.MYSQL_TEST_URL || null;
test('MySQL：建表、写、按单据读历史、latest、all({ since })，时间按 UTC 毫秒来回不变', { skip: MYSQL_TEST_URL ? false : '需要 MYSQL_TEST_URL' }, async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const jiuan = path.resolve(process.env.JIUAN07_DIR || path.join(here, '../../../../.build/jiuan07'));
  const mysql = createRequire(path.join(jiuan, 'package.json'))('mysql2/promise');
  const url = new URL(MYSQL_TEST_URL);
  const database = decodeURIComponent(url.pathname.slice(1));
  assert.ok(database.endsWith('_test'), `测试库名必须以 _test 结尾：${database}`);
  // 和九安的 pool 一样：utf8mb4、timezone 'Z'
  const pool = mysql.createPool({ host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    database, charset: 'utf8mb4', timezone: 'Z', connectionLimit: 4 });
  try {
    await pool.query('DROP TABLE IF EXISTS poc_review_decisions');
    const h = await harness({ pool, step: 0 });
    await h.reviews.start();
    h.setRounds('d1', done(1, 'fail'));
    const note = `${'虚'.repeat(199)}😀`;
    const first = (await h.post(override('other', { note }))).payload.data.review;
    const second = (await h.post(adopt(), ANALYST)).payload.data.review;
    assert.equal(first.createdAt, second.createdAt);
    const history = (await h.ask('GET', '?documentId=d1')).payload.data.items;
    assert.deepEqual(history, [second, first], '同一毫秒按编号，新的在前');
    assert.equal(history[1].note, note);
    assert.equal((await h.latest(['d1', 'd2'])).payload.data.items.d1.review.id, second.id);
    assert.deepEqual((await h.reviews.all({ since: first.createdAt })).map(item => item.id), [first.id, second.id]);
    assert.deepEqual(await h.reviews.all({ since: new Date(Date.parse(first.createdAt) + 1) }), []);
  } finally {
    await pool.query('DROP TABLE IF EXISTS poc_review_decisions');
    await pool.end();
  }
});
