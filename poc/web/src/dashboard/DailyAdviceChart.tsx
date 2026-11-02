/**
 * 每天的 AI 建议（样稿的堆叠柱）：每天建议通过 / 不建议通过 / 审核中三段，图例三项带图标和文字；悬停看当天明细；「表格」换成表格视图。
 * 状态色只给图形（柱、色块），字一律正文色系（Ruling T7d）。
 */
import { useState } from 'react';
import type { DailyAdvice } from '../api/dashboard';
import { ChartEmpty } from '../charts/ChartEmpty';
import { TipRows } from '../charts/ChartTip';
import { DataTable } from '../charts/DataTable';
import { Legend, type LegendItem } from '../charts/Legend';
import { StackedBarChart } from '../charts/StackedBarChart';
import { TableToggle } from '../charts/TableToggle';
import { Panel } from '../ui/Panel';
import { countText, longDay, shortDay } from './format';

const SERIES: Array<LegendItem & { key: 'pass' | 'fail' | 'running' }> = [
  { key: 'pass', label: '建议通过', color: 'var(--color-pass)', icon: 'check', iconClass: 'text-pass-ink' },
  { key: 'fail', label: '不建议通过', color: 'var(--color-fail)', icon: 'cross', iconClass: 'text-fail-ink' },
  { key: 'running', label: '审核中', color: 'var(--color-wait)', icon: 'refresh', iconClass: 'text-wait-ink' },
];
const HEIGHT = 190;
const totalOf = (day: DailyAdvice) => day.pass + day.fail + day.running;

export function DailyAdviceChart({ daily }: { daily: DailyAdvice[] }) {
  const [table, setTable] = useState(false);
  const any = daily.some(day => totalOf(day) > 0);
  const describe = (index: number) => {
    const day = daily[index];
    return `${shortDay(day.date)}：${SERIES.map(series => `${series.label} ${countText(day[series.key])} 张`).join('，')}`;
  };
  const tip = (index: number) => {
    const day = daily[index], total = totalOf(day);
    return (
      <>
        <b className="font-semibold">{longDay(day.date)}</b>
        {total > 0 ? (
          <>
            <TipRows rows={SERIES.map(series => ({ color: series.color, label: series.label, value: `${countText(day[series.key])} 张` }))} />
            <p className="m-0 mt-1 text-steel">共 {countText(total)} 张</p>
          </>
        ) : <p className="m-0 mt-1 text-steel">这天没有 AI 建议</p>}
      </>
    );
  };
  return (
    <Panel title="每天的 AI 建议" extra={any && <>{!table && <Legend items={SERIES} />}<TableToggle on={table} onToggle={() => setTable(on => !on)} /></>}>
      <div className="px-[14px] pb-2 pt-2">
        {!any ? <ChartEmpty height={HEIGHT}>这段时间还没有 AI 建议：出了建议，这里按天画出通过、不通过和审核中的张数。</ChartEmpty>
          : table ? (
            <DataTable label="每天的 AI 建议" rows={daily} columns={[
              { header: '日期', cell: day => shortDay(day.date) },
              ...SERIES.map(series => ({ header: series.label, numeric: true, cell: (day: DailyAdvice) => countText(day[series.key]) })),
              { header: '合计', numeric: true, cell: day => countText(totalOf(day)) },
            ]} />
          ) : (
            <StackedBarChart label="每天的 AI 建议" series={SERIES} height={HEIGHT} describe={describe} tip={tip}
              data={daily.map(day => ({ tick: shortDay(day.date), values: SERIES.map(series => day[series.key]) }))} />
          )}
      </div>
    </Panel>
  );
}
