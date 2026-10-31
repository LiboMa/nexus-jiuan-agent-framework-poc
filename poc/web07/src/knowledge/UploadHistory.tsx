/**
 * 上传记录（补丁 0005；外壳自己记的，最近 50 条）：有「入库中」的就每 2.5 秒再读一次，停下时制度清单跟着刷新。只给管理员。
 */
import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { timeText } from '../api/documents';
import { KB_POLL_MS, clip, fetchUploads, kbKeys, thousands, type KbUpload } from '../api/knowledge';
import { Button } from '../ui/Button';
import { Empty } from '../ui/Empty';
import { Panel } from '../ui/Panel';
import { Pill, type Tone } from '../ui/Pill';
import { cx } from '../ui/cx';
import { messageOf } from './AgentNotice';

const STATUS: Record<string, { text: string; tone: Tone; icon?: 'refresh' | null }> = {
  ingesting: { text: '入库中', tone: 'wait', icon: 'refresh' }, ingested: { text: '已入库', tone: 'pass' }, skipped: { text: '没有变化', tone: 'info', icon: null }, failed: { text: '失败', tone: 'fail' },
};
const outcome = (item: KbUpload) => (item.status === 'ingested' ? `写入 ${item.written ?? 0} / 删除 ${item.removed ?? 0} / 不变 ${item.unchanged ?? 0}`
  : item.status === 'skipped' ? '和库里的一样，没有重写' : item.status === 'failed' ? clip(item.error?.message || '失败', 80) : '—');
const running = (items: KbUpload[] | undefined) => Boolean(items?.some(item => item.status === 'ingesting'));

export function UploadHistory() {
  const queryClient = useQueryClient();
  const uploads = useQuery({ queryKey: kbKeys.uploads, queryFn: fetchUploads, refetchInterval: query => (running(query.state.data) ? KB_POLL_MS : false) });
  // 入库中的那几条都停下了：制度清单可能变了（已经在读就不重来，一次 A2A 调用要 10–20 秒）
  const was = useRef(false);
  const now = running(uploads.data);
  useEffect(() => {
    if (was.current && !now) void queryClient.invalidateQueries({ queryKey: kbKeys.sources }, { cancelRefetch: false });
    was.current = now;
  }, [now, queryClient]);

  const items = uploads.data ?? [];
  const head = 'whitespace-nowrap border-b border-line px-3 py-[9px] text-left text-12 font-medium text-steel';
  const cell = 'whitespace-nowrap border-b border-line px-3 py-[11px]';
  return (
    <Panel title="上传记录" className="mt-[14px]" extra={<Button size="sm" icon="refresh" disabled={uploads.isFetching} onClick={() => void uploads.refetch()}>刷新记录</Button>}>
      {uploads.isPending ? <p role="status" className="m-0 px-4 py-8 text-center text-13 text-steel">正在读取上传记录…</p>
        : uploads.isError && !uploads.data ? (
          <Empty icon="warning" title="上传记录没有读出来" description={messageOf(uploads.error)} action={<Button icon="refresh" onClick={() => void uploads.refetch()}>重新读取</Button>} />
        ) : !items.length ? <Empty icon="upload" title="还没有上传过制度" description="上传制度后，每一次入库的结果都记在这里。" />
          : (
            <div className="overflow-x-auto">
              <table aria-label="上传记录" className="w-full border-collapse">
                <thead>
                  <tr>{['时间', '文件', '上传人', '制度标识', '版本', '状态', '条数', '用时', '结果'].map(name => <th key={name} scope="col" className={cx(head, (name === '条数' || name === '用时') && 'text-right')}>{name}</th>)}</tr>
                </thead>
                <tbody>
                  {items.map(item => {
                    const status = STATUS[item.status];
                    return (
                      <tr key={item.id} data-upload={item.id}>
                        <td className={cx(cell, 'text-steel')}>{timeText(item.at)}</td>
                        <td className={cx(cell, 'max-w-[220px] truncate')} title={item.fileName}>{item.fileName || '—'}</td>
                        <td className={cx(cell, 'text-steel')}>{item.by || '—'}</td>
                        <td className={cell}>{item.sourceId || '—'}</td>
                        <td className={cx(cell, 'max-w-[140px] truncate text-steel')}>{item.sourceVersion || '—'}</td>
                        <td className={cell}>{status ? <Pill tone={status.tone} icon={status.icon}>{status.text}</Pill> : <Pill>{item.status || '—'}</Pill>}</td>
                        <td className={cx(cell, 'text-right')}>{thousands(item.rulesTotal)}</td>
                        <td className={cx(cell, 'text-right text-steel')}>{typeof item.elapsedMs === 'number' && Number.isFinite(item.elapsedMs) ? `${Math.round(item.elapsedMs / 1000)} 秒` : '—'}</td>
                        <td className={cx(cell, 'max-w-[320px] truncate', item.status === 'failed' ? 'text-fail-ink' : 'text-steel')} title={item.error?.message}>{outcome(item)}</td>
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
