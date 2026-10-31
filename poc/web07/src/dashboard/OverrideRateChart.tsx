/**
 * 人工改判率（样稿的折线）：每天改判 / 复核；那天没有复核就没有点，线在那里断开。最后一个有数的点直接标数；
 * 悬停给当天「复核 N 张 / 改判 M 张」；「表格」换成表格视图。一根 y 轴（百分数）。
 */
import { useState } from 'react';
import type { DailyRate } from '../api/dashboard';
import { ChartEmpty } from '../charts/ChartEmpty';
import { DataTable } from '../charts/DataTable';
import { LineChart } from '../charts/LineChart';
import { TableToggle } from '../charts/TableToggle';
import { Panel } from '../ui/Panel';
import { countText, longDay, percentText, rateOf, shortDay } from './format';

const HEIGHT = 190;

export function OverrideRateChart({ days }: { days: DailyRate[] }) {
  const [table, setTable] = useState(false);
  const rates = days.map(day => rateOf(day.overrides, day.reviews));
  const any = rates.some(rate => rate !== null);
  const describe = (index: number) => {
    const day = days[index], rate = rates[index];
    return rate === null ? `${shortDay(day.date)}：没有复核` : `${shortDay(day.date)}：改判率 ${percentText(rate, 1)}（复核 ${countText(day.reviews)} 张，改判 ${countText(day.overrides)} 张）`;
  };
  const tip = (index: number) => {
    const day = days[index], rate = rates[index];
    return (
      <>
        <b className="font-semibold">{longDay(day.date)}</b>
        {rate === null ? <p className="m-0 mt-1 text-steel">这天没有复核</p> : (
          <>
            <p className="m-0 mt-1 text-steel">改判率 <b className="font-semibold text-ink">{percentText(rate, 1)}</b></p>
            <p className="m-0 text-steel">复核 {countText(day.reviews)} 张 / 改判 {countText(day.overrides)} 张</p>
          </>
        )}
      </>
    );
  };
  return (
    <Panel title="人工改判率" extra={<><span>没采纳 AI 建议的比例，越低越好</span>{any && <TableToggle on={table} onToggle={() => setTable(on => !on)} />}</>}>
      <div className="px-[14px] pb-2 pt-2">
        {!any ? <ChartEmpty height={HEIGHT}>这段时间还没有人复核：复核之后，这里按天画出改判的比例。</ChartEmpty>
          : table ? (
            <DataTable label="人工改判率" rows={days} columns={[
              { header: '日期', cell: day => shortDay(day.date) },
              { header: '复核', numeric: true, cell: day => countText(day.reviews) },
              { header: '改判', numeric: true, cell: day => countText(day.overrides) },
              { header: '改判率', numeric: true, cell: (_day, index) => percentText(rates[index], 1) },
            ]} />
          ) : (
            // 百分数作单位画（刻度是整数的 %）
            <LineChart label="人工改判率" height={HEIGHT} describe={describe} tip={tip} format={value => `${value.toFixed(1)}%`} tickFormat={value => `${value}%`}
              points={days.map((day, index) => ({ tick: shortDay(day.date), value: rates[index] === null ? null : rates[index]! * 100 }))} />
          )}
      </div>
    </Panel>
  );
}
