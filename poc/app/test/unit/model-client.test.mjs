import test from 'node:test';
import assert from 'node:assert/strict';
import { createNexusModelClient } from '../../nexus/model-client.mjs';
import { createRunLog } from '../../nexus/runs.mjs';
import { answerEvents, rejectJson, startFakeA2a, writeEvents } from './helpers/fake-a2a.mjs';
import { waitUntil } from './helpers/wait.mjs';

const ENV = { AI_DATA_ENVIRONMENT: 'prod', AI_PROD_DATA_TENANT_ID: 'poc-tenant', AI_PROD_DATA_COMPANY_IDS: 'poc-company-a,poc-company-b',
  AI_MODEL_DATA_RETENTION: 'nexus-hidden-session-30d' };
const input = () => ({ facts: { documentId: 'doc-1', number: 'FYBX-POC-001' }, ruleResults: { items: [] }, aiReview: null, supplierContext: null, personalFocus: [],
  dataContext: { environment: 'prod', purpose: 'read_only_analysis', tenantId: 'poc-tenant', companyId: 'poc-company-a' } });
const advice = { recommendation: 'MANUAL_REVIEW', riskLevel: 'low', confidence: 'medium', summary: '需要人工核对附件（虚构）', keyFindings: [],
  requiredActions: ['补充酒店发票'], unresolvedQuestions: [], conflictFlags: [], rejectionDraft: null };

function client(fake, { key = 'nxa_test_key', env = ENV, timeoutMs } = {}) {
  const runLog = createRunLog();
  return { runLog, model: createNexusModelClient({ publishId: 'pub_test', rpcUrl: fake?.url ?? 'http://127.0.0.1:9/a2a/pub_test', getKey: () => key,
    env, runLog, source: 'jiuan', ...(timeoutMs ? { timeoutMs } : {}) }) };
}

test('带代码围栏的合格输出：剥掉围栏、过九安校验，并记一条成功的运行记录', async t => {
  const fake = await startFakeA2a(({ res }) => writeEvents(res, answerEvents(`\`\`\`json\n${JSON.stringify(advice)}\n\`\`\``)));
  t.after(() => fake.close());
  const { runLog, model } = client(fake);
  assert.equal(model.model, 'nexus-a2a:pub_test');
  assert.deepEqual(await model.advisory(input()), advice);
  const [run] = runLog.list();
  assert.equal(run.status, 'ok');
  assert.equal(run.validation, 'passed');
  assert.equal(run.fenced, true);
  assert.equal(run.source, 'jiuan');
  assert.equal(run.documentNumber, 'FYBX-POC-001');
  assert.equal(fake.requests[0].headers.authorization, 'Bearer nxa_test_key');
  assert.match(fake.requests[0].body.params.message.parts[0].text, /^<task>\n/);
});

test('多出一个键（如 usage）就是 AI_INVALID_RESPONSE，原始返回留在运行记录里', async t => {
  const fake = await startFakeA2a(({ res }) => writeEvents(res, answerEvents(JSON.stringify({ ...advice, usage: { input_tokens: 1 } }))));
  t.after(() => fake.close());
  const { runLog, model } = client(fake);
  await assert.rejects(model.advisory(input()), { code: 'AI_INVALID_RESPONSE' });
  const run = runLog.get(runLog.list()[0].id);
  assert.equal(run.status, 'error');
  assert.equal(run.validation, 'failed');
  assert.match(run.rawText, /usage/);
});

test('没有调用密钥：立即 AI_AUTH_INVALID，不发请求', async t => {
  const fake = await startFakeA2a(({ res }) => writeEvents(res, answerEvents(JSON.stringify(advice))));
  t.after(() => fake.close());
  const { runLog, model } = client(fake, { key: null });
  await assert.rejects(model.advisory(input()), { code: 'AI_AUTH_INVALID' });
  assert.equal(fake.requests.length, 0);
  const [run] = runLog.list();
  assert.equal(run.errorCode, 'AI_AUTH_INVALID');
  assert.equal(run.validation, 'not_run');
});

test('密钥已停用或发布已暂停（网关回 401 / 404）：AI_AUTH_INVALID', async t => {
  let status = 401;
  const fake = await startFakeA2a(({ res }) => rejectJson(res, status, status === 401 ? 'credential_revoked' : 'publication_not_found'));
  t.after(() => fake.close());
  const { model } = client(fake);
  await assert.rejects(model.advisory(input()), { code: 'AI_AUTH_INVALID' });
  status = 404;
  await assert.rejects(model.advisory(input()), { code: 'AI_AUTH_INVALID' });
});

test('超过时限：AI_UNAVAILABLE（timeout），并向网关发 tasks/cancel', async t => {
  const fake = await startFakeA2a(({ res }) => writeEvents(res, [answerEvents('x')[0]], { end: false }));
  t.after(() => fake.close());
  const { runLog, model } = client(fake, { timeoutMs: 300 });
  await assert.rejects(model.advisory(input()), error => error.code === 'AI_UNAVAILABLE' && error.detail?.reason === 'timeout');
  await waitUntil(() => fake.requests.some(request => request.body?.method === 'tasks/cancel'));
  assert.equal(runLog.list()[0].errorCode, 'AI_UNAVAILABLE');
});

test('数据治理没配好：九安的 AI_DATA_GOVERNANCE_BLOCKED，不发请求', async t => {
  const fake = await startFakeA2a(({ res }) => writeEvents(res, answerEvents(JSON.stringify(advice))));
  t.after(() => fake.close());
  const { model } = client(fake, { env: { AI_DATA_ENVIRONMENT: 'prod' } });
  await assert.rejects(model.advisory(input()), { code: 'AI_DATA_GOVERNANCE_BLOCKED' });
  assert.equal(fake.requests.length, 0);
});

test('传入 runId 时复用调用方建好的运行记录', async t => {
  const fake = await startFakeA2a(({ res }) => writeEvents(res, answerEvents(JSON.stringify(advice))));
  t.after(() => fake.close());
  const { runLog, model } = client(fake);
  const runId = runLog.start({ source: 'invoke', publishId: 'pub_test', task: 'advisory' });
  await model.advisory(input(), { runId });
  assert.equal(runLog.list().length, 1);
  assert.equal(runLog.get(runId).status, 'ok');
  assert.equal(runLog.get(runId).source, 'invoke');
});

test('审批建议可以带附件：文件 Part 跟在任务说明后面，输出照样过九安校验', async t => {
  const fake = await startFakeA2a(({ res }) => writeEvents(res, answerEvents(JSON.stringify(advice))));
  t.after(() => fake.close());
  const { model } = client(fake);
  const pdf = Buffer.from('%PDF-1.7\n% fictitious invoice\n');
  assert.deepEqual(await model.advisory(input(), { files: [{ name: '住宿发票.pdf', mimeType: 'application/pdf', bytes: pdf, size: pdf.length, sha256: 'x' }] }), advice);
  const [text, file] = fake.requests[0].body.params.message.parts;
  assert.match(text.text, /^<task>\n/);
  assert.deepEqual(file, { kind: 'file', file: { name: '住宿发票.pdf', mimeType: 'application/pdf', bytes: pdf.toString('base64') } });
});

test('取密钥时带上单据编号，可以异步、可以返回 {key, source, accountId}；只有 401 才回调 onAuthRejected；运行记录里有密钥来源', async t => {
  let status = 401;
  const fake = await startFakeA2a(({ res }) => rejectJson(res, status, status === 401 ? 'credential_revoked' : 'publication_not_found'));
  t.after(() => fake.close());
  const seen = [], rejected = [];
  const runLog = createRunLog();
  const model = createNexusModelClient({ publishId: 'pub_test', rpcUrl: fake.url, env: ENV, runLog, source: 'jiuan',
    getKey: async context => { seen.push(context); return { key: 'nxa_from_page', source: 'user', accountId: 'poc-reviewer' }; },
    onAuthRejected: credential => { rejected.push(credential.accountId); } });
  await assert.rejects(model.advisory(input()), { code: 'AI_AUTH_INVALID' });
  assert.deepEqual(seen, [{ documentId: 'doc-1' }]);
  assert.deepEqual(rejected, ['poc-reviewer']);
  assert.equal(runLog.list(1)[0].credentialSource, 'user');
  status = 404;
  await assert.rejects(model.advisory(input()), { code: 'AI_AUTH_INVALID' });
  assert.deepEqual(rejected, ['poc-reviewer']);
});

test('谁都没在页面上启用审批 Agent：AI_AUTH_INVALID，提示去 Agent 页启用，不发请求', async () => {
  const runLog = createRunLog();
  const model = createNexusModelClient({ publishId: 'pub_test', rpcUrl: 'http://127.0.0.1:9/a2a/pub_test', env: ENV, runLog, source: 'jiuan', getKey: async () => null });
  await assert.rejects(model.advisory(input()), error => error.code === 'AI_AUTH_INVALID' && /Agent 页/.test(error.message));
});
