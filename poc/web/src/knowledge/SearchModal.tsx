/**
 * 「检索」弹框（Spec 第 6 节；补丁 0005「按问题检索」）：问题必填，板块、金额可空（空的不传），条数 8。和审核 Agent 审单时用的是同一个检索。
 * 一次 A2A 调用（约 10–20 秒）：进行中按钮不可点；工具自己失败（200 + success:false）照它的话显示。
 */
import { useRef, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../api/client';
import { AMOUNT, NOT_READY_CODES, WORKING, clipChars, kbKeys, searchRules, type Agent, type KbHit, type SearchInput } from '../api/knowledge';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { messageOf } from './AgentNotice';

const inputClass = 'h-[30px] min-w-0 rounded-ctl border border-line bg-surface px-[10px] text-13 text-ink hover:border-faint focus:border-blue';
const segmentsText = (list: KbHit['segments']) => (Array.isArray(list) && list.length ? list.map(item => (item === '*' ? '全部板块' : item)).join('、') : '—');

export function SearchModal({ open, onClose, agent }: { open: boolean; onClose: () => void; agent: Agent }) {
  const queryClient = useQueryClient();
  const [q, setQ] = useState('');
  const [segment, setSegment] = useState('');
  const [amount, setAmount] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const inFlight = useRef(false);
  const search = useMutation({
    mutationFn: (input: SearchInput) => searchRules(input, agent),
    onError: error => { if (error instanceof ApiError && NOT_READY_CODES.has(error.code)) void queryClient.invalidateQueries({ queryKey: kbKeys.mode }); },
    onSettled: () => { inFlight.current = false; },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current) return;
    const text = q.trim(), where = segment.trim(), money = amount.trim().replace(/[,，\s]/gu, '');
    if (!text) { setProblem('请写一个问题'); return; }
    if (money && !AMOUNT.test(money)) { setProblem('金额写以元为单位的数字，例如 300000'); return; }
    setProblem(null);
    inFlight.current = true;
    search.mutate({ q: text, segment: where, amount: money });
  }

  const hits = search.data?.results ?? [];
  return (
    <Modal open={open} onOpenChange={next => { if (!next) onClose(); }} title="检索规则" icon="search" width={640} description={agent.search}>
      <form onSubmit={submit} className="flex flex-wrap items-center gap-2 px-[18px] pt-3">
        <input aria-label="问题" value={q} onChange={event => setQ(clipChars(event.target.value, 2000))} placeholder="例如：九安的房租年度框架合同，谁最终审批？"
          autoComplete="off" className={`${inputClass} w-full`} />
        <input aria-label="板块" value={segment} onChange={event => setSegment(clipChars(event.target.value, 40))} placeholder="板块，例如 九安（可空）" autoComplete="off" className={`${inputClass} flex-1`} />
        <input aria-label="金额（元）" value={amount} onChange={event => setAmount(event.target.value.slice(0, 20))} placeholder="金额，元（可空）" inputMode="decimal" autoComplete="off" className={`${inputClass} flex-1`} />
        <Button type="submit" variant="primary" icon="search" busy={search.isPending}>检索</Button>
      </form>
      <div className="px-[18px] pb-4 pt-3">
        {problem && <p role="alert" className="m-0 text-13 text-fail-ink">{problem}</p>}
        {search.isPending && <p role="status" className="m-0 text-13 text-steel">{WORKING}</p>}
        {search.isError && <p role="alert" className="m-0 text-13 text-fail-ink">{messageOf(search.error)}</p>}
        {search.isSuccess && (hits.length ? (
          <ol aria-label="检索结果" className="m-0 flex list-none flex-col p-0">
            {hits.map((hit, index) => (
              <li key={`${hit.rule_id}-${index}`} className="border-t border-line py-[10px] first:border-t-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-12 text-steel">
                  <span className="text-faint">#{index + 1}</span>
                  <b className="text-13 font-semibold text-ink">{hit.rule_id}</b>
                  <span>{segmentsText(hit.segments)}</span>
                  {hit.source_id && <span>{hit.source_id}</span>}
                  <span className="ml-auto">{typeof hit.distance === 'number' && Number.isFinite(hit.distance) ? `距离 ${hit.distance.toFixed(3)}` : '距离 —'}</span>
                </div>
                <p className="m-0 mt-1 whitespace-pre-wrap break-words text-13 text-ink">{hit.text || '—'}</p>
              </li>
            ))}
          </ol>
        ) : (
          <div className="py-6 text-center">
            <p className="m-0 text-14 font-semibold">没有找到规则</p>
            <p className="m-0 mt-1 text-13 text-steel">换几个关键词，或去掉板块、金额再检索。</p>
          </div>
        ))}
      </div>
    </Modal>
  );
}
