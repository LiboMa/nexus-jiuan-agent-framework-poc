/**
 * 上面一排四个数（样稿 .tiles）：待我复核（点了去单据池的「待复核」）、AI 已出建议、建议通过、出建议用时。
 * 没有的数写「—」（不带单位），绝不出 NaN。
 */
import { useId, type ReactNode } from 'react';
import { ADVICE_LIMIT_S, type Dashboard } from '../api/dashboard';
import type { Role } from '../api/session';
import { cx } from '../ui/cx';
import { NONE, countText, secondsText } from './format';

const BOX = 'block min-w-0 rounded-box border bg-surface px-4 py-[14px]';

function Figure({ id, label, value, unit, detail }: { id?: string; label: string; value: string; unit: string; detail: ReactNode }) {
  return (
    <>
      <span id={id} className="block text-13 text-steel">{label}</span>
      <p data-value="" className="m-0 mt-1 truncate text-28 font-title tracking-[-0.4px] text-ink">
        {value}{value !== NONE && <small className="ml-1 text-13 font-medium tracking-normal text-steel">{unit}</small>}
      </p>
      <p data-detail="" className="m-0 mt-[2px] truncate text-12 text-steel">{detail}</p>
    </>
  );
}

function Tile(props: { label: string; value: string; unit: string; detail: ReactNode }) {
  const id = useId();
  return <section aria-labelledby={id} className={cx(BOX, 'border-line')}><Figure id={id} {...props} /></section>;
}

export function StatTiles({ data, role }: { data: Dashboard; role: Role | undefined }) {
  const { pendingReview: pending, advice } = data;
  const rate = advice.passRate === null ? NONE : String(Math.round(advice.passRate * 100));
  const longest = advice.maxDurationMs === null ? NONE : `${secondsText(advice.maxDurationMs)} 秒`;
  return (
    <div className="mt-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
      <a href="#/documents" className={cx(BOX, 'border-blue shadow-[inset_3px_0_0_var(--color-blue)] hover:bg-blue-50')}>
        <Figure label={role === 'policy_reviewer' ? '待复核' : '待我复核'} value={countText(pending.count)} unit="张"
          detail={`其中 ${countText(pending.failCount)} 张 AI 不建议通过`} />
      </a>
      <Tile label="AI 已出建议" value={countText(advice.completed)} unit="张" detail={`人工改判 ${countText(advice.overrides)} 张`} />
      <Tile label="建议通过" value={rate} unit="%" detail={`${countText(advice.pass)} / ${countText(advice.completed)}`} />
      <Tile label="出建议用时" value={secondsText(advice.avgDurationMs)} unit="秒 / 张" detail={`最长 ${longest}，上限 ${ADVICE_LIMIT_S} 秒`} />
    </div>
  );
}
