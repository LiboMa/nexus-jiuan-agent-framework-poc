import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { startApp } from './startApp';
import { DOCS, FULL_BASIS, adviceOf, defaultStates, deferred, fakeBench, roundOf, version } from './documentsFake';
import { queryClient } from '../api/queryClient';
import type { Role } from '../api/session';

// 单据抽屉（样稿 drawer-a.html；Spec 第 6 节、第 9 节；Review Focus 2）。
async function openDrawer(id = 'doc-1', options: Parameters<typeof fakeBench>[0] = {}) {
  const bench = fakeBench(options);
  const app = await startApp(`#/documents?doc=${id}`);
  const number = bench.states.get(id)!.doc.number;
  const drawer = await screen.findByRole('dialog', { name: number });
  return { ...app, bench, drawer };
}
const as = (role: Role) => ({ role });
// 规则发布复核人在九安里没有公司（Ruling FR1），真的账号什么单据都看不到（单据池的测试有这一条）；
// 假如他有公司（九安现在不许）：抽屉照样只读——这里证明只读的这一层
const readOnlyReviewer = { role: 'policy_reviewer' as Role, companyIds: DOCS.map(d => d.companyId) };

afterEach(() => { vi.useRealTimers(); });

describe('drawer: header and the four tabs', () => {
  it('shows the number, company · item, amount · submitted date, and the tabs AI 建议 / 原件 N / 单据信息 / 历史', async () => {
    const { drawer } = await openDrawer('doc-2');
    expect(within(drawer).getByText('柯顿 · 运维服务费')).toBeInTheDocument();
    expect(within(drawer).getByText('¥128,500.00 · 提交于 10-29')).toBeInTheDocument();
    const list = within(drawer).getByRole('tablist', { name: '单据内容' });
    expect(await within(list).findByRole('tab', { name: '原件 3' })).toBeInTheDocument();
    expect(within(list).getAllByRole('tab').map(tab => tab.textContent)).toEqual(['AI 建议', '原件 3', '单据信息', '历史']);
    expect(within(list).getByRole('tab', { name: 'AI 建议' })).toHaveAttribute('aria-selected', 'true');
  });

  it('a long company name shrinks before the number does: the number in the title never truncates first', async () => {
    const { drawer } = await openDrawer('doc-2');
    const title = within(drawer).getByRole('heading', { name: 'DGZF-F07-002' });
    expect(title.className).toMatch(/(^| )shrink-0( |$)/);
    expect(within(drawer).getByText('柯顿 · 运维服务费').className).toMatch(/truncate/);
  });
});

describe('drawer: AI 建议', () => {
  it('shows the conclusion with its mark, the time it took, the custom-rule tag, the approval path, and each basis with its tag', async () => {
    const { drawer } = await openDrawer('doc-1');
    const verdict = await within(drawer).findByRole('region', { name: 'AI 结论' });
    expect(within(verdict).getByText('不建议通过')).toBeInTheDocument();
    expect(verdict.querySelector('svg [d="M6 6l12 12M18 6L6 18"]')).toBeInTheDocument();
    expect(within(verdict).getByText('101 秒 · 10-30 09:12')).toBeInTheDocument();
    expect(within(drawer).getByText('含 审核员 的自定义规则').closest('[data-tone]')).toHaveAttribute('data-tone', 'own');
    const path = within(drawer).getByRole('group', { name: '审批路径' });
    expect(within(path).getByText('部门负责人 → 财务经理 → 分管副总裁')).toBeInTheDocument();
    expect(within(path).getByText('分管副总裁')).toBeInTheDocument();

    const items = within(within(drawer).getByRole('list', { name: '依据' })).getAllByRole('listitem');
    expect(items.map(item => item.querySelector('[data-basis-tag]')!.textContent)).toEqual(['公司制度', '单据字段', '原件', '我的规则']);
    expect(items.map(item => item.querySelector('[data-basis-tag]')!.getAttribute('data-tone'))).toEqual(['info', 'neutral', 'neutral', 'own']);
    expect(within(items[0]).getByText('R-07 虚构付款审批 · 柯顿 · 10–20 万')).toBeInTheDocument();
    expect(within(items[2]).getByText('第 2 页')).toBeInTheDocument();
    expect(within(items[3]).getByText('运维费须附验收单（虚构）')).toBeInTheDocument();
    expect(within(items[3]).queryByText(/自定义：/)).not.toBeInTheDocument();
    // AI 的说明去掉开头的「（含 … 的自定义规则）」（已经是上面的标签）
    expect(within(drawer).getByText('付款金额超过虚构合同约定，收款方也不一致。')).toBeInTheDocument();
  });

  it('shows no approval path when no rule note can be read', async () => {
    const { drawer } = await openDrawer('doc-2');
    await within(drawer).findByRole('region', { name: 'AI 结论' });
    expect(within(drawer).getByText('建议通过')).toBeInTheDocument();
    expect(within(drawer).queryByRole('group', { name: '审批路径' })).not.toBeInTheDocument();
    expect(within(drawer).queryByText(/的自定义规则/)).not.toBeInTheDocument();
  });

  it('「重新审核」 sends POST advice with the document version, then polls every 3 s while it runs and stops when it settles', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { bench, drawer } = await openDrawer('doc-1');
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await within(drawer).findByRole('region', { name: 'AI 结论' });
    await user.click(within(drawer).getByRole('button', { name: '重新审核' }));
    expect(bench.find('POST', '/api/analysis/v1/documents/doc-1/advice').map(call => call.body)).toEqual([{ sourceVersion: version(1) }]);
    expect(bench.find('POST', '/api/analysis/v1/documents/doc-1/advice')[0].headers.get('X-CSRF-Token')).toBe('csrf-1');
    expect(await within(drawer).findByText('AI 正在审核')).toBeInTheDocument();
    expect(within(drawer).getByText(/每 3 秒自动刷新/)).toBeInTheDocument();

    const reads = () => bench.find('GET', '/api/analysis/v1/documents/doc-1/advice').length;
    const before = reads();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(reads()).toBe(before + 1);

    const s = bench.states.get('doc-1')!;
    s.advice = adviceOf(s.doc, { result: 'pass', note: '虚构补充协议已涵盖。', basis: [FULL_BASIS[1]] });
    s.latest = { state: 'pending', current: { round: 2, result: 'pass', status: 'completed' }, review: null };
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(await within(drawer).findByText('建议通过')).toBeInTheDocument();
    const settled = reads();
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(reads()).toBe(settled);
  });

  it('does not poll a drawer that was switched to another document, nor one that was closed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const states = defaultStates();
    states.get('doc-1')!.latest = { state: 'pending', current: { round: 1, result: 'fail', status: 'completed' }, review: null };
    const { bench, drawer } = await openDrawer('doc-4', { states });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    expect(await within(drawer).findByText('AI 正在审核')).toBeInTheDocument();
    const reads = (id: string) => bench.find('GET', `/api/analysis/v1/documents/${id}/advice`).length;
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(reads('doc-4')).toBeGreaterThanOrEqual(2);
    // 换到另一张（doc-1 已完成）：doc-4 不再读
    await user.click(screen.getByRole('radio', { name: /^全部/ }));
    await user.click(screen.getByRole('button', { name: 'DGZF-F07-001' }));
    const first = await screen.findByRole('dialog', { name: 'DGZF-F07-001' });
    await within(first).findByRole('region', { name: 'AI 结论' });
    const switched = reads('doc-4');
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(reads('doc-4')).toBe(switched);
    // 回到 doc-4 再关掉：关了也不读
    await user.click(screen.getByRole('button', { name: 'DGZF-F07-004' }));
    await within(await screen.findByRole('dialog', { name: 'DGZF-F07-004' })).findByText('AI 正在审核');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const closed = reads('doc-4');
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(reads('doc-4')).toBe(closed);
  });

  it('a failed 「重新审核」 on one document does not follow the user to the next one', async () => {
    const { drawer, user } = await openDrawer('doc-1', { overrides: {
      'POST /api/analysis/v1/documents/doc-1/advice': { status: 429, body: { error: { code: 'RATE_LIMIT', message: '操作太频繁，请一分钟后再试。' } } },
      'POST /api/analysis/v1/documents/doc-1/evidence/read': { status: 429, body: { error: { code: 'RATE_LIMIT', message: '读取太频繁，请一分钟后再试。' } } },
    } });
    await within(drawer).findByRole('region', { name: 'AI 结论' });
    await user.click(within(drawer).getByRole('button', { name: '重新审核' }));
    expect(await within(drawer).findByRole('alert')).toHaveTextContent('操作太频繁，请一分钟后再试。');
    await user.click(screen.getByRole('button', { name: 'DGZF-F07-002' }));
    const second = await screen.findByRole('dialog', { name: 'DGZF-F07-002' });
    await within(second).findByRole('region', { name: 'AI 结论' });
    expect(within(second).queryByRole('alert')).not.toBeInTheDocument();
    // 原件也一样
    await user.click(screen.getByRole('button', { name: 'DGZF-F07-001' }));
    const back = await screen.findByRole('dialog', { name: 'DGZF-F07-001' });
    await user.click(await within(back).findByRole('tab', { name: /^原件/ }));
    await user.click(await within(back).findByRole('button', { name: '读取原件' }));
    expect(await within(back).findByRole('alert')).toHaveTextContent('读取太频繁，请一分钟后再试。');
    await user.click(screen.getByRole('button', { name: 'DGZF-F07-002' }));
    const again = await screen.findByRole('dialog', { name: 'DGZF-F07-002' });
    await user.click(await within(again).findByRole('tab', { name: /^原件/ }));
    await within(again).findByRole('button', { name: '读取原件' });
    expect(within(again).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a 「重新审核」 still on its way when the user switches lands on its own document, not on the one now open', async () => {
    const late = deferred();
    const { drawer, user, bench } = await openDrawer('doc-1', { overrides: { 'POST /api/analysis/v1/documents/doc-1/advice': late.route } });
    await within(drawer).findByRole('region', { name: 'AI 结论' });
    await user.click(within(drawer).getByRole('button', { name: '重新审核' }));
    await user.click(screen.getByRole('button', { name: 'DGZF-F07-002' }));
    const second = await screen.findByRole('dialog', { name: 'DGZF-F07-002' });
    expect(await within(second).findByText('建议通过')).toBeInTheDocument();
    const roundsBefore = bench.find('GET', '/api/analysis/v1/poc/advice-rounds').length;
    await act(async () => { late.resolve({ status: 202, body: { data: adviceOf(DOCS[0], { status: 'running', result: null, basis: [], finishedAt: null, canRun: false }) } }); });
    // doc-2 还是它自己的建议；doc-1 的回答记在 doc-1 上
    await waitFor(() => expect(queryClient.getQueryData(['advice', 'doc-1'])).toMatchObject({ documentId: 'doc-1', status: 'running' }));
    expect(queryClient.getQueryData(['advice', 'doc-2'])).toMatchObject({ documentId: 'doc-2', status: 'completed' });
    expect(within(second).getByText('建议通过')).toBeInTheDocument();
    expect(within(second).queryByText('AI 正在审核')).not.toBeInTheDocument();
    expect(bench.find('GET', '/api/analysis/v1/poc/advice-rounds').length).toBe(roundsBefore);
  });

  it('no advice yet: says so and how it starts; admin can start one', async () => {
    const states = defaultStates();
    states.get('doc-1')!.advice = adviceOf(DOCS[0], { status: 'not_run', result: null, basis: [], startedAt: null, finishedAt: null });
    states.get('doc-1')!.latest = { state: 'no_advice', current: null, review: null };
    const { drawer, user, bench } = await openDrawer('doc-1', { states });
    expect(await within(drawer).findByText('还没有 AI 建议')).toBeInTheDocument();
    expect(within(drawer).getByText(/平台会自动发起/)).toBeInTheDocument();
    await user.click(within(drawer).getByRole('button', { name: '发起审核' }));
    expect(bench.find('POST', '/api/analysis/v1/documents/doc-1/advice')).toHaveLength(1);
    expect(await within(drawer).findByText('AI 正在审核')).toBeInTheDocument();
  });

  it('failed: shows the error code and 「重新审核」', async () => {
    const states = defaultStates();
    states.get('doc-1')!.advice = adviceOf(DOCS[0], { status: 'failed', result: null, basis: [], errorCode: 'AGENT_TIMEOUT' });
    states.get('doc-1')!.latest = { state: 'no_advice', current: { round: 1, result: null, status: 'failed' }, review: null };
    const { drawer } = await openDrawer('doc-1', { states });
    expect(await within(drawer).findByText('AI 建议没有完成')).toBeInTheDocument();
    expect(within(drawer).getByText('错误码 AGENT_TIMEOUT')).toBeInTheDocument();
    expect(within(drawer).getByText(/点「重新审核」再跑一轮/)).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: '重新审核' })).toBeEnabled();
  });

  it('failed with CUSTOM_RULES_TOO_LONG: says my rules are too long for one request, to shorten them, and links to 我的规则', async () => {
    const states = defaultStates();
    states.get('doc-1')!.advice = adviceOf(DOCS[0], { status: 'failed', result: null, basis: [], errorCode: 'CUSTOM_RULES_TOO_LONG' });
    states.get('doc-1')!.latest = { state: 'no_advice', current: { round: 1, result: null, status: 'failed' }, review: null };
    const { drawer } = await openDrawer('doc-1', { states });
    expect(await within(drawer).findByText('我的规则太长，这一轮没有发出')).toBeInTheDocument();
    expect(within(drawer).getByText('我的规则加上单据后超过了九安单次请求的上限（约 8.7 万字），请删减我的规则后再发起。')).toBeInTheDocument();
    expect(within(drawer).getByText(/错误码 CUSTOM_RULES_TOO_LONG/)).toBeInTheDocument();
    expect(within(drawer).getByRole('link', { name: '去「我的规则」' })).toHaveAttribute('href', '#/my-rules');
    expect(within(drawer).queryByText('AI 建议没有完成')).not.toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: '重新审核' })).toBeEnabled();
  });

  it('CUSTOM_RULES_TOO_LONG for a read-only reviewer: the same explanation, no link to 我的规则 and no 重新审核', async () => {
    const states = defaultStates();
    states.get('doc-1')!.advice = adviceOf(DOCS[0], { status: 'failed', result: null, basis: [], errorCode: 'CUSTOM_RULES_TOO_LONG' });
    const { drawer } = await openDrawer('doc-1', { ...readOnlyReviewer, states });
    expect(await within(drawer).findByText('我的规则太长，这一轮没有发出')).toBeInTheDocument();
    expect(within(drawer).queryByRole('link', { name: '去「我的规则」' })).not.toBeInTheDocument();
    expect(within(drawer).queryByRole('button', { name: '重新审核' })).not.toBeInTheDocument();
  });

  it('declined: shows the reason Nexus gave', async () => {
    const states = defaultStates();
    states.get('doc-1')!.advice = adviceOf(DOCS[0], { status: 'declined', result: null, basis: [], declinedReason: '虚构原件缺页，无法判断' });
    states.get('doc-1')!.latest = { state: 'no_advice', current: { round: 1, result: null, status: 'declined' }, review: null };
    const { drawer } = await openDrawer('doc-1', { states });
    expect(await within(drawer).findByText('AI 没有给出建议')).toBeInTheDocument();
    expect(within(drawer).getByText('原因：虚构原件缺页，无法判断')).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: '重新审核' })).toBeInTheDocument();
  });

  it('advice for an older version, an unsupported type, an unreadable state: each says what happened and what to do', async () => {
    const states = defaultStates();
    states.get('doc-1')!.advice = adviceOf(DOCS[0], { status: 'completed', stale: true, result: null, basis: [] });
    states.get('doc-2')!.advice = adviceOf(DOCS[1], { status: 'unsupported', applicable: false, result: null, canRun: false });
    states.get('doc-3')!.advice = adviceOf(DOCS[2], { status: 'unavailable', result: null, canRun: false });
    const { user, drawer } = await openDrawer('doc-1', { states });
    expect(await within(drawer).findByText('AI 建议对应的是旧版本')).toBeInTheDocument();
    expect(within(drawer).getByText(/单据已经更新/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'DGZF-F07-002' }));
    const second = await screen.findByRole('dialog', { name: 'DGZF-F07-002' });
    expect(await within(second).findByText('这类单据不送 AI 审核')).toBeInTheDocument();
    expect(within(second).queryByRole('button', { name: '重新审核' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /^全部/ }));
    await user.click(screen.getByRole('button', { name: 'DGZF-F07-003' }));
    const third = await screen.findByRole('dialog', { name: 'DGZF-F07-003' });
    expect(await within(third).findByText('AI 建议的状态暂时读不到')).toBeInTheDocument();
    expect(within(third).getByRole('button', { name: '重新读取' })).toBeInTheDocument();
  });

  it('outdated: the drawer says 「AI 建议已更新」 and the review area names the round that was reviewed', async () => {
    const { drawer } = await openDrawer('doc-2');
    expect(await within(drawer).findByText('AI 建议已更新')).toBeInTheDocument();
    expect(await within(drawer).findByText(/上次复核的是第 1 轮/)).toBeInTheDocument();
  });

  it('a failed start shows the server\'s message as it is', async () => {
    const { drawer, user } = await openDrawer('doc-1', { overrides: {
      'POST /api/analysis/v1/documents/doc-1/advice': { status: 429, body: { error: { code: 'RATE_LIMIT', message: '操作太频繁，请一分钟后再试。' } } },
    } });
    await within(drawer).findByRole('region', { name: 'AI 结论' });
    await user.click(within(drawer).getByRole('button', { name: '重新审核' }));
    expect(await within(drawer).findByRole('alert')).toHaveTextContent('操作太频繁，请一分钟后再试。');
  });
});

describe('drawer: the tab while it closes, and page text after 读取原件 (P2, P3)', () => {
  /** jsdom 不放动画：让 Radix 以为抽屉有进出场动画（data-state=open → drawer-in，closed → drawer-out），关的时候就像真浏览器那样留在页面上，直到动画放完。 */
  function withDrawerAnimation() {
    const real = window.getComputedStyle.bind(window);
    const spy = vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element, pseudo?: string | null) => {
      const styles = real(element, pseudo);
      if (!(element instanceof HTMLElement) || element.getAttribute('role') !== 'dialog') return styles;
      return new Proxy(styles, { get: (target, name) => {
        if (name === 'animationName') return element.getAttribute('data-state') === 'closed' ? 'drawer-out' : 'drawer-in';
        const value = Reflect.get(target, name);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    });
    if (typeof globalThis.CSS?.escape !== 'function') vi.stubGlobal('CSS', { ...globalThis.CSS, escape: (text: string) => text });
    const finish = (dialog: HTMLElement) => act(() => {
      const event = new Event('animationend', { bubbles: true });
      Object.defineProperty(event, 'animationName', { value: 'drawer-out' });
      dialog.dispatchEvent(event);
    });
    return { finish, restore: () => spy.mockRestore() };
  }

  it('P3: closing keeps the tab the user was on while the drawer slides out; opening again starts at AI 建议', async () => {
    const animation = withDrawerAnimation();
    try {
      const { drawer, user } = await openDrawer('doc-1');
      await user.click(await within(drawer).findByRole('tab', { name: '原件 3' }));
      expect(within(drawer).getByRole('tab', { name: '原件 3' })).toHaveAttribute('aria-selected', 'true');
      await user.keyboard('{Escape}');
      // 还在放关的动画：页签不跳回「AI 建议」
      expect(drawer).toBeInTheDocument();
      expect(drawer).toHaveAttribute('data-state', 'closed');
      expect(within(drawer).getByRole('tab', { name: '原件 3' })).toHaveAttribute('aria-selected', 'true');
      expect(within(drawer).getByRole('tab', { name: 'AI 建议' })).toHaveAttribute('aria-selected', 'false');
      animation.finish(drawer);
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: 'DGZF-F07-001' }));
      const again = await screen.findByRole('dialog', { name: 'DGZF-F07-001' });
      expect(within(again).getByRole('tab', { name: 'AI 建议' })).toHaveAttribute('aria-selected', 'true');
    } finally {
      animation.restore();
    }
  });

  it('P2: after 读取原件, leaving the 原件 tab and coming back within 30 s shows the new page text', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { bench, drawer } = await openDrawer('doc-1');
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(await within(drawer).findByRole('tab', { name: '原件 3' }));
    expect(await within(drawer).findByText(/虚构合同 第一页/)).toBeInTheDocument();
    await user.click(within(drawer).getByRole('button', { name: '读取原件' }));
    expect(await within(drawer).findByText('正在读取原件')).toBeInTheDocument();
    // 去看别的页签；读取在后台读完了，第 3 张原件的文字也有了
    await user.click(within(drawer).getByRole('tab', { name: 'AI 建议' }));
    const s = bench.states.get('doc-1')!;
    s.evidence = { ...s.evidence, status: 'completed', canRun: true };
    s.pages = [...s.pages, { id: 'a-3', name: '虚构验收单.xlsx', status: 'ready', totalPages: 1, pages: [{ page: 1, text: '验收单：已验收（虚构）' }] }];
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    // 10 秒后回来（还在 30 秒的新鲜期里）
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    await user.click(within(drawer).getByRole('tab', { name: '原件 3' }));
    expect(await within(drawer).findByText('验收单：已验收（虚构）')).toBeInTheDocument();
  });
});

describe('drawer: 重新审核 and the 工作台 (F3)', () => {
  it('starting a round marks the 工作台 numbers stale; a refused start does not', async () => {
    const { bench, drawer, user } = await openDrawer('doc-1');
    await within(drawer).findByRole('region', { name: 'AI 结论' });
    queryClient.setQueryData(['dashboard', '14d'], { window: '14d' });
    bench.routes['POST /api/analysis/v1/documents/doc-1/advice'] = { status: 429, body: { error: { code: 'RATE_LIMIT', message: '操作太频繁，请一分钟后再试。' } } };
    await user.click(within(drawer).getByRole('button', { name: '重新审核' }));
    expect(await within(drawer).findByRole('alert')).toHaveTextContent('操作太频繁，请一分钟后再试。');
    expect(queryClient.getQueryState(['dashboard', '14d'])!.isInvalidated).toBe(false);
    bench.routes['POST /api/analysis/v1/documents/doc-1/advice'] = { status: 202, body: { data: adviceOf(DOCS[0], { status: 'running', result: null, finishedAt: null, canRun: false }) } };
    await user.click(within(drawer).getByRole('button', { name: '重新审核' }));
    expect(await within(drawer).findByText('AI 正在审核')).toBeInTheDocument();
    expect(queryClient.getQueryState(['dashboard', '14d'])!.isInvalidated).toBe(true);
  });
});

describe('drawer: roles', () => {
  it('policy_reviewer reads everything but has no 重新审核, no 读取原件 and no review form — a read-only note instead', async () => {
    const { drawer, user } = await openDrawer('doc-1', readOnlyReviewer);
    await within(drawer).findByRole('region', { name: 'AI 结论' });
    expect(within(drawer).queryByRole('button', { name: '重新审核' })).not.toBeInTheDocument();
    expect(within(drawer).queryByRole('button', { name: '提交复核' })).not.toBeInTheDocument();
    expect(within(drawer).queryByRole('radio', { name: /采纳 AI 建议/ })).not.toBeInTheDocument();
    expect(within(drawer).getByText(/只能查看/)).toBeInTheDocument();
    await user.click(within(drawer).getByRole('tab', { name: /^原件/ }));
    expect(await within(drawer).findByText('虚构合同.pdf')).toBeInTheDocument();
    expect(within(drawer).queryByRole('button', { name: '读取原件' })).not.toBeInTheDocument();
  });

  it('an analyst may do all of it', async () => {
    const { drawer } = await openDrawer('doc-1', as('analyst'));
    await within(drawer).findByRole('region', { name: 'AI 结论' });
    expect(within(drawer).getByRole('button', { name: '重新审核' })).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: '提交复核' })).toBeInTheDocument();
  });
});

describe('drawer: 原件, 单据信息, 历史', () => {
  it('原件 lists each original with its read state and pages; 读取原件 posts the version', async () => {
    const { drawer, user, bench } = await openDrawer('doc-1');
    await user.click(await within(drawer).findByRole('tab', { name: '原件 3' }));
    const files = within(drawer).getByRole('list', { name: '原件清单' });
    const rows = within(files).getAllByRole('listitem');
    expect(rows.map(row => row.querySelector('[data-file-name]')!.textContent)).toEqual(['虚构合同.pdf', '虚构发票.pdf', '虚构验收单.xlsx']);
    expect(within(rows[0]).getByText('文字已读取')).toBeInTheDocument();
    expect(within(rows[0]).getByText('已识别文字 3 / 3 页')).toBeInTheDocument();
    expect(within(rows[1]).getByText('文字部分读取')).toBeInTheDocument();
    expect(within(rows[2]).getByText('还没读取')).toBeInTheDocument();
    expect(within(drawer).getByText(/AI 引用了第 2 页/)).toBeInTheDocument();
    await user.click(within(drawer).getByRole('button', { name: '读取原件' }));
    expect(bench.find('POST', '/api/analysis/v1/documents/doc-1/evidence/read').map(call => call.body)).toEqual([{ sourceVersion: version(1) }]);
    expect(await within(drawer).findByText('正在读取原件')).toBeInTheDocument();
  });

  it('原件 shows each file\'s pages, page numbers labelled, text as plain text in a scrollable block', async () => {
    const { drawer, user, bench } = await openDrawer('doc-1', readOnlyReviewer);
    await user.click(await within(drawer).findByRole('tab', { name: '原件 3' }));
    const contract = await within(drawer).findByRole('region', { name: '虚构合同.pdf 的文字' });
    const pages = within(contract).getAllByRole('article');
    expect(pages.map(page => page.getAttribute('aria-label'))).toEqual(['虚构合同.pdf 第 1 页', '虚构合同.pdf 第 2 页', '虚构合同.pdf 第 3 页']);
    expect(within(pages[1]).getByText('第 2 页')).toBeInTheDocument();
    expect(pages[1].querySelector('[data-page-text]')).toHaveTextContent('合同金额 110,000 元（虚构）。 付款方式：验收后付款。');
    expect(pages[1].querySelector('[data-page-text]')!.className).toMatch(/overflow-auto/);
    // 尖括号照原样显示，不当成标签
    expect(pages[2].querySelector('[data-page-text]')!.textContent).toBe('<b>不是标签</b> 落款（虚构）');
    expect(pages[2].querySelector('b')).toBeNull();
    const invoice = within(drawer).getByRole('region', { name: '虚构发票.pdf 的文字' });
    expect(within(invoice).getAllByRole('article')[0]).toHaveTextContent('这一页没有识别出文字');
    expect(new URLSearchParams(bench.find('GET', '/api/analysis/v1/poc/evidence-pages')[0].search).get('documentId')).toBe('doc-1');
  });

  it('an 「原件」 basis item opens the 原件 tab at the page the AI cited', async () => {
    const { drawer, user } = await openDrawer('doc-1');
    await within(drawer).findByRole('region', { name: 'AI 结论' });
    await user.click(within(drawer).getByRole('button', { name: '看原件第 2 页' }));
    expect(within(drawer).getByRole('tab', { name: '原件 3' })).toHaveAttribute('aria-selected', 'true');
    const cited = await within(drawer).findByRole('article', { name: '虚构合同.pdf 第 2 页' });
    expect(cited).toHaveAttribute('aria-current', 'true');
    expect(within(cited).getByText('AI 引用')).toBeInTheDocument();
    expect(within(drawer).getByRole('article', { name: '虚构合同.pdf 第 1 页' })).not.toHaveAttribute('aria-current');
    // 关上再打开同一张：回到「AI 建议」
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'DGZF-F07-001' }));
    const again = await screen.findByRole('dialog', { name: 'DGZF-F07-001' });
    expect(within(again).getByRole('tab', { name: 'AI 建议' })).toHaveAttribute('aria-selected', 'true');
  });

  it('原件 without any read text says how to get it', async () => {
    const states = defaultStates();
    states.get('doc-1')!.pages = [];
    const { drawer, user } = await openDrawer('doc-1', { states });
    await user.click(await within(drawer).findByRole('tab', { name: '原件 3' }));
    expect(await within(drawer).findByText(/还没有读出文字的原件/)).toBeInTheDocument();
  });

  it('单据信息 shows the fields, the payment lines and the approval flow from the 1:1 page', async () => {
    const { drawer, user } = await openDrawer('doc-2');
    await user.click(within(drawer).getByRole('tab', { name: '单据信息' }));
    expect(await within(drawer).findByText('周宁（虚构） · F07-E1101')).toBeInTheDocument();
    expect(within(drawer).getByText('审批中 · 财务经理审批')).toBeInTheDocument();
    expect(within(drawer).getByText('运维服务费（虚构）')).toBeInTheDocument();
    expect(within(drawer).getByText('信息技术部（虚构）-D9201-IT')).toBeInTheDocument();
    expect(within(drawer).getByText('运维服务（虚构）')).toBeInTheDocument();
    const flow = within(drawer).getByRole('list', { name: '审批流程' });
    expect(within(flow).getAllByRole('listitem').map(item => item.getAttribute('data-tone'))).toEqual(['pending', 'pass', 'pass']);
    expect(within(flow).getByText(/同意（虚构）/)).toBeInTheDocument();
  });

  it('历史 lists the AI rounds newest first, and the reviews', async () => {
    const states = defaultStates();
    states.get('doc-2')!.rounds.push(roundOf(DOCS[1], 0, { round: 0, status: 'failed', result: null, errorCode: 'AGENT_TASK_UNROUTED', documentVersion: 'old' }));
    const { drawer, user, bench } = await openDrawer('doc-2', { states });
    await user.click(within(drawer).getByRole('tab', { name: '历史' }));
    const rounds = await within(drawer).findByRole('list', { name: 'AI 建议的各轮' });
    const items = within(rounds).getAllByRole('listitem');
    expect(items.map(item => item.querySelector('[data-round]')!.textContent)).toEqual(['第 2 轮', '第 1 轮', '第 0 轮']);
    expect(within(items[0]).getByText('建议通过')).toBeInTheDocument();
    expect(within(items[0]).getByText(/人工发起/)).toBeInTheDocument();
    expect(within(items[2]).getByText('没有完成')).toBeInTheDocument();
    expect(within(items[2]).getByText(/AGENT_TASK_UNROUTED/)).toBeInTheDocument();
    expect(within(items[2]).getByText('针对旧版本')).toBeInTheDocument();
    const reviews = within(drawer).getByRole('list', { name: '复核记录' });
    expect(within(reviews).getByText('采纳 AI 建议')).toBeInTheDocument();
    expect(within(reviews).getByText(/第 1 轮/)).toBeInTheDocument();
    expect(new URLSearchParams(bench.find('GET', '/api/analysis/v1/poc/advice-rounds')[0].search).get('documentId')).toBe('doc-2');
  });
});
