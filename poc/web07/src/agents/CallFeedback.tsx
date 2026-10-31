/**
 * 一轮调用的反馈（补丁 0002 的 callFeedback）：测试结果和调用记录展开后共用。结论、对象、触发 · 时间 · 用时；没完成时的原因和错误码；
 * 文本测试发出的文字和回复；请求信封不合契约的地方、检查过的结果信封和原始回答（收起）；Agent 的备注（模型自评）和逐条依据；发给谁、Agent 版本。
 */
import type { ReactNode } from 'react';
import { basisTag, timeText, type BasisItem } from '../api/documents';
import type { CallRow } from '../api/agents';
import { Pill } from '../ui/Pill';
import { cx } from '../ui/cx';
import { callStatus, conclusionOf, problemText, resultText, seconds, shortRef, triggerOf } from './labels';

const TAG_TONES: Record<string, string> = {
  info: 'border-blue-200 bg-blue-50 text-blue', own: 'border-own-200 bg-own-50 text-own-ink', neutral: 'border-line bg-surface text-steel',
};
const pretty = (value: unknown) => { try { return JSON.stringify(value, null, 2); } catch { return String(value); } };
/** 等宽字（JSON）：主题里只有正文字体，这里用 style 属性（走 CSSOM，不违反 style-src 'self'）。 */
export const MONO = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' } as const;

/** head：带不带结论那一行（调用记录展开时表格那一行已经有了）。 */
export function CallFeedback({ call, nameOf, head = true }: { call: CallRow; nameOf: (publishId: string) => string | null; head?: boolean }) {
  const verdict = conclusionOf(call) ?? callStatus(call);
  const subject = call.mode === 'text' ? '文本' : call.mode === 'envelope' ? call.task || '请求信封' : call.number || '—';
  const basis = Array.isArray(call.basis) ? call.basis : [];
  const problems = Array.isArray(call.problems) ? call.problems : [];
  const name = call.publishId ? nameOf(call.publishId) : null;
  return (
    <div className="flex flex-col gap-2 text-13">
      {head && (
        <div className="flex flex-wrap items-center gap-x-[10px] gap-y-1">
          <Pill tone={verdict.tone} icon={verdict.tone === 'wait' ? 'warning' : undefined}>{verdict.text}</Pill>
          <b className="font-semibold">{subject}</b>
          <span className="text-12 text-steel">{`${triggerOf(call)} · ${timeText(call.at || call.finishedAt || call.startedAt)} · 用时 ${seconds(call.latencyMs)}`}</span>
        </div>
      )}
      {call.errorCode && (
        <div className="rounded-box border border-wait-200 bg-wait-50 px-3 py-2 text-wait-ink">
          <p className="m-0">没有完成：{resultText(call.errorCode)}</p>
          <p className="m-0 mt-[2px] text-12">错误码 {call.errorCode}</p>
        </div>
      )}
      {call.declinedReason && <p className="m-0 text-wait-ink">Agent 没有给出建议：{call.declinedReason}</p>}
      {call.mode === 'text' && call.input && <Note label="发出的文字">{call.input}</Note>}
      {call.mode === 'text' && call.reply != null && <Note label="Agent 的回复">{call.reply || '（空）'}</Note>}
      {call.mode === 'envelope' && problems.length > 0 && (
        <div className="rounded-box border border-wait-200 bg-wait-50 px-3 py-2">
          <p className="m-0 text-12 text-wait-ink">不合契约的地方</p>
          <ul className="m-0 mt-1 list-disc pl-5 text-13 text-wait-ink">{problems.map((problem, index) => <li key={index}>{problemText(problem)}</li>)}</ul>
        </div>
      )}
      {call.mode === 'envelope' && call.envelope != null && <Folded label="结果信封（已按契约检查）">{pretty(call.envelope)}</Folded>}
      {call.mode === 'envelope' && call.reply != null && <Folded label="原始回答">{call.reply || '（空）'}</Folded>}
      {call.note && <Note label="备注（模型自评，未核实）">{call.note}</Note>}
      {basis.length > 0 && (
        <ul aria-label="依据" className="m-0 list-none border-t border-line p-0">
          {basis.map((item, index) => <BasisLine key={index} item={item} />)}
        </ul>
      )}
      <p className="m-0 text-12 text-faint">
        {`发给 ${name || call.publishId || '—'}${name ? `（${call.publishId}）` : ''}${call.agentVersion ? ` · Agent 版本 ${call.agentVersion}` : ''}${call.repaired ? ' · 修正过一次格式' : ''}`}
      </p>
    </div>
  );
}

function Note({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="bg-sunken px-3 py-2">
      <p className="m-0 text-12 text-steel">{label}</p>
      <p className="m-0 mt-[2px] whitespace-pre-wrap break-words text-ink">{children}</p>
    </div>
  );
}

function Folded({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="border border-line">
      <summary className="cursor-pointer px-3 py-[6px] text-12 font-medium text-blue">{label}</summary>
      <pre className="m-0 max-h-[280px] overflow-auto whitespace-pre-wrap break-all border-t border-line bg-sunken px-3 py-2 text-12 text-ink" style={MONO}>{children}</pre>
    </details>
  );
}

function BasisLine({ item }: { item: BasisItem }) {
  const tag = basisTag(item);
  const page = Number.isSafeInteger(item.page) && (item.page as number) > 0 ? item.page as number : null;
  return (
    <li className="grid grid-cols-[70px_1fr] gap-[10px] border-b border-line py-2">
      <span data-basis-tag="" data-tone={tag.tone} className={cx('self-start justify-self-start whitespace-nowrap rounded-ctl border px-[6px] py-px text-12 font-semibold', TAG_TONES[tag.tone])}>{tag.label}</span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <b className="break-words font-semibold">{item.kind === 'evidence' ? shortRef(item.ref) : tag.title || '—'}</b>
          {page !== null && <span className="text-12 text-steel">第 {page} 页</span>}
        </div>
        {item.note && <div className="text-steel">{item.note}</div>}
      </div>
    </li>
  );
}
