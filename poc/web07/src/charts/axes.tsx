import { MARGIN, r1, tickEvery, type Scale } from './scale';

type Area = { left: number; top: number; bottom: number; plotHeight: number; slot: number };
const AXIS_TEXT = { fontSize: 12, fill: 'var(--color-faint)' } as const;

/** 横向网格线（1 px 实线、比面色深一档，0 那条用分隔色）和左边的刻度：只有一根 y 轴。 */
export function YGrid({ scale, area, width, format }: { scale: Scale; area: Area; width: number; format: (value: number) => string }) {
  return (
    <g aria-hidden="true">
      {scale.ticks.map((tick, index) => {
        const y = Math.round(area.bottom - (tick / scale.max) * area.plotHeight) + 0.5;
        return (
          <g key={index}>
            <line x1={area.left} x2={width - MARGIN.right} y1={y} y2={y} stroke={index === 0 ? 'var(--color-line)' : 'var(--color-track)'} strokeWidth={1} />
            <text data-axis="y" x={area.left - 6} y={y + 4} textAnchor="end" {...AXIS_TEXT}>{format(tick)}</text>
          </g>
        );
      })}
    </g>
  );
}

/** 下边的日期：大约 7 个，从第一天起隔几天标一个。 */
export function XTicks({ ticks, area, height }: { ticks: string[]; area: Area; height: number }) {
  const every = tickEvery(ticks.length);
  return (
    <g aria-hidden="true">
      {ticks.map((tick, index) => (index % every === 0
        ? <text key={index} data-axis="x" x={r1(area.left + (index + 0.5) * area.slot)} y={height - 6} textAnchor="middle" {...AXIS_TEXT}>{tick}</text>
        : null))}
    </g>
  );
}
