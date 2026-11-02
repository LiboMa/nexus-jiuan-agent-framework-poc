/**
 * 图表的刻度和布局（手写 SVG，Spec 第 3 节）。y 轴从 0 起，步长取 1 / 2 / 5 × 10ⁿ（不小于 minStep），大约 count 段；
 * 没有数（0、负数、NaN、Infinity）时给 minStep × count：刻度的最大值永远大于 0，柱高、点位不会除以 0（Review Focus 4）。
 */
export interface Scale { max: number; ticks: number[] }

export function niceScale(max: number, { count = 4, minStep = 1 }: { count?: number; minStep?: number } = {}): Scale {
  if (!(Number.isFinite(max) && max > 0)) return { max: minStep * count, ticks: Array.from({ length: count + 1 }, (_, i) => i * minStep) };
  const raw = max / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  const step = Math.max(minStep, (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow);
  const top = Math.ceil(max / step - 1e-9) * step;
  // 步长小于 1 时乘出来的小数会带尾巴（0.30000000000000004），按步长的位数收一下
  const digits = Math.max(0, -Math.floor(Math.log10(step)));
  const clean = (value: number) => Number(value.toFixed(digits));
  return { max: clean(top), ticks: Array.from({ length: Math.round(top / step) + 1 }, (_, i) => clean(i * step)) };
}

/** x 轴每隔几天标一个日期（大约 7 个）。 */
export const tickEvery = (n: number) => Math.max(1, Math.ceil(n / 7));

/** 图的边距（px）：左边放 y 轴刻度，下边放日期。 */
export const MARGIN = { top: 12, right: 8, bottom: 24, left: 36 } as const;
/** 柱子最粗 24 px；相邻的柱子、堆叠的段之间留 2 px 面色的缝。 */
export const BAR_MAX = 24;
export const GAP = 2;

/** 绘图区：宽 width、高 height 的图里，n 个等宽的格子。 */
export function plotArea(width: number, height: number, n: number) {
  const left = MARGIN.left, top = MARGIN.top, bottom = height - MARGIN.bottom;
  const plotWidth = Math.max(1, width - MARGIN.left - MARGIN.right);
  const slot = plotWidth / Math.max(1, n);
  return { left, top, bottom, plotWidth, plotHeight: bottom - top, slot };
}

/** 保留一位小数，SVG 属性短一点。 */
export const r1 = (value: number) => Math.round(value * 10) / 10;
