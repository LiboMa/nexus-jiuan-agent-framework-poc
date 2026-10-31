import { useId, type ReactNode } from 'react';
import { YGrid, XTicks } from './axes';
import { ChartTip } from './ChartTip';
import { BAR_MAX, GAP, niceScale, plotArea, r1 } from './scale';
import { useRoving } from './useRoving';
import { useWidth } from './useWidth';

/**
 * 按天堆叠的柱状图（手写 SVG；dataviz 的柱子规格）：柱子最粗 24 px、从同一条底线往上长；堆叠的段之间、贴着的相邻柱子之间都留 2 px 面色的缝，
 * 不给柱子描边；不在每根柱子上标数（数在悬停提示和表格视图里）。每一天的悬停区是整个格子、整个绘图高度（比柱子大），
 * 悬停和键盘焦点给同一份提示；y 轴从 0 起、只有一根。
 */
export interface BarSeries { key: string; label: string; color: string }
export interface BarDatum { tick: string; values: number[] }

const finite = (value: number) => (Number.isFinite(value) && value > 0 ? value : 0);

/**
 * 一根柱子的各段（自下而上；0 和坏数不画）：段顶对齐它在数据里的位置，上面的段让出 2 px 缝；再小的段也至少 1 px 高。
 * unit = 每个单位多少 px（刻度最大值永远大于 0，所以它是有限数）。
 */
export function stackSegments(values: number[], { bottom, unit, gap = GAP }: { bottom: number; unit: number; gap?: number }) {
  const segments: Array<{ series: number; y: number; height: number }> = [];
  let total = 0, floor: number | null = null;
  values.forEach((raw, series) => {
    const value = finite(raw);
    if (!value) return;
    total += value;
    const base = floor === null ? bottom : floor - gap;
    const top = Math.min(base - 1, bottom - total * unit);
    segments.push({ series, y: r1(top), height: r1(base - top) });
    floor = top;
  });
  return segments;
}

export function StackedBarChart({ label, series, data, height = 190, describe, tip }: {
  label: string; series: BarSeries[]; data: BarDatum[]; height?: number;
  /** 读屏念的这一天（也是悬停区的名字）。 */
  describe: (index: number) => string;
  tip: (index: number) => ReactNode;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const tipId = useId();
  const { active, focused, itemProps } = useRoving(data.length);
  const scale = niceScale(Math.max(0, ...data.map(datum => datum.values.reduce((sum, value) => sum + finite(value), 0))));
  const area = plotArea(width, height, data.length);
  const unit = area.plotHeight / scale.max;

  const bars = data.map((datum, index) => {
    const left = area.left + index * area.slot, right = left + area.slot;
    // 格子窄到柱子贴着时，两边各让 1 px（缝 2 px）；宽的时候柱子 24 px 居中
    const touching = area.slot - GAP <= BAR_MAX;
    const x = r1(touching ? left + GAP / 2 : left + (area.slot - BAR_MAX) / 2);
    const barWidth = touching ? Math.max(1, r1(r1(right - GAP / 2) - x)) : BAR_MAX;
    return { left, x, barWidth, segments: stackSegments(datum.values, { bottom: area.bottom, unit }) };
  });
  const shown = active !== null ? bars[active] : null;

  return (
    <div ref={ref} className="relative">
      <svg role="group" aria-label={label} width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block overflow-visible">
        <YGrid scale={scale} area={area} width={width} format={value => value.toLocaleString('en-US')} />
        {bars.map((bar, index) => (
          <g key={index} role="img" aria-label={describe(index)} aria-describedby={active === index ? tipId : undefined} data-bar={index} className="outline-none" {...itemProps(index)}>
            <rect
              data-hit="" x={r1(bar.left)} y={area.top} width={r1(area.slot)} height={area.plotHeight}
              fill={active === index ? 'var(--color-blue-50)' : 'transparent'}
              stroke={focused === index ? 'var(--color-blue)' : 'none'} strokeWidth={focused === index ? 1.5 : 0}
            />
            {bar.segments.map(segment => (
              <rect key={segment.series} data-segment={series[segment.series]?.key} x={bar.x} y={segment.y} width={bar.barWidth} height={segment.height}
                fill={series[segment.series]?.color} shapeRendering="crispEdges" />
            ))}
          </g>
        ))}
        <XTicks ticks={data.map(datum => datum.tick)} area={area} height={height} />
      </svg>
      {active !== null && shown && (
        <ChartTip id={tipId} x={shown.x + shown.barWidth / 2} y={(shown.segments.at(-1)?.y ?? area.bottom) - 8} width={width}>{tip(active)}</ChartTip>
      )}
    </div>
  );
}
