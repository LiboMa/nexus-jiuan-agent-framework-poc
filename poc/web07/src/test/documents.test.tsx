import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { startApp } from './startApp';
import { DOCS, adviceOf, defaultStates, fakeBench, type FakeDoc } from './documentsFake';

// 单据池（Spec 第 6 节、Ruling T5d）：九安的对公付款单（最多 500 张，每页 50 张读），复核状态按 50 张一批问外壳；页签、翻页都在页面里做。
async function openPool(options: Parameters<typeof fakeBench>[0] = {}, hash = '#/documents') {
  const bench = fakeBench(options);
  const app = await startApp(hash);
  await screen.findByRole('heading', { level: 1, name: '单据池' });
  return { ...app, bench };
}
const table = () => screen.getByRole('table', { name: '单据' });
const numbers = () => within(table()).queryAllByRole('row').slice(1).map(row => row.getAttribute('data-number'));
const rowOf = (number: string) => within(table()).getAllByRole('row').find(row => row.getAttribute('data-number') === number)!;
const tabs = () => screen.getByRole('radiogroup', { name: '复核状态' });

describe('单据池: tabs by review state', () => {
  it('待复核 = pending + outdated, 已复核 = reviewed, 全部 = every corporate payment; the 差旅报销 never shows', async () => {
    const { user, bench } = await openPool();
    expect(await within(tabs()).findByRole('radio', { name: '待复核 2' })).toHaveAttribute('aria-checked', 'true');
    expect(numbers()).toEqual(['DGZF-F07-001', 'DGZF-F07-002']);
    expect(within(table()).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['单号', '板块', '事项', '金额', 'AI 建议', '复核']);
    const second = rowOf('DGZF-F07-002');
    expect(within(second).getByText('柯顿')).toBeInTheDocument();
    expect(within(second).getByText('运维服务费')).toBeInTheDocument();
    expect(within(second).getByText('¥128,500.00')).toBeInTheDocument();
    expect(within(second).getByText('建议通过').closest('[data-tone]')).toHaveAttribute('data-tone', 'pass');
    expect(within(second).getByText('AI 建议已更新').closest('[data-tone]')).toHaveAttribute('data-tone', 'wait');
    expect(within(rowOf('DGZF-F07-001')).getByText('不建议通过').closest('[data-tone]')).toHaveAttribute('data-tone', 'fail');
    expect(within(rowOf('DGZF-F07-001')).getByText('待复核')).toBeInTheDocument();

    await user.click(within(tabs()).getByRole('radio', { name: '已复核 1' }));
    expect(numbers()).toEqual(['DGZF-F07-003']);
    expect(within(rowOf('DGZF-F07-003')).getByText('已采纳')).toBeInTheDocument();

    await user.click(within(tabs()).getByRole('radio', { name: '全部 4' }));
    expect(numbers()).toEqual(['DGZF-F07-001', 'DGZF-F07-002', 'DGZF-F07-003', 'DGZF-F07-004']);
    expect(within(rowOf('DGZF-F07-004')).getByText('审核中').closest('[data-tone]')).toHaveAttribute('data-tone', 'wait');
    expect(screen.queryByText('CLBX-F07-005')).not.toBeInTheDocument();

    const [list] = bench.find('GET', '/api/analysis/v1/documents');
    expect(Object.fromEntries(new URLSearchParams(list.search))).toEqual({ limit: '50', offset: '0' });
    const latest = bench.find('GET', '/api/analysis/v1/poc/reviews/latest');
    expect(latest).toHaveLength(1);
    expect(new URLSearchParams(latest[0].search).get('ids')).toBe('doc-1,doc-2,doc-3,doc-4');
  });

  it('names every state of the AI advice in the table with a word and a mark — never an error', async () => {
    const states = defaultStates();
    states.get('doc-2')!.latest = { state: 'no_advice', current: null, review: null };
    states.get('doc-3')!.latest = { state: 'no_advice', current: { round: 1, result: null, status: 'failed' }, review: null };
    states.get('doc-4')!.latest = { state: 'no_advice', current: { round: 2, result: null, status: 'declined' }, review: null };
    const { user } = await openPool({ states });
    await within(tabs()).findByRole('radio', { name: '待复核 1' });
    await user.click(within(tabs()).getByRole('radio', { name: '全部 4' }));
    expect(within(rowOf('DGZF-F07-002')).getByText('还没有建议')).toBeInTheDocument();
    expect(within(rowOf('DGZF-F07-003')).getByText('没有完成')).toBeInTheDocument();
    expect(within(rowOf('DGZF-F07-004')).getByText('没有给出建议')).toBeInTheDocument();
    for (const number of ['DGZF-F07-002', 'DGZF-F07-003', 'DGZF-F07-004']) expect(within(rowOf(number)).getByText('等 AI 建议')).toBeInTheDocument();
  });

  it('says what to do when there is nothing to review, and keeps the other tabs reachable', async () => {
    const states = defaultStates();
    for (const id of ['doc-1', 'doc-2']) states.get(id)!.latest = { state: 'reviewed', current: { round: 1, result: 'fail', status: 'completed' }, review: { decision: 'override', adviceRound: 1 } };
    const { user } = await openPool({ states });
    expect(await screen.findByText('没有待复核的单据')).toBeInTheDocument();
    expect(screen.getByText(/AI 给出新建议后/)).toBeInTheDocument();
    await user.click(within(tabs()).getByRole('radio', { name: '已复核 3' }));
    expect(within(rowOf('DGZF-F07-001')).getByText('已改判')).toBeInTheDocument();
  });
});

describe('单据池: loading and paging (T5d)', () => {
  it('reads corporate payments 50 at a time up to 500, asks the review states 50 at a time, pages 20 rows on the page, and says when it stopped at 500', async () => {
    const many: FakeDoc[] = [];
    for (let n = 1; n <= 535; n += 1) {
      const other = n >= 11 && n <= 15; // 中间夹几张差旅报销：不算进 500 张
      many.push({ ...DOCS[0], id: `m-${n}`, number: `DGZF-M-${String(n).padStart(3, '0')}`, type: other ? 'employee_expense' : 'corporate_payment' });
    }
    const states = defaultStates(many);
    for (const s of states.values()) { s.latest = { state: 'pending', current: { round: 1, result: 'pass', status: 'completed' }, review: null }; s.advice = adviceOf(s.doc, { result: 'pass' }); }
    const { user, bench } = await openPool({ docs: many, states });
    expect(await within(tabs()).findByRole('radio', { name: '待复核 500' })).toBeInTheDocument();
    const lists = bench.find('GET', '/api/analysis/v1/documents').map(call => Object.fromEntries(new URLSearchParams(call.search)));
    expect(lists.map(params => params.offset)).toEqual(['0', '50', '100', '150', '200', '250', '300', '350', '400', '450', '500']);
    expect(lists.every(params => params.limit === '50')).toBe(true);
    const chunks = bench.find('GET', '/api/analysis/v1/poc/reviews/latest').map(call => new URLSearchParams(call.search).get('ids')!.split(','));
    expect(chunks).toHaveLength(10);
    expect(chunks.every(ids => ids.length === 50)).toBe(true);
    expect(chunks.flat()).not.toContain('m-12');
    expect(screen.getByText(/只列出了最近的 500 张对公付款单/)).toBeInTheDocument();

    expect(numbers()).toHaveLength(20);
    expect(numbers()[0]).toBe('DGZF-M-001');
    expect(screen.getByText('第 1 / 25 页')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '下一页' }));
    expect(screen.getByText('第 2 / 25 页')).toBeInTheDocument();
    expect(numbers()[0]).toBe('DGZF-M-026'); // 第 1 页是 001–010、016–025（011–015 是差旅报销，不在单据池里）
    // 换页签回到第一页
    await user.click(within(tabs()).getByRole('radio', { name: '全部 500' }));
    expect(screen.getByText('第 1 / 25 页')).toBeInTheDocument();
  });

  it('when the 2,000-row scan stops before 500 payments, the footnote gives the real numbers', async () => {
    const many: FakeDoc[] = [];
    for (let n = 1; n <= 2050; n += 1) {
      const payment = n % 100 === 0; // 每 100 张里只有 1 张对公付款单
      many.push({ ...DOCS[0], id: `s-${n}`, number: `DGZF-S-${String(n).padStart(4, '0')}`, type: payment ? 'corporate_payment' : 'employee_expense' });
    }
    const states = defaultStates(many);
    for (const s of states.values()) s.latest = { state: 'pending', current: { round: 1, result: 'pass', status: 'completed' }, review: null };
    const { bench } = await openPool({ docs: many, states });
    expect(await within(tabs()).findByRole('radio', { name: '待复核 20' }, { timeout: 4000 })).toBeInTheDocument();
    expect(bench.find('GET', '/api/analysis/v1/documents')).toHaveLength(40);
    expect(screen.getByText('只读了最近的 2,000 张单据，其中 20 张对公付款单：要找更早的单，请按单号或收款方搜索。')).toBeInTheDocument();
    expect(screen.queryByText(/只列出了最近的 500 张/)).not.toBeInTheDocument();
  });

  it('no footnote when everything fits', async () => {
    await openPool();
    await within(tabs()).findByRole('radio', { name: '待复核 2' });
    expect(screen.queryByText(/只列出了最近的 500 张/)).not.toBeInTheDocument();
  });

  it('shows the server\'s own words when the list or the review states cannot be read, with a retry', async () => {
    let fail = true;
    const { user, bench } = await openPool({ overrides: {
      'GET /api/analysis/v1/poc/reviews/latest': () => (fail
        ? { status: 503, body: { error: { code: 'REVIEW_UNAVAILABLE', message: '复核记录暂时读写不了，稍后再试。' } } }
        : { body: { data: { items: { 'doc-1': { state: 'pending', current: { round: 1, result: 'fail', status: 'completed' }, review: null } } } } }),
    } });
    // 5xx 全站重试一次（queryClient），所以多等一会儿
    expect(await screen.findByText('复核记录暂时读写不了，稍后再试。', {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByText('没有待复核的单据')).not.toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: '重新读取' }));
    expect(await within(tabs()).findByRole('radio', { name: '待复核 1' })).toBeInTheDocument();
    expect(bench.find('GET', '/api/analysis/v1/poc/reviews/latest').length).toBeGreaterThanOrEqual(2);
  });
});

describe('单据池: search', () => {
  it('sends q on Enter, from the first page, and offers to clear it when nothing matches', async () => {
    const { user, bench } = await openPool();
    await within(tabs()).findByRole('radio', { name: '待复核 2' });
    const search = screen.getByRole('searchbox', { name: '搜索单号、收款方' });
    await user.type(search, '柯顿{Enter}');
    await user.click(within(tabs()).getByRole('radio', { name: /^全部/ }));
    expect(await screen.findByText('DGZF-F07-002')).toBeInTheDocument();
    const last = bench.find('GET', '/api/analysis/v1/documents').at(-1)!;
    expect(Object.fromEntries(new URLSearchParams(last.search))).toEqual({ q: '柯顿', limit: '50', offset: '0' });
    expect(numbers()).toEqual(['DGZF-F07-002']);

    await user.clear(search);
    await user.type(search, '1..2{Enter}'); // 查询串里的 .. 照样发（T5c）
    expect(await screen.findByText('没有找到单据')).toBeInTheDocument();
    expect(new URLSearchParams(bench.find('GET', '/api/analysis/v1/documents').at(-1)!.search).get('q')).toBe('1..2');
    await user.click(screen.getByRole('button', { name: '清空搜索' }));
    expect(await screen.findByText('DGZF-F07-004')).toBeInTheDocument();
    expect(search).toHaveValue('');
  });
});

describe('单据池: the drawer', () => {
  it('a click on a row opens the drawer at ?doc=<id>; another row switches it (no backdrop); Esc closes it', async () => {
    const { user } = await openPool();
    await user.click(await screen.findByRole('button', { name: 'DGZF-F07-001' }));
    expect(window.location.hash).toBe('#/documents?doc=doc-1');
    const drawer = await screen.findByRole('dialog', { name: 'DGZF-F07-001' });
    expect(drawer).toHaveStyle({ width: '430px' });
    expect(drawer).not.toHaveAttribute('aria-modal', 'true');
    expect(rowOf('DGZF-F07-001')).toHaveAttribute('aria-current', 'true');
    // 表格还在、还能点：点另一行就换单
    await user.click(screen.getByRole('button', { name: 'DGZF-F07-002' }));
    expect(await screen.findByRole('dialog', { name: 'DGZF-F07-002' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/documents?doc=doc-2');
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(document.querySelectorAll('style').length).toBe(0);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(window.location.hash).toBe('#/documents');
  });

  it('on wide screens the page makes room for the open drawer, so every column and the search box stay visible (V1, V2)', async () => {
    const { user } = await openPool();
    const content = screen.getByTestId('pool-content');
    expect(content).toHaveAttribute('data-drawer-open', 'false');
    expect(content.className).not.toMatch(/mr-\[/);
    await user.click(await screen.findByRole('button', { name: 'DGZF-F07-001' }));
    await screen.findByRole('dialog', { name: 'DGZF-F07-001' });
    expect(content).toHaveAttribute('data-drawer-open', 'true');
    // 宽屏（≥ 1280 px）让出抽屉的 430 px（内容区自己有 26 px 右边距，再留 16 px 空）；窄屏照旧叠在上面
    expect(content.className).toMatch(/(^| )xl:mr-\[420px\]( |$)/);
    expect(within(content).getByRole('searchbox', { name: '搜索单号、收款方' })).toBeInTheDocument();
    expect(within(content).getByRole('table', { name: '单据' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(content).toHaveAttribute('data-drawer-open', 'false'));
  });

  it('opens straight from the address, and rows open with the keyboard too', async () => {
    const { user } = await openPool({}, '#/documents?doc=doc-3');
    expect(await screen.findByRole('dialog', { name: 'DGZF-F07-003' })).toBeInTheDocument();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '关闭' }));
    expect(window.location.hash).toBe('#/documents');
    screen.getByRole('button', { name: 'DGZF-F07-002' }).focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog', { name: 'DGZF-F07-002' })).toBeInTheDocument();
  });
});

describe('单据池: an account with no companies (Ruling FR1)', () => {
  it('policy_reviewer has no companies in Jiuan: the pool says plainly that this account has nothing to see, and keeps its tabs', async () => {
    const { bench } = await openPool({ role: 'policy_reviewer' });
    expect(await screen.findByText('这个账号没有可看的单据')).toBeInTheDocument();
    expect(screen.getByText(/换管理员或分析员账号/)).toBeInTheDocument();
    expect(screen.queryByText('单据池里还没有对公付款单')).not.toBeInTheDocument();
    expect(screen.queryByRole('table', { name: '单据' })).not.toBeInTheDocument();
    expect(within(tabs()).getAllByRole('radio').map(radio => radio.textContent)).toEqual(['待复核 0', '已复核 0', '全部 0']);
    // 照真的九安：列表是空的
    expect(bench.find('GET', '/api/analysis/v1/documents')).toHaveLength(1);
  });

  it('an admin whose pool is simply empty still hears that no corporate payment has come in yet', async () => {
    await openPool({ docs: [], states: defaultStates(DOCS) });
    expect(await screen.findByText('单据池里还没有对公付款单')).toBeInTheDocument();
    expect(screen.queryByText('这个账号没有可看的单据')).not.toBeInTheDocument();
  });
});

// F2：单据池开着时自己刷新——表格里有「审核中」的行、或「待复核」是空的，每 12 秒问一次复核状态；单据池是空的，每 12 秒读一次列表。
// 页面藏起来（切到别的标签页）或离开单据池就停。「刷新」和再搜一次同样的字都重新读列表和状态。
describe('单据池: refreshes while it is open (F2)', () => {
  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  });
  const latestCalls = (bench: ReturnType<typeof fakeBench>) => bench.find('GET', '/api/analysis/v1/poc/reviews/latest').length;
  const listCalls = (bench: ReturnType<typeof fakeBench>) => bench.find('GET', '/api/analysis/v1/documents').length;
  const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  const hide = (hidden: boolean) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
  };

  it('a 审核中 row turns into 待复核 without the user doing anything, then the polling stops', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { bench } = await openPool();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await within(tabs()).findByRole('radio', { name: '待复核 2' });
    await user.click(within(tabs()).getByRole('radio', { name: '全部 4' }));
    expect(within(rowOf('DGZF-F07-004')).getByText('审核中')).toBeInTheDocument();
    const before = latestCalls(bench);
    // 那一轮跑完了：外壳现在说 doc-4 待复核
    const s4 = bench.states.get('doc-4')!;
    s4.latest = { state: 'pending', current: { round: 1, result: 'pass', status: 'completed' }, review: null };
    await advance(9_000);
    expect(latestCalls(bench)).toBe(before);
    await advance(3_500);
    expect(latestCalls(bench)).toBe(before + 1);
    expect(await within(rowOf('DGZF-F07-004')).findByText('建议通过')).toBeInTheDocument();
    expect(within(rowOf('DGZF-F07-004')).getByText('待复核')).toBeInTheDocument();
    expect(within(tabs()).getByRole('radio', { name: '待复核 3' })).toBeInTheDocument();
    // 没有在跑的了、「待复核」也不空：不再问
    await advance(40_000);
    expect(latestCalls(bench)).toBe(before + 1);
    expect(listCalls(bench)).toBe(1);
  });

  it('while 待复核 is empty it keeps asking, so new work shows up by itself', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const states = defaultStates();
    for (const id of ['doc-1', 'doc-2']) states.get(id)!.latest = { state: 'reviewed', current: { round: 1, result: 'fail', status: 'completed' }, review: { decision: 'adopt', adviceRound: 1 } };
    states.get('doc-4')!.latest = { state: 'no_advice', current: null, review: null };
    const { bench } = await openPool({ states });
    expect(await screen.findByText('没有待复核的单据')).toBeInTheDocument();
    const before = latestCalls(bench);
    states.get('doc-4')!.latest = { state: 'pending', current: { round: 1, result: 'fail', status: 'completed' }, review: null };
    await advance(12_500);
    expect(latestCalls(bench)).toBe(before + 1);
    expect(await screen.findByRole('button', { name: 'DGZF-F07-004' })).toBeInTheDocument();
    await advance(30_000);
    expect(latestCalls(bench)).toBe(before + 1);
  });

  it('an empty pool reads the list again every 12 s until documents arrive', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const docs: FakeDoc[] = [];
    const { bench } = await openPool({ docs, states: defaultStates(DOCS) });
    expect(await screen.findByText('单据池里还没有对公付款单')).toBeInTheDocument();
    expect(listCalls(bench)).toBe(1);
    await advance(12_500);
    expect(listCalls(bench)).toBe(2);
    docs.push(DOCS[0]);
    await advance(12_500);
    expect(await screen.findByRole('button', { name: 'DGZF-F07-001' })).toBeInTheDocument();
    const lists = listCalls(bench);
    await advance(40_000);
    expect(listCalls(bench)).toBe(lists);
  });

  it('stops while the page is hidden and starts again when it is shown; stops when the user leaves the pool', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { bench } = await openPool();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await within(tabs()).findByRole('radio', { name: '待复核 2' });
    await user.click(within(tabs()).getByRole('radio', { name: '全部 4' }));
    const before = latestCalls(bench);
    hide(true);
    await advance(40_000);
    expect(latestCalls(bench)).toBe(before);
    hide(false);
    await advance(12_500);
    expect(latestCalls(bench)).toBeGreaterThan(before);
    const shown = latestCalls(bench);
    await user.click(screen.getByRole('link', { name: '工作台' }));
    await screen.findByRole('heading', { level: 1, name: '工作台' });
    await advance(40_000);
    expect(latestCalls(bench)).toBe(shown);
  });

  it('「刷新」 next to 搜索 reads the list and the review states again', async () => {
    const { user, bench } = await openPool();
    await within(tabs()).findByRole('radio', { name: '待复核 2' });
    const refresh = screen.getByRole('button', { name: '刷新' });
    expect(screen.getByRole('button', { name: '搜索' }).nextElementSibling).toBe(refresh);
    const [lists, latest] = [listCalls(bench), latestCalls(bench)];
    bench.states.get('doc-3')!.latest = { state: 'outdated', current: { round: 2, result: 'pass', status: 'completed' }, review: { decision: 'adopt', adviceRound: 1 } };
    await user.click(refresh);
    expect(await within(tabs()).findByRole('radio', { name: '待复核 3' })).toBeInTheDocument();
    expect(listCalls(bench)).toBe(lists + 1);
    expect(latestCalls(bench)).toBe(latest + 1);
    // 连点两下：一次
    fireEvent.click(refresh);
    fireEvent.click(refresh);
    await waitFor(() => expect(latestCalls(bench)).toBe(latest + 2));
    expect(listCalls(bench)).toBe(lists + 2);
  });

  it('searching the same words again reads again', async () => {
    const { user, bench } = await openPool();
    await within(tabs()).findByRole('radio', { name: '待复核 2' });
    const search = screen.getByRole('searchbox', { name: '搜索单号、收款方' });
    await user.type(search, '柯顿{Enter}');
    await waitFor(() => expect(new URLSearchParams(bench.find('GET', '/api/analysis/v1/documents').at(-1)!.search).get('q')).toBe('柯顿'));
    const [lists, latest] = [listCalls(bench), latestCalls(bench)];
    await user.click(screen.getByRole('button', { name: '搜索' }));
    await waitFor(() => expect(listCalls(bench)).toBe(lists + 1));
    await waitFor(() => expect(latestCalls(bench)).toBe(latest + 1));
    expect(new URLSearchParams(bench.find('GET', '/api/analysis/v1/documents').at(-1)!.search).get('q')).toBe('柯顿');
  });
});
