import { describe, expect, it } from 'vitest';
import { fullTimeText, timeText, type LatestState } from '../api/documents';
import { NEXT_SORT, lastAudit, sortByLastAudit, type LastAudit } from '../documents/lastAudit';

// 单据池「最近审核」一栏（2026-11-01）：这一轮最后一次复核的时间和 AI 的时间（定局的一轮取结束、在跑的取开始）取晚的那个；
// 第二行说是谁：「复核 · 名字」或 AI 建议 / AI 失败 / AI 拒绝 / AI 开始。北京时间。
type Current = NonNullable<LatestState['current']>;
const current = (over: Partial<Current> = {}): Current => ({ round: 2, result: 'pass', status: 'completed', startedAt: '2026-11-01T06:00:00.000Z', finishedAt: '2026-11-01T06:02:00.000Z', ...over });
const review = (over: Record<string, unknown> = {}) => ({ id: 1, documentId: 'd', documentVersion: 'v', adviceRound: 2, aiResult: 'pass', decision: 'adopt', finalResult: 'pass', reason: null, note: null,
  actor: 'poc-reviewer', actorName: '审核员（虚构）', createdAt: '2026-11-01T07:20:00.000Z', ...over }) as LatestState['review'];
const latest = (state: LatestState['state'], cur: Current | null, rev: LatestState['review'] = null): LatestState => ({ state, current: cur, review: rev });

describe('lastAudit(latest): the value and the second line', () => {
  it('names the AI side by how the current round ended: 完成 → AI 建议, 失败 → AI 失败, 拒绝 → AI 拒绝 (all at finishedAt), 在跑 → AI 开始 (at startedAt)', () => {
    expect(lastAudit(latest('pending', current()))).toEqual({ at: '2026-11-01T06:02:00.000Z', by: 'AI 建议' });
    expect(lastAudit(latest('no_advice', current({ status: 'failed', result: null, finishedAt: '2026-11-01T06:00:07.000Z' })))).toEqual({ at: '2026-11-01T06:00:07.000Z', by: 'AI 失败' });
    expect(lastAudit(latest('no_advice', current({ status: 'declined', result: null })))).toEqual({ at: '2026-11-01T06:02:00.000Z', by: 'AI 拒绝' });
    expect(lastAudit(latest('running', current({ status: 'running', result: null, finishedAt: null })))).toEqual({ at: '2026-11-01T06:00:00.000Z', by: 'AI 开始' });
    // 在跑的一轮不看 finishedAt（九安在跑时不写它；就算有也不算）
    expect(lastAudit(latest('running', current({ status: 'running', result: null, startedAt: '2026-11-01T06:10:00.000Z', finishedAt: '2026-11-01T06:02:00.000Z' }))))
      .toEqual({ at: '2026-11-01T06:10:00.000Z', by: 'AI 开始' });
  });

  it('「复核 · <actorName>」 when this round\'s review is the later of the two; the account when the name is missing', () => {
    expect(lastAudit(latest('reviewed', current(), review()))).toEqual({ at: '2026-11-01T07:20:00.000Z', by: '复核 · 审核员（虚构）' });
    expect(lastAudit(latest('reviewed', current(), review({ actorName: '' })))).toEqual({ at: '2026-11-01T07:20:00.000Z', by: '复核 · poc-reviewer' });
    expect(lastAudit(latest('reviewed', current(), review({ actorName: undefined })))?.by).toBe('复核 · poc-reviewer');
  });

  it('takes the later of the review and the AI time', () => {
    // 复核之后人又发起了一轮、还在跑：AI 开始更晚
    const rerun = current({ status: 'running', result: null, startedAt: '2026-11-01T07:30:00.000Z', finishedAt: null });
    expect(lastAudit(latest('running', rerun, review({ adviceRound: 2 })))).toEqual({ at: '2026-11-01T07:30:00.000Z', by: 'AI 开始' });
    // 复核比这一轮结束晚：复核
    expect(lastAudit(latest('reviewed', current({ finishedAt: '2026-11-01T07:19:59.999Z' }), review()))).toEqual({ at: '2026-11-01T07:20:00.000Z', by: '复核 · 审核员（虚构）' });
    // 这一轮结束比复核晚（不该有，但照规则）：AI
    expect(lastAudit(latest('reviewed', current({ finishedAt: '2026-11-01T07:20:00.001Z' }), review()))).toEqual({ at: '2026-11-01T07:20:00.001Z', by: 'AI 建议' });
    // AI 那边没有时间：只有复核
    expect(lastAudit(latest('reviewed', current({ startedAt: null, finishedAt: null }), review()))).toEqual({ at: '2026-11-01T07:20:00.000Z', by: '复核 · 审核员（虚构）' });
  });

  it('only a review of the current round counts (an outdated review is older news)', () => {
    // 复核的是第 1 轮，现在是第 2 轮：只看第 2 轮的时间，哪怕复核的时间写得更晚
    expect(lastAudit(latest('outdated', current({ round: 2 }), review({ adviceRound: 1, createdAt: '2026-11-01T08:00:00.000Z' })))).toEqual({ at: '2026-11-01T06:02:00.000Z', by: 'AI 建议' });
    expect(lastAudit(latest('outdated', current({ round: 2, startedAt: null, finishedAt: null }), review({ adviceRound: 1 })))).toBeNull();
  });

  it('nothing known → null (the cell shows 「—」)', () => {
    expect(lastAudit(undefined)).toBeNull();
    expect(lastAudit(null)).toBeNull();
    expect(lastAudit(latest('no_advice', null))).toBeNull();
    expect(lastAudit(latest('pending', current({ startedAt: null, finishedAt: null })))).toBeNull();
    // 手写的旧样子（没有时间字段）也当没有
    expect(lastAudit({ state: 'pending', current: { round: 1, result: 'pass', status: 'completed' } as Current, review: null })).toBeNull();
    // 完成了却没有结束时间：不拿开始时间凑
    expect(lastAudit(latest('pending', current({ finishedAt: null })))).toBeNull();
    // 读不出的时间、不认识的状态
    expect(lastAudit(latest('pending', current({ finishedAt: 'not a time' })))).toBeNull();
    expect(lastAudit(latest('no_advice', current({ status: 'superseded' })))).toBeNull();
    expect(lastAudit(latest('reviewed', current({ startedAt: null, finishedAt: null }), review({ createdAt: 'x' })))).toBeNull();
  });
});

describe('Shanghai time: 「MM-DD HH:mm」 in the cell, 「YYYY-MM-DD HH:mm:ss」 on hover', () => {
  it('crosses midnight and the new year in Asia/Shanghai, not UTC', () => {
    expect(timeText('2026-10-31T15:59:59.000Z')).toBe('10-31 23:59');
    expect(fullTimeText('2026-10-31T15:59:59.000Z')).toBe('2026-10-31 23:59:59');
    expect(timeText('2026-10-31T16:00:00.000Z')).toBe('11-01 00:00');
    expect(fullTimeText('2026-10-31T16:00:00.000Z')).toBe('2026-11-01 00:00:00');
    expect(timeText('2026-11-01T07:20:05.000Z')).toBe('11-01 15:20');
    expect(fullTimeText('2026-11-01T07:20:05.000Z')).toBe('2026-11-01 15:20:05');
    expect(fullTimeText('2026-12-31T16:30:09.000Z')).toBe('2027-01-01 00:30:09');
    expect(fullTimeText('2026-11-01T00:00:00+08:00')).toBe('2026-11-01 00:00:00');
    expect(fullTimeText(null)).toBe('—');
    expect(fullTimeText('x')).toBe('—');
  });
});

describe('sortByLastAudit: descending → ascending → the original order; rows with no time last both ways', () => {
  const rows = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => ({ id }));
  const times: Record<string, LastAudit | null> = {
    a: { at: '2026-11-01T06:00:00.000Z', by: 'AI 建议' }, b: null, c: { at: '2026-11-01T08:00:00.000Z', by: 'AI 开始' },
    d: { at: '2026-11-01T06:00:00.000Z', by: '复核 · 审核员（虚构）' }, e: null, f: { at: '2026-10-31T23:00:00.000Z', by: 'AI 失败' },
  };
  const ids = (sort: Parameters<typeof sortByLastAudit>[2]) => sortByLastAudit(rows, id => times[id], sort).map(row => row.id);

  it('cycles none → descending → ascending → none', () => {
    expect(NEXT_SORT).toEqual({ none: 'descending', descending: 'ascending', ascending: 'none' });
  });

  it('descending: latest first; ties keep the original order; no-time rows last in the original order', () => {
    expect(ids('descending')).toEqual(['c', 'a', 'd', 'f', 'b', 'e']);
  });

  it('ascending: earliest first; ties keep the original order; no-time rows still last', () => {
    expect(ids('ascending')).toEqual(['f', 'a', 'd', 'c', 'b', 'e']);
  });

  it('none: the original order, and the input is never changed', () => {
    expect(ids('none')).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    sortByLastAudit(rows, id => times[id], 'descending');
    expect(rows.map(row => row.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });
});
