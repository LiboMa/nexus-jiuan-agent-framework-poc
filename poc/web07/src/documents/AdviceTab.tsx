/**
 * 抽屉的「AI 建议」页签（样稿 drawer-a.html）：结论（✓ / ✕ + 字）、用时、「重新审核」（= 九安的手动发起，POST advice {sourceVersion}）；
 * 用到「我的规则」时的标签；审批路径与最终审批人（只在规则依据的 note 读得出时，Spec 第 9 节）；依据逐条带「公司制度 / 单据字段 / 原件 / 我的规则」。
 * 没有建议、进行中、失败、declined、给旧版本的、读不到……每种都说清发生了什么、怎么办（Review Focus 2）。规则发布复核人只看不动。
 */
import type { ReactNode } from 'react';
import { useMutation, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { dashboardKeys } from '../api/dashboard';
import type { Role } from '../api/session';
import { basisTag, customRulesOwner, keys, secondsBetween, startAdvice, stripCustomRulesNote, timeText, type Advice, type BasisItem } from '../api/documents';
import { Button } from '../ui/Button';
import { Icon, type IconName } from '../ui/icons';
import { Pill } from '../ui/Pill';
import { cx } from '../ui/cx';
import { parseApprovalPath } from './approvalPath';
import { canAct } from './labels';

const TAG_TONES = {
  info: 'border-blue-200 bg-blue-50 text-blue',
  own: 'border-own-200 bg-own-50 text-own-ink',
  neutral: 'border-line bg-surface text-steel',
} as Record<string, string>;

/** 从「原件」依据跳到原件页签的那一页。 */
export interface PageTarget { ref: string; page: number }

export function AdviceTab({ id, version, role, advice, onOpenPage }: {
  id: string; version: string; role?: Role; advice: UseQueryResult<Advice, Error>; onOpenPage?: (target: PageTarget) => void;
}) {
  const queryClient = useQueryClient();
  const actor = canAct(role);
  // 单据编号作为这一次提交的变量：回调写回发起的那张单（抽屉换单时这一页签也整个换掉，见 DocumentDrawer）
  const start = useMutation({
    mutationFn: (vars: { id: string; version: string }) => startAdvice(vars.id, vars.version),
    onSuccess: (data, vars) => {
      queryClient.setQueryData(keys.advice(vars.id), data);
      void queryClient.invalidateQueries({ queryKey: ['reviews'] });
      void queryClient.invalidateQueries({ queryKey: keys.rounds(vars.id) });
      // 工作台的「审核中」、待复核跟着变（外壳的缓存也清了，F3）
      void queryClient.invalidateQueries({ queryKey: dashboardKeys.all });
    },
  });
  const value = advice.data;
  if (advice.isPending) return <Body><p role="status" className="m-0 text-13 text-steel">正在读取 AI 建议…</p></Body>;
  if (advice.isError && !value) {
    return <Body><State icon="warning" title="AI 建议没有读出来" text={advice.error.message} action={<Button size="sm" icon="refresh" onClick={() => void advice.refetch()}>重新读取</Button>} /></Body>;
  }
  if (!value) return null;

  const rerun = (label: string) => actor && value.canRun !== false
    ? <Button size="sm" icon="refresh" busy={start.isPending} disabled={!version} onClick={() => start.mutate({ id, version })}>{label}</Button>
    : null;
  const failure = start.isError ? <p role="alert" className="m-0 mt-2 text-13 text-fail-ink">{start.error.message}</p> : null;
  // 没有权限的人看到的下一步：找能动手的人
  const ask = '需要重新审核请找管理员或分析员。';

  const stale = value.stale === true && ['completed', 'failed', 'declined'].includes(value.status);
  if (value.status === 'completed' && !stale && (value.result === 'pass' || value.result === 'fail')) {
    return <Body><Completed advice={value} action={rerun('重新审核')} onOpenPage={onOpenPage} />{failure}</Body>;
  }
  let state: ReactNode;
  if (stale) {
    state = <State icon="refresh" title="AI 建议对应的是旧版本" text={`单据已经更新，旧建议不再显示；平台会自动重新发起，${actor ? '也可以点「重新审核」现在跑一轮。' : '请稍后再来看。'}`} action={rerun('重新审核')} />;
  } else if (value.status === 'not_run') {
    state = <State icon="file" title="还没有 AI 建议" text={`单据读取完成后平台会自动发起；${actor ? '也可以点「发起审核」现在跑一轮。' : '请稍后再来看。'}`} action={rerun('发起审核')} />;
  } else if (value.status === 'running') {
    state = <State icon="refresh" tone="wait" title="AI 正在审核" text="一般要一到两分钟，这里每 3 秒自动刷新；可以先看原件和单据信息。" />;
  } else if (value.status === 'failed') {
    state = (
      <State icon="warning" tone="wait" title="AI 建议没有完成" text={actor ? '点「重新审核」再跑一轮；一直不成请联系管理员。' : ask} action={rerun('重新审核')}>
        {value.errorCode && <p className="m-0 mt-1 text-12 text-steel">错误码 {value.errorCode}</p>}
      </State>
    );
  } else if (value.status === 'declined') {
    state = (
      <State icon="warning" tone="wait" title="AI 没有给出建议" text={actor ? '按原因补齐单据或原件后，点「重新审核」再跑一轮。' : ask} action={rerun('重新审核')}>
        <p className="m-0 mt-1 text-13 text-ink">原因：{value.declinedReason?.trim() || '服务端没有给出原因'}</p>
      </State>
    );
  } else if (value.status === 'unsupported') {
    state = <State icon="file" title="这类单据不送 AI 审核" text="AI 建议目前只接入对公付款单。" />;
  } else {
    state = <State icon="warning" tone="wait" title="AI 建议的状态暂时读不到" text="请稍后点「重新读取」；一直这样请联系管理员。" action={<Button size="sm" icon="refresh" onClick={() => void advice.refetch()}>重新读取</Button>} />;
  }
  return <Body>{state}{failure}</Body>;
}

const Body = ({ children }: { children: ReactNode }) => <div className="px-[18px] py-[14px]">{children}</div>;

function State({ icon, tone, title, text, action, children }: { icon: IconName; tone?: 'wait'; title: string; text: string; action?: ReactNode; children?: ReactNode }) {
  return (
    <div className={cx('flex items-start gap-[10px] border px-[14px] py-3', tone === 'wait' ? 'border-wait-200 bg-wait-50' : 'border-line bg-canvas')}>
      <span className={cx('mt-px', tone === 'wait' ? 'text-wait' : 'text-blue')}><Icon name={icon} size={18} /></span>
      <div className="min-w-0 flex-1">
        <p className="m-0 text-14 font-semibold text-ink">{title}</p>
        {children}
        <p className="m-0 mt-1 text-13 text-steel">{text}</p>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

function Completed({ advice, action, onOpenPage }: { advice: Advice; action: ReactNode; onOpenPage?: (target: PageTarget) => void }) {
  const pass = advice.result === 'pass';
  const seconds = secondsBetween(advice.startedAt, advice.finishedAt);
  const owner = customRulesOwner(advice.note);
  const basis = Array.isArray(advice.basis) ? advice.basis : [];
  const path = basis.filter(item => item.kind === 'rule').map(item => parseApprovalPath(item.note ?? '')).find(Boolean) ?? null;
  const note = typeof advice.note === 'string' ? stripCustomRulesNote(advice.note) : '';
  return (
    <>
      <section aria-label="AI 结论" className={cx('flex items-center gap-[10px] border px-[14px] py-3', pass ? 'border-pass-200 bg-pass-50' : 'border-fail-200 bg-fail-50')}>
        <b className={cx('flex items-center gap-[6px] text-14', pass ? 'text-pass-ink' : 'text-fail-ink')}>
          <Icon name={pass ? 'check' : 'cross'} size={16} />{pass ? '建议通过' : '不建议通过'}
        </b>
        <span className="text-13 text-steel">{[seconds === null ? null : `${seconds} 秒`, timeText(advice.finishedAt)].filter(Boolean).join(' · ')}</span>
        {action && <span className="ml-auto">{action}</span>}
      </section>
      {owner && <div className="mt-2"><Pill tone="own" icon={null}>含 {owner} 的自定义规则</Pill></div>}
      {advice.basisChanged && (
        <p className="m-0 mt-2 flex items-center gap-[6px] text-13 text-wait-ink"><Icon name="warning" size={14} />原件已更新：点「重新审核」按新原件再跑一轮。</p>
      )}
      {path && (
        <div role="group" aria-label="审批路径" className="mt-3 grid grid-cols-[70px_1fr] gap-x-[10px] gap-y-1 text-13">
          <span className="text-steel">审批路径</span><b className="font-semibold">{path.path}</b>
          <span className="text-steel">最终审批人</span><b className="font-semibold">{path.finalApprover}</b>
        </div>
      )}
      {basis.length > 0 ? (
        <ul aria-label="依据" className="m-0 mt-2 list-none p-0">
          {basis.map((item, index) => <BasisRow key={index} item={item} onOpenPage={onOpenPage} />)}
        </ul>
      ) : <p className="m-0 mt-3 text-13 text-steel">AI 没有列出依据。</p>}
      {note && (
        <div className="mt-3 border-t border-line pt-[10px]">
          <p className="m-0 text-12 text-steel">AI 的说明（模型自评，请对照单据和原件核对）</p>
          <p className="m-0 mt-1 whitespace-pre-wrap text-13 text-ink">{note}</p>
        </div>
      )}
    </>
  );
}

function BasisRow({ item, onOpenPage }: { item: BasisItem; onOpenPage?: (target: PageTarget) => void }) {
  const tag = basisTag(item);
  const page = item.kind === 'evidence' && Number.isSafeInteger(item.page) ? item.page as number : null;
  return (
    <li className="grid grid-cols-[70px_1fr] gap-[10px] border-t border-line py-[10px] first:border-t-0">
      <span data-basis-tag="" data-tone={tag.tone} className={cx('self-start justify-self-start whitespace-nowrap rounded-ctl border px-[6px] py-px text-12 font-semibold', TAG_TONES[tag.tone])}>
        {tag.label}
      </span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <b className="font-semibold break-words">{tag.title || '—'}</b>
          {page !== null && (onOpenPage
            ? <button type="button" aria-label={`看原件第 ${page} 页`} onClick={() => onOpenPage({ ref: item.ref, page })} className="text-12 text-blue hover:underline">第 {page} 页</button>
            : <span className="text-12 text-steel">第 {page} 页</span>)}
        </div>
        {item.note && <div className="text-13 text-steel">{item.note}</div>}
      </div>
    </li>
  );
}
