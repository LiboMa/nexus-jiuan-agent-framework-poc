import { describe, expect, it } from 'vitest';
import { niceScale, tickEvery } from '../charts/scale';
import { stackSegments } from '../charts/StackedBarChart';
import { lineRuns } from '../charts/LineChart';
import { percentText, rateOf, secondsText } from '../dashboard/format';

// 图表的几何（src/charts/*）：刻度、堆叠段、断开的折线；空数据不除以 0（Review Focus 4）。
describe('niceScale: 0-based ticks with 1 / 2 / 5 × 10ⁿ steps, never a zero or broken max', () => {
  it('rounds the max up to a clean step', () => {
    expect(niceScale(29)).toEqual({ max: 30, ticks: [0, 10, 20, 30] });
    expect(niceScale(4)).toEqual({ max: 4, ticks: [0, 1, 2, 3, 4] });
    expect(niceScale(6.25)).toEqual({ max: 8, ticks: [0, 2, 4, 6, 8] });
    expect(niceScale(100)).toEqual({ max: 100, ticks: [0, 50, 100] });
    expect(niceScale(1234)).toEqual({ max: 1500, ticks: [0, 500, 1000, 1500] });
  });

  it('never goes below the minimum step (whole sheets, whole percent)', () => {
    expect(niceScale(1)).toEqual({ max: 1, ticks: [0, 1] });
    expect(niceScale(0.4)).toEqual({ max: 1, ticks: [0, 1] });
  });

  it('nothing to scale (0, negative, NaN, Infinity) gives a finite scale of minStep × count', () => {
    for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      const scale = niceScale(bad);
      expect(scale).toEqual({ max: 4, ticks: [0, 1, 2, 3, 4] });
    }
  });

  it('labels about seven days on the x axis', () => {
    expect(tickEvery(1)).toBe(1);
    expect(tickEvery(7)).toBe(1);
    expect(tickEvery(14)).toBe(2);
    expect(tickEvery(30)).toBe(5);
    expect(tickEvery(31)).toBe(5);
    expect(tickEvery(0)).toBe(1);
  });
});

describe('stackSegments: bottom-up, a 2 px gap between segments, zero segments skipped', () => {
  it('keeps the top of the stack at the data value and takes the gaps from the upper segments', () => {
    expect(stackSegments([2, 1, 1], { bottom: 166, unit: 5 })).toEqual([
      { series: 0, y: 156, height: 10 }, { series: 1, y: 151, height: 3 }, { series: 2, y: 146, height: 3 },
    ]);
  });

  it('skips the empty segments (the first drawn one sits on the baseline)', () => {
    expect(stackSegments([0, 3, 0], { bottom: 166, unit: 5 })).toEqual([{ series: 1, y: 151, height: 15 }]);
    expect(stackSegments([0, 0, 0], { bottom: 166, unit: 5 })).toEqual([]);
  });

  it('a tiny segment is still at least 1 px tall, and the gap stays 2 px', () => {
    const [low, high] = stackSegments([1, 1], { bottom: 166, unit: 1 });
    expect(low).toEqual({ series: 0, y: 165, height: 1 });
    expect(high.height).toBe(1);
    expect(low.y - (high.y + high.height)).toBe(2);
  });

  it('broken numbers draw nothing', () => {
    expect(stackSegments([Number.NaN, -1, Number.POSITIVE_INFINITY], { bottom: 166, unit: 5 })).toEqual([]);
  });
});

describe('lineRuns: a day without data breaks the line', () => {
  it('splits into runs of consecutive days with data', () => {
    expect(lineRuns([1, 2, null, 3, null, null, 4, 5])).toEqual([[0, 1], [3], [6, 7]]);
    expect(lineRuns([null, null])).toEqual([]);
    expect(lineRuns([0])).toEqual([[0]]);
  });
});

describe('dashboard number formats', () => {
  it('percent and rate: 「—」 for nothing, never NaN', () => {
    expect(percentText(0.0625, 1)).toBe('6.3%');
    expect(percentText(176 / 221)).toBe('80%');
    expect(percentText(null)).toBe('—');
    expect(rateOf(1, 16)).toBe(0.0625);
    expect(rateOf(0, 0)).toBeNull();
    expect(rateOf(3, -1)).toBeNull();
  });

  it('seconds from milliseconds, 「—」 for null', () => {
    expect(secondsText(82_400)).toBe('82');
    expect(secondsText(null)).toBe('—');
  });
});
