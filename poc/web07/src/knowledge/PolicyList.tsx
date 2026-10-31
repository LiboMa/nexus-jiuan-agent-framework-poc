/**
 * 制度清单（Spec 第 6 节；补丁 0005「制度清单」）：标题、制度标识、版本、条数、状态、时间。以知识库 Agent 返回的为准。
 * 「下线」「恢复」只在 describe 的 ops 里有时显示（别的 op 不管，Ruling T6c）；「删除」先在弹框里再确认一次；「查看」开登记和规则编号。
 * 每个操作是一次 A2A 调用（约 10–20 秒），一次一个：进行中清单的按钮和「刷新清单」都不可用。
 */
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../api/client';
import { timeText } from '../api/documents';
import { NOT_READY_CODES, WORKING, fetchSource, fetchSources, kbKeys, manageSource, nameOf, thousands, type Agent, type KbOp, type KbSource } from '../api/knowledge';
import { Button } from '../ui/Button';
import { Empty } from '../ui/Empty';
import { Modal } from '../ui/Modal';
import { Panel } from '../ui/Panel';
import { Pill } from '../ui/Pill';
import { cx } from '../ui/cx';
import { messageOf } from './AgentNotice';

const STATUS: Record<string, { text: string; tone: 'pass' | 'wait' }> = { active: { text: '有效', tone: 'pass' }, inactive: { text: '已下线', tone: 'wait' } };
type Notice = { text: string; ok: boolean };

export function PolicyList({ agent, ops, onUpload }: { agent: Agent; ops: readonly string[]; onUpload: () => void }) {
  const queryClient = useQueryClient();
  const can = (op: string) => ops.includes(op);
  const sources = useQuery({ queryKey: kbKeys.sources, queryFn: () => fetchSources(agent), retry: false });
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirming, setConfirming] = useState<KbSource | null>(null);
  const [viewing, setViewing] = useState<KbSource | null>(null);
  const inFlight = useRef(false);
  const notReady = (error: unknown) => error instanceof ApiError && NOT_READY_CODES.has(error.code);

  const done: Record<KbOp, (source: KbSource, count: number) => string> = {
    deactivate: (source, count) => `已下线「${nameOf(source)}」（${count} 条规则）：AI 审单时用不到了${can('restore') ? '，可以恢复' : ''}。`,
    restore: (source, count) => `已恢复「${nameOf(source)}」（${count} 条规则）：AI 审单时又能用上了。`,
    delete: (source, count) => `已删除「${nameOf(source)}」：${count} 条规则和登记都删掉了。`,
  };
  // 操作成功后再读一次清单；清单没读成也说清操作本身已经成了
  const manage = useMutation({
    mutationFn: async ({ op, source }: { op: KbOp; source: KbSource }): Promise<Notice> => {
      const data = await manageSource(source.source_id, op, agent);
      const text = done[op](source, typeof data?.affected === 'number' ? data.affected : 0);
      try {
        await queryClient.fetchQuery({ queryKey: kbKeys.sources, queryFn: () => fetchSources(agent), staleTime: 0, retry: false });
        return { text, ok: true };
      } catch (error) {
        if (notReady(error)) throw error;
        return { text: `${text} 清单没有刷新：${messageOf(error)}`, ok: false };
      }
    },
    onSuccess: result => setNotice(result),
    onError: error => setNotice({ text: messageOf(error), ok: false }),
    onSettled: () => { inFlight.current = false; },
  });
  function run(op: KbOp, source: KbSource) {
    if (inFlight.current) return;
    inFlight.current = true;
    setNotice(null);
    manage.mutate({ op, source });
  }

  // 钥匙没了、发布编号没了：重新问 /mode，整页换成那句提示
  const failure = manage.error ?? sources.error;
  useEffect(() => { if (notReady(failure)) void queryClient.invalidateQueries({ queryKey: kbKeys.mode }); }, [failure, queryClient]);

  const busy = manage.isPending || sources.isFetching;
  const list = sources.data ?? [];
  const head = 'whitespace-nowrap border-b border-line px-3 py-[9px] text-left text-12 font-medium text-steel';
  const cell = 'whitespace-nowrap border-b border-line px-3 py-[11px]';
  return (
    <Panel
      title="制度清单" className="mt-[14px]"
      extra={<>{sources.isSuccess && <span>{list.length} 份</span>}<Button size="sm" icon="refresh" disabled={busy} onClick={() => { setNotice(null); void sources.refetch(); }}>刷新清单</Button></>}
    >
      <p className="m-0 px-4 pt-3 text-12 text-steel">
        清单以{agent.lead}那边的为准。{can('deactivate') && `「下线」后 AI 审单时用不到这份制度的规则${can('restore') ? '，可以恢复' : ''}；`}「删除」连规则带登记一起删掉，不能恢复。
      </p>
      {busy && sources.data ? <p role="status" className="m-0 px-4 pt-2 text-13 text-wait-ink">{WORKING}</p>
        : notice ? <p role={notice.ok ? 'status' : 'alert'} className={cx('m-0 px-4 pt-2 text-13', notice.ok ? 'text-pass-ink' : 'text-fail-ink')}>{notice.text}</p>
          : sources.isError && sources.data ? <p role="alert" className="m-0 px-4 pt-2 text-13 text-fail-ink">{messageOf(sources.error)}</p> : null}

      {sources.isPending ? <p role="status" className="m-0 px-4 py-10 text-center text-13 text-steel">正在读取制度清单（约 10–20 秒）…</p>
        : sources.isError && !sources.data ? (
          <Empty icon="warning" title="制度清单没有读出来" description={messageOf(sources.error)}
            action={<Button icon="refresh" onClick={() => void sources.refetch()}>重新读取</Button>} />
        ) : !list.length ? (
          <Empty icon="knowledge" title="规则库里还没有制度"
            description="点右上角「上传制度」，把审批矩阵格式的制度 .docx 交给知识库入库。"
            action={<Button variant="primary" icon="upload" onClick={onUpload}>上传制度</Button>} />
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table aria-label="制度清单" className="w-full border-collapse">
              <thead>
                <tr>
                  {['标题', '制度标识', '版本', '条数', '状态', '时间'].map(name => <th key={name} scope="col" className={cx(head, name === '条数' && 'text-right')}>{name}</th>)}
                  <th scope="col" className={head}>操作</th>
                </tr>
              </thead>
              <tbody>
                {list.map(source => {
                  const status = STATUS[source.status ?? ''];
                  const inactive = source.status === 'inactive';
                  return (
                    <tr key={source.source_id} data-source={source.source_id} className="hover:bg-canvas">
                      <td className={cx(cell, 'max-w-[280px] truncate font-semibold')} title={nameOf(source)}>{nameOf(source)}</td>
                      <td className={cx(cell, 'text-steel')}>{source.source_id}</td>
                      <td className={cx(cell, 'max-w-[160px] truncate text-steel')}>{source.source_version || '—'}</td>
                      <td className={cx(cell, 'text-right')}>{thousands(source.rules_total)}</td>
                      <td className={cell}>{status ? <Pill tone={status.tone} icon={status.tone === 'wait' ? null : undefined}>{status.text}</Pill> : <Pill>{source.status || '—'}</Pill>}</td>
                      <td className={cx(cell, 'text-steel')}>{timeText(source.updated_at || source.ingested_at)}</td>
                      <td className={cell}>
                        <div className="flex gap-[6px]">
                          <Button size="sm" disabled={busy} onClick={() => setViewing(source)}>查看</Button>
                          {inactive
                            ? can('restore') && <Button size="sm" disabled={busy} onClick={() => run('restore', source)}>恢复</Button>
                            : can('deactivate') && <Button size="sm" disabled={busy} onClick={() => run('deactivate', source)}>下线</Button>}
                          <Button size="sm" variant="danger" disabled={busy} onClick={() => setConfirming(source)}>删除</Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

      <Modal
        open={Boolean(confirming)} onOpenChange={next => { if (!next) setConfirming(null); }} title="删除制度" icon="warning"
        footer={<>
          <Button onClick={() => setConfirming(null)}>取消</Button>
          <Button variant="danger" disabled={busy} onClick={() => { const source = confirming; setConfirming(null); if (source) run('delete', source); }}>确认删除</Button>
        </>}
      >
        {confirming && (
          <p className="m-0 px-[18px] pt-4 text-13 text-ink">
            删除「{nameOf(confirming)}」（{confirming.source_id}）的全部 {thousands(confirming.rules_total ?? 0)} 条规则和登记，删了不能恢复。{can('deactivate') ? '只是暂时不用的话，点「下线」。' : ''}
          </p>
        )}
      </Modal>
      <SourceDetail source={viewing} agent={agent} onClose={() => setViewing(null)} />
    </Panel>
  );
}

/** 「查看」：一份制度的登记和规则编号（GET /poc/kb/sources/:id，一次 A2A 调用）。 */
function SourceDetail({ source, agent, onClose }: { source: KbSource | null; agent: Agent; onClose: () => void }) {
  const last = useRef<KbSource | null>(null);
  if (source) last.current = source;
  const shown = source ?? last.current;
  const id = shown?.source_id ?? '';
  const detail = useQuery({ queryKey: kbKeys.source(id), queryFn: () => fetchSource(id, agent), enabled: Boolean(source), retry: false });
  const value = detail.data?.source ?? shown;
  const ruleIds = Array.isArray(detail.data?.rule_ids) ? detail.data.rule_ids : [];
  const rows: Array<[string, string]> = value ? [
    ['制度标识', value.source_id], ['版本', value.source_version || '—'], ['文件', value.file_name || '—'], ['条数', thousands(value.rules_total)],
    ['状态', STATUS[value.status ?? '']?.text ?? (value.status || '—')], ['入库时间', timeText(value.ingested_at)], ['更新时间', timeText(value.updated_at)],
  ] : [];
  return (
    <Modal open={Boolean(source)} onOpenChange={next => { if (!next) onClose(); }} title={shown ? nameOf(shown) : '制度'} icon="knowledge" width={520}>
      <div className="px-[18px] pb-4 pt-3">
        <dl className="m-0 grid grid-cols-[88px_1fr] gap-x-3 gap-y-[6px] text-13">
          {rows.map(([label, text]) => <div key={label} className="contents"><dt className="text-steel">{label}</dt><dd className="m-0 break-all">{text}</dd></div>)}
        </dl>
        <div className="mt-4 border-t border-line pt-3">
          {detail.isPending ? <p role="status" className="m-0 text-13 text-steel">正在读取规则编号（约 10–20 秒）…</p>
            : detail.isError ? <p role="alert" className="m-0 text-13 text-fail-ink">{messageOf(detail.error)}</p> : (
              <>
                <p className="m-0 text-13 font-semibold">规则编号 {ruleIds.length} 条</p>
                {ruleIds.length ? (
                  <ul className="m-0 mt-2 flex max-h-[240px] list-none flex-wrap gap-[6px] overflow-auto p-0">
                    {ruleIds.map(rule => <li key={rule} className="rounded-ctl border border-blue-200 bg-blue-50 px-[6px] py-[1px] text-12 text-blue">{rule}</li>)}
                  </ul>
                ) : <p className="m-0 mt-1 text-13 text-steel">这份制度下没有规则。</p>}
              </>
            )}
        </div>
      </div>
    </Modal>
  );
}
