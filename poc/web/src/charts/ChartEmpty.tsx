import type { ReactNode } from 'react';

/** 图没有数时：和图一样高（换窗口不跳），一句话说清这里将来画什么。 */
export function ChartEmpty({ height = 120, children }: { height?: number; children: ReactNode }) {
  return <p style={{ minHeight: height }} className="m-0 flex items-center justify-center px-6 text-center text-13 text-steel">{children}</p>;
}
