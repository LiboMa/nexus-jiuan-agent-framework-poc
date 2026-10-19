import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalRoutes } from '../../approval/routes.mjs';
import { PASSWORDS, advisoryResult, fakeModel, startApp } from './helpers/app.mjs';
import { waitUntil } from './helpers/wait.mjs';

async function setup(t, { behavior, autoRetryDelayMs } = {}) {
  const model = fakeModel(behavior);
  const env = await startApp(t, { modelClient: model.client, plugins: [approvalRoutes({ publishId: 'pub_test', pollMs: 10, timeoutMs: 5000, ...(autoRetryDelayMs ? { autoRetryDelayMs } : {}) })] });
  const reviewer = env.client();
  await reviewer.login('poc-reviewer', PASSWORDS.get('poc-reviewer'));
  const checker = env.client();
  await checker.login('poc-checker', PASSWORDS.get('poc-checker'));
  const { body } = await reviewer.api('/documents?limit=50');
  return { ...env, model, reviewer, checker, byNumber: number => body.data.items.find(item => item.number === number) };
}
const act = (http, document, action, extra = {}) => http.api(`/poc/approvals/${document.id}/${action}`, { method: 'POST', body: { sourceVersion: document.version, ...extra } });
const view = (http, document) => http.api(`/poc/approvals/${document.id}`);
const until = (http, document, status) => waitUntil(async () => {
  const response = await view(http, document);
  return response.body.data.status === status && response.body.data;
});

test('退回路径：发起 → 预审 → AI 初审 → 人工复核退回，结果为已退回（一步复核）', async t => {
  const { reviewer, checker, byNumber, model } = await setup(t);
  const document = byNumber('FYBX-POC-002');
  assert.equal((await view(reviewer, document)).body.data.status, 'not_started');
  assert.equal((await act(reviewer, document, 'start')).status, 200);
  const ready = await until(reviewer, document, 'pending_review');
  assert.equal(ready.ai.advice.modelRecommendation, 'MANUAL_REVIEW');
  assert.equal(ready.ai.publishId, 'pub_test');
  assert.deepEqual(ready.actions, ['decide']);
  assert.equal(model.calls.length, 1);
  const decided = await act(checker, document, 'decide', { decision: 'return', returnNote: '请补充酒店发票与培训通知' });
  assert.equal(decided.body.data.status, 'returned');
  assert.equal(decided.body.data.terminal, true);
  assert.equal(decided.body.data.decision.by.id, 'poc-checker');
  assert.equal((await act(reviewer, document, 'start')).status, 409);
});

test('通过路径：结果为已通过；单据卡片用的批量状态接口带上初审建议', async t => {
  const { reviewer, byNumber } = await setup(t);
  const document = byNumber('FYBX-POC-001'), other = byNumber('FYBX-POC-004');
  await act(reviewer, document, 'start');
  await until(reviewer, document, 'pending_review');
  assert.equal((await act(reviewer, document, 'decide', { decision: 'approve' })).body.data.status, 'approved');
  const list = await reviewer.api(`/poc/approvals?ids=${document.id}%2C${other.id}`);
  const item = list.body.data.items[document.id];
  assert.equal(item.status, 'approved');
  assert.equal(item.label, '已通过');
  assert.equal(item.advice.modelRecommendation, 'MANUAL_REVIEW');
  assert.equal(typeof item.advice.summary, 'string');
  assert.deepEqual(list.body.data.items[other.id], { status: 'not_started', label: '未发起', auto: false, advice: null, failure: null });
});

test('复核人也能发起和复核；确认这一步没有了', async t => {
  const { checker, byNumber } = await setup(t);
  const document = byNumber('FYBX-POC-005');
  assert.equal((await act(checker, document, 'start')).status, 200);
  await until(checker, document, 'pending_review');
  assert.equal((await act(checker, document, 'decide', { decision: 'approve' })).body.data.status, 'approved');
  assert.equal((await checker.api(`/poc/approvals/${document.id}/confirm`, { method: 'POST', body: { sourceVersion: document.version } })).status, 404);
});

test('同一张单据同时发起两次：一个 200，一个 409', async t => {
  const { reviewer, byNumber } = await setup(t);
  const document = byNumber('FYBX-POC-003');
  const statuses = (await Promise.all([act(reviewer, document, 'start'), act(reviewer, document, 'start')])).map(response => response.status).sort();
  assert.deepEqual(statuses, [200, 409]);
});

test('与 AI 初审建议相反、又没写理由的决定被拒绝', async t => {
  const { reviewer, byNumber } = await setup(t, { behavior: async () => advisoryResult({ recommendation: 'RETURN_DRAFT' }) });
  const document = byNumber('FYBX-POC-003');
  await act(reviewer, document, 'start');
  await until(reviewer, document, 'pending_review');
  const refused = await act(reviewer, document, 'decide', { decision: 'approve' });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error.code, 'POC_APPROVAL_REASON_REQUIRED');
  assert.equal((await act(reviewer, document, 'decide', { decision: 'approve', reason: '已线下核对' })).body.data.status, 'approved');
});

test('AI 初审失败（如密钥失效）：进入 AI 初审失败，可以重试成功，也可以转人工', async t => {
  let calls = 0;
  const { reviewer, byNumber } = await setup(t, { behavior: async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('auth'), { code: 'AI_AUTH_INVALID' });
    return advisoryResult();
  } });
  const document = byNumber('DGZF-POC-001');
  await act(reviewer, document, 'start');
  const failed = await until(reviewer, document, 'ai_failed');
  assert.equal(failed.failure.errorCode, 'AI_AUTH_INVALID');
  assert.deepEqual(failed.actions, ['retry', 'manual']);
  await act(reviewer, document, 'retry');
  assert.ok((await until(reviewer, document, 'pending_review')).ai.advice.summary);
  calls = 0;
  const other = byNumber('DGZF-POC-002');
  await act(reviewer, other, 'start');
  await until(reviewer, other, 'ai_failed');
  const manual = await act(reviewer, other, 'manual');
  assert.equal(manual.body.data.status, 'pending_review');
  assert.equal(manual.body.data.ai.skipped, true);
});

test('模拟来单：按模板生成新单据，排在单据池最前面；系统自动发起，不用点就到待人工复核；卡片接口带初审建议', async t => {
  const { reviewer, checker } = await setup(t);
  const templates = (await reviewer.api('/poc/intake/templates')).body.data.items;
  assert.equal(templates.length, 8);
  const created = await reviewer.api('/poc/intake', { method: 'POST', body: { template: 'FYBX-POC-001' } });
  assert.equal(created.status, 201);
  const arrived = created.body.data.document;
  assert.equal(arrived.number, 'FYBX-SIM-001');
  assert.equal((await reviewer.api('/documents?limit=50')).body.data.items[0].number, 'FYBX-SIM-001');
  const ready = await until(reviewer, arrived, 'pending_review');
  assert.equal(ready.auto, true);
  assert.equal(ready.timeline.at(-1).action, 'auto_start');
  const item = (await checker.api(`/poc/approvals?ids=${arrived.id}`)).body.data.items[arrived.id];
  assert.equal(item.auto, true);
  assert.equal(item.advice.modelRecommendation, 'MANUAL_REVIEW');
  const second = (await reviewer.api('/poc/intake', { method: 'POST', body: { template: 'DGZF-POC-001' } })).body.data.document;
  assert.equal(second.number, 'DGZF-SIM-002');
  assert.equal((await act(checker, arrived, 'decide', { decision: 'approve' })).body.data.status, 'approved');
});

test('模拟来单：模板不对是 400；每个账号每分钟最多 5 次，第 6 次 429', async t => {
  const { reviewer } = await setup(t);
  const bad = await reviewer.api('/poc/intake', { method: 'POST', body: { template: 'NOPE-001' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'POC_INTAKE_TEMPLATE_UNKNOWN');
  assert.equal((await reviewer.api('/poc/intake', { method: 'POST', body: { template: 'FYBX-POC-001', extra: 1 } })).status, 400);
  const statuses = [];
  for (let index = 0; index < 5; index += 1) statuses.push((await reviewer.api('/poc/intake', { method: 'POST', body: { template: 'FYBX-POC-004' } })).status);
  assert.deepEqual(statuses, [201, 201, 201, 201, 429]);
});

test('来单后 AI 初审失败一次：系统自动重试，第二次成功', async t => {
  let calls = 0;
  const { reviewer } = await setup(t, { autoRetryDelayMs: 20, behavior: async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error('busy'), { code: 'AI_UNAVAILABLE' });
    return advisoryResult();
  } });
  const arrived = (await reviewer.api('/poc/intake', { method: 'POST', body: { template: 'FYBX-POC-003' } })).body.data.document;
  const ready = await until(reviewer, arrived, 'pending_review');
  assert.ok(ready.timeline.some(entry => entry.action === 'auto_retry'));
});

test('单据版本对不上：409 POC_APPROVAL_SOURCE_CHANGED', async t => {
  const { reviewer, byNumber } = await setup(t);
  const document = byNumber('FYBX-POC-004');
  const response = await reviewer.api(`/poc/approvals/${document.id}/start`, { method: 'POST', body: { sourceVersion: 'b'.repeat(64) } });
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'POC_APPROVAL_SOURCE_CHANGED');
});

test('看不到的单据、多余的字段、错误的 CSRF 令牌都被拒绝', async t => {
  const { reviewer, byNumber } = await setup(t);
  assert.equal((await reviewer.api(`/poc/approvals/${'0'.repeat(64)}`)).status, 404);
  const document = byNumber('FYBX-POC-001');
  assert.equal((await reviewer.api(`/poc/approvals/${document.id}/start`, { method: 'POST', body: { sourceVersion: document.version, extra: 1 } })).status, 400);
  const csrf = await reviewer.api(`/poc/approvals/${document.id}/start`, { method: 'POST', body: { sourceVersion: document.version }, headers: { 'X-CSRF-Token': 'wrong' } });
  assert.equal(csrf.status, 403);
  assert.equal(csrf.body.error.code, 'CSRF_INVALID');
});
