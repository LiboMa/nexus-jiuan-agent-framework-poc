/**
 * PoC 审批流的状态机与留痕。纯内存、同步执行：每个方法要么完成一次合法转换，要么抛错而状态不变。
 * 流程：来单（系统自动发起，或人手动发起）→ 九安预审 → AI 初审 → 人工复核（一步，通过或退回，流程结束）。
 * 系统步骤（预审完成、AI 初审返回或失败、自动重试）带 attempt：发起、重试、转人工或失效之后，旧一轮的回调一律作废。
 * AI 初审失败时系统自动重试一次（每轮审批一次）；再失败就停在「AI 初审失败」，由人重试或直接人工复核。
 * AI 的输出只写进 ai 字段，不触发任何转换；通过 / 退回由人决定。两个 PoC 账号（审核员、复核人）都能发起和复核。
 */
export const APPROVAL_STATUS = Object.freeze({
  not_started: '未发起', prechecking: '预审中', ai_running: 'AI 初审中', ai_failed: 'AI 初审失败', pending_review: '待人工复核',
  approved: '已通过', returned: '已退回', invalidated: '已失效',
});
const TERMINAL = new Set(['approved', 'returned']);
const SYSTEM = Object.freeze({ id: 'system', name: '系统' });
const ACTION_LABEL = Object.freeze({
  start: '发起 AI 初审', auto_start: '系统自动发起（来单）', precheck_done: '九安预审完成', precheck_failed: '九安预审未完成',
  ai_done: 'AI 初审建议已返回', ai_failed: 'AI 初审未完成', auto_retry: '系统自动重试 AI 初审',
  retry: '重试 AI', manual: '转人工（不带 AI 初审建议）', decide_approve: '人工复核：通过', decide_return: '人工复核：退回',
  invalidated: '单据版本变化，审批失效',
});
const STEPS = Object.freeze([['start', '来单 / 发起'], ['precheck', '九安预审'], ['ai', 'AI 初审'], ['review', '人工复核']]);
const human = user => user?.pocRole === 'reviewer' || user?.pocRole === 'checker';

const fail = (code, status) => { throw Object.assign(new Error(code), { code, status }); };
function text(value, max) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > max) fail('INVALID_REQUEST', 400);
  return value.trim();
}

/** 审核员的决定与模型原始建议相反时必须写理由（九安的有效结论只有「需关注 / 需人工审核」两档，所以按模型原始建议判断）。 */
export function requiresReason(decision, modelRecommendation) {
  if (decision === 'approve') return ['RETURN_DRAFT', 'ATTENTION'].includes(modelRecommendation);
  if (decision === 'return') return modelRecommendation === 'PASS_CANDIDATE';
  return false;
}

export function allowedActions(record, user) {
  if (!human(user)) return [];
  const status = record?.status ?? 'not_started';
  if (status === 'not_started' || status === 'invalidated') return ['start'];
  if (status === 'ai_failed') return ['retry', 'manual'];
  if (status === 'pending_review') return ['decide'];
  return [];
}

export function approvalSteps(record) {
  const status = record?.status ?? 'not_started';
  const state = { start: 'pending', precheck: 'pending', ai: 'pending', review: 'pending' };
  if (record && status !== 'not_started') {
    state.start = 'done';
    if (status !== 'invalidated') {
      state.precheck = status === 'prechecking' ? 'active' : record.precheck ? 'done' : record.failure?.stage === 'precheck' ? 'failed' : 'pending';
      state.ai = status === 'ai_running' ? 'active' : record.ai?.skipped ? 'skipped' : record.failure?.stage === 'ai' ? 'failed' : record.ai?.advice ? 'done' : 'pending';
      state.review = status === 'pending_review' ? 'active' : TERMINAL.has(status) ? 'done' : 'pending';
    }
  }
  return STEPS.map(([key, label]) => ({ key, label, state: state[key] }));
}

export function approvalView(record, user, documentId) {
  const status = record?.status ?? 'not_started';
  return {
    documentId, status, statusLabel: APPROVAL_STATUS[status], attempt: record?.attempt ?? 0, sourceVersion: record?.sourceVersion ?? null,
    auto: record?.startedBy?.id === SYSTEM.id, steps: approvalSteps(record), precheck: record?.precheck ?? null, ai: record?.ai ?? null,
    failure: record?.failure ?? null, decision: record?.decision ?? null, timeline: [...(record?.timeline ?? [])].reverse(),
    actions: allowedActions(record, user), terminal: TERMINAL.has(status),
  };
}

export function createApprovalWorkflow({ now = () => new Date().toISOString() } = {}) {
  const records = new Map();
  const actorOf = user => ({ id: user.id, name: user.name });
  function log(record, action, actor, from, extra = {}) {
    record.timeline.push({ at: now(), action, label: ACTION_LABEL[action], from, to: record.status, actor, attempt: record.attempt,
      sourceVersion: record.sourceVersion, ...extra });
    record.updatedAt = now();
  }
  function move(record, to, action, actor, extra) {
    const from = record.status;
    record.status = to;
    log(record, action, actor, from, extra);
    return structuredClone(record);
  }
  function existing(documentId) {
    const record = records.get(documentId);
    if (!record) fail('POC_APPROVAL_TRANSITION', 409);
    return record;
  }
  const person = user => { if (!human(user)) fail('POC_APPROVAL_FORBIDDEN', 403); };
  const status = (record, allowed) => { if (!allowed.includes(record.status)) fail('POC_APPROVAL_TRANSITION', 409); };
  const version = (record, sourceVersion) => { if (sourceVersion !== record.sourceVersion) fail('POC_APPROVAL_SOURCE_CHANGED', 409); };
  function systemStep(documentId, attempt, allowed) {
    const record = existing(documentId);
    if (record.attempt !== attempt) fail('POC_APPROVAL_TRANSITION', 409);
    status(record, allowed);
    return record;
  }
  function humanStep(documentId, user, sourceVersion, allowed) {
    person(user);
    const record = existing(documentId);
    status(record, allowed);
    version(record, sourceVersion);
    return record;
  }
  function open(document, actor, action) {
    const previous = records.get(document.id);
    if (previous && previous.status !== 'invalidated') fail('POC_APPROVAL_TRANSITION', 409);
    const record = { documentId: document.id, companyId: document.companyId, sourceVersion: document.version, status: 'prechecking',
      attempt: (previous?.attempt ?? 0) + 1, autoRetries: 0, startedAt: now(), startedBy: actor, updatedAt: now(),
      precheck: null, ai: null, failure: null, decision: null, timeline: previous?.timeline ?? [] };
    records.set(document.id, record);
    log(record, action, actor, previous?.status ?? 'not_started');
    return structuredClone(record);
  }

  return {
    get: documentId => (records.has(documentId) ? structuredClone(records.get(documentId)) : null),
    // 最近一次发起或重试这张单据审批的人：审批流取调用密钥时，先用他在页面上启用的那把。
    initiatorOf(documentId) {
      const timeline = records.get(documentId)?.timeline ?? [];
      for (let index = timeline.length - 1; index >= 0; index -= 1) {
        const entry = timeline[index];
        if ((entry.action === 'start' || entry.action === 'retry') && entry.actor?.id && entry.actor.id !== SYSTEM.id) return entry.actor.id;
      }
      return null;
    },
    statusOf: documentId => records.get(documentId)?.status ?? 'not_started',
    start({ document, user, sourceVersion }) {
      person(user);
      if (records.get(document.id) && records.get(document.id).status !== 'invalidated') fail('POC_APPROVAL_TRANSITION', 409);
      if (sourceVersion !== document.version) fail('POC_APPROVAL_SOURCE_CHANGED', 409);
      return open(document, actorOf(user), 'start');
    },
    // 来单：系统自动发起，不需要有人点
    autoStart({ document }) {
      return open(document, SYSTEM, 'auto_start');
    },
    // AI 初审失败后系统自动重试，每轮审批只重试一次
    canAutoRetry: documentId => records.get(documentId)?.status === 'ai_failed' && (records.get(documentId).autoRetries ?? 0) < 1,
    autoRetry(documentId, attempt) {
      const record = systemStep(documentId, attempt, ['ai_failed']);
      if ((record.autoRetries ?? 0) >= 1) fail('POC_APPROVAL_TRANSITION', 409);
      record.autoRetries = (record.autoRetries ?? 0) + 1;
      record.attempt += 1;
      record.failure = null;
      return move(record, record.precheck ? 'ai_running' : 'prechecking', 'auto_retry', SYSTEM);
    },
    precheckDone(documentId, attempt, { summary, precheckHash, rulesHash }) {
      const record = systemStep(documentId, attempt, ['prechecking']);
      record.precheck = { summary, precheckHash, rulesHash, at: now() };
      return move(record, 'ai_running', 'precheck_done', SYSTEM, { precheckHash, rulesHash });
    },
    precheckFailed(documentId, attempt, { errorCode, message = null }) {
      const record = systemStep(documentId, attempt, ['prechecking']);
      record.failure = { stage: 'precheck', errorCode, message, at: now() };
      return move(record, 'ai_failed', 'precheck_failed', SYSTEM, { errorCode });
    },
    aiDone(documentId, attempt, result) {
      const record = systemStep(documentId, attempt, ['ai_running']);
      record.ai = { ...result, at: now() };
      record.failure = null;
      return move(record, 'pending_review', 'ai_done', SYSTEM, { publishId: result.publishId ?? null, model: result.model ?? null,
        rulesHash: result.rulesHash ?? null, evidenceHash: result.evidenceHash ?? null, latencyMs: result.latencyMs ?? null,
        summary: result.advice?.summary ? result.advice.summary.slice(0, 300) : null, modelRecommendation: result.advice?.modelRecommendation ?? null });
    },
    aiFailed(documentId, attempt, { errorCode, message = null, latencyMs = null }) {
      const record = systemStep(documentId, attempt, ['ai_running']);
      record.failure = { stage: 'ai', errorCode, message, at: now() };
      return move(record, 'ai_failed', 'ai_failed', SYSTEM, { errorCode, latencyMs });
    },
    retry({ documentId, user, sourceVersion }) {
      const record = humanStep(documentId, user, sourceVersion, ['ai_failed']);
      record.attempt += 1;
      record.failure = null;
      return move(record, record.precheck ? 'ai_running' : 'prechecking', 'retry', actorOf(user));
    },
    manual({ documentId, user, sourceVersion }) {
      const record = humanStep(documentId, user, sourceVersion, ['ai_failed']);
      record.attempt += 1;
      record.ai = { skipped: true, at: now() };
      return move(record, 'pending_review', 'manual', actorOf(user));
    },
    decide({ documentId, user, sourceVersion, decision, reason, returnNote }) {
      const record = humanStep(documentId, user, sourceVersion, ['pending_review']);
      if (!['approve', 'return'].includes(decision)) fail('INVALID_REQUEST', 400);
      const why = text(reason, 1000), note = text(returnNote, 2000);
      const disagrees = requiresReason(decision, record.ai?.advice?.modelRecommendation);
      if (disagrees && !why) fail('POC_APPROVAL_REASON_REQUIRED', 400);
      if (decision === 'return' && !note) fail('POC_APPROVAL_RETURN_NOTE_REQUIRED', 400);
      record.decision = { decision, reason: why || null, returnNote: decision === 'return' ? note : null, disagreesWithAgent: disagrees, by: actorOf(user), at: now() };
      return move(record, decision === 'approve' ? 'approved' : 'returned', decision === 'approve' ? 'decide_approve' : 'decide_return',
        actorOf(user), { reason: why || null, note: decision === 'return' ? note : null });
    },
    invalidateIfChanged(documentId, currentVersion) {
      const record = records.get(documentId);
      if (!record || record.sourceVersion === currentVersion || TERMINAL.has(record.status) || record.status === 'invalidated') return null;
      record.attempt += 1;
      return move(record, 'invalidated', 'invalidated', SYSTEM, { currentVersion });
    },
  };
}
