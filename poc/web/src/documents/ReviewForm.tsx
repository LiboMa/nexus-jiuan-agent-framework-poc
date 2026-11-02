/**
 * 抽屉底部的复核区（样稿 drawer-a.html；Spec 第 9 节）：按单据、绑定当前那一轮（外壳 /poc/reviews/latest 的 current.round）。
 * 采纳 AI 建议，或改判（原因按方向：AI 不建议通过 → 改判为通过的五个，AI 建议通过 → 改判为不通过的五个；「其他」必须写备注；备注 ≤ 200 字）。
 * 「提交复核」成功后由单据池开下一张待复核（Ruling T5f），工作台的数作废重读（F3）。409（REVIEW_STALE / REVIEW_ADVICE_NOT_READY）照服务端的话提示，并刷新这张单（Review Focus 3）。
 */
import { useRef, useState, type KeyboardEvent } from 'react';
import { useMutation, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { ApiError } from '../api/client';
import { dashboardKeys } from '../api/dashboard';
import {
  NOTE_MAX, OVERRIDE_REASONS, REASON_LABELS, keys, limitNote, noteLength, submitReview, timeText, type AiResult, type LatestState, type OverrideReason, type ReviewInput,
} from '../api/documents';
import { Button } from '../ui/Button';
import { cx } from '../ui/cx';
import { decisionText, reasonText } from './labels';

type Decision = 'adopt' | 'override';
const RESULT_TEXT: Record<AiResult, string> = { pass: '建议通过', fail: '不建议通过' };
const REFRESH_ON = new Set(['REVIEW_STALE', 'REVIEW_ADVICE_NOT_READY']);
const field = 'w-full rounded-ctl border border-line bg-surface px-[10px] text-13 text-ink hover:border-faint focus:border-blue disabled:opacity-55';

export function ReviewForm({ id, version, latest, onReviewed, onNext, hasNext }: {
  id: string; version: string; latest: UseQueryResult<LatestState | null, Error>; onReviewed: (documentId: string) => void; onNext?: () => void; hasNext: boolean;
}) {
  const queryClient = useQueryClient();
  const [decision, setDecision] = useState<Decision>('adopt');
  const [reason, setReason] = useState<OverrideReason | ''>('');
  const [note, setNote] = useState('');
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  // 正在提交：按钮要等下一次渲染才变灰，连点两下的第二下在这里挡住
  const inFlight = useRef(false);
  const value = latest.data;
  const ai = value?.current?.result;
  const round = value?.current?.round;
  const ready = Boolean(value && ['pending', 'outdated', 'reviewed'].includes(value.state) && (ai === 'pass' || ai === 'fail') && Number.isSafeInteger(round) && version);

  // 回调里一律用这一次提交的单据（变量），不用渲染时的 id：提交还在路上时人可能已经换了单
  const submit = useMutation({
    mutationFn: (input: ReviewInput) => submitReview(input),
    onSuccess: ({ review }, input) => {
      const doc = input.documentId;
      // 先把这张单在各处的复核状态改成「已复核」（单据池马上换页签），再整体刷新
      queryClient.setQueriesData<Record<string, LatestState>>({ queryKey: ['reviews', 'latest', 'pool'] },
        old => (old?.[doc] ? { ...old, [doc]: { ...old[doc], state: 'reviewed', review } } : old));
      queryClient.setQueryData<LatestState | null>(keys.latest(doc), old => (old ? { ...old, state: 'reviewed', review } : old));
      void queryClient.invalidateQueries({ queryKey: ['reviews'] });
      void queryClient.invalidateQueries({ queryKey: keys.rounds(doc) });
      // 工作台的待复核、改判数跟着变：每个窗口的那份都作废（外壳的缓存也清了，F3）
      void queryClient.invalidateQueries({ queryKey: dashboardKeys.all });
      onReviewed(doc);
    },
    onError: (error, input) => {
      if (error instanceof ApiError && REFRESH_ON.has(error.code)) {
        const doc = input.documentId;
        for (const key of [keys.advice(doc), keys.document(doc), keys.rounds(doc), ['reviews']]) void queryClient.invalidateQueries({ queryKey: key });
      }
    },
    onSettled: () => { inFlight.current = false; },
  });

  const trimmed = note.trim();
  // 刷新后 AI 的结论可能换了方向：不属于这个方向的原因当没选
  const picked = ai && reason && (OVERRIDE_REASONS[ai] as readonly string[]).includes(reason) ? reason : '';
  const problem = !ready ? null
    : decision === 'override' && !picked ? '选一个改判原因再提交'
      : decision === 'override' && picked === 'other' && !trimmed ? '选了「其他」，写上备注再提交' : null;
  function send() {
    if (inFlight.current || !ready || problem || !value?.current || !ai) return;
    inFlight.current = true;
    submit.mutate({ documentId: id, sourceVersion: version, round: value.current.round, decision,
      ...(decision === 'override' && picked ? { reason: picked } : {}), ...(decision === 'override' && trimmed ? { note: trimmed } : {}) });
  }
  function choose(next: Decision) {
    setDecision(next);
    if (next === 'adopt') { setReason(''); setNote(''); }
  }
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    const next = index === 0 ? 1 : 0;
    choose(next === 0 ? 'adopt' : 'override');
    refs.current[next]?.focus();
  }

  const options: Array<{ value: Decision; title: string; note: string }> = [
    { value: 'adopt', title: '采纳 AI 建议', note: ai ? `按「${RESULT_TEXT[ai]}」处理` : '按 AI 的结论处理' },
    { value: 'override', title: '改判', note: ai === 'pass' ? '我认为不应该通过' : ai === 'fail' ? '我认为应该通过' : '和 AI 的结论相反' },
  ];
  const waiting = !latest.isPending && !latest.isError && !ready;

  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <b className="text-14">复核</b>
        <span className="text-12 text-steel">只记录在本平台，不回写汇联易</span>
      </div>
      {value?.state === 'outdated' && value.review && (
        <p className="m-0 mt-2 text-13 text-wait-ink">AI 建议已更新：上次复核的是第 {value.review.adviceRound} 轮，请按第 {round} 轮的建议重新复核。</p>
      )}
      {value?.state === 'reviewed' && value.review && (
        <p className="m-0 mt-2 text-13 text-steel">
          已复核：{decisionText(value.review)}{value.review.reason ? `（${reasonText(value.review.reason)}）` : ''} · {value.review.actor} · {timeText(value.review.createdAt)}。再提交一次会以最后一次为准。
        </p>
      )}
      {latest.isPending && <p role="status" className="m-0 mt-2 text-13 text-steel">正在读取复核状态…</p>}
      {latest.isError && <p role="alert" className="m-0 mt-2 text-13 text-fail-ink">{latest.error.message}</p>}
      {waiting && (
        <p className="m-0 mt-2 text-13 text-steel">
          <span className="font-semibold text-ink">等 AI 建议出来再复核</span>
          <span className="ml-2">{value?.state === 'running' ? 'AI 正在审核，出结果后这里就能提交。' : '上面「AI 建议」里有下一步该做什么。'}</span>
        </p>
      )}

      {/* 还不能复核时不画两个选项：免得看起来像已经选了「采纳」 */}
      {ready && <div role="radiogroup" aria-label="复核结论" className="mt-[10px] grid grid-cols-2 gap-2">
        {options.map((option, index) => {
          const on = decision === option.value;
          return (
            <button
              key={option.value} ref={node => { refs.current[index] = node; }} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1}
              disabled={submit.isPending} onClick={() => choose(option.value)} onKeyDown={event => onKeyDown(event, index)}
              className={cx('border bg-surface px-3 py-[10px] text-left disabled:cursor-not-allowed disabled:opacity-55', on ? 'border-blue shadow-[inset_0_0_0_1px_var(--color-blue)]' : 'border-line hover:border-faint')}
            >
              <b className="block text-13 font-semibold">{option.title}</b>
              <span className="block text-12 text-steel">{option.note}</span>
            </button>
          );
        })}
      </div>}

      {decision === 'override' && ready && ai && (
        <div className="mt-2 flex flex-col gap-2">
          <select aria-label="改判原因" value={picked} onChange={event => setReason(event.target.value as OverrideReason | '')} className={cx(field, 'h-[30px]')} disabled={submit.isPending}>
            <option value="">选一个原因</option>
            {OVERRIDE_REASONS[ai].map(code => <option key={code} value={code}>{REASON_LABELS[code]}</option>)}
          </select>
          <div>
            <textarea
              aria-label="备注" rows={2} value={note} disabled={submit.isPending}
              onChange={event => setNote(limitNote(event.target.value))}
              placeholder={picked === 'other' ? '写一下为什么改判（必填）' : '写一下为什么改判（选填）'} className={cx(field, 'block resize-none py-[6px]')}
            />
            <div className="mt-[2px] text-right text-12 text-steel">{noteLength(note)} / {NOTE_MAX}</div>
          </div>
        </div>
      )}
      {problem && <p className="m-0 mt-2 text-12 text-wait-ink">{problem}</p>}
      {submit.isError && <p role="alert" className="m-0 mt-2 text-13 text-fail-ink">{submit.error.message}</p>}

      <div className="mt-3 flex justify-end gap-2">
        <Button disabled={!hasNext || !onNext} onClick={() => onNext?.()}>下一张</Button>
        <Button variant="primary" busy={submit.isPending} disabled={!ready || Boolean(problem)} onClick={send}>提交复核</Button>
      </div>
    </div>
  );
}
