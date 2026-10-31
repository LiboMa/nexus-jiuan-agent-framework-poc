import { useId, type ReactNode } from 'react';
import { YGrid, XTicks } from './axes';
import { ChartTip } from './ChartTip';
import { niceScale, plotArea, r1 } from './scale';
import { DAY_CLASS, RING_CLASS, useRoving } from './useRoving';
import { useWidth } from './useWidth';

/**
 * 按天的折线（单系列，不要图例；手写 SVG）：线 2 px；没有数（null）的日子断开、不连线；前后都没有数的孤点画成记号。
 * 只给最后一个有数的点直接标数（正文色），其余的数在悬停提示和表格视图里。每一天的悬停区是整个格子（准星找日期，不用对准细线），
 * 悬停和键盘焦点给同一份提示；y 轴从 0 起、只有一根。
 */
export interface LinePoint { tick: string; value: number | null }

/** 连续有数的日子分成一段段（序号）；null 和坏数断开。 */
export function lineRuns(values: Array<number | null>): number[][] {
  const runs: number[][] = [];
  let run: number[] = [];
  values.forEach((value, index) => {
    if (typeof value === 'number' && Number.isFinite(value)) { run.push(index); return; }
    if (run.length) runs.push(run);
    run = [];
  });
  if (run.length) runs.push(run);
  return runs;
}

const MARK = 10;

export function LineChart({ label, points, height = 190, minStep = 1, format, tickFormat, describe, tip }: {
  label: string; points: LinePoint[]; height?: number; minStep?: number;
  /** 直接标在最后一点上的写法。 */
  format: (value: number) => string;
  tickFormat: (value: number) => string;
  describe: (index: number) => string;
  tip: (index: number) => ReactNode;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const tipId = useId();
  const { active, itemProps } = useRoving(points.length, points.map(point => point.tick).join('|'));
  const values = points.map(point => (typeof point.value === 'number' && Number.isFinite(point.value) && point.value >= 0 ? point.value : null));
  const known = values.filter((value): value is number => value !== null);
  const scale = niceScale(known.length ? Math.max(...known) : 0, { minStep });
  const area = plotArea(width, height, points.length);
  const xOf = (index: number) => r1(area.left + (index + 0.5) * area.slot);
  const yOf = (value: number) => r1(area.bottom - (value / scale.max) * area.plotHeight);
  // 悬停区、记号取整像素（边缘清楚）；线照实际位置画
  const edge = (index: number) => Math.round(area.left + index * area.slot);
  const markAt = (index: number, value: number) => ({ x: Math.round(xOf(index)) - MARK / 2, y: Math.round(yOf(value)) - MARK / 2 });

  const runs = lineRuns(values);
  const last = runs.at(-1)?.at(-1) ?? null;
  const marked = [...new Set([...runs.filter(run => run.length === 1).map(run => run[0]), ...(last === null ? [] : [last])])].sort((a, b) => a - b);
  const lastValue = last === null ? null : values[last];
  // 最后一点的数：默认标在点的左上；太靠左就放右边，太靠上就放下面
  const nearLeft = last !== null && xOf(last) < area.left + 48;
  const labelAt = last === null || lastValue === null ? null : {
    x: nearLeft ? xOf(last) + 9 : xOf(last) - 9, anchor: (nearLeft ? 'start' : 'end') as 'start' | 'end',
    y: yOf(lastValue) < area.top + 14 ? yOf(lastValue) + 20 : yOf(lastValue) - 10,
  };
  const activeValue = active === null ? null : values[active] ?? null;

  return (
    <div ref={ref} className="relative">
      <svg role="group" aria-label={label} width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block overflow-visible">
        <YGrid scale={scale} area={area} width={width} format={tickFormat} />
        {active !== null && <line aria-hidden="true" x1={xOf(active)} x2={xOf(active)} y1={area.top} y2={area.bottom} stroke="var(--color-line)" strokeWidth={1} />}
        {runs.filter(run => run.length > 1).map((run, index) => (
          <path key={index} data-line="" d={run.map((at, step) => `${step ? 'L' : 'M'}${xOf(at)},${yOf(values[at]!)}`).join(' ')}
            fill="none" stroke="var(--color-blue)" strokeWidth="2" strokeLinejoin="miter" strokeLinecap="square" />
        ))}
        {marked.map(at => (
          <rect key={at} data-marker={at} {...markAt(at, values[at]!)} width={MARK} height={MARK} fill="var(--color-blue)" stroke="var(--color-surface)" strokeWidth={2} />
        ))}
        {active !== null && activeValue !== null && !marked.includes(active) && (
          <rect aria-hidden="true" {...markAt(active, activeValue)} width={MARK} height={MARK} fill="var(--color-blue)" stroke="var(--color-surface)" strokeWidth={2} />
        )}
        {labelAt && lastValue !== null && (
          <text data-label="" x={labelAt.x} y={labelAt.y} textAnchor={labelAt.anchor} fontSize={12} fontWeight={600} fill="var(--color-ink)">{format(lastValue)}</text>
        )}
        {points.map((_, index) => (
          <g key={index} role="img" aria-label={describe(index)} aria-describedby={active === index ? tipId : undefined} data-x={xOf(index)} className={DAY_CLASS} {...itemProps(index)}>
            <rect data-hit="" x={edge(index)} y={area.top} width={edge(index + 1) - edge(index)} height={area.plotHeight} fill="transparent" className={RING_CLASS} />
          </g>
        ))}
        <XTicks ticks={points.map(point => point.tick)} area={area} height={height} />
      </svg>
      {active !== null && (
        <ChartTip id={tipId} x={xOf(active)} y={(activeValue === null ? area.top : yOf(activeValue)) - 10} width={width}>{tip(active)}</ChartTip>
      )}
    </div>
  );
}
