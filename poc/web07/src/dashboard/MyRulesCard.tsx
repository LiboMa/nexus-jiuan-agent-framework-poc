/** 我的规则用量（样稿底排第三张）：已用 N / 5,000 字（紫色条）、N 份；规则发布复核人没有「我的规则」。 */
import type { Dashboard } from '../api/dashboard';
import type { Role } from '../api/session';
import { r1 } from '../charts/scale';
import { Panel } from '../ui/Panel';
import { countText } from './format';

export function MyRulesCard({ mine, role }: { mine: Dashboard['myRules']; role: Role | undefined }) {
  const percent = mine.limitChars > 0 ? Math.min(100, r1((mine.usedChars / mine.limitChars) * 100)) : 0;
  return (
    <Panel title="我的规则" extra={`${countText(mine.files)} 份`}>
      <div className="px-4 py-[14px]">
        {role === 'policy_reviewer' ? <p className="m-0 text-13 text-steel">你的账号没有「我的规则」。</p> : (
          <>
            <div className="flex items-baseline justify-between gap-2"><span className="text-steel">已用</span><b className="whitespace-nowrap font-semibold">{`${countText(mine.usedChars)} / ${countText(mine.limitChars)} 字`}</b></div>
            <div role="meter" aria-label="已用字数" aria-valuemin={0} aria-valuemax={mine.limitChars} aria-valuenow={Math.min(mine.usedChars, mine.limitChars)} className="mt-2 h-[6px] bg-track">
              <span data-fill="" className="block h-full bg-own" style={{ width: `${percent}%` }} />
            </div>
            <a href="#/my-rules" className="mt-3 inline-block text-12 font-semibold text-blue hover:underline">管理我的规则</a>
          </>
        )}
      </div>
    </Panel>
  );
}
