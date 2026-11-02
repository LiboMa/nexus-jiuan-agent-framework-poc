// 工作台测试用的假测试台：外壳的 GET /poc/dashboard?window=…（poc/app/dashboard.mjs），按窗口给一份；「上传制度」要的 /poc/kb/* 借 knowledgeFake。
// 数全部虚构（账号、名字带「虚构」，规则编号照知识库的写法 C05-2.3 等），没有真实制度原文。
import type { Role } from '../api/session';
import { fakeKb, type KbOptions } from './knowledgeFake';
import type { FakeRoute } from './fakeApi';

export const DASHBOARD = '/api/analysis/v1/poc/dashboard';
type Window = 'today' | '14d' | 'month';

export interface FakeDashboard {
  window: Window; from: string; to: string;
  pendingReview: { count: number; failCount: number };
  advice: { completed: number; pass: number; fail: number; overrides: number; passRate: number | null; avgDurationMs: number | null; maxDurationMs: number | null };
  daily: Array<{ date: string; pass: number; fail: number; running: number }>;
  topBasis: Array<{ kind: string; label: string; count: number }>;
  overrideRate: Array<{ date: string; reviews: number; overrides: number }>;
  reviewers: Array<{ account: string; name: string; reviews: number; overrides: number; customRules: number }>;
  knowledge: { mode: string; configured: boolean; ready: boolean; sources: number; rules: number; lastIngestAt: string | null };
  topRules: Array<{ ruleId: string; count: number; detail?: string }>;
  myRules: { files: number; usedChars: number; limitChars: number | null };
}

/** 从 first 起 n 个上海日期（YYYY-MM-DD）。 */
export function days(first: string, n: number): string[] {
  const start = Date.parse(`${first}T00:00:00.000Z`);
  return Array.from({ length: n }, (_, i) => new Date(start + i * 86_400_000).toISOString().slice(0, 10));
}
const D14 = days('2026-10-17', 14);

// 每天的 AI 建议（照样稿的形状）：最后一天有一张审核中
const DAILY_14: Array<[number, number, number]> = [
  [17, 7, 0], [20, 6, 0], [12, 4, 0], [14, 3, 0], [11, 4, 0], [3, 1, 0], [5, 1, 0],
  [18, 3, 0], [24, 3, 0], [12, 5, 0], [12, 3, 0], [23, 3, 0], [3, 1, 0], [2, 1, 1],
];
// 人工改判：10-22、10-23、10-29 没有复核（线断开）；10-30 复核 16 张、改判 1 张 → 6.3%
const RATE_14: Array<[number, number]> = [
  [16, 1], [20, 1], [21, 1], [24, 1], [18, 1], [0, 0], [0, 0], [26, 1], [23, 1], [32, 1], [28, 1], [35, 1], [0, 0], [16, 1],
];
export const LONG_RULE = `C99 虚构的一条很长很长的规则依据${'甲'.repeat(44)}`;

export function fortnight(): FakeDashboard {
  return {
    window: '14d', from: '2026-10-16T16:00:00.000Z', to: '2026-10-30T04:00:00.000Z',
    pendingReview: { count: 7, failCount: 2 },
    advice: { completed: 221, pass: 176, fail: 45, overrides: 11, passRate: 176 / 221, avgDurationMs: 82_400, maxDurationMs: 101_000 },
    daily: D14.map((date, i) => ({ date, pass: DAILY_14[i][0], fail: DAILY_14[i][1], running: DAILY_14[i][2] })),
    topBasis: [
      { kind: 'rule', label: 'C05-2.3', count: 14 },
      { kind: 'field', label: '收款方', count: 10 },
      { kind: 'evidence', label: '虚构合同.pdf', count: 8 },
      { kind: 'custom', label: '运维费须附验收单（虚构）', count: 5 },
      // 截到 60 字后一样的两组（外壳各算各的，T7c）
      { kind: 'rule', label: LONG_RULE, count: 3 },
      { kind: 'rule', label: LONG_RULE, count: 3 },
    ],
    overrideRate: D14.map((date, i) => ({ date, reviews: RATE_14[i][0], overrides: RATE_14[i][1] })),
    reviewers: [
      { account: 'u-admin', name: '审核员', reviews: 86, overrides: 3, customRules: 2 },
      { account: 'poc-checker', name: '复核人（虚构）', reviews: 64, overrides: 4, customRules: 1 },
      { account: 'li-hang', name: '李航（虚构）', reviews: 48, overrides: 1, customRules: 0 },
      { account: 'wang-yue', name: '王悦（虚构）', reviews: 0, overrides: 0, customRules: 3 },
    ],
    knowledge: { mode: 'pg', configured: true, ready: true, sources: 3, rules: 1102, lastIngestAt: '2026-10-30T02:00:00.000Z' },
    topRules: [
      { ruleId: 'C05-2.3', count: 31 }, { ruleId: 'C05-3.4', count: 18 }, { ruleId: 'C07-7.11', count: 9 }, { ruleId: 'G-01', count: 4 }, { ruleId: 'C05-NOTE', count: 2 },
    ],
    myRules: { files: 2, usedChars: 1320, limitChars: null },
  };
}

export function today(): FakeDashboard {
  return {
    ...fortnight(), window: 'today', from: '2026-10-29T16:00:00.000Z',
    pendingReview: { count: 7, failCount: 2 },
    advice: { completed: 3, pass: 2, fail: 1, overrides: 1, passRate: 2 / 3, avgDurationMs: 41_000, maxDurationMs: 60_000 },
    daily: [{ date: '2026-10-30', pass: 2, fail: 1, running: 1 }],
    overrideRate: [{ date: '2026-10-30', reviews: 16, overrides: 1 }],
    topBasis: [{ kind: 'rule', label: 'C05-2.3', count: 1 }],
    topRules: [{ ruleId: 'C05-2.3', count: 2 }],
  };
}

export function month(): FakeDashboard {
  const dates = days('2026-10-01', 30);
  return {
    ...fortnight(), window: 'month', from: '2026-09-30T16:00:00.000Z',
    advice: { completed: 400, pass: 300, fail: 100, overrides: 20, passRate: 0.75, avgDurationMs: 80_000, maxDurationMs: 119_000 },
    daily: dates.map((date, i) => ({ date, pass: 10, fail: 3 + (i % 2), running: 0 })),
    overrideRate: dates.map(date => ({ date, reviews: 10, overrides: 1 })),
  };
}

/** Review Focus 4：什么数都没有（照 app dashboard.test.mjs 的样子）。 */
export function empty(window: Window = '14d'): FakeDashboard {
  const dates = window === 'today' ? ['2026-10-30'] : window === '14d' ? D14 : days('2026-10-01', 30);
  return {
    window, from: '2026-10-16T16:00:00.000Z', to: '2026-10-30T04:00:00.000Z',
    pendingReview: { count: 0, failCount: 0 },
    advice: { completed: 0, pass: 0, fail: 0, overrides: 0, passRate: null, avgDurationMs: null, maxDurationMs: null },
    daily: dates.map(date => ({ date, pass: 0, fail: 0, running: 0 })),
    topBasis: [],
    overrideRate: dates.map(date => ({ date, reviews: 0, overrides: 0 })),
    reviewers: [{ account: 'u-admin', name: '审核员', reviews: 0, overrides: 0, customRules: 0 }, { account: 'poc-checker', name: '复核人（虚构）', reviews: 0, overrides: 0, customRules: 0 }],
    knowledge: { mode: 's3vectors', configured: false, ready: false, sources: 0, rules: 0, lastIngestAt: null },
    topRules: [],
    myRules: { files: 0, usedChars: 0, limitChars: null },
  };
}

/** 分析员看到的：按审核员只有自己一行。 */
export function asAnalyst(data: FakeDashboard): FakeDashboard {
  return { ...data, reviewers: [{ account: 'u-analyst', name: '复核人', reviews: 12, overrides: 1, customRules: 1 }], myRules: { files: 1, usedChars: 300, limitChars: null } };
}
/**
 * 规则发布复核人：九安里没有公司（Ruling FR1），外壳一张单也数不到——单据上来的数全是 0、没有按审核员的行、没有「我的规则」；
 * 知识库不分公司，照常给。
 */
export function asPolicyReviewer(data: FakeDashboard): FakeDashboard {
  return { ...empty(data.window), from: data.from, to: data.to, knowledge: data.knowledge, reviewers: [], myRules: { files: 0, usedChars: 0, limitChars: null } };
}

export interface DashboardOptions extends KbOptions {
  /** 每个窗口给什么（默认 today / fortnight / month）；也可以直接给一条路由。 */
  data?: Partial<Record<Window, unknown>> | ((window: Window) => unknown);
  route?: FakeRoute;
}

/** 假测试台：工作台 + 知识库（「上传制度」弹框）。role 决定会话；data 按窗口给。 */
export function fakeDashboard({ role = 'admin' as Role, data, route, overrides = {}, ...kb }: DashboardOptions = {}) {
  const pick = (window: Window) => {
    if (typeof data === 'function') return data(window);
    const given = data?.[window];
    if (given !== undefined) return given;
    const base = window === 'today' ? today() : window === 'month' ? month() : fortnight();
    return role === 'analyst' ? asAnalyst(base) : role === 'policy_reviewer' ? asPolicyReviewer(base) : base;
  };
  const dashboard: FakeRoute = route ?? (call => {
    const window = new URLSearchParams(call.search).get('window') as Window;
    if (!['today', '14d', 'month'].includes(window)) return { status: 400, body: { error: { code: 'DASHBOARD_INVALID', message: '统计窗口只能是今天（today）、近 14 天（14d）或本月（month）：请刷新页面后重试。' } } };
    return { body: { data: pick(window) } };
  });
  return fakeKb({ ...kb, role, overrides: { [`GET ${DASHBOARD}`]: dashboard, ...overrides } });
}
