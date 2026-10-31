// 单据池和单据抽屉测试用的假后端：九安的 /documents…、外壳的 /poc/reviews…、/poc/advice-rounds。有状态：提交复核后 latest 跟着变。
// 照真的按登录的人的公司给（九安的单据接口、外壳的新接口都按它，Ruling FR1）：规则发布复核人在九安里没有公司，列表是空的，每张单 404，
// latest 里是 no_advice；latest 对不认识的单据也给 no_advice（外壳 reviews.mjs 就这样）。
// 单据、公司、规则全部虚构（规则编号 R-xx、名字带「虚构」），没有真实制度原文。
import type { Role } from '../api/session';
import { fakeApi, sessionBody, type FakeCall, type FakeReply, type FakeRoute } from './fakeApi';

const API = '/api/analysis/v1';
export const version = (n: number) => String(n % 10).repeat(64);

export interface FakeDoc {
  id: string; number: string; companyId: string; companyName: string; title: string; formName: string; type: string;
  amount: number | string; currency: string; version: string; submittedAt: string; supplier?: string;
}
export type FakeLatest = { state: string; current: { round: number; result: string | null; status: string } | null; review: Record<string, unknown> | null };
export interface FakeDocState {
  doc: FakeDoc;
  advice: Record<string, unknown>;
  latest: FakeLatest;
  rounds: Array<Record<string, unknown>>;
  reviews: Array<Record<string, unknown>>;
  evidence: Record<string, unknown>;
  page: Record<string, unknown>;
  /** 外壳 /poc/evidence-pages 的 files（按页的文字）。 */
  pages: Array<Record<string, unknown>>;
}

const doc = (n: number, companyName: string, title: string, amount: number | string, extra: Partial<FakeDoc> = {}): FakeDoc => ({
  id: `doc-${n}`, number: `DGZF-F07-00${n}`, companyId: `c-${n}`, companyName, title, formName: '对公付款单（虚构）', type: 'corporate_payment',
  amount, currency: 'CNY', version: version(n), submittedAt: '2026-10-29T02:00:00.000Z', supplier: `示例供应商 ${n}（虚构）`, ...extra,
});
export const DOCS: FakeDoc[] = [
  doc(1, '九安', '房租 · 年度框架合同', 36000),
  doc(2, '柯顿', '运维服务费', 128500),
  doc(3, 'O+O', '增值税缴款', '52340.18'),
  doc(4, '新零售', '推广费', 9800),
  { ...doc(5, '九安', '差旅报销', 1200), number: 'CLBX-F07-005', type: 'employee_expense', formName: '差旅报销单（虚构）' },
];

/** 一份完成的 AI 建议（九安 GET /documents/:id/advice 在 Nexus 方式下的样子）。 */
export function adviceOf(d: FakeDoc, over: Record<string, unknown> = {}) {
  return {
    environment: 'prod', tenantId: 'fake-tenant', companyId: d.companyId, documentId: d.id, sourceVersion: d.version, readOnly: true, canApprove: false, canReject: false,
    kind: 'review_advice', applicable: true, status: 'completed', stale: false, result: 'fail', note: '付款金额超过虚构合同约定。', basis: [], basisChanged: false,
    errorCode: null, declinedReason: '', startedAt: '2026-10-30T01:10:19.000Z', finishedAt: '2026-10-30T01:12:00.000Z', canRun: true, ...over,
  };
}
export const FULL_BASIS = [
  { kind: 'rule', ref: 'R-07 虚构付款审批 · 柯顿 · 10–20 万', page: null, note: '适用审批路径：部门负责人 → 财务经理 → 分管副总裁；最终审批人：分管副总裁；核对：付款金额超过虚构合同约定 18,500 元' },
  { kind: 'field', ref: '收款方', page: null, note: '与虚构合同乙方名称不一致' },
  { kind: 'evidence', ref: '虚构合同.pdf', page: 2, note: '第 2 页写的合同金额是 110,000 元' },
  { kind: 'rule', ref: '自定义：运维费须附验收单（虚构）', page: null, note: '原件里没有找到验收单' },
];
export const roundOf = (d: FakeDoc, n: number, over: Record<string, unknown> = {}) => ({
  documentId: d.id, companyId: d.companyId, documentVersion: d.version, round: n, trigger: 'upstream', requestedBy: 'system:pipeline', status: 'completed', result: 'fail',
  basis: [], errorCode: null, startedAt: `2026-10-30T0${n}:00:00.000Z`, finishedAt: `2026-10-30T0${n}:01:41.000Z`, current: false, ...over,
});
export const reviewOf = (d: FakeDoc, round: number, over: Record<string, unknown> = {}) => ({
  id: round * 10, documentId: d.id, documentVersion: d.version, adviceRound: round, aiResult: 'fail', decision: 'adopt', finalResult: 'fail', reason: null, note: null,
  actor: 'u-admin', createdAt: '2026-10-30T01:20:00.000Z', ...over,
});

function evidenceOf(d: FakeDoc, over: Record<string, unknown> = {}) {
  return {
    environment: 'prod', readOnly: true, tenantId: 'fake-tenant', companyId: d.companyId, documentId: d.id, sourceVersion: d.version, status: 'completed', errorCode: null,
    canRun: true, canApprove: false,
    manifest: { items: [
      { id: 'a-1', name: '虚构合同.pdf', metadataState: 'available' },
      { id: 'a-2', name: '虚构发票.pdf', metadataState: 'available' },
      { id: 'a-3', name: '虚构验收单.xlsx', metadataState: 'available' },
    ], historyItems: [] },
    files: [{ attachmentId: 'a-1', status: 'ready', pageCount: 3, recognizedPageCount: 3 }, { attachmentId: 'a-2', status: 'extraction_partial', pageCount: 2, recognizedPageCount: 1 }],
    coverage: { status: 'pending_read', counts: { total: 3, metadataIncomplete: 0, pendingRead: 1, readFailed: 0, extractionInsufficient: 1, ready: 1 } },
    ...over,
  };
}

/** 原件按页的文字（全部虚构；第 3 页故意带尖括号，页面必须当纯文字显示）。 */
export function pagesOf(d: FakeDoc) {
  return [
    { id: 'a-1', name: '虚构合同.pdf', status: 'ready', totalPages: 3, pages: [
      { page: 1, text: `${d.number} 虚构合同 第一页：甲方示例公司，乙方示例供应商。` },
      { page: 2, text: '合同金额 110,000 元（虚构）。\n付款方式：验收后付款。' },
      { page: 3, text: '<b>不是标签</b> 落款（虚构）' },
    ] },
    { id: 'a-2', name: '虚构发票.pdf', status: 'extraction_partial', totalPages: 2, pages: [{ page: 1, text: '' }, { page: 2, text: '虚构发票 128,500.00' }] },
  ];
}

function pageOf(d: FakeDoc) {
  return {
    supported: true, version: d.version, dataAsOf: '2026-10-30 09:00',
    header: { formName: d.formName, dateLabel: '提交日期：', date: '2026-10-29', creatorName: '周宁（虚构）', businessCode: d.number },
    applicant: { name: '周宁（虚构）', employeeId: 'F07-E1101', companyName: `示例${d.companyName}公司（虚构）`, departmentPath: '行政部（虚构）' },
    status: { tone: 'approving', label: '审批中', currentNodeName: '财务经理审批' },
    amounts: { payment: 'CNY 128,500.00', withReceipt: 'CNY 128,500.00' },
    infoFields: [{ label: '事由', value: `${d.title}（虚构）`, longText: true }, { label: '成本中心', value: '信息技术部（虚构）', code: 'D9201-IT', codeStyle: 'suffix' }],
    payment: { count: 1, withReceiptTotal: 'CNY 128,500.00', paymentTotal: 'CNY 128,500.00',
      rows: [{ no: 1, type: '费用', expense: { typeName: '运维服务（虚构）', amount: 'CNY 128,500.00', code: 'E-001', comment: '十月运维（虚构）' }, labels: [] }] },
    timeline: { order: 'desc', items: [
      { tone: 'pending', action: '待审批', nodeName: '财务经理审批', personName: '陈思（虚构）' },
      { tone: 'pass', at: '2026-10-29 10:00', action: '审批通过', nodeName: '部门负责人审批', personName: '冯涛（虚构）', employeeId: 'F07-E1200', note: '同意（虚构）' },
      { tone: 'pass', at: '2026-10-29 09:00', action: '提交', personName: '周宁（虚构）' },
    ] },
  };
}

/** 默认的四种复核状态：1 待复核（AI 不建议通过、带四种依据）、2 已更新（复核过第 1 轮，现在第 2 轮）、3 已复核、4 审核中；5 是差旅报销（不进单据池）。 */
export function defaultStates(docs = DOCS): Map<string, FakeDocState> {
  const states = new Map<string, FakeDocState>();
  for (const d of docs) {
    states.set(d.id, { doc: d, advice: adviceOf(d), latest: { state: 'no_advice', current: null, review: null }, rounds: [], reviews: [], evidence: evidenceOf(d), page: pageOf(d), pages: pagesOf(d) });
  }
  const [d1, d2, d3, d4] = docs;
  const s1 = states.get(d1.id)!;
  s1.advice = adviceOf(d1, { result: 'fail', note: '（含 审核员 的自定义规则）付款金额超过虚构合同约定，收款方也不一致。', basis: FULL_BASIS });
  s1.latest = { state: 'pending', current: { round: 1, result: 'fail', status: 'completed' }, review: null };
  s1.rounds = [roundOf(d1, 1, { current: true })];
  const s2 = states.get(d2.id)!;
  s2.advice = adviceOf(d2, { result: 'pass', note: '虚构合同已涵盖本次付款。', basis: [FULL_BASIS[1]] });
  s2.latest = { state: 'outdated', current: { round: 2, result: 'pass', status: 'completed' }, review: reviewOf(d2, 1) };
  s2.rounds = [roundOf(d2, 2, { result: 'pass', current: true, trigger: 'manual', requestedBy: 'u-admin' }), roundOf(d2, 1)];
  s2.reviews = [reviewOf(d2, 1)];
  const s3 = states.get(d3.id)!;
  s3.advice = adviceOf(d3, { result: 'pass', note: '虚构缴款通知齐全。', basis: [FULL_BASIS[2]] });
  s3.latest = { state: 'reviewed', current: { round: 1, result: 'pass', status: 'completed' }, review: reviewOf(d3, 1, { aiResult: 'pass', finalResult: 'pass' }) };
  s3.rounds = [roundOf(d3, 1, { result: 'pass', current: true })];
  s3.reviews = [reviewOf(d3, 1, { aiResult: 'pass', finalResult: 'pass' })];
  const s4 = states.get(d4.id)!;
  s4.advice = adviceOf(d4, { status: 'running', result: null, finishedAt: null, canRun: false });
  s4.latest = { state: 'running', current: { round: 1, result: null, status: 'running' }, review: null };
  s4.rounds = [roundOf(d4, 1, { status: 'running', result: null, finishedAt: null, current: true })];
  return states;
}

const ok = (data: unknown, status = 200): FakeReply => ({ status, body: { data } });
const refuse = (status: number, code: string, message: string): FakeReply => ({ status, body: { error: { code, message } } });

const NO_ADVICE: FakeLatest = { state: 'no_advice', current: null, review: null };
const NOT_FOUND: FakeReply = { status: 404, body: { error: { code: 'NOT_FOUND', message: '未找到可访问的记录。' } } };

/**
 * 假测试台。overrides 里的路由（「方法 路径」）优先；docs 给单据列表（默认 DOCS）；states 给每张单的状态（默认 defaultStates）。
 * companyIds：这个人能看的公司（不给：规则发布复核人 [] 什么都看不到，别的角色看得到全部虚构公司）；给了也写进会话。
 */
export function fakeBench({ role = 'admin' as Role, docs = DOCS, states = defaultStates(docs), overrides = {} as Record<string, FakeRoute>, companyIds }: {
  role?: Role; docs?: FakeDoc[]; states?: Map<string, FakeDocState>; overrides?: Record<string, FakeRoute>; companyIds?: string[];
} = {}) {
  const scope = companyIds ?? (role === 'policy_reviewer' ? [] : null);
  const mine = (d: FakeDoc) => scope === null || scope.includes(d.companyId);
  const inScope = (id: string | null) => { const s = states.get(id ?? ''); return s && mine(s.doc) ? s : undefined; };
  const list = (call: FakeCall): FakeReply => {
    const params = new URLSearchParams(call.search);
    const q = params.get('q') ?? '', limit = Number(params.get('limit') ?? 25), offset = Number(params.get('offset') ?? 0);
    const hit = docs.filter(d => mine(d) && (!q || d.number.includes(q) || d.companyName.includes(q) || (d.supplier ?? '').includes(q)));
    const items = hit.slice(offset, offset + limit).map(d => ({
      id: d.id, environment: 'prod', tenantId: 'fake-tenant', companyId: d.companyId, companyName: d.companyName, number: d.number, formName: d.formName, type: d.type,
      status: '1003', amount: d.amount, currency: d.currency, version: d.version, submittedAt: d.submittedAt, title: d.title, applicantName: '周宁（虚构）',
      reviewFields: d.supplier ? { supplier: { name: d.supplier } } : {},
    }));
    return ok({ items, total: hit.length, dataAsOf: '2026-10-30T01:00:00.000Z' });
  };
  const latest = (call: FakeCall): FakeReply => {
    const ids = (new URLSearchParams(call.search).get('ids') ?? '').split(',').filter(Boolean);
    if (!ids.length || ids.length > 50) return refuse(400, 'REVIEW_INVALID', '复核状态一次查 1 到 50 张单据（ids 用逗号分开）：请减少单据数后重试。');
    return ok({ items: Object.fromEntries(ids.map(id => [id, inScope(id)?.latest ?? NO_ADVICE])) });
  };
  const addReview = (call: FakeCall): FakeReply => {
    if (role === 'policy_reviewer') return refuse(403, 'REVIEW_FORBIDDEN', '只有管理员和分析员能复核 AI 建议（规则发布复核人只能查看）：要复核请换管理员或分析员账号登录。');
    const body = call.body as { documentId: string; sourceVersion: string; round: number; decision: string; reason?: string; note?: string };
    const s = inScope(body.documentId);
    if (!s) return refuse(404, 'REVIEW_NOT_FOUND', '找不到这张单据：刷新单据池后再试。');
    if (body.sourceVersion !== s.doc.version || body.round !== s.latest.current?.round) return refuse(409, 'REVIEW_STALE', '这张单的 AI 建议刚更新，请先看新的建议。');
    const aiResult = s.latest.current!.result!;
    const finalResult = body.decision === 'adopt' ? aiResult : aiResult === 'pass' ? 'fail' : 'pass';
    const review = { id: 100 + s.reviews.length, documentId: s.doc.id, documentVersion: s.doc.version, adviceRound: body.round, aiResult, decision: body.decision, finalResult,
      reason: body.reason ?? null, note: body.note ?? null, actor: `u-${role}`, createdAt: '2026-10-30T02:00:00.000Z' };
    s.reviews = [review, ...s.reviews];
    s.latest = { ...s.latest, state: 'reviewed', review };
    return ok({ review }, 201);
  };
  const routes: Record<string, FakeRoute> = {
    'GET /api/analysis/v1/session': { body: sessionBody(role, 'csrf-1', companyIds) },
    [`GET ${API}/documents`]: list,
    [`GET ${API}/poc/reviews/latest`]: latest,
    [`POST ${API}/poc/reviews`]: addReview,
    [`GET ${API}/poc/reviews`]: call => {
      const s = inScope(new URLSearchParams(call.search).get('documentId'));
      return s ? ok({ items: s.reviews }) : refuse(404, 'REVIEW_NOT_FOUND', '找不到这张单据：刷新单据池后再试。');
    },
    [`GET ${API}/poc/evidence-pages`]: call => {
      const s = inScope(new URLSearchParams(call.search).get('documentId'));
      return s ? ok({ documentId: s.doc.id, documentVersion: s.doc.version, files: s.pages }) : refuse(404, 'EVIDENCE_PAGES_NOT_FOUND', '找不到这张单据：刷新单据池后再试。');
    },
    [`GET ${API}/poc/advice-rounds`]: call => {
      const s = inScope(new URLSearchParams(call.search).get('documentId'));
      return s ? ok({ documentId: s.doc.id, documentVersion: s.doc.version, items: s.rounds }) : refuse(404, 'ADVICE_ROUNDS_NOT_FOUND', '找不到这张单据：刷新单据池后再试。');
    },
  };
  for (const [id, s] of states) {
    const base = `${API}/documents/${id}`;
    // 九安：不在这个人公司里的单据，每个接口都是 404
    if (!mine(s.doc)) {
      for (const route of [`GET ${base}`, `GET ${base}/page`, `GET ${base}/advice`, `POST ${base}/advice`, `GET ${base}/evidence`, `POST ${base}/evidence/read`]) routes[route] = NOT_FOUND;
      continue;
    }
    routes[`GET ${base}`] = () => ok({ ...s.doc, sourceForm: { header: { title: s.doc.title } }, reviewFields: {} });
    routes[`GET ${base}/page`] = () => ok(s.page);
    routes[`GET ${base}/advice`] = () => ok(s.advice);
    routes[`POST ${base}/advice`] = call => {
      if ((call.body as { sourceVersion?: string })?.sourceVersion !== s.doc.version) return refuse(409, 'ANALYSIS_SOURCE_CHANGED', '单据已更新，请刷新后再发起。');
      s.advice = { ...s.advice, status: 'running', result: null, basis: [], note: '', finishedAt: null, canRun: false };
      s.latest = { ...s.latest, state: 'running', current: { round: (s.latest.current?.round ?? 0) + 1, result: null, status: 'running' } };
      return ok(s.advice, 202);
    };
    routes[`GET ${base}/evidence`] = () => ok(s.evidence);
    routes[`POST ${base}/evidence/read`] = call => {
      if ((call.body as { sourceVersion?: string })?.sourceVersion !== s.doc.version) return refuse(409, 'ANALYSIS_SOURCE_CHANGED', '单据已更新，请刷新后再读取。');
      s.evidence = { ...s.evidence, status: 'running', canRun: false };
      return ok(s.evidence, 202);
    };
  }
  Object.assign(routes, overrides);
  const server = fakeApi(routes);
  return { ...server, states, docs };
}

/** 一个先不回答的请求：resolve(reply) 时才回。用来测「请求还在路上时换了单」。 */
export function deferred() {
  let resolve!: (reply: FakeReply) => void;
  const promise = new Promise<FakeReply>(done => { resolve = done; });
  return { route: () => promise, resolve };
}
