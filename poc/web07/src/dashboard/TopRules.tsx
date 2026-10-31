/** 最常引用的规则（Spec 5.2：窗口里建议引用的公司制度规则编号，前 5，不含我的规则）。 */
import type { Dashboard } from '../api/dashboard';
import { ChartEmpty } from '../charts/ChartEmpty';
import { Panel } from '../ui/Panel';
import { countText } from './format';

export function TopRules({ items, windowText }: { items: Dashboard['topRules']; windowText: string }) {
  return (
    <Panel title="最常引用的规则" extra={windowText}>
      {items.length === 0 ? <ChartEmpty height={96}>这段时间的 AI 建议还没有引用公司制度：引用了，这里列出最常用的规则编号。</ChartEmpty> : (
        <ul className="m-0 list-none p-0">
          {items.slice(0, 5).map((item, index) => (
            <li key={index} className="flex min-w-0 items-center gap-[10px] border-t border-line px-4 py-[9px] first:border-t-0">
              <span data-rule="" className="min-w-0 truncate rounded-ctl border border-blue-200 bg-blue-50 px-[6px] py-px text-12 font-semibold text-blue">{item.ruleId}</span>
              <span data-count="" className="ml-auto whitespace-nowrap text-steel">{countText(item.count)} 次</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
