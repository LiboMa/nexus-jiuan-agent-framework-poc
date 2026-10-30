/**
 * 单据池、抽屉、历史共用的状态字样：每个状态一个词、一个记号（状态色一律配图标和文字）。
 */
import type { AdviceRound, LatestState, Review } from '../api/documents';
import { REASON_LABELS, type OverrideReason } from '../api/documents';
import type { Role } from '../api/session';
import type { IconName } from '../ui/icons';
import type { Tone } from '../ui/Pill';

/** 能动手的角色（复核、重新审核、读取原件）：管理员、分析员；规则发布复核人只看。 */
export const canAct = (role: Role | string | undefined) => role === 'admin' || role === 'analyst';
/** 原件读取进行中的状态（这时每 3 秒看一次）。 */
export const EVIDENCE_PENDING: ReadonlySet<string> = new Set(['queued', 'running']);

export interface Label { text: string; tone: Tone; icon?: IconName | null }

const RESULT: Record<'pass' | 'fail', Label> = { pass: { text: '建议通过', tone: 'pass' }, fail: { text: '不建议通过', tone: 'fail' } };

/** 单据池「AI 建议」一栏：按外壳给的当前一轮。 */
export function adviceLabel(latest: LatestState): Label {
  const current = latest.current;
  if (latest.state === 'running' || current?.status === 'running') return { text: '审核中', tone: 'wait', icon: 'refresh' };
  if (['pending', 'reviewed', 'outdated'].includes(latest.state) && (current?.result === 'pass' || current?.result === 'fail')) return RESULT[current.result];
  if (current?.status === 'failed') return { text: '没有完成', tone: 'wait', icon: 'warning' };
  if (current?.status === 'declined') return { text: '没有给出建议', tone: 'wait', icon: 'warning' };
  // 完成了、却不能复核：这一轮审的是单据更早的版本，平台会重新发起
  if (current?.status === 'completed') return { text: '建议待更新', tone: 'neutral', icon: 'refresh' };
  return { text: '还没有建议', tone: 'neutral', icon: null };
}

/** 单据池「复核」一栏。pill=false 时是一行字（待复核、等 AI 建议）。 */
export function reviewLabel(latest: LatestState): Label & { pill: boolean } {
  if (latest.state === 'pending') return { text: '待复核', tone: 'neutral', pill: false };
  if (latest.state === 'outdated') return { text: 'AI 建议已更新', tone: 'wait', icon: 'refresh', pill: true };
  if (latest.state === 'reviewed') return { text: latest.review?.decision === 'override' ? '已改判' : '已采纳', tone: 'neutral', pill: true };
  return { text: '等 AI 建议', tone: 'neutral', pill: false };
}

/** 历史里一轮的状态。 */
export function roundLabel(round: Pick<AdviceRound, 'status' | 'result'>): Label {
  if (round.status === 'completed' && (round.result === 'pass' || round.result === 'fail')) return RESULT[round.result];
  return ({
    running: { text: '审核中', tone: 'wait', icon: 'refresh' },
    failed: { text: '没有完成', tone: 'wait', icon: 'warning' },
    declined: { text: '没有给出建议', tone: 'wait', icon: 'warning' },
    superseded: { text: '被新一轮取代', tone: 'neutral' },
    completed: { text: '已完成', tone: 'neutral' },
  } as Record<string, Label>)[round.status ?? ''] ?? { text: '没有跑', tone: 'neutral' };
}

/** 一次复核做了什么：采纳 AI 建议 / 改判为通过 / 改判为不通过。 */
export const decisionText = (review: Pick<Review, 'decision' | 'finalResult'>) =>
  review.decision === 'adopt' ? '采纳 AI 建议' : review.finalResult === 'pass' ? '改判为通过' : '改判为不通过';
export const reasonText = (reason: string | null | undefined) => (reason && Object.hasOwn(REASON_LABELS, reason) ? REASON_LABELS[reason as OverrideReason] : reason ?? '');
