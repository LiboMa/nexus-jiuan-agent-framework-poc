/**
 * 抽屉的「历史」页签：AI 建议的各轮（外壳 GET /poc/advice-rounds，新的在前；九安的 advice 接口只给当前一轮，Ruling T5e）
 * 和这张单的复核记录（GET /poc/reviews?documentId=，新的在前；以最后一次为准）。
 */
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchReviews, fetchRounds, keys, timeText, type AdviceRound } from '../api/documents';
import { Button } from '../ui/Button';
import { Pill } from '../ui/Pill';
import { decisionText, reasonText, roundLabel } from './labels';

const SYSTEM = 'system:pipeline';
const triggerText = (round: AdviceRound) => (round.trigger === 'manual' || (round.requestedBy && round.requestedBy !== SYSTEM)
  ? `人工发起${round.requestedBy && round.requestedBy !== SYSTEM ? ` · ${round.requestedBy}` : ''}` : '自动发起');
const order = (round: AdviceRound) => (Number.isSafeInteger(round.round) ? (round.round as number) : -1);

export function HistoryTab({ id }: { id: string }) {
  const rounds = useQuery({ queryKey: keys.rounds(id), queryFn: () => fetchRounds(id) });
  const reviews = useQuery({ queryKey: keys.reviews(id), queryFn: () => fetchReviews(id) });
  const roundItems = [...(rounds.data?.items ?? [])].sort((a, b) => order(b) - order(a));
  const reviewItems = reviews.data?.items ?? [];
  return (
    <div className="px-[18px] py-[14px]">
      <Section title="AI 建议的各轮" query={rounds} empty={!roundItems.length && '还没有跑过 AI 建议：单据读取完成后平台会自动发起。'}>
        <ol aria-label="AI 建议的各轮" className="m-0 list-none p-0">
          {roundItems.map((round, index) => {
            const label = roundLabel(round);
            const old = rounds.data?.documentVersion && round.documentVersion && round.documentVersion !== rounds.data.documentVersion;
            return (
              <li key={`${round.round}-${index}`} className="border-t border-line py-[10px] first:border-t-0">
                <div className="flex flex-wrap items-center gap-2">
                  <b data-round="" className="font-semibold">第 {round.round ?? '—'} 轮</b>
                  <Pill tone={label.tone} icon={label.icon}>{label.text}</Pill>
                  {round.current && <Pill tone="info" icon={null}>当前</Pill>}
                  {old && <Pill tone="neutral" icon={null}>针对旧版本</Pill>}
                  <span className="ml-auto text-12 text-faint">{timeText(round.finishedAt ?? round.startedAt)}</span>
                </div>
                <div className="mt-[2px] text-12 text-steel">
                  {[triggerText(round), round.errorCode ? `错误码 ${round.errorCode}` : null, round.basis?.length ? `依据 ${round.basis.length} 条` : null].filter(Boolean).join(' · ')}
                </div>
              </li>
            );
          })}
        </ol>
      </Section>
      <Section title="复核记录" query={reviews} empty={!reviewItems.length && '还没有复核记录：采纳或改判 AI 建议后会记在这里（只记录在本平台，不回写汇联易）。'}>
        <ol aria-label="复核记录" className="m-0 list-none p-0">
          {reviewItems.map(review => (
            <li key={review.id} className="border-t border-line py-[10px] first:border-t-0">
              <div className="flex flex-wrap items-center gap-2">
                <b className="font-semibold">{decisionText(review)}</b>
                {review.reason && <span className="text-13 text-steel">{reasonText(review.reason)}</span>}
                <span className="ml-auto text-12 text-faint">{timeText(review.createdAt)}</span>
              </div>
              <div className="mt-[2px] text-12 text-steel">第 {review.adviceRound} 轮 · {review.actorName?.trim() ? review.actorName : review.actor}</div>
              {review.note && <p className="m-0 mt-1 whitespace-pre-wrap text-13 text-ink">{review.note}</p>}
            </li>
          ))}
        </ol>
      </Section>
    </div>
  );
}

function Section({ title, query, empty, children }: {
  title: string; query: { isPending: boolean; isError: boolean; error: Error | null; refetch: () => unknown }; empty: string | false; children: ReactNode;
}) {
  return (
    <section className="mt-4 first:mt-0">
      <h3 className="m-0 mb-1 text-13 font-semibold">{title}</h3>
      {query.isPending ? <p role="status" className="m-0 text-13 text-steel">正在读取…</p>
        : query.isError ? (
          <div>
            <p role="alert" className="m-0 text-13 text-fail-ink">{query.error?.message}</p>
            <Button size="sm" icon="refresh" className="mt-2" onClick={() => void query.refetch()}>重新读取</Button>
          </div>
        )
          : empty ? <p className="m-0 text-13 text-steel">{empty}</p> : children}
    </section>
  );
}
