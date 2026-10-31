/**
 * 调用记录（补丁 0002 的 callsCard；外壳 /platform/agent-access/calls，最近 50 轮，新的在前）：审批流的自动初审、单据页发起、这里的测试。
 * 每行：时间、单据号、任务、发给哪个 Agent、触发、状态、结论、用时、错误码；默认收起，「展开」看 Agent 的备注和逐条依据（模型自评，未核实）。
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { timeText } from '../api/documents';
import { agentKeys, fetchCalls, type CallRow } from '../api/agents';
import { messageOf } from '../knowledge/AgentNotice';
import { Button } from '../ui/Button';
import { Empty } from '../ui/Empty';
import { Panel } from '../ui/Panel';
import { Pill } from '../ui/Pill';
import { cx } from '../ui/cx';
import { CallFeedback } from './CallFeedback';
import { callStatus, conclusionOf, resultText, seconds, taskOf, triggerOf } from './labels';

const head = 'whitespace-nowrap border-b border-line px-3 py-[9px] text-left text-12 font-medium text-steel';
const cell = 'whitespace-nowrap border-b border-line px-3 py-[10px] text-13';
const keyOf = (call: CallRow, index: number) => [call.testId, call.documentId, call.task, call.round, call.at, index].join('|');

export function CallsPanel({ nameOf }: { nameOf: (publishId: string) => string | null }) {
  const calls = useQuery({ queryKey: agentKeys.calls, queryFn: fetchCalls });
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) => setOpened(now => { const next = new Set(now); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const items = calls.data ?? [];
  return (
    <Panel title="调用记录" className="mt-[14px]"
      extra={<>{calls.isSuccess && <span>{items.length} 轮</span>}<Button size="sm" icon="refresh" disabled={calls.isFetching} onClick={() => void calls.refetch()}>刷新</Button></>}>
      <p className="m-0 px-4 pt-3 text-12 text-steel">每一轮一行，新的在前（最近 50 轮）：审批流的自动初审、单据页发起，以及上面的测试。点「展开」看 Agent 的备注和依据——那是模型自评，没有核实。</p>
      {calls.isPending ? <p role="status" className="m-0 px-4 py-8 text-center text-13 text-steel">正在读取调用记录…</p>
        : calls.isError && !calls.data ? (
          <Empty icon="warning" title="调用记录没有读出来" description={messageOf(calls.error)} action={<Button icon="refresh" onClick={() => void calls.refetch()}>重新读取</Button>} />
        ) : !items.length ? (
          <Empty icon="agent" title="还没有调用记录" description="单据读完详情后九安会自动发起 AI 审核，也可以在上面的 Agent 列表里点「测试」。" />
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table aria-label="调用记录" className="w-full border-collapse">
              <thead>
                <tr>{['时间', '单据号', '任务', '发给', '触发', '状态', '结论', '用时', '错误码', '详情'].map(name => <th key={name} scope="col" className={cx(head, name === '用时' && 'text-right')}>{name}</th>)}</tr>
              </thead>
              <tbody>
                {items.map((call, index) => {
                  const key = keyOf(call, index);
                  const open = opened.has(key);
                  const status = callStatus(call);
                  const verdict = conclusionOf(call);
                  const name = call.publishId ? nameOf(call.publishId) : null;
                  const detailId = `call-detail-${index}`;
                  return [
                    <tr key={key} data-call="" className="hover:bg-canvas">
                      <td className={cx(cell, 'text-steel')}>{timeText(call.at || call.finishedAt || call.startedAt)}</td>
                      <td className={cell}>{call.number || '—'}</td>
                      <td className={cell}>{taskOf(call)}</td>
                      <td className={cx(cell, 'max-w-[200px] truncate')} title={call.publishId ?? undefined}>{name || call.publishId || '—'}</td>
                      <td className={cx(cell, 'text-steel')}>{triggerOf(call)}</td>
                      <td className={cell}><Pill tone={status.tone} icon={status.tone === 'wait' ? 'warning' : null}>{status.text}</Pill></td>
                      <td className={cell}>{verdict ? <Pill tone={verdict.tone} icon={verdict.tone === 'wait' ? 'warning' : undefined}>{verdict.text}</Pill> : '—'}</td>
                      <td className={cx(cell, 'text-right')}>{seconds(call.latencyMs)}</td>
                      <td className={cx(cell, 'text-12 text-steel')} title={call.errorCode ? resultText(call.errorCode) : undefined}>{call.errorCode || '—'}</td>
                      <td className={cell}>
                        <Button size="sm" variant="ghost" aria-expanded={open} aria-controls={open ? detailId : undefined} onClick={() => toggle(key)}>{open ? '收起' : '展开'}</Button>
                      </td>
                    </tr>,
                    open && (
                      <tr key={`${key}-detail`} id={detailId}>
                        <td colSpan={10} className="border-b border-line bg-surface px-4 py-3 shadow-[inset_2px_0_0_var(--color-blue)]">
                          <CallFeedback call={call} nameOf={nameOf} head={false} />
                        </td>
                      </tr>
                    ),
                  ];
                })}
              </tbody>
            </table>
          </div>
        )}
    </Panel>
  );
}
