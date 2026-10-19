import test from 'node:test';
import assert from 'node:assert/strict';
import { APPROVAL_STATUS, allowedActions, approvalSteps, approvalView, createApprovalWorkflow, requiresReason } from '../../approval/workflow.mjs';

const reviewer = { id: 'poc-reviewer', name: '审核员（虚构）', pocRole: 'reviewer' };
const checker = { id: 'poc-checker', name: '复核人（虚构）', pocRole: 'checker' };
const V1 = 'a'.repeat(64), V2 = 'b'.repeat(64);
const document = { id: 'doc-1', companyId: 'poc-company-a', version: V1 };
const hashes = { precheckHash: 'p'.repeat(64), rulesHash: 'r'.repeat(64) };
const advice = modelRecommendation => ({ modelRecommendation, effectiveOutcome: 'MANUAL_REVIEW', riskLevel: 'medium', confidence: 'low',
  summary: '缺少酒店发票（虚构）', keyFindings: [], requiredActions: ['补充酒店发票'], unresolvedQuestions: [], conflictFlags: [] });
const aiResult = modelRecommendation => ({ advice: advice(modelRecommendation), model: 'nexus-a2a:pub_x', publishId: 'pub_x', rulesHash: hashes.rulesHash,
  evidenceHash: 'e'.repeat(64), contextHash: 'c'.repeat(64), generatedAt: '2026-10-16T01:00:00.000Z', reused: false, latencyMs: 45_000 });
function toReview(workflow, modelRecommendation = 'MANUAL_REVIEW') {
  const started = workflow.start({ document, user: reviewer, sourceVersion: V1 });
  workflow.precheckDone(document.id, started.attempt, { summary: { baseChecks: 3 }, ...hashes });
  return workflow.aiDone(document.id, started.attempt, aiResult(modelRecommendation));
}
const codeOf = fn => { try { fn(); } catch (error) { return [error.code, error.status]; } return null; };

test('退回路径：来单 → 预审 → AI 初审 → 人工复核退回，结果为已退回（一步复核，没有确认这一步）', () => {
  const workflow = createApprovalWorkflow();
  assert.equal(toReview(workflow).status, 'pending_review');
  const done = workflow.decide({ documentId: document.id, user: checker, sourceVersion: V1, decision: 'return', returnNote: '请补充酒店发票' });
  assert.equal(done.status, 'returned');
  assert.deepEqual(done.timeline.map(entry => entry.action), ['start', 'precheck_done', 'ai_done', 'decide_return']);
  assert.equal(done.decision.returnNote, '请补充酒店发票');
  assert.equal(done.decision.by.id, checker.id);
});

test('通过路径：结果为已通过；模型说「需人工审核」时，通过不需要理由', () => {
  const workflow = createApprovalWorkflow();
  toReview(workflow, 'MANUAL_REVIEW');
  const decided = workflow.decide({ documentId: document.id, user: reviewer, sourceVersion: V1, decision: 'approve' });
  assert.equal(decided.status, 'approved');
  assert.equal(decided.decision.disagreesWithAgent, false);
});

test('来单自动发起：系统是发起人；取调用密钥时不按人找（initiatorOf 为 null）；留痕写明是来单', () => {
  const workflow = createApprovalWorkflow();
  const started = workflow.autoStart({ document });
  assert.equal(started.status, 'prechecking');
  assert.equal(started.startedBy.id, 'system');
  assert.equal(started.timeline.at(-1).action, 'auto_start');
  assert.equal(started.timeline.at(-1).label, '系统自动发起（来单）');
  assert.equal(workflow.initiatorOf(document.id), null);
  assert.deepEqual(codeOf(() => workflow.autoStart({ document })), ['POC_APPROVAL_TRANSITION', 409]);
});

test('AI 初审失败：系统自动重试一次；再失败就停在「AI 初审失败」，人可以重试或直接人工复核', () => {
  const workflow = createApprovalWorkflow();
  const started = workflow.autoStart({ document });
  workflow.precheckDone(document.id, started.attempt, { summary: {}, ...hashes });
  workflow.aiFailed(document.id, started.attempt, { errorCode: 'AI_UNAVAILABLE' });
  assert.equal(workflow.canAutoRetry(document.id), true);
  const retried = workflow.autoRetry(document.id, started.attempt);
  assert.equal(retried.status, 'ai_running');
  assert.equal(retried.timeline.at(-1).action, 'auto_retry');
  workflow.aiFailed(document.id, retried.attempt, { errorCode: 'AI_UNAVAILABLE' });
  assert.equal(workflow.canAutoRetry(document.id), false);
  assert.deepEqual(codeOf(() => workflow.autoRetry(document.id, retried.attempt)), ['POC_APPROVAL_TRANSITION', 409]);
  assert.deepEqual(allowedActions(workflow.get(document.id), checker), ['retry', 'manual']);
  assert.equal(workflow.manual({ documentId: document.id, user: checker, sourceVersion: V1 }).status, 'pending_review');
});

test('两个 PoC 账号都能发起和复核；不是 PoC 账号的不行', () => {
  const workflow = createApprovalWorkflow();
  const stranger = { id: 'x', name: '外人', pocRole: null };
  assert.deepEqual(codeOf(() => workflow.start({ document, user: stranger, sourceVersion: V1 })), ['POC_APPROVAL_FORBIDDEN', 403]);
  assert.equal(workflow.start({ document, user: checker, sourceVersion: V1 }).startedBy.id, checker.id);
  const other = createApprovalWorkflow();
  toReview(other);
  assert.deepEqual(codeOf(() => other.decide({ documentId: document.id, user: stranger, sourceVersion: V1, decision: 'approve' })), ['POC_APPROVAL_FORBIDDEN', 403]);
  assert.deepEqual(allowedActions(other.get(document.id), reviewer), ['decide']);
  assert.deepEqual(allowedActions(other.get(document.id), checker), ['decide']);
});

test('与 AI 初审建议相反时必须写理由', () => {
  const workflow = createApprovalWorkflow();
  toReview(workflow, 'RETURN_DRAFT');
  assert.deepEqual(codeOf(() => workflow.decide({ documentId: document.id, user: reviewer, sourceVersion: V1, decision: 'approve' })), ['POC_APPROVAL_REASON_REQUIRED', 400]);
  const decided = workflow.decide({ documentId: document.id, user: reviewer, sourceVersion: V1, decision: 'approve', reason: '已线下核对发票原件' });
  assert.equal(decided.decision.disagreesWithAgent, true);
  assert.equal(decided.decision.reason, '已线下核对发票原件');
});

test('退回必须写退回说明；决定只能是通过或退回；理由不能超长', () => {
  const workflow = createApprovalWorkflow();
  toReview(workflow);
  assert.deepEqual(codeOf(() => workflow.decide({ documentId: document.id, user: reviewer, sourceVersion: V1, decision: 'return', returnNote: '   ' })), ['POC_APPROVAL_RETURN_NOTE_REQUIRED', 400]);
  assert.deepEqual(codeOf(() => workflow.decide({ documentId: document.id, user: reviewer, sourceVersion: V1, decision: 'maybe' })), ['INVALID_REQUEST', 400]);
  assert.deepEqual(codeOf(() => workflow.decide({ documentId: document.id, user: reviewer, sourceVersion: V1, decision: 'approve', reason: 'x'.repeat(1001) })), ['INVALID_REQUEST', 400]);
  assert.equal(workflow.get(document.id).status, 'pending_review');
});

test('非法转换返回 409，状态不变', () => {
  const workflow = createApprovalWorkflow();
  toReview(workflow);
  const before = workflow.get(document.id);
  assert.deepEqual(codeOf(() => workflow.start({ document, user: reviewer, sourceVersion: V1 })), ['POC_APPROVAL_TRANSITION', 409]);
  assert.deepEqual(codeOf(() => workflow.retry({ documentId: document.id, user: reviewer, sourceVersion: V1 })), ['POC_APPROVAL_TRANSITION', 409]);
  assert.deepEqual(codeOf(() => workflow.decide({ documentId: 'no-such', user: reviewer, sourceVersion: V1, decision: 'approve' })), ['POC_APPROVAL_TRANSITION', 409]);
  assert.deepEqual(workflow.get(document.id), before);
  workflow.decide({ documentId: document.id, user: reviewer, sourceVersion: V1, decision: 'approve' });
  assert.deepEqual(codeOf(() => workflow.decide({ documentId: document.id, user: checker, sourceVersion: V1, decision: 'return', returnNote: 'x' })), ['POC_APPROVAL_TRANSITION', 409]);
});

test('单据版本对不上：409 POC_APPROVAL_SOURCE_CHANGED', () => {
  const workflow = createApprovalWorkflow();
  assert.deepEqual(codeOf(() => workflow.start({ document, user: reviewer, sourceVersion: V2 })), ['POC_APPROVAL_SOURCE_CHANGED', 409]);
  toReview(workflow);
  assert.deepEqual(codeOf(() => workflow.decide({ documentId: document.id, user: reviewer, sourceVersion: V2, decision: 'approve' })), ['POC_APPROVAL_SOURCE_CHANGED', 409]);
});

test('单据版本变化后审批失效，旧一轮的回调作废，可以按新版本重新发起', () => {
  const workflow = createApprovalWorkflow();
  const started = workflow.start({ document, user: reviewer, sourceVersion: V1 });
  assert.equal(workflow.invalidateIfChanged(document.id, V1), null);
  assert.equal(workflow.invalidateIfChanged(document.id, V2).status, 'invalidated');
  assert.deepEqual(codeOf(() => workflow.precheckDone(document.id, started.attempt, { summary: {}, ...hashes })), ['POC_APPROVAL_TRANSITION', 409]);
  const restarted = workflow.start({ document: { ...document, version: V2 }, user: reviewer, sourceVersion: V2 });
  assert.equal(restarted.status, 'prechecking');
  assert.equal(restarted.sourceVersion, V2);
  assert.ok(restarted.attempt > started.attempt);
  assert.deepEqual(restarted.timeline.map(entry => entry.action), ['start', 'invalidated', 'start']);
});

test('已结束的审批不会因版本变化而失效', () => {
  const workflow = createApprovalWorkflow();
  toReview(workflow);
  workflow.decide({ documentId: document.id, user: reviewer, sourceVersion: V1, decision: 'approve' });
  assert.equal(workflow.invalidateIfChanged(document.id, V2), null);
  assert.equal(workflow.get(document.id).status, 'approved');
});

test('重试之后，上一轮迟到的回调被拒绝', () => {
  const workflow = createApprovalWorkflow();
  const started = workflow.start({ document, user: reviewer, sourceVersion: V1 });
  workflow.precheckDone(document.id, started.attempt, { summary: {}, ...hashes });
  workflow.aiFailed(document.id, started.attempt, { errorCode: 'AI_UNAVAILABLE' });
  const retried = workflow.retry({ documentId: document.id, user: reviewer, sourceVersion: V1 });
  assert.equal(retried.status, 'ai_running');
  assert.deepEqual(codeOf(() => workflow.aiDone(document.id, started.attempt, aiResult('MANUAL_REVIEW'))), ['POC_APPROVAL_TRANSITION', 409]);
  assert.equal(workflow.aiDone(document.id, retried.attempt, aiResult('MANUAL_REVIEW')).status, 'pending_review');
});

test('预审失败后重试，从预审重新开始', () => {
  const workflow = createApprovalWorkflow();
  const started = workflow.start({ document, user: reviewer, sourceVersion: V1 });
  const failed = workflow.precheckFailed(document.id, started.attempt, { errorCode: 'ANALYSIS_RULES_UNAVAILABLE' });
  assert.equal(failed.status, 'ai_failed');
  assert.equal(failed.failure.stage, 'precheck');
  assert.deepEqual(approvalSteps(failed).map(step => step.state), ['done', 'failed', 'pending', 'pending']);
  assert.equal(workflow.retry({ documentId: document.id, user: reviewer, sourceVersion: V1 }).status, 'prechecking');
});

test('转人工：跳过 AI 初审，做决定不需要理由', () => {
  const workflow = createApprovalWorkflow();
  const started = workflow.start({ document, user: reviewer, sourceVersion: V1 });
  workflow.precheckDone(document.id, started.attempt, { summary: {}, ...hashes });
  workflow.aiFailed(document.id, started.attempt, { errorCode: 'AI_UNAVAILABLE' });
  const manual = workflow.manual({ documentId: document.id, user: reviewer, sourceVersion: V1 });
  assert.equal(manual.status, 'pending_review');
  assert.equal(manual.ai.skipped, true);
  assert.equal(approvalSteps(manual)[2].state, 'skipped');
  assert.equal(workflow.decide({ documentId: document.id, user: reviewer, sourceVersion: V1, decision: 'approve' }).decision.disagreesWithAgent, false);
});

test('系统步骤的留痕带单据版本、预审与规则哈希、发布编号和模型', () => {
  const record = toReview(createApprovalWorkflow());
  const precheck = record.timeline.find(entry => entry.action === 'precheck_done');
  const ai = record.timeline.find(entry => entry.action === 'ai_done');
  assert.equal(precheck.sourceVersion, V1);
  assert.equal(precheck.precheckHash, hashes.precheckHash);
  assert.equal(precheck.rulesHash, hashes.rulesHash);
  assert.equal(ai.actor.id, 'system');
  assert.equal(ai.publishId, 'pub_x');
  assert.equal(ai.model, 'nexus-a2a:pub_x');
  assert.equal(ai.latencyMs, 45_000);
  assert.equal(ai.modelRecommendation, 'MANUAL_REVIEW');
});

test('四个步骤与可用操作随状态变化；视图里的留痕最新的在前', () => {
  assert.deepEqual(approvalSteps(null).map(step => [step.key, step.state]), [['start', 'pending'], ['precheck', 'pending'], ['ai', 'pending'], ['review', 'pending']]);
  assert.deepEqual(allowedActions(null, reviewer), ['start']);
  assert.deepEqual(allowedActions(null, checker), ['start']);
  const record = toReview(createApprovalWorkflow());
  assert.deepEqual(approvalSteps(record).map(step => step.state), ['done', 'done', 'done', 'active']);
  const view = approvalView(record, reviewer, document.id);
  assert.equal(view.statusLabel, '待人工复核');
  assert.equal(view.timeline[0].action, 'ai_done');
  assert.equal(view.terminal, false);
  assert.deepEqual(approvalView(null, checker, 'doc-x'), { documentId: 'doc-x', status: 'not_started', statusLabel: '未发起', attempt: 0, sourceVersion: null, auto: false,
    steps: approvalSteps(null), precheck: null, ai: null, failure: null, decision: null, timeline: [], actions: ['start'], terminal: false });
  assert.equal(APPROVAL_STATUS.ai_failed, 'AI 初审失败');
});

test('requiresReason 的取值', () => {
  assert.equal(requiresReason('approve', 'RETURN_DRAFT'), true);
  assert.equal(requiresReason('approve', 'ATTENTION'), true);
  assert.equal(requiresReason('approve', 'MANUAL_REVIEW'), false);
  assert.equal(requiresReason('approve', 'PASS_CANDIDATE'), false);
  assert.equal(requiresReason('return', 'PASS_CANDIDATE'), true);
  assert.equal(requiresReason('return', 'RETURN_DRAFT'), false);
  assert.equal(requiresReason('return', undefined), false);
});
