/**
 * 单据池「最近审核」一栏（2026-11-01）：一张单最后一次被审是什么时候、谁审的。
 *   AI 的时间：当前一轮定局了（完成 / 失败 / 拒绝）取 finishedAt，在跑取 startedAt；
 *   复核的时间：这一轮的最后一次复核（latest.review 审的就是当前一轮时）的 createdAt；
 *   两个取晚的（一样晚算复核：复核总在这一轮出结果之后）；第二行是「复核 · 名字」或「AI 建议 / AI 失败 / AI 拒绝 / AI 开始」。都没有回 null（格子里写「—」）。
 * 排序：最近的在前 → 最早的在前 → 原来的顺序（九安的顺序，默认）；没有时间的两个方向都排在最后，一样的时间保持原来的先后。
 */
import type { LatestState } from '../api/documents';

export interface LastAudit { at: string; by: string }
export type AuditSort = 'none' | 'descending' | 'ascending';
/** 点一下表头换到的下一种排序。 */
export const NEXT_SORT: Readonly<Record<AuditSort, AuditSort>> = { none: 'descending', descending: 'ascending', ascending: 'none' };

/** 定局的一轮：取结束的时间；在跑的一轮取开始的时间。 */
const AI_LABELS: Readonly<Record<string, { label: string; field: 'startedAt' | 'finishedAt' }>> = {
  completed: { label: 'AI 建议', field: 'finishedAt' },
  failed: { label: 'AI 失败', field: 'finishedAt' },
  declined: { label: 'AI 拒绝', field: 'finishedAt' },
  running: { label: 'AI 开始', field: 'startedAt' },
};
const msOf = (at: unknown): number | null => {
  const ms = typeof at === 'string' ? Date.parse(at) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

export function lastAudit(latest: LatestState | null | undefined): LastAudit | null {
  const current = latest?.current ?? null;
  const ai = current && Object.hasOwn(AI_LABELS, current.status) ? AI_LABELS[current.status] : null;
  const aiAt = ai && current ? current[ai.field] ?? null : null;
  const aiMs = msOf(aiAt);
  const review = latest?.review ?? null;
  // 只算这一轮的复核：复核的是更早的一轮（outdated）时，那是旧消息
  const ours = review && (!current || review.adviceRound === current.round) ? review : null;
  const reviewMs = msOf(ours?.createdAt);
  if (ours && reviewMs !== null && (aiMs === null || reviewMs >= aiMs)) {
    const name = typeof ours.actorName === 'string' && ours.actorName.trim() ? ours.actorName : ours.actor;
    return { at: ours.createdAt, by: `复核 · ${name}` };
  }
  return ai && aiMs !== null ? { at: aiAt as string, by: ai.label } : null;
}

/** 按最近审核排（不改原来的数组）；none 回原来的顺序。 */
export function sortByLastAudit<T extends { id: string }>(items: readonly T[], auditOf: (id: string) => LastAudit | null, sort: AuditSort): T[] {
  if (sort === 'none') return [...items];
  const sign = sort === 'descending' ? -1 : 1;
  return items
    .map((item, index) => ({ item, index, ms: msOf(auditOf(item.id)?.at) }))
    .sort((a, b) => {
      if (a.ms === null || b.ms === null) return a.ms === b.ms ? a.index - b.index : a.ms === null ? 1 : -1;
      return sign * (a.ms - b.ms) || a.index - b.index;
    })
    .map(({ item }) => item);
}
