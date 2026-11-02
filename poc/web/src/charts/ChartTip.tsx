import type { ReactNode } from 'react';
import { cx } from '../ui/cx';

/**
 * 图上的悬停提示：白底卡片，压在指到的那一天上方（x、y 是图里的 px）；靠左、靠右时往里收，不出图。不接指针事件。
 * 只放 React 节点（文字照 textContent 进页面，不拼 HTML）。
 */
export function ChartTip({ id, x, y, width, children }: { id: string; x: number; y: number; width: number; children: ReactNode }) {
  const align = x < width * 0.2 ? 'start' : x > width * 0.8 ? 'end' : 'center';
  return (
    <div
      id={id} role="tooltip" style={{ left: x, top: y }}
      className={cx(
        'pointer-events-none absolute z-10 -translate-y-full whitespace-nowrap rounded-box border border-line bg-surface px-[10px] py-2 text-12 text-ink shadow-tip',
        align === 'center' ? '-translate-x-1/2' : align === 'end' ? '-translate-x-full' : '-translate-x-3',
      )}
    >
      {children}
    </div>
  );
}

/** 提示里的一行：短线条（系列色）· 系列名（次要）· 数（醒目）。 */
export interface TipRow { color: string; label: string; value: string }
export function TipRows({ rows }: { rows: TipRow[] }) {
  return (
    <ul className="m-0 mt-1 flex list-none flex-col gap-[2px] p-0">
      {rows.map((row, index) => (
        // 提示框按内容收宽：用 flex，不用 1fr 的网格（那一栏会被压成 0、数压到字上）
        <li key={index} className="flex items-center gap-2">
          <svg width="12" height="2" className="shrink-0" aria-hidden="true" focusable="false"><rect width="12" height="2" fill={row.color} /></svg>
          <span className="text-steel">{row.label}</span>
          <b className="ml-auto pl-4 font-semibold">{row.value}</b>
        </li>
      ))}
    </ul>
  );
}
