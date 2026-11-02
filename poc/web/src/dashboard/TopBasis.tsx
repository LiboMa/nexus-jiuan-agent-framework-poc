/**
 * 不通过最常见的依据（Spec 5.2：按规则编号 / 单据字段 / 原件 / 我的规则标题归并，前 6）：标签说是哪一类，条形的长短比次数，右边是次数。
 * 我的规则用紫色。同一类、同一标签可能有两行（截到 60 字后一样的两组，Ruling T7c）：按序号作键。
 */
import type { Dashboard } from '../api/dashboard';
import { ChartEmpty } from '../charts/ChartEmpty';
import { r1 } from '../charts/scale';
import { Panel } from '../ui/Panel';
import { Pill, type Tone } from '../ui/Pill';
import { cx } from '../ui/cx';
import { countText } from './format';

const KINDS: Record<string, { label: string; tone: Tone; fill: string }> = {
  rule: { label: '公司制度', tone: 'info', fill: 'bg-blue' },
  custom: { label: '我的规则', tone: 'own', fill: 'bg-own' },
  field: { label: '单据字段', tone: 'neutral', fill: 'bg-blue' },
  evidence: { label: '原件', tone: 'neutral', fill: 'bg-blue' },
};

export function TopBasis({ items, fail }: { items: Dashboard['topBasis']; fail: number }) {
  const most = Math.max(0, ...items.map(item => item.count));
  return (
    <Panel title="不通过最常见的依据" extra={`${countText(fail)} 张不建议通过`}>
      {items.length === 0 ? <ChartEmpty height={190}>这段时间 AI 没有不建议通过的单据：有了，这里列出最常引用的依据。</ChartEmpty> : (
        <ul className="m-0 list-none px-4 pb-3 pt-[6px]">
          {items.map((item, index) => {
            const kind = KINDS[item.kind] ?? KINDS.rule;
            return (
              <li key={index} className="grid grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)_32px] items-center gap-[10px] py-[6px]"
                title={`${kind.label}「${item.label}」：${countText(item.count)} 张不建议通过的单据用到`}>
                <span className="flex min-w-0 items-center gap-2">
                  <Pill tone={kind.tone} className="shrink-0">{kind.label}</Pill>
                  <span className="min-w-0 truncate" title={item.label}>{item.label}</span>
                </span>
                <span className="block h-[10px] bg-track"><span data-fill="" className={cx('block h-full', kind.fill)} style={{ width: `${most > 0 ? r1((item.count / most) * 100) : 0}%` }} /></span>
                <b data-count="" className="text-right font-semibold">{countText(item.count)}</b>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
