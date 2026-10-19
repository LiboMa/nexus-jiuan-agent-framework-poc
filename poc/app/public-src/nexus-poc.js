/**
 * 九安前端副本里的 PoC 扩展（scripts/build-public.mjs 把它放进 app/public/）：
 *   - 登录卡片里的口令登录；
 *   - 单据详情里的「审批流」卡片，以及单据卡片上的审批状态；
 *   - 「Nexus Agent」页（见本文件后半部分；调用测试与调用记录的展示在 nexus-invoke.js）。
 * analysis.js 经 nexusCtx 把请求函数（api）和界面小工具（element、tag、panel……）传进来，这里不读写它的内部状态。
 * 页面的 CSP 不允许内联样式与脚本：外观全部用 nexus-poc.css 里的 class。
 */
import { CONFIDENCE, createInvokePanel, inputModeLabels, pollDelay, runResult, runView, seconds } from './nexus-invoke.js';

export { pollDelay, runView };

export const POC_SAFE_ERRORS = Object.freeze({
  INVALID_CREDENTIALS: '账号或口令不正确。',
  POC_LOGIN_RATE_LIMIT: '登录尝试过多，请一分钟后再试。',
  POC_APPROVAL_TRANSITION: '当前审批状态不允许这项操作，请刷新后查看最新状态。',
  POC_APPROVAL_FORBIDDEN: '当前账号不能执行这项审批操作。',
  POC_APPROVAL_REASON_REQUIRED: '这项决定与 AI 初审建议不一致，请写明理由。',
  POC_INTAKE_TEMPLATE_UNKNOWN: '没有这个来单模板，请从列表里选。',
  POC_INTAKE_RATE_LIMIT: '模拟来单每分钟最多 5 次，请稍后再试。',
  POC_DOCUMENT_EXISTS: '这张单据已经在单据池里了。',
  POC_APPROVAL_RETURN_NOTE_REQUIRED: '退回时请填写退回说明。',
  POC_APPROVAL_SOURCE_CHANGED: '单据版本已变化，原审批已失效，请重新发起。',
  POC_NEXUS_API_KEY_INVALID: 'API 密钥无效、已经用过（第一次连接后平台会换新），或者不属于这个 Nexus：在 Nexus「个人设置 › API 密钥」新建一把再连接。',
  POC_NEXUS_UNREACHABLE: '暂时连不上 Nexus，稍后再试。',
  POC_NEXUS_NOT_CONNECTED: '还没有连接 Nexus：先在上面填入你的 API 密钥。',
  POC_PUBLICATION_NOT_MINE: '这个发布不在你的 Nexus 列表里：确认用的是发布者本人或被分享者的 API 密钥，再点「刷新」。',
  POC_CARD_UNAVAILABLE: '读不到这个发布的 A2A 名片：发布可能暂停了，或者 A2A 没打开。',
  POC_CALL_KEY_INVALID: '调用密钥无效，或者不属于这个发布：在 Nexus「互联中心 › 对外发布」找到这个发布，签一把新的再粘贴。',
  POC_AGENT_NOT_ENABLED: '这个 Agent 还没有启用：先在「我的 Agent」里粘贴调用密钥启用。',
  POC_ISSUE_NOT_ALLOWED: '应用暂时不能替你签发调用密钥：请在 Nexus 网页上签发后粘贴进来。',
  POC_ME_RATE_LIMIT: '连接和启用每分钟最多 5 次，请稍后再试。',
  POC_INVOKE_RATE_LIMIT: '调用测试每分钟最多 5 次，请稍后再试。',
  POC_ADVISORY_INPUT_UNAVAILABLE: '这张单据暂时组装不出审批建议的输入，请刷新后重试。',
  POC_ATTACHMENT_TOO_MANY: '附件最多 5 个。',
  POC_ATTACHMENT_TOO_LARGE: '单个附件不能超过 5 MB。',
  POC_ATTACHMENT_TOTAL_TOO_LARGE: '附件合计不能超过 6 MB。',
  POC_ATTACHMENT_TYPE_NOT_SUPPORTED: '不支持这种附件类型：可用图片、PDF、Excel、CSV、Word、Markdown、文本、JSON、YAML、XML、HTML。',
  POC_ATTACHMENT_TYPE_MISMATCH: '附件的内容与扩展名不符（例如改过扩展名的文件），请用原始文件。',
  POC_ATTACHMENT_INVALID: '附件读取失败或内容不完整，请重新选择。',
  BODY_LIMIT: '请求太大：附件合计不能超过 6 MB。',
});

const STATUS_TONE = Object.freeze({ not_started: '', prechecking: 'blue', ai_running: 'blue', ai_failed: 'red', pending_review: 'amber',
  approved: 'green', returned: 'red', invalidated: '' });
const STEP_STATE = Object.freeze({ pending: ['未开始', ''], active: ['进行中', 'blue'], done: ['完成', 'green'], failed: ['失败', 'red'], skipped: ['跳过', ''] });
const RECOMMENDATION = Object.freeze({ PASS_CANDIDATE: '可考虑通过', ATTENTION: '需关注', RETURN_DRAFT: '建议退回', MANUAL_REVIEW: '需人工审核' });
const RISK = Object.freeze({ low: '低', medium: '中', high: '高', unknown: '未知' });
const CHECK_STATUS = Object.freeze({ verified: '已核验', clear: '已核验', attention: '需关注', missing: '缺失', not_applicable: '不适用' });
const WORKING = new Set(['prechecking', 'ai_running']);
const RECOMMENDATION_TONE = Object.freeze({ RETURN_DRAFT: 'red', PASS_CANDIDATE: 'green', ATTENTION: 'amber', MANUAL_REVIEW: 'amber' });
const LOGIN_ACCOUNTS = Object.freeze([['poc-reviewer', '审核员（虚构）'], ['poc-checker', '复核人（虚构）']]);

const shortHash = value => (typeof value === 'string' && value.length > 12 ? value.slice(0, 12) : value || '—');

export const approvalTone = status => STATUS_TONE[status] ?? '';

/** 与 app/approval/workflow.mjs 的 requiresReason 保持一致（单元测试逐项比对）；这里只用于提前提示，服务端才是准绳。 */
export function requiresReason(decision, modelRecommendation) {
  if (decision === 'approve') return ['RETURN_DRAFT', 'ATTENTION'].includes(modelRecommendation);
  if (decision === 'return') return modelRecommendation === 'PASS_CANDIDATE';
  return false;
}

/** 退回说明的默认内容。九安的建议服务不让模型写退回意见（rejectionDraft 固定为空），所以带出 Agent 列出的待补事项，由审核员修改。 */
export function defaultReturnNote(advice) {
  const items = [...(advice?.requiredActions ?? []), ...(advice?.unresolvedQuestions ?? [])]
    .filter(item => typeof item === 'string' && item.trim()).map(item => item.trim()).slice(0, 8);
  if (!items.length) return '';
  return `请补充或说明以下事项后重新提交：\n${items.map((item, index) => `${index + 1}. ${item}`).join('\n')}`.slice(0, 2000);
}


export function traceText(entry) {
  return [`单据版本 ${shortHash(entry.sourceVersion)}`, entry.precheckHash ? `预审 ${shortHash(entry.precheckHash)}` : null,
    entry.rulesHash ? `规则 ${shortHash(entry.rulesHash)}` : null, entry.publishId ? `发布 ${entry.publishId}` : null,
    entry.model ? `模型 ${entry.model}` : null, Number.isFinite(entry.latencyMs) ? `用时 ${seconds(entry.latencyMs)}` : null].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------------------
// 口令登录（替换九安登录卡片里「钉钉实名入口尚未启用」的提示）
// ---------------------------------------------------------------------------
export function passwordLoginForm(ctx) {
  const { element } = ctx.ui;
  const account = element('select', { id: 'poc-login-account', name: 'account', required: true },
    LOGIN_ACCOUNTS.map(([value, label]) => element('option', { value }, label)));
  const password = element('input', { id: 'poc-login-password', name: 'password', type: 'password', autocomplete: 'current-password', required: true, maxlength: '200' });
  const message = element('div', { class: 'poc-login-message' });
  const submit = element('button', { type: 'submit', class: 'button primary' }, '登录');
  let busy = false;
  async function login(event) {
    event.preventDefault();
    if (busy) return;
    busy = true;
    submit.disabled = true;
    submit.textContent = '正在登录…';
    message.replaceChildren();
    try {
      const { ticket } = await ctx.api('/poc/login', { method: 'POST', body: { account: account.value, password: password.value } });
      await ctx.api('/auth/exchange', { method: 'POST', body: { ticket } });
      password.value = '';
      await ctx.onLoggedIn();
    } catch (error) {
      message.replaceChildren(element('div', { class: 'inline-message error', role: 'alert' }, ctx.loginErrorMessage(error)));
      busy = false;
      submit.disabled = false;
      submit.textContent = '登录';
      password.focus();
    }
  }
  return element('form', { class: 'poc-login-form', on: { submit: login } },
    element('div', { class: 'field' }, element('label', { for: 'poc-login-account' }, '账号'), account),
    element('div', { class: 'field' }, element('label', { for: 'poc-login-password' }, '口令'), password),
    message, submit,
    element('p', { class: 'quiet-note' }, '两个虚构账号的口令由部署脚本生成，写在 infra/secrets.env。测试环境重启后，单据与审批记录会重置，需要重新登录。'));
}

// ---------------------------------------------------------------------------
// 单据卡片上的审批状态
// ---------------------------------------------------------------------------
/** 卡片上的几枚标签：审批状态；有 AI 初审建议时带结论和风险；来单自动发起的标一下。 */
export function approvalChips(entry, ui) {
  const chips = [ui.tag(`审批：${entry.label}`, approvalTone(entry.status))];
  if (entry.advice) {
    chips.push(ui.tag(`AI 初审：${RECOMMENDATION[entry.advice.modelRecommendation] ?? entry.advice.modelRecommendation ?? '—'}`, RECOMMENDATION_TONE[entry.advice.modelRecommendation] ?? ''));
    if (entry.advice.riskLevel) chips.push(ui.tag(`风险：${RISK[entry.advice.riskLevel] ?? entry.advice.riskLevel}`));
  }
  if (entry.auto) chips.push(ui.tag('来单自动发起', 'blue'));
  return chips;
}
/** 还有在预审或 AI 初审中的，就接着刷新卡片，建议一出来就显示，不用点。 */
export const needsPolling = items => Object.values(items ?? {}).some(entry => WORKING.has(entry?.status));

export async function fillApprovalStatuses(container, items, ctx, { route } = {}) {
  if (route === 'documents') mountIntakeBar(container, ctx);
  const ids = (Array.isArray(items) ? items : []).map(item => item?.id)
    .filter(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(id)).slice(0, 50);
  if (!ids.length) return;
  let rounds = 0;
  async function fill() {
    if (!container.isConnected || !ctx.isCurrent()) return;
    let result;
    try { result = await ctx.api(`/poc/approvals?ids=${ids.join('%2C')}`); } catch { return; }
    if (!ctx.isCurrent() || !container.isConnected) return;
    for (const slot of container.querySelectorAll('[data-approval-status]')) {
      const id = slot.closest('[data-document-id]')?.getAttribute('data-document-id');
      const entry = id ? result?.items?.[id] : null;
      if (!entry) continue;
      slot.replaceChildren(...approvalChips(entry, ctx.ui));
      if (entry.advice?.summary) slot.setAttribute('title', `AI 初审摘要：${entry.advice.summary}`);
    }
    rounds += 1;
    if (needsPolling(result?.items) && rounds < 150) setTimeout(() => { void fill(); }, 4000);
  }
  await fill();
}

// 单据池顶上的「模拟来单」：按模板生成一张新的虚构单据，系统自动发起 AI 初审（九安生产上是汇联易同步进来的新单据）
function mountIntakeBar(container, ctx) {
  if (container.querySelector('.poc-intake')) return;
  const { element, button } = ctx.ui;
  const select = element('select', { id: 'poc-intake-template', 'aria-label': '来单模板' }, element('option', { value: '' }, '正在读取模板…'));
  const message = element('p', { class: 'quiet-note', 'aria-live': 'polite' });
  const run = button('模拟来单', () => { void arrive(); }, { primary: true, iconName: 'document' });
  async function arrive() {
    if (!select.value) return;
    run.disabled = true;
    message.textContent = '正在来单…';
    try {
      const result = await ctx.api('/poc/intake', { method: 'POST', body: { template: select.value } });
      ctx.ui.announce(`已来单 ${result.document.number}，系统已自动发起 AI 初审`);
      if (ctx.isCurrent()) ctx.reload();
    } catch (error) {
      if (error.status === 401) { ctx.onAccessLost?.(error); return; }
      message.textContent = ctx.ui.errorMessage(error);
      run.disabled = false;
    }
  }
  const bar = element('section', { class: 'poc-intake note-block', 'aria-label': '模拟来单' },
    element('strong', {}, '模拟来单'),
    element('span', {}, '按模板生成一张新的虚构单据放进单据池，系统自动跑九安预审和 AI 初审，建议出来后直接显示在卡片上，再由人工复核。'),
    element('label', { for: 'poc-intake-template' }, '模板'), select, run, message);
  container.prepend(bar);
  void ctx.api('/poc/intake/templates').then(data => {
    select.replaceChildren(...(data.items ?? []).map(item => element('option', { value: item.number }, `${item.number} · ${item.formName} · ${item.companyName}`)));
  }).catch(error => { message.textContent = ctx.ui.errorMessage(error); });
}

// ---------------------------------------------------------------------------
// 单据详情里的「审批流」卡片
// ---------------------------------------------------------------------------
export function mountApprovalPanel(target, document, ctx) {
  const { element, panel } = ctx.ui;
  const path = `/poc/approvals/${document.id}`;
  // 表单里正在填的内容放在这里：重画卡片（轮询、提交中、报错）时不丢。
  const draft = { decision: null, reason: '', returnNote: null, checkReason: '' };
  let view = null, error = null, busy = false, timer = null, polls = 0, disposed = false;
  const live = () => !disposed && target.isConnected && ctx.isCurrent();
  function settle(next) {
    const before = view?.status;
    view = next;
    if (before !== next.status) Object.assign(draft, { decision: null, reason: '', returnNote: null, checkReason: '' });
    // Agent 建议落定之后，让九安自己的「AI 独立建议」卡片也刷新一次（两者读的是同一份九安记录）。
    if (WORKING.has(before) && !WORKING.has(next.status)) ctx.refreshAnalysis?.();
  }
  function schedule() {
    clearTimeout(timer);
    timer = null;
    if (!live() || !view || !WORKING.has(view.status)) { polls = 0; return; }
    polls += 1;
    const delay = pollDelay(polls);
    if (delay !== null) timer = setTimeout(() => { void refresh(); }, delay);
  }
  async function refresh() {
    if (!live()) return;
    try {
      settle(await ctx.api(path));
      error = null;
    } catch (failure) {
      if (failure.status === 401) { ctx.onAccessLost(failure); return; }
      error = failure;
    }
    render();
    schedule();
  }
  async function act(action, body = {}) {
    if (busy || !live()) return;
    busy = true;
    error = null;
    render();
    try {
      settle(await ctx.api(`${path}/${action}`, { method: 'POST', body: { sourceVersion: document.version, ...body } }));
      ctx.ui.announce(`审批状态：${view.statusLabel}`);
    } catch (failure) {
      if (failure.status === 401) { busy = false; ctx.onAccessLost(failure); return; }
      error = failure;
      try { settle(await ctx.api(path)); } catch { /* 保留上次读到的状态 */ }
    } finally {
      busy = false;
    }
    render();
    schedule();
  }
  function render() {
    if (!live()) return;
    target.replaceChildren(panel('审批流：AI 初审 + 人工复核', 'AI 只给初审建议；通过或退回由人工复核决定。', element('div', { class: 'poc-approval' },
      error ? element('div', { class: 'inline-message error', role: 'alert' }, ctx.ui.errorMessage(error)) : null,
      view ? approvalContent(view, { ctx, busy, act, draft }) : element('p', { class: 'quiet-note' }, '正在读取审批流…'))));
  }
  void refresh();
  return { refresh, dispose() { disposed = true; clearTimeout(timer); } };
}

function approvalContent(view, options) {
  const { ctx } = options;
  const { element, tag } = ctx.ui;
  return [
    element('div', { class: 'poc-approval-head' },
      element('span', { class: 'poc-status', 'data-status': view.status }, tag(view.statusLabel, approvalTone(view.status))),
      view.auto ? tag('来单自动发起', 'blue') : null,
      element('p', {}, nextStepText(view))),
    adviceBlock(view, ctx),
    stepsList(view, ctx),
    view.precheck ? precheckLine(view.precheck, ctx) : null,
    view.status === 'ai_failed' && view.failure ? element('div', { class: 'note-block amber' },
      `${view.failure.stage === 'precheck' ? '九安预审' : 'AI 初审'}未完成（错误码 ${view.failure.errorCode}）。${view.failure.message ?? ''}`) : null,
    decisionSummary(view, ctx),
    actionArea(view, options),
    timelineList(view, ctx),
  ];
}

function nextStepText(view) {
  const acting = (view.actions ?? []).length > 0;
  switch (view.status) {
    case 'not_started': return acting ? '发起后先跑九安预审，再交给 AI 初审（通常 30–60 秒）。新来的单据会自动发起。' : '还没有发起。';
    case 'prechecking': return '九安正在预审：基础检查与规则试跑。';
    case 'ai_running': return 'AI 初审中，通常需要 30–60 秒，完成后这里会自动更新。';
    case 'ai_failed': return (view.timeline ?? []).some(entry => entry.action === 'auto_retry')
      ? '系统已经自动重试过一次。可以再重试，或直接人工复核（不带 AI 初审建议）。' : '可以重试，或直接人工复核（不带 AI 初审建议）。系统会先自动重试一次。';
    case 'pending_review': return acting ? '请结合 AI 初审建议与单据依据做人工复核：通过或退回。' : '等待人工复核。';
    case 'approved': return '审批已结束：已通过。';
    case 'returned': return '审批已结束：已退回。';
    case 'invalidated': return '单据版本已变化，原审批失效，可以重新发起。';
    default: return '';
  }
}

function stepsList(view, ctx) {
  const { element, tag } = ctx.ui;
  return element('ol', { class: 'poc-steps', 'aria-label': '审批步骤' }, view.steps.map(step => {
    const [label, tone] = STEP_STATE[step.state] ?? ['—', ''];
    const working = step.state === 'active' && WORKING.has(view.status);
    return element('li', { class: `poc-step poc-step-${step.state}${working ? ' poc-step-working' : ''}` },
      element('span', { class: 'poc-step-label' }, step.label), tag(label, tone));
  }));
}

function precheckLine(precheck, ctx) {
  const summary = precheck.summary ?? {};
  const counts = byStatus => Object.entries(byStatus ?? {}).map(([status, count]) => `${CHECK_STATUS[status] ?? status} ${count}`).join('、');
  return ctx.ui.element('p', { class: 'quiet-note' },
    `九安预审：基础检查 ${summary.baseChecks ?? 0} 项（${counts(summary.baseByStatus) || '无'}）；规则 ${summary.rules ?? 0} 条${summary.rules ? `（${counts(summary.rulesByStatus)}）` : ''}。`);
}

function adviceBlock(view, ctx) {
  const { element, tag, facts } = ctx.ui;
  const ai = view.ai;
  if (!ai) return null;
  if (ai.skipped) return element('div', { class: 'note-block' }, '已转人工复核：这次没有 AI 初审建议。');
  const advice = ai.advice;
  if (!advice) return null;
  const list = (title, items) => (Array.isArray(items) && items.length
    ? element('div', {}, element('h4', {}, title), element('ul', {}, items.map(item => element('li', {}, item)))) : null);
  const tone = advice.modelRecommendation === 'RETURN_DRAFT' ? 'red' : advice.modelRecommendation === 'PASS_CANDIDATE' ? 'green' : 'amber';
  return element('section', { class: 'poc-advice', 'aria-label': 'AI 初审建议' },
    element('h3', { class: 'poc-advice-title' }, 'AI 初审建议'),
    element('div', { class: 'poc-tags' },
      tag(`AI 初审：${RECOMMENDATION[advice.modelRecommendation] ?? advice.modelRecommendation ?? '—'}`, tone),
      tag(`九安有效结论：${advice.effectiveOutcome === 'ATTENTION' ? '需关注' : '需人工审核'}`, 'blue'),
      tag(`风险：${RISK[advice.riskLevel] ?? '—'}`), tag(`模型自评把握：${CONFIDENCE[advice.confidence] ?? '—'}`)),
    advice.summary ? element('p', { class: 'poc-advice-summary' }, advice.summary) : null,
    list('关键发现', advice.keyFindings), list('需要补充或核实', advice.requiredActions),
    list('尚未解决的问题', advice.unresolvedQuestions), list('冲突与疑点', advice.conflictFlags),
    facts([['发布', ai.publishId || '—'], ['模型', ai.model || '—'], ['用时', seconds(ai.latencyMs)],
      ['生成时间', ai.generatedAt ? ctx.ui.dateText(ai.generatedAt) : '—'], ['是否复用已有建议', ai.reused ? '是（同一单据版本 24 小时内的建议）' : '否']]));
}

function decisionSummary(view, ctx) {
  const { element } = ctx.ui;
  const decision = view.decision;
  if (!decision) return null;
  return element('div', { class: 'note-block' },
    `${decision.by?.name ?? '复核人'}人工复核：${decision.decision === 'approve' ? '通过' : '退回'}${decision.disagreesWithAgent ? '（与 AI 初审建议不一致）' : ''}。`,
    decision.reason ? element('p', {}, `理由：${decision.reason}`) : null,
    decision.returnNote ? element('p', { class: 'poc-pre' }, `退回说明：${decision.returnNote}`) : null);
}

function actionArea(view, options) {
  const { ctx, busy, act } = options;
  const { element, button } = ctx.ui;
  const actions = new Set(view.actions ?? []);
  if (actions.has('decide')) return decisionForm(view, options);
  const buttons = [
    actions.has('start') ? button(view.status === 'invalidated' ? '重新发起 AI 初审' : '发起 AI 初审', () => void act('start'), { primary: true, disabled: busy, iconName: 'agent' }) : null,
    actions.has('retry') ? button('重试 AI', () => void act('retry'), { primary: true, disabled: busy, iconName: 'sync' }) : null,
    actions.has('manual') ? button('人工复核（不带 AI 初审建议）', () => void act('manual'), { disabled: busy }) : null,
  ].filter(Boolean);
  return buttons.length ? element('div', { class: 'poc-actions' }, buttons) : null;
}

function decisionForm(view, { ctx, busy, act, draft }) {
  const { element } = ctx.ui;
  const advice = view.ai?.advice ?? null;
  const choice = value => element('input', { type: 'radio', name: 'poc-decision', value, id: `poc-decision-${value}`, checked: draft.decision === value,
    disabled: busy, on: { change: () => { draft.decision = value; update(); } } });
  const approve = choice('approve'), giveBack = choice('return');
  const reason = element('textarea', { id: 'poc-decision-reason', rows: '3', maxlength: '1000', disabled: busy, on: { input: () => { draft.reason = reason.value; } } });
  reason.value = draft.reason;
  const note = element('textarea', { id: 'poc-return-note', rows: '6', maxlength: '2000', disabled: busy, on: { input: () => { draft.returnNote = note.value; } } });
  note.value = draft.returnNote ?? defaultReturnNote(advice);
  const noteField = element('div', { class: 'field', hidden: draft.decision !== 'return' },
    element('label', { for: 'poc-return-note' }, '退回说明（发给提单人；默认带出 AI 初审列出的待补事项，可修改）'), note);
  const hint = element('p', { class: 'quiet-note', 'aria-live': 'polite' });
  const submit = element('button', { type: 'submit', class: 'button primary', disabled: true }, busy ? '正在提交…' : '提交复核结果');
  function update() {
    noteField.hidden = draft.decision !== 'return';
    hint.textContent = draft.decision && requiresReason(draft.decision, advice?.modelRecommendation) ? '这项决定与 AI 初审建议不一致，请写明理由。' : '';
    submit.disabled = busy || !draft.decision;
  }
  update();
  return element('form', { class: 'poc-decision', on: { submit: event => {
    event.preventDefault();
    if (!draft.decision || busy) return;
    void act('decide', { decision: draft.decision, reason: draft.reason.trim() || undefined, returnNote: draft.decision === 'return' ? note.value : undefined });
  } } },
    element('fieldset', { class: 'poc-choice' }, element('legend', {}, '人工复核'),
      element('label', { for: 'poc-decision-approve' }, approve, '通过'), element('label', { for: 'poc-decision-return' }, giveBack, '退回')),
    element('div', { class: 'field' }, element('label', { for: 'poc-decision-reason' }, '理由（与 AI 初审建议不一致时必填）'), reason),
    noteField, hint, element('div', { class: 'poc-actions' }, submit));
}

function timelineList(view, ctx) {
  const { element } = ctx.ui;
  if (!view.timeline?.length) return null;
  return element('section', { class: 'poc-timeline-section' }, element('h4', {}, '留痕'),
    element('ol', { class: 'poc-timeline' }, view.timeline.map(entry => element('li', {},
      element('div', { class: 'poc-timeline-head' }, element('strong', {}, entry.label), element('span', {}, entry.actor?.name ?? '系统'),
        element('time', {}, ctx.ui.dateText(entry.at))),
      entry.reason ? element('p', {}, `理由：${entry.reason}`) : null,
      entry.note ? element('p', { class: 'poc-pre' }, `退回说明：${entry.note}`) : null,
      entry.summary ? element('p', {}, `建议摘要：${entry.summary}`) : null,
      entry.errorCode ? element('p', {}, `错误码：${entry.errorCode}`) : null,
      element('p', { class: 'poc-trace' }, traceText(entry))))));
}

// ---------------------------------------------------------------------------
// 「Nexus Agent」页：我的 Nexus 连接、我的 Agent（待启用 / 已启用 / 有问题）、我还没发布的 Agent、调用测试、最近的调用记录
// ---------------------------------------------------------------------------
const CONNECTION_STATUS = Object.freeze({ connected: ['已连接', 'green'], not_connected: ['未连接', 'amber'], error: ['连接出错', 'red'] });
const GROUPS = Object.freeze([['pending', '待启用'], ['enabled', '已启用'], ['problem', '有问题']]);

export async function loadNexusAgentsPage(api) {
  const [me, runs, limits] = await Promise.all([api('/poc/nexus/me'), api('/poc/nexus/runs?limit=20'), api('/poc/nexus/attachment-policy')]);
  return { me, runs: Array.isArray(runs?.items) ? runs.items : [], policy: limits?.attachmentPolicy ?? null };
}

/** 有问题的原因（没问题返回 null）：密钥失效、发布没上线或暂停、A2A 没开、名片读不到。断开 Nexus 后仍记着的已启用项（listed=false）不算有问题。 */
export function problemOf(publication) {
  const enablement = publication.enablement;
  if (enablement && enablement.status !== 'active') return '调用密钥失效：在 Nexus「互联中心 › 对外发布」签一把新的，点「换密钥」重新启用。';
  if (publication.listed === false) return null;
  if (publication.status !== 'active') return publication.status === 'paused' ? '发布已暂停：在 Nexus「互联中心 › 对外发布」恢复。' : '发布还没上线。';
  if (publication.a2a?.enabled === false) return '这个发布没有打开 A2A。';
  if (publication.card?.error) return `读不到 A2A 名片（${publication.card.error}）：发布可能暂停了，或者 A2A 没打开。`;
  return null;
}

export function groupPublications(publications = []) {
  const groups = { pending: [], enabled: [], problem: [] };
  for (const publication of publications) {
    if (problemOf(publication)) groups.problem.push(publication);
    else groups[publication.enablement ? 'enabled' : 'pending'].push(publication);
  }
  return groups;
}

/** 调用测试里列哪些：我已启用、没有问题的，加上系统提供的（审批流在用的那个）；能力清单从启用时缓存的取。 */
export function invocable(me) {
  const enabled = groupPublications(me?.publications ?? []).enabled.map(publication => ({ ...publication, canInvoke: true }));
  const system = (me?.system ?? []).filter(item => !enabled.some(publication => publication.publishId === item.publishId))
    .map(item => ({ ...item, displayName: `${item.displayName}（系统提供）`, canInvoke: true }));
  return { callable: [...enabled, ...system], manifests: new Map(enabled.filter(publication => publication.capabilities).map(publication => [publication.publishId, publication.capabilities])) };
}

// 一个请求没结束时，同一区域的按钮都不能点（例如重新验证还没回来就点了停用）。
function poster(ctx, message, controls = () => []) {
  return async (path, body, control) => {
    const all = [control, ...controls()];
    for (const item of all) item.disabled = true;
    message.replaceChildren();
    try {
      await ctx.api(path, { method: 'POST', body });
      if (ctx.isCurrent()) ctx.reload();
    } catch (error) {
      if (error.status === 401) { ctx.onAuthLost(error.message); return; }
      message.replaceChildren(ctx.ui.errorMessage(error));
      for (const item of all) item.disabled = false;
    }
  };
}

export function myConnectionPanel(me, ctx) {
  const { element, tag, panel, facts, button } = ctx.ui;
  const connection = me?.connection ?? { status: 'not_connected' };
  const [label, tone] = CONNECTION_STATUS[connection.status] ?? ['状态未知', ''];
  const message = element('p', { class: 'form-error', role: 'alert' });
  if (connection.status === 'connected' || connection.status === 'error') {
    const post = poster(ctx, message, () => [refresh, disconnect]);
    const refresh = button('刷新', () => { void post('/poc/nexus/me/refresh', {}, refresh); }, { iconName: 'sync' });
    const disconnect = button('断开', () => { void post('/poc/nexus/me/disconnect', { client: 'web' }, disconnect); },
      { quiet: true, title: '只删除应用服务端保存的连接；Nexus 上的 API 密钥请到网页停用' });
    return panel('我的 Nexus 连接', '用你自己的 Nexus 身份列出你的发布；调用用各发布的调用密钥。', element('div', { class: 'poc-connection' },
      element('div', { class: 'poc-tags' }, tag(label, tone)),
      // 暂时读不到列表：连接还在，先刷新重试；已启用的 Agent 照常可以调用。
      connection.status === 'error' ? element('div', { class: 'note-block amber' }, `暂时读不到你的 Nexus 列表（${connection.error ?? '原因未知'}）：点「刷新」重试。已启用的 Agent 照常可以调用。`) : null,
      facts([
        ['Nexus 账号', connection.nexusUser ? `${connection.nexusUser.name ?? '—'}（${connection.nexusUser.role ?? '—'}）` : '—'],
        ['档位', connection.preset ?? '—'],
        ['连接时间', connection.connectedAt ? ctx.ui.dateText(connection.connectedAt) : '—'],
        ['刷新时间', connection.refreshedAt ? ctx.ui.dateText(connection.refreshedAt) : '—'],
      ]),
      message, element('div', { class: 'poc-actions' }, refresh, disconnect)));
  }
  const post = poster(ctx, message);
  const input = element('input', { type: 'password', id: 'poc-me-api-key', autocomplete: 'off', spellcheck: 'false', placeholder: 'nxc_…' });
  const connect = button('连接', () => { void post('/poc/nexus/me/connect', { apiKey: input.value, client: 'web' }, connect); }, { primary: true });
  return panel('我的 Nexus 连接', '连接后，你在 Nexus 上的发布会出现在下面；在 Nexus 新发布的 Agent，刷新后也会出现。', element('div', { class: 'poc-connection' },
    element('div', { class: 'poc-tags' }, tag(label, tone)),
    element('div', { class: 'field' }, element('label', { for: 'poc-me-api-key' }, 'Nexus API 密钥'), input),
    element('p', { class: 'quiet-note' }, '在 Nexus「个人设置 › API 密钥」新建一把，给本应用单独用，只读档位就够了。连接后平台会把这串换新，原来那串作废；随时可以在 Nexus 停用。'),
    message, element('div', { class: 'poc-actions' }, connect)));
}

function cardSummary(card) {
  if (!card) return '—';
  if (card.error) return `读不到（${card.error}）`;
  const modes = inputModeLabels(card.inputModes);
  return `A2A ${card.protocolVersion ?? '—'}${card.streaming ? '，流式' : ''} · 接受 ${modes.length ? modes.join('、') : '文字'}`;
}

export function agentCard(publication, ctx, { group, onTest = () => {} } = {}) {
  const { element, tag, button, facts } = ctx.ui;
  const enablement = publication.enablement;
  const id = publication.publishId;
  const message = element('p', { class: 'form-error', role: 'alert' });
  const post = poster(ctx, message, () => [...actions, submit]);
  const keyId = `poc-key-${id}`, capabilitiesId = `poc-capabilities-${id}`;
  const keyInput = element('input', { type: 'password', id: keyId, autocomplete: 'off', spellcheck: 'false', placeholder: 'nxa_…' });
  const capabilities = element('input', { type: 'checkbox', id: capabilitiesId, checked: true });
  const submit = button(enablement ? '确认换密钥' : '确认启用', () => {
    void post(`/poc/nexus/me/agents/${id}/enable`, { token: keyInput.value, loadCapabilities: capabilities.checked, client: 'web' }, submit);
  }, { primary: true });
  const form = element('div', { class: 'poc-enable-form', hidden: true },
    element('div', { class: 'field' }, element('label', { for: keyId }, '调用密钥（Nexus「互联中心 › 对外发布」签发）'), keyInput),
    element('label', { for: capabilitiesId, class: 'poc-check' }, capabilities, '顺便读一次能力清单（约 0.03 美元）'),
    element('div', { class: 'poc-actions' }, submit, button('取消', () => { form.hidden = true; }, { quiet: true })));
  const open = label => button(label, () => { form.hidden = false; keyInput.focus(); }, { primary: !enablement });
  const reread = button('重新读能力清单', () => { void post(`/poc/nexus/me/agents/${id}/enable`, { loadCapabilities: true, client: 'web' }, reread); },
    { quiet: true, title: '用已保存的调用密钥重新验证，并重新读能力清单（约 0.03 美元）' });
  const disable = button('停用', () => { void post(`/poc/nexus/me/agents/${id}/disable`, { client: 'web' }, disable); }, { quiet: true });
  const actions = group === 'pending' ? [open('启用')]
    : group === 'enabled' ? [button('调用测试', () => onTest(id), { primary: true, iconName: 'agent' }), open('换密钥'), reread, disable]
      : enablement ? [open('换密钥'), disable] : [];
  const tags = [[group === 'enabled' ? '已启用' : group === 'problem' ? '有问题' : '待启用', group === 'enabled' ? 'green' : group === 'problem' ? 'red' : 'amber'],
    publication.listed === false ? ['Nexus 已断开，仍可调用', ''] : null,
    enablement?.versionChanged ? ['Agent 版本有变化，可以重新读能力清单', 'amber'] : null].filter(Boolean);
  return element('article', { class: 'poc-agent-card', 'data-publish-id': id },
    element('h3', {}, publication.displayName),
    element('div', { class: 'poc-tags' }, tags.map(([label, tone]) => tag(label, tone))),
    publication.description ? element('p', { class: 'poc-agent-description' }, publication.description) : null,
    group === 'problem' ? element('div', { class: 'note-block amber' }, problemOf(publication)) : null,
    facts([
      ['发布编号', id],
      ['版本', publication.version == null ? '—' : `${publication.followUpdates ? '跟随最新' : '钉住'} v${publication.version}`],
      ['名片', cardSummary(publication.card)],
      ...(enablement ? [['密钥指纹', enablement.fingerprint ?? '—'], ['验证时间', enablement.verifiedAt ? ctx.ui.dateText(enablement.verifiedAt) : '—'],
        ['能力清单', enablement.capabilitiesVersion ?? '没有读到']] : []),
    ]),
    message, element('div', { class: 'poc-actions' }, actions), form);
}

function myAgentsPanel(me, ctx, onTest) {
  const { element, panel, empty } = ctx.ui;
  const groups = groupPublications(me?.publications ?? []);
  const connected = me?.connection?.status === 'connected';
  const sections = GROUPS.filter(([name]) => groups[name].length).map(([name, title]) => element('section', { class: 'poc-agent-group' },
    element('h4', {}, `${title}（${groups[name].length}）`),
    element('div', { class: 'poc-agent-grid' }, groups[name].map(publication => agentCard(publication, ctx, { group: name, onTest })))));
  const unpublished = me?.unpublished ?? [];
  return panel('我的 Agent', '启用：粘贴这个发布的调用密钥。应用当场验证（不花钱），默认顺便读一次能力清单。', element('div', { class: 'poc-my-agents' },
    ...(sections.length ? sections : [empty(connected ? '你还没有已发布的 Agent' : '先连接 Nexus',
      connected ? '在 Nexus 上发布 Agent 并打开 A2A，再点「刷新」。' : '连接后，这里会列出你在 Nexus 上的发布。', null, 'setup')]),
    unpublished.length ? element('details', { class: 'poc-unpublished' },
      element('summary', {}, `我还没发布的 Agent（${unpublished.length}）：发布并打开 A2A 之后，会出现在上面`),
      element('ul', {}, unpublished.map(agent => element('li', {}, `${agent.name}（${agent.status ?? '—'}，v${agent.version ?? '—'}）`)))) : null));
}

export function nexusAgentsPage(result, ctx) {
  const { element } = ctx.ui;
  const me = result?.me ?? {};
  const runsPanel = createRunsPanel(result?.runs ?? [], ctx);
  const { callable, manifests } = invocable(me);
  const invokePanel = createInvokePanel(callable, ctx, { onFinished: () => runsPanel.reload(), policy: result?.policy ?? null, manifests });
  return element('div', { class: 'poc-agents-page' },
    myConnectionPanel(me, ctx), myAgentsPanel(me, ctx, publishId => invokePanel.select(publishId)), invokePanel.node, runsPanel.node);
}

function createRunsPanel(runs, ctx) {
  const { element, panel, button, tag } = ctx.ui;
  const tbody = element('tbody');
  const detail = element('div', { class: 'poc-result' });
  function rows(items) {
    tbody.replaceChildren(...(items.length ? items.map(run => {
      const view = runView(run);
      return element('tr', {},
        element('td', {}, ctx.ui.dateText(run.startedAt)), element('td', {}, view.source), element('td', {}, run.publishId ?? '—'),
        element('td', {}, view.task), element('td', {}, run.documentNumber ?? '—'), element('td', {}, tag(view.result[0], view.result[1])),
        element('td', {}, view.latency), element('td', {}, view.errorCode), element('td', {}, tag(view.validation[0], view.validation[1])),
        element('td', {}, view.attachments), element('td', {}, view.fenced), element('td', {}, run.hasRawText ? button('查看', () => { void show(run.id); }, { quiet: true }) : '—'));
    }) : [element('tr', {}, element('td', { colspan: '12' }, '还没有调用记录。'))]));
  }
  async function show(runId) {
    try { detail.replaceChildren(...runResult(await ctx.api(`/poc/nexus/runs/${runId}`), ctx)); }
    catch (error) { detail.replaceChildren(element('div', { class: 'inline-message error', role: 'alert' }, ctx.ui.errorMessage(error))); }
  }
  async function reload() {
    try {
      const page = await ctx.api('/poc/nexus/runs?limit=20');
      if (ctx.isCurrent()) rows(page.items ?? []);
    } catch { /* 下次打开本页时再读 */ }
  }
  rows(runs);
  const node = panel('最近的调用记录', '最多保留 50 条，服务重启后清空；审批流和单据详情里的 AI 建议也记在这里。', element('div', {},
    element('div', { class: 'poc-table-wrap' }, element('table', { class: 'poc-runs' },
      element('thead', {}, element('tr', {}, ['时间', '来源', '发布', '任务', '单据', '结果', '用时', '错误码', '九安校验', '附件', '代码围栏', '原始返回']
        .map(label => element('th', { scope: 'col' }, label)))), tbody)),
    detail));
  return { node, reload };
}
