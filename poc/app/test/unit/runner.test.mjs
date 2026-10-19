import test from 'node:test';
import assert from 'node:assert/strict';
import { createApprovalRunner, precheckSummary } from '../../approval/runner.mjs';
import { createApprovalWorkflow } from '../../approval/workflow.mjs';
import { waitUntil } from './helpers/wait.mjs';

const reviewer = { id: 'poc-reviewer', name: '审核员（虚构）', pocRole: 'reviewer' };
const V = 'a'.repeat(64);
const document = { id: 'doc-1', companyId: 'poc-company-a', version: V };
const current = { precheck: { checks: [{ status: 'verified' }, { status: 'missing' }] }, ruleTrial: { items: [{ status: 'clear' }] } };
const completed = { status: 'completed', model: 'nexus-a2a:pub_x', rulesHash: 'r'.repeat(64), evidenceHash: 'e'.repeat(64), contextHash: 'c'.repeat(64),
  generatedAt: '2030-01-01T00:00:00.000Z', advice: { modelRecommendation: 'MANUAL_REVIEW', effectiveOutcome: 'MANUAL_REVIEW', riskLevel: 'low', confidence: 'medium',
    summary: '建议（虚构）', keyFindings: [], requiredActions: [], unresolvedQuestions: [], conflictFlags: [], rejectionDraft: null } };
const registry = ({ readCurrent = async () => current, enqueue = async () => ({ status: 'queued' }), view = async () => completed } = {}) =>
  ({ get: () => ({ readCurrent }), adviceService: { enqueue, view } });
const start = runner => runner.start({ document, user: reviewer, actor: { id: reviewer.id }, sourceVersion: V });
const reach = (workflow, status) => waitUntil(() => workflow.get(document.id)?.status === status && workflow.get(document.id));

test('预审与 Agent 建议依次完成：状态到待审核，留下预审摘要、哈希、发布与模型', async () => {
  const workflow = createApprovalWorkflow();
  start(createApprovalRunner({ workflow, registry: registry(), tenantId: 'poc-tenant', publishId: 'pub_x', pollMs: 1 }));
  const record = await reach(workflow, 'pending_review');
  assert.deepEqual(record.precheck.summary, { baseChecks: 2, baseByStatus: { verified: 1, missing: 1 }, rules: 1, rulesByStatus: { clear: 1 } });
  assert.match(record.precheck.precheckHash, /^[a-f0-9]{64}$/);
  assert.equal(record.ai.publishId, 'pub_x');
  assert.equal(record.ai.model, 'nexus-a2a:pub_x');
  assert.equal(record.ai.advice.summary, '建议（虚构）');
  assert.equal('rejectionDraft' in record.ai.advice, false);
});

test('Agent 一直没有结果：到时限后进入 AI 失败（POC_AI_TIMEOUT）', async () => {
  let now = 0;
  const workflow = createApprovalWorkflow();
  start(createApprovalRunner({ workflow, registry: registry({ view: async () => ({ status: 'running' }) }), tenantId: 'poc-tenant',
    pollMs: 1000, timeoutMs: 5000, clock: () => now, wait: async ms => { now += ms; } }));
  assert.equal((await reach(workflow, 'ai_failed')).failure.errorCode, 'POC_AI_TIMEOUT');
});

test('九安记录为失败时带上九安的错误码；入队被拒时用拒绝的错误码', async () => {
  const first = createApprovalWorkflow();
  start(createApprovalRunner({ workflow: first, tenantId: 'poc-tenant', pollMs: 1,
    registry: registry({ view: async () => ({ status: 'failed', errorCode: 'AI_INVALID_RESPONSE', message: '模型未返回可核验的完整建议' }) }) }));
  assert.equal((await reach(first, 'ai_failed')).failure.errorCode, 'AI_INVALID_RESPONSE');
  const second = createApprovalWorkflow();
  start(createApprovalRunner({ workflow: second, tenantId: 'poc-tenant', pollMs: 1,
    registry: registry({ enqueue: async () => { throw Object.assign(new Error('full'), { code: 'ANALYSIS_AI_QUEUE_FULL', status: 429 }); } }) }));
  assert.equal((await reach(second, 'ai_failed')).failure.errorCode, 'ANALYSIS_AI_QUEUE_FULL');
});

test('预审出错：进入 AI 失败；重试从预审重新开始并成功', async () => {
  let broken = true;
  const workflow = createApprovalWorkflow();
  const runner = createApprovalRunner({ workflow, tenantId: 'poc-tenant', pollMs: 1, registry: registry({ readCurrent: async () => {
    if (broken) throw Object.assign(new Error('rules'), { code: 'ANALYSIS_RULES_UNAVAILABLE' });
    return current;
  } }) });
  start(runner);
  const failed = await reach(workflow, 'ai_failed');
  assert.equal(failed.failure.stage, 'precheck');
  assert.equal(failed.failure.errorCode, 'ANALYSIS_RULES_UNAVAILABLE');
  broken = false;
  runner.retry({ document, user: reviewer, actor: { id: reviewer.id }, sourceVersion: V });
  await reach(workflow, 'pending_review');
});

test('precheckSummary 按状态计数，缺字段时为 0', () => {
  assert.deepEqual(precheckSummary(undefined, undefined), { baseChecks: 0, baseByStatus: {}, rules: 0, rulesByStatus: {} });
});

test('来单自动发起：不用人点，预审和 AI 初审依次完成，停在待人工复核；留痕的发起人是系统', async () => {
  const workflow = createApprovalWorkflow();
  const runner = createApprovalRunner({ workflow, registry: registry(), tenantId: 'poc-tenant', publishId: 'pub_x', pollMs: 1 });
  runner.autoStart({ document, actor: { id: 'poc-reviewer' } });
  const record = await reach(workflow, 'pending_review');
  assert.equal(record.startedBy.id, 'system');
  assert.deepEqual(record.timeline.map(entry => entry.action), ['auto_start', 'precheck_done', 'ai_done']);
});

test('AI 初审失败一次：系统自动重试，第二次成功', async () => {
  let calls = 0;
  const workflow = createApprovalWorkflow();
  const runner = createApprovalRunner({ workflow, tenantId: 'poc-tenant', pollMs: 1, autoRetryDelayMs: 1,
    registry: registry({ view: async () => (++calls === 1 ? { status: 'failed', errorCode: 'AI_UNAVAILABLE' } : completed) }) });
  runner.autoStart({ document, actor: { id: 'poc-reviewer' } });
  const record = await reach(workflow, 'pending_review');
  assert.deepEqual(record.timeline.map(entry => entry.action), ['auto_start', 'precheck_done', 'ai_failed', 'auto_retry', 'ai_done']);
});

test('AI 初审连续失败：只自动重试一次，然后停在 AI 初审失败，等人处理', async () => {
  const workflow = createApprovalWorkflow();
  const runner = createApprovalRunner({ workflow, tenantId: 'poc-tenant', pollMs: 1, autoRetryDelayMs: 1,
    registry: registry({ view: async () => ({ status: 'failed', errorCode: 'AI_UNAVAILABLE' }) }) });
  runner.autoStart({ document, actor: { id: 'poc-reviewer' } });
  await waitUntil(() => workflow.get(document.id)?.timeline.filter(entry => entry.action === 'ai_failed').length === 2);
  await new Promise(resolve => setTimeout(resolve, 30));
  const record = workflow.get(document.id);
  assert.equal(record.status, 'ai_failed');
  assert.equal(record.timeline.filter(entry => entry.action === 'auto_retry').length, 1);
  runner.close();
});
