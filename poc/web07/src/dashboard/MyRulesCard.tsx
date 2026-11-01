/**
 * 我的规则用量（样稿底排第三张）：已用 N 字、N 份；合计字数不设上限，所以没有用量条（外壳的 limitChars 是 null）。
 * 规则发布复核人没有「我的规则」（表头也不写份数）。
 */
import type { Dashboard } from '../api/dashboard';
import type { Role } from '../api/session';
import { Panel } from '../ui/Panel';
import { countText } from './format';

export function MyRulesCard({ mine, role }: { mine: Dashboard['myRules']; role: Role | undefined }) {
  const none = role === 'policy_reviewer';
  return (
    <Panel title="我的规则" extra={none ? undefined : `${countText(mine.files)} 份`}>
      <div className="px-4 py-[14px]">
        {none ? <p className="m-0 text-13 text-steel">你的账号没有「我的规则」。</p> : (
          <>
            <div className="flex items-baseline justify-between gap-2"><span className="text-steel">已用</span><b className="whitespace-nowrap font-semibold">{`${countText(mine.usedChars)} 字`}</b></div>
            <p className="m-0 mt-1 text-12 text-steel">字数不设上限；规则越长，每一轮 AI 审核越慢</p>
            <a href="#/my-rules" className="mt-3 inline-block text-12 font-semibold text-blue hover:underline">管理我的规则</a>
          </>
        )}
      </div>
    </Panel>
  );
}
