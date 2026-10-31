/**
 * 工作台要的数：测试台外壳 GET /poc/dashboard?window=today|14d|month（poc/app07/dashboard.mjs，结果缓存 60 秒）。
 *   pendingReview { count, failCount }（不按窗口）· advice { completed, pass, fail, overrides, passRate（0–1 或 null）, avgDurationMs, maxDurationMs（null = 没有） }
 *   daily[] { date, pass, fail, running } · overrideRate[] { date, reviews, overrides }（窗口里每个上海日期一项，从早到晚）
 *   topBasis[] { kind: rule|custom|field|evidence, label, count }（同一 kind + label 可能有两行）· topRules[] { ruleId, count }
 *   reviewers[] { account, name, reviews, overrides, customRules }（分析员只有自己一行，规则发布复核人没有行）
 *   knowledge { mode, configured, ready, sources, rules, lastIngestAt } · myRules { files, usedChars, limitChars }
 * 读进来先整理一遍：数不是有限的非负数就当 0，可空的不是数就当 null，数组不是数组就当空——页面上不会出现 NaN（Review Focus 4）。
 */
import { api } from './client';

export type DashboardWindow = 'today' | '14d' | 'month';
export const WINDOW_OPTIONS: Array<{ value: DashboardWindow; label: string }> = [
  { value: 'today', label: '今天' }, { value: '14d', label: '近 14 天' }, { value: 'month', label: '本月' },
];
export const DEFAULT_WINDOW: DashboardWindow = '14d';
export const windowLabel = (window: DashboardWindow) => WINDOW_OPTIONS.find(option => option.value === window)?.label ?? '';
/** 一轮 AI 建议的时限（秒）：九安合同 review_advice@1 的 limits.timeoutMs。 */
export const ADVICE_LIMIT_S = 120;
export const MY_RULES_LIMIT = 5000;

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
  topRules: Array<{ ruleId: string; count: number }>;
  myRules: { files: number; usedChars: number; limitChars: number };
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
    topRules: list(data.topRules).filter(item => text(item.ruleId)).map(item => ({ ruleId: text(item.ruleId), count: count(item.count) })),
    // 合计上限没给就按外壳的 5,000 字（custom-rules.mjs 的 CUSTOM_RULES_LIMITS.chars）
    myRules: { files: count(mine.files), usedChars: count(mine.usedChars), limitChars: count(mine.limitChars) || MY_RULES_LIMIT },
  };
}

export const fetchDashboard = async (window: DashboardWindow) => readDashboard(await api<unknown>(`/poc/dashboard?window=${window}`));
/** all：每个窗口的数（复核成功、发起一轮后整体作废，F3）。 */
export const dashboardKeys = { all: ['dashboard'] as const, window: (window: DashboardWindow) => ['dashboard', window] as const };
