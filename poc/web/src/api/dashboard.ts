/**
 * 工作台要的数：测试台外壳 GET /poc/dashboard?window=today|14d|month（poc/app/dashboard.mjs，结果缓存 60 秒）。
 *   pendingReview { count, failCount }（不按窗口）· advice { completed, pass, fail, overrides, passRate（0–1 或 null）, avgDurationMs, maxDurationMs（null = 没有） }
 *   daily[] { date, pass, fail, running } · overrideRate[] { date, reviews, overrides }（窗口里每个上海日期一项，从早到晚）
 *   topBasis[] { kind: rule|custom|field|evidence, label, count }（同一 kind + label 可能有两行）· topRules[] { ruleId, count, detail? }
 *   reviewers[] { account, name, reviews, overrides, customRules }（分析员只有自己一行，规则发布复核人没有行）
 *   knowledge { mode, configured, ready, sources, rules, lastIngestAt } · myRules { files, usedChars, limitChars（null：合计字数不设上限） }
 * 读进来先整理一遍：数不是有限的非负数就当 0，可空的不是数就当 null，数组不是数组就当空——页面上不会出现 NaN（Review Focus 4）。
 */
import { api } from './client';

export type DashboardWindow = 'today' | '14d' | 'month';
export const WINDOW_OPTIONS: Array<{ value: DashboardWindow; label: string }> = [
  { value: 'today', label: '今天' }, { value: '14d', label: '近 14 天' }, { value: 'month', label: '本月' },
];
export const DEFAULT_WINDOW: DashboardWindow = '14d';
export const windowLabel = (window: DashboardWindow) => WINDOW_OPTIONS.find(option => option.value === window)?.label ?? '';
/** 一轮 AI 建议的时限（秒）：九安合同 review_advice@1 的 limits.timeoutMs（测试台补丁 0006 起 180000）。 */
export const ADVICE_LIMIT_S = 180;
/** 九安单次请求的大小上限（review_advice@1 的 limits.maxRequestChars，字数）：「我的规则」加上单据放不进去，那一轮就不发（外壳的 CUSTOM_RULES_TOO_LONG）。 */
export const ADVICE_MAX_REQUEST_CHARS = 87_442;
/** 页面上的说法：约 8.7 万字。 */
export const ADVICE_REQUEST_LIMIT_TEXT = `约 ${(ADVICE_MAX_REQUEST_CHARS / 10_000).toFixed(1)} 万字`;

export type BasisKind = 'rule' | 'custom' | 'field' | 'evidence';
export interface DailyAdvice { date: string; pass: number; fail: number; running: number }
export interface DailyRate { date: string; reviews: number; overrides: number }
export interface ReviewerRow { account: string; name: string; reviews: number; overrides: number; customRules: number }
export interface Dashboard {
  window: DashboardWindow | string;
  pendingReview: { count: number; failCount: number };
  advice: { completed: number; pass: number; fail: number; overrides: number; passRate: number | null; avgDurationMs: number | null; maxDurationMs: number | null };
  daily: DailyAdvice[];
  topBasis: Array<{ kind: BasisKind | string; label: string; count: number }>;
  overrideRate: DailyRate[];
  reviewers: ReviewerRow[];
  knowledge: { mode: string; configured: boolean; ready: boolean; sources: number; rules: number; lastIngestAt: string | null };
  /** detail：按条入库的规则（如风险判断卡）编号后面的文字——卡片编号、费用类型、审核线。 */
  topRules: Array<{ ruleId: string; count: number; detail?: string }>;
  /** limitChars：外壳回 null——「我的规则」合计字数不设上限，只受九安单次请求大小的限制（poc/app/custom-rules.mjs）。 */
  myRules: { files: number; usedChars: number; limitChars: number | null };
}

type Loose = Record<string, unknown>;
const obj = (value: unknown): Loose => (value && typeof value === 'object' && !Array.isArray(value) ? value as Loose : {});
const list = (value: unknown): Loose[] => (Array.isArray(value) ? value.map(obj) : []);
/** 有限的非负数，否则 0。 */
const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);
/** 有限的非负数，否则 null。 */
const maybe = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 把接口给的数整理成页面放心用的样子。 */
export function readDashboard(raw: unknown): Dashboard {
  const data = obj(raw), pending = obj(data.pendingReview), advice = obj(data.advice), knowledge = obj(data.knowledge), mine = obj(data.myRules);
  const rate = maybe(advice.passRate);
  return {
    window: text(data.window),
    pendingReview: { count: count(pending.count), failCount: count(pending.failCount) },
    advice: {
      completed: count(advice.completed), pass: count(advice.pass), fail: count(advice.fail), overrides: count(advice.overrides),
      passRate: rate !== null && rate <= 1 ? rate : null, avgDurationMs: maybe(advice.avgDurationMs), maxDurationMs: maybe(advice.maxDurationMs),
    },
    daily: list(data.daily).filter(day => DATE.test(text(day.date))).map(day => ({ date: text(day.date), pass: count(day.pass), fail: count(day.fail), running: count(day.running) })),
    topBasis: list(data.topBasis).filter(item => text(item.label)).map(item => ({ kind: text(item.kind), label: text(item.label), count: count(item.count) })),
    overrideRate: list(data.overrideRate).filter(day => DATE.test(text(day.date)))
      .map(day => ({ date: text(day.date), reviews: count(day.reviews), overrides: Math.min(count(day.overrides), count(day.reviews)) })),
    reviewers: list(data.reviewers).filter(row => text(row.account) || text(row.name))
      .map(row => ({ account: text(row.account), name: text(row.name) || text(row.account), reviews: count(row.reviews), overrides: count(row.overrides), customRules: count(row.customRules) })),
    knowledge: {
      mode: text(knowledge.mode), configured: knowledge.configured === true, ready: knowledge.ready === true,
      sources: count(knowledge.sources), rules: count(knowledge.rules), lastIngestAt: text(knowledge.lastIngestAt) || null,
    },
    topRules: list(data.topRules).filter(item => text(item.ruleId)).map(item => ({ ruleId: text(item.ruleId), count: count(item.count), ...(text(item.detail) ? { detail: text(item.detail) } : {}) })),
    myRules: { files: count(mine.files), usedChars: count(mine.usedChars), limitChars: maybe(mine.limitChars) },
  };
}

export const fetchDashboard = async (window: DashboardWindow) => readDashboard(await api<unknown>(`/poc/dashboard?window=${window}`));
/** all：每个窗口的数（复核成功、发起一轮后整体作废，F3）。 */
export const dashboardKeys = { all: ['dashboard'] as const, window: (window: DashboardWindow) => ['dashboard', window] as const };
