import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { startApp } from './startApp';
import { defaultStates, fakeBench, version } from './documentsFake';

// 复核（Spec 第 9 节；Ruling T5f；Review Focus 3）：按单据、绑定当前那一轮；采纳或改判（原因按方向，「其他」必须写备注，备注 ≤ 200 字）；
// 提交成功后开「待复核」里的下一张，没有了就关掉抽屉说一声。
async function openDrawer(id = 'doc-1', options: Parameters<typeof fakeBench>[0] = {}) {
  const bench = fakeBench(options);
  const app = await startApp(`#/documents?doc=${id}`);
  const drawer = await screen.findByRole('dialog', { name: bench.states.get(id)!.doc.number });
  await within(drawer).findByRole('radio', { name: /采纳 AI 建议/ });
  return { ...app, bench, drawer };
}
const reasonOptions = (drawer: HTMLElement) => within(within(drawer).getByRole('combobox', { name: '改判原因' })).getAllByRole('option').slice(1).map(option => [option.getAttribute('value'), option.textContent]);

describe('review: adopt', () => {
  it('adopts the AI advice bound to the current round, then opens the next document of 待复核', async () => {
    const { drawer, user, bench } = await openDrawer('doc-1');
    expect(within(drawer).getByText('只记录在本平台，不回写汇联易')).toBeInTheDocument();
    const adopt = within(drawer).getByRole('radio', { name: /采纳 AI 建议/ });
    expect(adopt).toHaveAccessibleName(/按「不建议通过」处理/);
    expect(within(drawer).getByRole('radio', { name: /改判/ })).toHaveAccessibleName(/我认为应该通过/);
    expect(adopt).toHaveAttribute('aria-checked', 'true');
    await user.click(within(drawer).getByRole('button', { name: '提交复核' }));
    const [post] = bench.find('POST', '/api/analysis/v1/poc/reviews');
    expect(post.body).toEqual({ documentId: 'doc-1', sourceVersion: version(1), round: 1, decision: 'adopt' });
    expect(post.headers.get('X-CSRF-Token')).toBe('csrf-1');
    expect(await screen.findByRole('dialog', { name: 'DGZF-F07-002' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/documents?doc=doc-2');
    // 单据池跟着刷新：doc-1 离开了「待复核」
    expect(await screen.findByRole('radio', { name: '待复核 1' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '已复核 2' })).toBeInTheDocument();
  });

  it('when it was the last one to review, closes the drawer and says 「待复核的单据都处理完了」', async () => {
    const states = defaultStates();
    states.get('doc-2')!.latest = { state: 'reviewed', current: { round: 2, result: 'pass', status: 'completed' }, review: { decision: 'adopt', adviceRound: 2 } };
    const { drawer, user } = await openDrawer('doc-1', { states });
    await user.click(within(drawer).getByRole('button', { name: '提交复核' }));
    expect(await screen.findByText('待复核的单据都处理完了')).toBeInTheDocument();
    // 关抽屉走路由（改地址），比提示晚一拍
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(window.location.hash).toBe('#/documents');
  });

  it('「下一张」 opens the next one to review without saving anything', async () => {
    const { drawer, user, bench } = await openDrawer('doc-1');
    await user.click(within(drawer).getByRole('button', { name: '下一张' }));
    expect(await screen.findByRole('dialog', { name: 'DGZF-F07-002' })).toBeInTheDocument();
    expect(bench.find('POST', '/api/analysis/v1/poc/reviews')).toHaveLength(0);
  });
});

describe('review: override', () => {
  it('AI says 不建议通过 → the reasons to pass; 「其他」 needs a note; the note stops at 200 characters', async () => {
    const { drawer, user, bench } = await openDrawer('doc-1');
    await user.click(within(drawer).getByRole('radio', { name: /改判/ }));
    expect(reasonOptions(drawer)).toEqual([
      ['contract_covers', '合同或补充协议已涵盖'], ['evidence_complete', '原件齐全 AI 没识别'], ['amount_ok', '金额核对无误'], ['rule_not_applicable', '适用规则不对'], ['other', '其他'],
    ]);
    const submit = within(drawer).getByRole('button', { name: '提交复核' });
    expect(submit).toBeDisabled();
    expect(within(drawer).getByText('选一个改判原因再提交')).toBeInTheDocument();
    await user.selectOptions(within(drawer).getByRole('combobox', { name: '改判原因' }), 'other');
    expect(submit).toBeDisabled();
    expect(within(drawer).getByText('选了「其他」，写上备注再提交')).toBeInTheDocument();
    const note = within(drawer).getByRole('textbox', { name: '备注' });
    await user.click(note);
    await user.paste('虚'.repeat(205));
    expect(note).toHaveValue('虚'.repeat(200));
    expect(within(drawer).getByText('200 / 200')).toBeInTheDocument();
    expect(submit).toBeEnabled();
    await user.click(submit);
    expect(bench.find('POST', '/api/analysis/v1/poc/reviews')[0].body).toEqual({ documentId: 'doc-1', sourceVersion: version(1), round: 1, decision: 'override', reason: 'other', note: '虚'.repeat(200) });
    expect(await screen.findByRole('dialog', { name: 'DGZF-F07-002' })).toBeInTheDocument();
  });

  it('AI says 建议通过 → the reasons not to pass (the round is the current one, not the one reviewed before)', async () => {
    const { drawer, user, bench } = await openDrawer('doc-2');
    await user.click(within(drawer).getByRole('radio', { name: /改判/ }));
    expect(within(drawer).getByRole('radio', { name: /改判/ })).toHaveAccessibleName(/我认为不应该通过/);
    expect(reasonOptions(drawer)).toEqual([
      ['evidence_missing', '原件缺失或不符'], ['amount_mismatch', '金额不符'], ['payee_mismatch', '收款方不符'], ['rule_not_applicable', '适用规则不对'], ['other', '其他'],
    ]);
    await user.selectOptions(within(drawer).getByRole('combobox', { name: '改判原因' }), 'payee_mismatch');
    await user.type(within(drawer).getByRole('textbox', { name: '备注' }), '  收款方是虚构的另一家公司  ');
    await user.click(within(drawer).getByRole('button', { name: '提交复核' }));
    expect(bench.find('POST', '/api/analysis/v1/poc/reviews')[0].body).toEqual({
      documentId: 'doc-2', sourceVersion: version(2), round: 2, decision: 'override', reason: 'payee_mismatch', note: '收款方是虚构的另一家公司',
    });
  });

  it('switching back to 采纳 drops the reason', async () => {
    const { drawer, user, bench } = await openDrawer('doc-1');
    await user.click(within(drawer).getByRole('radio', { name: /改判/ }));
    await user.selectOptions(within(drawer).getByRole('combobox', { name: '改判原因' }), 'amount_ok');
    await user.click(within(drawer).getByRole('radio', { name: /采纳 AI 建议/ }));
    expect(within(drawer).queryByRole('combobox', { name: '改判原因' })).not.toBeInTheDocument();
    await user.click(within(drawer).getByRole('button', { name: '提交复核' }));
    expect(bench.find('POST', '/api/analysis/v1/poc/reviews')[0].body).toEqual({ documentId: 'doc-1', sourceVersion: version(1), round: 1, decision: 'adopt' });
  });
});

describe('review: when the advice moved on (Review Focus 3)', () => {
  it('409 REVIEW_STALE: shows the server\'s words, reloads the advice and the review state, and stays on this document', async () => {
    const { drawer, user, bench } = await openDrawer('doc-1', { overrides: {
      'POST /api/analysis/v1/poc/reviews': { status: 409, body: { error: { code: 'REVIEW_STALE', message: '这张单的 AI 建议刚更新，请先看新的建议。' } } },
    } });
    const advice = () => bench.find('GET', '/api/analysis/v1/documents/doc-1/advice').length;
    const latest = () => bench.find('GET', '/api/analysis/v1/poc/reviews/latest').filter(call => new URLSearchParams(call.search).get('ids') === 'doc-1').length;
    const [adviceBefore, latestBefore] = [advice(), latest()];
    await user.click(within(drawer).getByRole('button', { name: '提交复核' }));
    expect(await within(drawer).findByRole('alert')).toHaveTextContent('这张单的 AI 建议刚更新，请先看新的建议。');
    await screen.findByRole('dialog', { name: 'DGZF-F07-001' });
    expect(window.location.hash).toBe('#/documents?doc=doc-1');
    await expect.poll(advice).toBeGreaterThan(adviceBefore);
    await expect.poll(latest).toBeGreaterThan(latestBefore);
  });

  it('cannot review before the advice is out: says why and keeps 提交复核 off', async () => {
    fakeBench();
    await startApp('#/documents?doc=doc-4');
    const drawer = await screen.findByRole('dialog', { name: 'DGZF-F07-004' });
    expect(await within(drawer).findByText('等 AI 建议出来再复核')).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: '提交复核' })).toBeDisabled();
  });

  it('a document reviewed already says by whom and that a new review replaces it', async () => {
    const { drawer } = await openDrawer('doc-3');
    expect(within(drawer).getByText(/已复核：采纳 AI 建议/)).toBeInTheDocument();
    expect(within(drawer).getByText(/以最后一次为准/)).toBeInTheDocument();
  });
});
