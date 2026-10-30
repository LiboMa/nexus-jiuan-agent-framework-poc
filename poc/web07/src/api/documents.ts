/**
 * 单据池与单据抽屉要的接口。请求与返回的字段照九安旧页面的用法（public/document-list.js、analysis.js、document-page.js）：
 *   九安  GET /documents?q&limit&offset（公司单据；每页最多 50 张；接口不按类型筛，这里只留对公付款单）
 *         GET /documents/:id · /documents/:id/page（1:1 单据页模型）
 *         GET|POST /documents/:id/advice（Nexus 方式：review_advice 的当前一轮；POST {sourceVersion} = 手动发起）
 *         GET /documents/:id/evidence · POST /documents/:id/evidence/read {sourceVersion}
 *   外壳  GET /poc/reviews/latest?ids=（≤ 50 张）· GET|POST /poc/reviews · GET /poc/advice-rounds?documentId=
 */
import { api } from './client';
import type { Tone } from '../ui/Pill';

// ---- 单据 ----

export interface DocumentItem {
  id: string; number?: string | null; companyId?: string; companyName?: string | null; formName?: string | null; title?: string | null;
  type?: string | null; amount?: number | string | null; currency?: string | null; version: string; submittedAt?: string | null;
  reviewFields?: { supplier?: { name?: string | null } | null; expenseType?: string | null } | null;
  sourceForm?: { header?: { title?: string | null } | null } | null;
}
export const CORPORATE_PAYMENT = 'corporate_payment';
/** 单据池最多读这么多张对公付款单（Ruling T5d）；九安每页最多 50 张。 */
export const POOL_MAX = 500;
export const LIST_PAGE = 50;
/** 夹着别的类型时最多翻这么多张，免得一直翻下去。 */
const SCAN_MAX = 2000;
const DOCUMENT_ID = /^[a-zA-Z0-9_-]{1,160}$/;
export const isDocumentId = (id: unknown): id is string => typeof id === 'string' && DOCUMENT_ID.test(id);
const enc = encodeURIComponent;

/** 当前搜索下的对公付款单，按九安的顺序（最近收到的在前）；capped = 后面还有没读的。 */
export async function loadPool(q: string): Promise<{ items: DocumentItem[]; capped: boolean }> {
  const found = new Map<string, DocumentItem>();
  let offset = 0, more = true;
  while (more && found.size < POOL_MAX && offset < SCAN_MAX) {
    const params = new URLSearchParams({ ...(q ? { q } : {}), limit: String(LIST_PAGE), offset: String(offset) });
    const page = await api<{ items?: DocumentItem[]; total?: number }>(`/documents?${params}`);
    const rows = Array.isArray(page?.items) ? page.items : [];
    for (const row of rows) if (row?.type === CORPORATE_PAYMENT && isDocumentId(row.id) && !found.has(row.id)) found.set(row.id, row);
    offset += LIST_PAGE;
    more = rows.length === LIST_PAGE && !(typeof page?.total === 'number' && offset >= page.total);
  }
  const items = [...found.values()];
  return { items: items.slice(0, POOL_MAX), capped: more || items.length > POOL_MAX };
}

export const fetchDocument = (id: string) => api<DocumentItem>(`/documents/${enc(id)}`);

// ---- 复核状态（外壳 reviews.mjs）----

export type ReviewState = 'no_advice' | 'running' | 'pending' | 'reviewed' | 'outdated';
export type AiResult = 'pass' | 'fail';
export interface Review {
  id: number; documentId: string; documentVersion: string; adviceRound: number; aiResult: AiResult; decision: 'adopt' | 'override';
  finalResult: AiResult; reason: string | null; note: string | null; actor: string; createdAt: string;
}
export interface LatestState {
  state: ReviewState;
  current: { round: number; result: AiResult | null; status: string } | null;
  review: Review | null;
}
const LATEST_CHUNK = 50;

/** 一批单据的复核状态：每次最多 50 张（外壳的上限），并发问完再合起来。 */
export async function loadStates(ids: string[]): Promise<Record<string, LatestState>> {
  const chunks: string[][] = [];
  for (let at = 0; at < ids.length; at += LATEST_CHUNK) chunks.push(ids.slice(at, at + LATEST_CHUNK));
  const answers = await Promise.all(chunks.map(chunk => api<{ items?: Record<string, LatestState> }>(`/poc/reviews/latest?ids=${chunk.map(enc).join(',')}`)));
  return Object.assign({}, ...answers.map(answer => answer?.items ?? {}));
}
export const fetchLatest = async (id: string): Promise<LatestState | null> => (await loadStates([id]))[id] ?? null;
export const fetchReviews = (id: string) => api<{ items: Review[] }>(`/poc/reviews?documentId=${enc(id)}`);

/** 改判原因（Spec 第 9 节）：按 AI 的结论分方向；和外壳 reviews.mjs 的 OVERRIDE_REASONS 一模一样（有测试钉住）。 */
export const OVERRIDE_REASONS = {
  fail: ['contract_covers', 'evidence_complete', 'amount_ok', 'rule_not_applicable', 'other'],
  pass: ['evidence_missing', 'amount_mismatch', 'payee_mismatch', 'rule_not_applicable', 'other'],
} as const satisfies Record<AiResult, readonly string[]>;
export type OverrideReason = (typeof OVERRIDE_REASONS)[AiResult][number];
export const REASON_LABELS: Record<OverrideReason, string> = {
  contract_covers: '合同或补充协议已涵盖', evidence_complete: '原件齐全 AI 没识别', amount_ok: '金额核对无误', rule_not_applicable: '适用规则不对',
  evidence_missing: '原件缺失或不符', amount_mismatch: '金额不符', payee_mismatch: '收款方不符', other: '其他',
};
export const NOTE_MAX = 200;

export interface ReviewInput { documentId: string; sourceVersion: string; round: number; decision: 'adopt' | 'override'; reason?: OverrideReason; note?: string }
export const submitReview = (input: ReviewInput) => api<{ review: Review }>('/poc/reviews', { method: 'POST', body: input });

// ---- AI 建议（九安 reviewAdviceData）----

export type AdviceStatus = 'unsupported' | 'not_run' | 'running' | 'completed' | 'failed' | 'declined' | 'unavailable';
export interface BasisItem { kind: 'rule' | 'field' | 'evidence' | string; ref: string; page?: number | null; note?: string }
export interface Advice {
  documentId?: string; sourceVersion?: string; kind?: string; applicable?: boolean; status: AdviceStatus | string; stale?: boolean;
  result: AiResult | null; note?: string; basis?: BasisItem[]; basisChanged?: boolean; errorCode?: string | null; declinedReason?: string;
  startedAt?: string | null; finishedAt?: string | null; canRun?: boolean;
}
/** 进行中时每 3 秒看一次（Ruling：轮询 3 s，停在结果上）。 */
export const ADVICE_POLL_MS = 3000;
export const fetchAdvice = (id: string) => api<Advice>(`/documents/${enc(id)}/advice`);
export const startAdvice = (id: string, sourceVersion: string) => api<Advice>(`/documents/${enc(id)}/advice`, { method: 'POST', body: { sourceVersion } });

const CUSTOM_PREFIX = '自定义：';
/** 依据的标签：ref 以「自定义：」开头的规则 → 我的规则（标题是前缀后面的）；别的规则 → 公司制度；字段 → 单据字段；原件 → 原件。 */
export function basisTag(item: Pick<BasisItem, 'kind' | 'ref'>): { label: string; tone: Tone; title: string } {
  const ref = typeof item.ref === 'string' ? item.ref.trim() : '';
  if (item.kind === 'rule' && ref.startsWith(CUSTOM_PREFIX)) return { label: '我的规则', tone: 'own', title: ref.slice(CUSTOM_PREFIX.length).trim() || ref };
  if (item.kind === 'rule') return { label: '公司制度', tone: 'info', title: ref };
  if (item.kind === 'field') return { label: '单据字段', tone: 'neutral', title: ref };
  return { label: '原件', tone: 'neutral', title: ref };
}
const CUSTOM_NOTE = /^（含\s*(.+?)\s*的自定义规则）/u;
/** AI 的说明以「（含 X 的自定义规则）」开头时（提示词的写法）回 X。 */
export function customRulesOwner(note: string | undefined | null): string | null {
  return typeof note === 'string' ? CUSTOM_NOTE.exec(note)?.[1] ?? null : null;
}
export const stripCustomRulesNote = (note: string) => note.replace(CUSTOM_NOTE, '').trim();

// ---- 原件（九安 analysis-evidence-service 的 project）----

export interface Evidence {
  status: string; errorCode?: string | null; canRun?: boolean; sourceVersion?: string;
  manifest?: { items?: Array<{ id: string; name?: string; metadataState?: string }>; historyItems?: unknown[] } | null;
  files?: Array<{ attachmentId: string; status: string; pageCount?: number | null; recognizedPageCount?: number | null }>;
  coverage?: { status?: string; counts?: Record<string, number> } | null;
}
export const fetchEvidence = (id: string) => api<Evidence>(`/documents/${enc(id)}/evidence`);
export const readEvidence = (id: string, sourceVersion: string) => api<Evidence>(`/documents/${enc(id)}/evidence/read`, { method: 'POST', body: { sourceVersion } });

// ---- 单据页模型（九安 document-page-model：值都已格式化好）----

export interface PageModel {
  supported?: boolean; version?: string; dataAsOf?: string;
  header?: { formName?: string; dateLabel?: string; date?: string; creatorName?: string; businessCode?: string };
  applicant?: { name?: string; employeeId?: string; companyName?: string; departmentPath?: string };
  status?: { tone?: string; label?: string; currentNodeName?: string };
  amounts?: { payment?: string; withReceipt?: string };
  infoFields?: Array<{ label: string; value: string; code?: string; codeStyle?: string; longText?: boolean }>;
  payment?: { count?: number; withReceiptTotal?: string; paymentTotal?: string;
    rows?: Array<{ no?: number; type?: string; expense?: { typeName?: string; amount?: string; code?: string; comment?: string }; labels?: string[] }> };
  timeline?: { items?: Array<{ tone?: string; at?: string; action?: string; nodeName?: string; personName?: string; employeeId?: string; note?: string }> };
}
export const fetchPage = (id: string) => api<PageModel>(`/documents/${enc(id)}/page`);

// ---- AI 建议的各轮（外壳 advice-rounds.mjs）----

export interface AdviceRound {
  documentId: string; documentVersion: string | null; round: number | null; trigger: string | null; requestedBy: string | null; status: string | null;
  result: AiResult | null; basis: BasisItem[]; errorCode: string | null; startedAt: string | null; finishedAt: string | null; current: boolean;
}
export const fetchRounds = (id: string) => api<{ documentId: string; documentVersion: string; items: AdviceRound[] }>(`/poc/advice-rounds?documentId=${enc(id)}`);

// ---- 查询键：同一张单的几份数据各自缓存，复核后按前缀一起刷新 ----

export const keys = {
  pool: (q: string) => ['documents', 'pool', q] as const,
  poolStates: (ids: string[]) => ['reviews', 'latest', 'pool', ids.join(',')] as const,
  latest: (id: string) => ['reviews', 'latest', 'one', id] as const,
  reviews: (id: string) => ['reviews', 'history', id] as const,
  document: (id: string) => ['document', id] as const,
  advice: (id: string) => ['advice', id] as const,
  evidence: (id: string) => ['evidence', id] as const,
  page: (id: string) => ['document-page', id] as const,
  rounds: (id: string) => ['advice-rounds', id] as const,
};

// ---- 格式 ----

/** 金额照九安 amountText：千分位、两位小数；人民币写 ¥。 */
export function amountText(amount: unknown, currency?: string | null): string {
  const raw = typeof amount === 'number' && Number.isFinite(amount) ? String(amount) : typeof amount === 'string' ? amount.trim() : '';
  if (!/^-?\d+(?:\.\d+)?$/.test(raw) || raw.length > 40) return '金额未读到';
  const [whole, decimal = ''] = raw.split('.');
  const grouped = whole.replace(/^(-?)0+(?=\d)/, '$1').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const value = `${grouped}.${decimal.padEnd(2, '0')}`;
  const code = typeof currency === 'string' && /^[A-Z]{3}$/.test(currency) ? currency : 'CNY';
  return code === 'CNY' ? `¥${value}` : `${code} ${value}`;
}

const SHANGHAI = 'Asia/Shanghai';
const parts = (at: string, withTime: boolean) => {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  const pick = Object.fromEntries(new Intl.DateTimeFormat('zh-CN', { timeZone: SHANGHAI, month: '2-digit', day: '2-digit', ...(withTime ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } : {}) })
    .formatToParts(date).map(part => [part.type, part.value]));
  return pick as Record<string, string>;
};
/** 北京时间「10-29」。 */
export function dayText(at: string | null | undefined): string {
  const p = at ? parts(at, false) : null;
  return p ? `${p.month}-${p.day}` : '—';
}
/** 北京时间「10-30 09:12」。 */
export function timeText(at: string | null | undefined): string {
  const p = at ? parts(at, true) : null;
  return p ? `${p.month}-${p.day} ${p.hour}:${p.minute}` : '—';
}
/** 用时（秒）；读不出回 null。 */
export function secondsBetween(from: string | null | undefined, to: string | null | undefined): number | null {
  const a = from ? Date.parse(from) : NaN, b = to ? Date.parse(to) : NaN;
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? Math.round((b - a) / 1000) : null;
}

/** 表格的「事项」：表单自己的事由，没有就费用类型、表单名。 */
export function itemText(item: DocumentItem): string {
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : '');
  return text(item.title) || text(item.sourceForm?.header?.title) || text(item.reviewFields?.expenseType) || text(item.formName) || '—';
}
