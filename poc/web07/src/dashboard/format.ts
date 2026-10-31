/**
 * 工作台的数字写法：没有的数（null）写「—」，绝不出 NaN；比例只在分母大于 0 时算。日期一律按上海时间。
 */
const SHANGHAI = 'Asia/Shanghai';
export const NONE = '—';

/** 千分位整数；不是有限数写「—」。 */
export const countText = (value: number | null | undefined) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : NONE);
/** 0–1 的小数 → 百分数（digits 位小数）；null 写「—」。 */
export const percentText = (fraction: number | null | undefined, digits = 0) =>
  (typeof fraction === 'number' && Number.isFinite(fraction) ? `${(fraction * 100).toFixed(digits)}%` : NONE);
/** part / whole；whole 不大于 0 时没有比例（null）。 */
export const rateOf = (part: number, whole: number): number | null => (whole > 0 && Number.isFinite(part) && Number.isFinite(whole) ? part / whole : null);
/** 毫秒 → 整秒；null 写「—」。 */
export const secondsText = (ms: number | null | undefined) => (typeof ms === 'number' && Number.isFinite(ms) ? String(Math.round(ms / 1000)) : NONE);

/** 上海日期 YYYY-MM-DD → 「10/17」（坐标轴、表格）。 */
export const shortDay = (date: string) => { const [, m, d] = date.split('-'); return `${Number(m)}/${Number(d)}`; };
/** 上海日期 YYYY-MM-DD → 「10 月 17 日」（悬停提示）。 */
export const longDay = (date: string) => { const [, m, d] = date.split('-'); return `${Number(m)} 月 ${Number(d)} 日`; };

/** 某一刻在上海是几月几日、星期几：「10 月 31 日 · 周六」（页面标题旁）。 */
export function todayText(ms: number): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('zh-CN', { timeZone: SHANGHAI, month: 'numeric', day: 'numeric', weekday: 'short' })
    .formatToParts(new Date(ms)).map(part => [part.type, part.value]));
  return `${Number(parts.month)} 月 ${Number(parts.day)} 日 · ${parts.weekday}`;
}
