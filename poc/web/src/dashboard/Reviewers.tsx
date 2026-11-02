/**
 * 按审核员（样稿 .rv）：审核员 · 复核 · 改判 · 改判率 · 个人规则；改判率 = 改判 / 复核，没有复核写「—」。
 * 管理员看全员，自己那行标「（我）」、浅蓝底；分析员只有自己一行；规则发布复核人不做复核，只说一句。名字长了截断，不撑破版面。
 */
import type { ReviewerRow } from '../api/dashboard';
import type { Role } from '../api/session';
import { ChartEmpty } from '../charts/ChartEmpty';
import { Panel } from '../ui/Panel';
import { cx } from '../ui/cx';
import { NONE, countText, percentText, rateOf } from './format';

export function Reviewers({ rows, me, role, windowText }: { rows: ReviewerRow[]; me: string | undefined; role: Role | undefined; windowText: string }) {
  const head = 'whitespace-nowrap border-b border-line px-[10px] py-2 text-right text-12 font-medium text-steel first:text-left';
  const cell = 'whitespace-nowrap border-b border-line px-[10px] py-[9px] text-right';
  return (
    <Panel title="按审核员" extra={windowText}>
      {role === 'policy_reviewer' ? <ChartEmpty height={150}>你的账号不做复核，这里没有按审核员的统计。</ChartEmpty>
        : rows.length === 0 ? <ChartEmpty height={150}>还没有审核员的复核记录。</ChartEmpty> : (
          <div className="overflow-x-auto">
            <table aria-label="按审核员" className="w-full border-collapse text-13">
              <thead><tr>{['审核员', '复核', '改判', '改判率', '个人规则'].map(name => <th key={name} scope="col" className={head}>{name}</th>)}</tr></thead>
              <tbody>
                {rows.map((row, index) => {
                  const mine = Boolean(me) && row.account === me;
                  return (
                    <tr key={index} data-me={mine ? 'true' : undefined} className={cx(mine && 'bg-blue-50')}>
                      <td className="w-full max-w-0 border-b border-line px-[10px] py-[9px]">
                        <span className="flex min-w-0 items-center gap-2">
                          <i aria-hidden="true" className="grid h-[22px] w-[22px] shrink-0 place-items-center bg-blue-100 text-12 font-title not-italic text-blue">{Array.from(row.name)[0] ?? '?'}</i>
                          <span data-name="" className="min-w-0 truncate" title={row.name}>{row.name}{mine ? '（我）' : ''}</span>
                        </span>
                      </td>
                      <td className={cell}>{countText(row.reviews)}</td>
                      <td className={cell}>{countText(row.overrides)}</td>
                      <td className={cell}>{percentText(rateOf(row.overrides, row.reviews), 1)}</td>
                      <td className={cell}>{row.customRules > 0 ? `${countText(row.customRules)} 份` : NONE}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
    </Panel>
  );
}
