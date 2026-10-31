import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { todayText } from '../dashboard/format';
import { startApp } from './startApp';
import { DASHBOARD, LONG_RULE, empty, fakeDashboard, fortnight, month, today, type DashboardOptions } from './dashboardFake';
import { deferred, docxFile } from './knowledgeFake';

// 工作台（Spec 第 6 节；样稿 dashboard-a-v9.html；Task 7 的 Ruling T7a–T7d）：右上「今天 / 近 14 天 / 本月」（默认近 14 天）、管理员的「上传制度」；
// 四个数；每天的 AI 建议（堆叠柱）；不通过最常见的依据；人工改判率（折线，没有复核的日子断开）；按审核员；知识库、最常引用的规则、我的规则。
// 空的测试台每个数是 0 或「—」、图表说清这里将来画什么（Review Focus 4）。
async function openDashboard(options: DashboardOptions = {}, { settle = true } = {}) {
  const bench = fakeDashboard(options);
  const app = await startApp('#/');
  await screen.findByRole('heading', { level: 1, name: '工作台' });
  if (settle) await screen.findByRole('region', { name: '每天的 AI 建议' });
  return { ...app, bench };
}
/** 换了窗口：等新窗口的数到了（之前的数留着、标「正在读取」）。 */
const settled = () => waitFor(() => expect(screen.getByTestId('dashboard-content')).toHaveAttribute('aria-busy', 'false'));
const region = (name: string) => screen.getByRole('region', { name });
const tile = (name: string) => (name === '待我复核' ? screen.getByRole('link', { name: /^待我复核/ }) : region(name));
const valueOf = (name: string) => tile(name).querySelector('[data-value]')?.textContent;
const detailOf = (name: string) => tile(name).querySelector('[data-detail]')?.textContent;
const searches = (bench: ReturnType<typeof fakeDashboard>) => bench.find('GET', DASHBOARD).map(call => call.search);
const box = (el: Element) => ({ x: Number(el.getAttribute('x')), y: Number(el.getAttribute('y')), width: Number(el.getAttribute('width')), height: Number(el.getAttribute('height')) });
const barChart = () => within(region('每天的 AI 建议')).getByRole('group', { name: '每天的 AI 建议' });
const lineChart = () => within(region('人工改判率')).getByRole('group', { name: '人工改判率' });
const xs = (d: string) => [...d.matchAll(/[ML]\s*([\d.]+)/g)].map(match => Number(match[1]));
/** 页面上任何字、任何属性里都不能有 NaN / Infinity / undefined。 */
function expectNoBadNumbers() {
  expect(document.body.textContent).not.toMatch(/NaN|Infinity|undefined|null/);
  for (const element of document.body.querySelectorAll('*')) {
    for (const attribute of element.attributes) expect(`${attribute.name}=${attribute.value}`).not.toMatch(/NaN|Infinity|undefined/);
  }
}

describe('工作台: window and header (T7b)', () => {
  it('asks for 近 14 天 first; 今天 / 近 14 天 / 本月 each send window= and nothing else', async () => {
    const { user, bench } = await openDashboard();
    await waitFor(() => expect(valueOf('AI 已出建议')).toBe('221张'));
    expect(searches(bench)).toEqual(['?window=14d']);
    const range = screen.getByRole('radiogroup', { name: '统计范围' });
    expect(within(range).getAllByRole('radio').map(radio => radio.textContent)).toEqual(['今天', '近 14 天', '本月']);
    expect(within(range).getByRole('radio', { name: '近 14 天' })).toHaveAttribute('aria-checked', 'true');

    await user.click(within(range).getByRole('radio', { name: '今天' }));
    await waitFor(() => expect(valueOf('AI 已出建议')).toBe('3张'));
    expect(within(barChart()).getAllByRole('img')).toHaveLength(1);
    await user.click(within(range).getByRole('radio', { name: '本月' }));
    await waitFor(() => expect(valueOf('AI 已出建议')).toBe('400张'));
    expect(within(barChart()).getAllByRole('img')).toHaveLength(30);
    expect(searches(bench)).toEqual(['?window=14d', '?window=today', '?window=month']);
    expect(within(region('按审核员')).getByText('本月')).toBeInTheDocument();
  });

  it('the header shows the Shanghai date as 「10 月 31 日 · 周六」', async () => {
    expect(todayText(Date.parse('2026-10-30T16:30:00.000Z'))).toBe('10 月 31 日 · 周六');
    expect(todayText(Date.parse('2026-10-30T15:59:00.000Z'))).toBe('10 月 30 日 · 周五');
    expect(todayText(Date.parse('2026-11-01T04:00:00.000Z'))).toBe('11 月 1 日 · 周日');
    await openDashboard();
    const heading = screen.getByRole('heading', { level: 1, name: '工作台' });
    expect(heading.parentElement).toHaveTextContent(/工作台\d{1,2} 月 \d{1,2} 日 · 周[一二三四五六日]/);
  });

  it('when the numbers cannot be read, shows the shell message as it came, and 「重试」 asks again', async () => {
    let fail = true;
    const { user, bench } = await openDashboard({ route: () => (fail
      ? { status: 503, body: { error: { code: 'DASHBOARD_UNAVAILABLE', message: '工作台的数暂时算不出来（AI 建议轮次、复核记录或上传历史读不到）：稍后刷新再试。' } } }
      : { body: { data: fortnight() } }) }, { settle: false });
    // 5xx 由查询重试一次，之后才说明
    expect(await screen.findByText('工作台的数暂时算不出来（AI 建议轮次、复核记录或上传历史读不到）：稍后刷新再试。', {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '每天的 AI 建议' })).not.toBeInTheDocument();
    const asked = searches(bench).length;
    fail = false;
    await user.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(valueOf('AI 已出建议')).toBe('221张'));
    expect(searches(bench).length).toBe(asked + 1);
  });
});

describe('工作台: the four numbers match the API', () => {
  it('待我复核 / AI 已出建议 / 建议通过 / 出建议用时', async () => {
    await openDashboard();
    await waitFor(() => expect(valueOf('待我复核')).toBe('7张'));
    expect(detailOf('待我复核')).toBe('其中 2 张 AI 不建议通过');
    expect(tile('待我复核')).toHaveAttribute('href', '#/documents');
    expect(valueOf('AI 已出建议')).toBe('221张');
    expect(detailOf('AI 已出建议')).toBe('人工改判 11 张');
    expect(valueOf('建议通过')).toBe('80%');
    expect(detailOf('建议通过')).toBe('176 / 221');
    expect(valueOf('出建议用时')).toBe('82秒 / 张');
    expect(detailOf('出建议用时')).toBe('最长 101 秒，上限 120 秒');
  });

  it('clicking 待我复核 opens 单据池 on its 待复核 tab', async () => {
    const { user } = await openDashboard();
    await waitFor(() => expect(valueOf('待我复核')).toBe('7张'));
    await user.click(tile('待我复核'));
    expect(await screen.findByRole('heading', { level: 1, name: '单据池' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/documents');
    expect(screen.getByRole('radio', { name: /^待复核/ })).toHaveAttribute('aria-checked', 'true');
  });

  it('建议通过 never says 100% unless all passed, nor 0% unless none did', async () => {
    const { user } = await openDashboard({ data: {
      '14d': { ...fortnight(), advice: { ...fortnight().advice, completed: 200, pass: 199, fail: 1, passRate: 199 / 200 } },
      today: { ...today(), advice: { ...today().advice, completed: 300, pass: 1, fail: 299, passRate: 1 / 300 } },
    } });
    await waitFor(() => expect(valueOf('建议通过')).toBe('99%'));
    expect(detailOf('建议通过')).toBe('199 / 200');
    await user.click(screen.getByRole('radio', { name: '今天' }));
    await waitFor(() => expect(valueOf('建议通过')).toBe('1%'));
    expect(detailOf('建议通过')).toBe('1 / 300');
  });

  it('null averages and rate show 「—」, never NaN', async () => {
    const data = { ...fortnight(), advice: { completed: 0, pass: 0, fail: 0, overrides: 0, passRate: null, avgDurationMs: null, maxDurationMs: null } };
    await openDashboard({ data: { '14d': data } });
    await waitFor(() => expect(valueOf('AI 已出建议')).toBe('0张'));
    expect(valueOf('建议通过')).toBe('—');
    expect(detailOf('建议通过')).toBe('0 / 0');
    expect(valueOf('出建议用时')).toBe('—');
    expect(detailOf('出建议用时')).toBe('最长 —，上限 120 秒');
    expectNoBadNumbers();
  });
});

describe('每天的 AI 建议 (stacked bars)', () => {
  it('stacks 建议通过 / 不建议通过 / 审核中 bottom-up, 2 px gaps between segments and between bars, bars at most 24 px', async () => {
    await openDashboard();
    const bars = within(barChart()).getAllByRole('img');
    expect(bars).toHaveLength(14);
    const segments = [...bars[13].querySelectorAll('[data-segment]')];
    expect(segments.map(segment => segment.getAttribute('data-segment'))).toEqual(['pass', 'fail', 'running']);
    expect(segments.map(segment => segment.getAttribute('fill'))).toEqual(['var(--color-pass)', 'var(--color-fail)', 'var(--color-wait)']);
    const [pass, fail, running] = segments.map(box);
    expect(pass.y - (fail.y + fail.height)).toBe(2);
    expect(fail.y - (running.y + running.height)).toBe(2);
    // 只有不是 0 的段才画
    expect([...bars[0].querySelectorAll('[data-segment]')].map(segment => segment.getAttribute('data-segment'))).toEqual(['pass', 'fail']);
    const marks = bars.map(bar => box(bar.querySelector('[data-segment]')!));
    for (let at = 1; at < marks.length; at += 1) expect(marks[at].x - (marks[at - 1].x + marks[at - 1].width)).toBeGreaterThanOrEqual(2);
    // 整像素：crispEdges 下缝才是不多不少的 2 px
    for (const rect of barChart().querySelectorAll('[data-segment], [data-hit]')) {
      for (const name of ['x', 'y', 'width', 'height']) expect(Number.isInteger(Number(rect.getAttribute(name))), `${name}=${rect.getAttribute(name)}`).toBe(true);
    }
    expect(Math.max(...marks.map(mark => mark.width))).toBeLessThanOrEqual(24);
    // 悬停区比柱子大：整个格子、整个绘图高度
    const hit = box(bars[13].querySelector('[data-hit]')!);
    expect(hit.width).toBeGreaterThan(marks[13].width + 2);
    expect(hit.height).toBeGreaterThan(pass.height + fail.height + running.height + 4);
  });

  it('in 本月 the 30 bars touch with exactly a 2 px gap', async () => {
    const { user } = await openDashboard();
    await user.click(screen.getByRole('radio', { name: '本月' }));
    await waitFor(() => expect(within(barChart()).getAllByRole('img')).toHaveLength(30));
    const marks = within(barChart()).getAllByRole('img').map(bar => box(bar.querySelector('[data-segment]')!));
    for (let at = 1; at < marks.length; at += 1) expect(marks[at].x - (marks[at - 1].x + marks[at - 1].width)).toBe(2);
    for (const rect of barChart().querySelectorAll('[data-segment]')) {
      for (const name of ['x', 'y', 'width', 'height']) expect(Number.isInteger(Number(rect.getAttribute(name)))).toBe(true);
    }
  });

  it('a legend of three items, each with text; 建议通过 / 不建议通过 carry ✓ / ✕; text never wears the series color', async () => {
    await openDashboard();
    const legend = within(region('每天的 AI 建议')).getByRole('list', { name: '图例' });
    const items = within(legend).getAllByRole('listitem');
    expect(items.map(item => item.textContent)).toEqual(['建议通过', '不建议通过', '审核中']);
    expect(items.map(item => item.querySelector('[data-swatch]')?.getAttribute('fill'))).toEqual(['var(--color-pass)', 'var(--color-fail)', 'var(--color-wait)']);
    expect(items[0].querySelector('path')?.getAttribute('d')).toBe('M5 12.5l4.5 4.5L19 7.5');
    expect(items[1].querySelector('path')?.getAttribute('d')).toBe('M6 6l12 12M18 6L6 18');
    for (const item of items) expect(item.className).not.toMatch(/text-(pass|fail|wait)\b/);
  });

  it('does not put a number on every bar: the only texts are the axes', async () => {
    await openDashboard();
    const texts = [...barChart().querySelectorAll('text')];
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) expect(text).toHaveAttribute('data-axis');
    for (const text of texts) expect(text.getAttribute('fill')).toBe('var(--color-faint)');
    // 14 天标 7 个日期
    expect(texts.filter(text => text.getAttribute('data-axis') === 'x').map(text => text.textContent)).toEqual(['10/17', '10/19', '10/21', '10/23', '10/25', '10/27', '10/29']);
    expect(texts.filter(text => text.getAttribute('data-axis') === 'y').map(text => text.textContent)).toEqual(['0', '10', '20', '30']);
  });

  it('hover shows that day\'s breakdown; keyboard focus shows the same and arrows move by day', async () => {
    const { user } = await openDashboard();
    const bars = within(barChart()).getAllByRole('img');
    await user.hover(bars[13]);
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent('10 月 30 日');
    expect(within(tip).getAllByRole('listitem').map(item => item.textContent)).toEqual(['建议通过2 张', '不建议通过1 张', '审核中1 张']);
    expect(tip).toHaveTextContent('共 4 张');
    expect(bars[13]).toHaveAttribute('aria-describedby', tip.id);
    expect(bars[13]).toHaveAccessibleName('10/30：建议通过 2 张，不建议通过 1 张，审核中 1 张');
    await user.unhover(bars[13]);
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());

    // 只有一根柱子在 Tab 顺序里
    expect(bars.filter(bar => bar.getAttribute('tabindex') === '0')).toHaveLength(1);
    act(() => { (bars[13] as unknown as HTMLElement).focus(); });
    expect(await screen.findByRole('tooltip')).toHaveTextContent('10 月 30 日');
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tooltip')).toHaveTextContent('10 月 29 日');
    expect(document.activeElement).toBe(bars[12]);
    await user.keyboard('{Home}');
    expect(screen.getByRole('tooltip')).toHaveTextContent('10 月 17 日');
  });

  it('a mouse click on a day draws no focus ring: the ring is keyboard-only (:focus-visible)', async () => {
    const { user } = await openDashboard();
    for (const chart of [barChart(), lineChart()]) {
      const day = within(chart).getAllByRole('img').at(-1)!;
      await user.click(day);
      expect(document.activeElement).toBe(day);
      const hit = day.querySelector('[data-hit]')!;
      expect(hit).not.toHaveAttribute('stroke');
      expect(hit.getAttribute('class')).toMatch(/group-focus-visible:stroke-blue/);
      expect(day.getAttribute('class')).toMatch(/(^| )group( |$)/);
    }
  });

  it('「表格」 switches to a table view of every day, and back', async () => {
    const { user } = await openDashboard();
    const panel = region('每天的 AI 建议');
    const toggle = within(panel).getByRole('button', { name: '表格' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    const table = within(panel).getByRole('table', { name: '每天的 AI 建议' });
    expect(within(table).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['日期', '建议通过', '不建议通过', '审核中', '合计']);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(14);
    expect(within(rows[0]).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['10/17', '17', '7', '0', '24']);
    expect(within(rows[13]).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['10/30', '2', '1', '1', '4']);
    expect(within(panel).queryByRole('group', { name: '每天的 AI 建议' })).not.toBeInTheDocument();
    await user.click(toggle);
    expect(within(panel).getByRole('group', { name: '每天的 AI 建议' })).toBeInTheDocument();
  });
});

describe('人工改判率 (line)', () => {
  it('days without reviews break the line: no segment across 10/22–10/23 or 10/29', async () => {
    await openDashboard();
    const chart = lineChart();
    const days = within(chart).getAllByRole('img');
    expect(days).toHaveLength(14);
    const centre = (at: number) => Number(days[at].getAttribute('data-x'));
    const segments = [...chart.querySelectorAll('path[data-line]')];
    expect(segments).toHaveLength(2);
    expect(segments.map(segment => xs(segment.getAttribute('d')!).length)).toEqual([5, 5]);
    expect(xs(segments[0].getAttribute('d')!)).toEqual([0, 1, 2, 3, 4].map(centre));
    expect(xs(segments[1].getAttribute('d')!)).toEqual([7, 8, 9, 10, 11].map(centre));
    for (const segment of segments) {
      expect(segment.getAttribute('stroke')).toBe('var(--color-blue)');
      expect(segment.getAttribute('stroke-width')).toBe('2');
      expect(segment.getAttribute('fill')).toBe('none');
    }
    // 10/30 前后都没有数，单独一点画成记号
    expect([...chart.querySelectorAll('[data-marker]')].map(marker => marker.getAttribute('data-marker'))).toEqual(['13']);
  });

  it('labels the last point with data directly (6.3%), in ink, and only that one', async () => {
    await openDashboard();
    const labels = [...lineChart().querySelectorAll('text[data-label]')];
    expect(labels.map(label => label.textContent)).toEqual(['6.3%']);
    expect(labels[0].getAttribute('fill')).toBe('var(--color-ink)');
  });

  it('when the last day has no reviews, the label sits on the last day that has some', async () => {
    const data = fortnight();
    data.overrideRate[13] = { ...data.overrideRate[13], reviews: 0, overrides: 0 };
    await openDashboard({ data: { '14d': data } });
    expect([...lineChart().querySelectorAll('text[data-label]')].map(label => label.textContent)).toEqual(['2.9%']);
    expect([...lineChart().querySelectorAll('[data-marker]')].map(marker => marker.getAttribute('data-marker'))).toEqual(['11']);
  });

  it('the tooltip gives that day\'s 复核 N 张 / 改判 M 张; a day without reviews says so', async () => {
    const { user } = await openDashboard();
    const days = within(lineChart()).getAllByRole('img');
    await user.hover(days[10]);
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent('10 月 27 日');
    expect(tip).toHaveTextContent('改判率 3.6%');
    expect(tip).toHaveTextContent('复核 28 张 / 改判 1 张');
    await user.hover(days[5]);
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent('10 月 22 日'));
    expect(screen.getByRole('tooltip')).toHaveTextContent('这天没有复核');
    expect(days[5]).toHaveAccessibleName('10/22：没有复核');
  });

  it('one axis only, in percent, on the left', async () => {
    await openDashboard();
    const ticks = [...lineChart().querySelectorAll('text[data-axis="y"]')];
    expect(ticks.map(tick => tick.textContent)).toEqual(['0%', '2%', '4%', '6%', '8%']);
    expect(new Set(ticks.map(tick => tick.getAttribute('x'))).size).toBe(1);
    expect(lineChart().querySelectorAll('text[data-axis]:not([data-axis="x"]):not([data-axis="y"])')).toHaveLength(0);
  });

  it('「表格」 gives every day with 复核 / 改判 / 改判率 (「—」 without reviews)', async () => {
    const { user } = await openDashboard();
    const panel = region('人工改判率');
    await user.click(within(panel).getByRole('button', { name: '表格' }));
    const table = within(panel).getByRole('table', { name: '人工改判率' });
    expect(within(table).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['日期', '复核', '改判', '改判率']);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(within(rows[5]).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['10/22', '0', '0', '—']);
    expect(within(rows[13]).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['10/30', '16', '1', '6.3%']);
  });
});

describe('不通过最常见的依据', () => {
  it('lists the basis with its kind, a bar and the count; 我的规则 in purple; two rows with the same label both show (keyed by index, T7c)', async () => {
    const errors = vi.spyOn(console, 'error');
    await openDashboard();
    const panel = region('不通过最常见的依据');
    expect(within(panel).getByText('45 张不建议通过')).toBeInTheDocument();
    const rows = within(panel).getAllByRole('listitem');
    expect(rows).toHaveLength(6);
    expect(rows.map(row => row.querySelector('[data-tone]')?.textContent)).toEqual(['公司制度', '单据字段', '原件', '我的规则', '公司制度', '公司制度']);
    expect(rows.map(row => row.querySelector('[data-count]')?.textContent)).toEqual(['14', '10', '8', '5', '3', '3']);
    expect(rows[3].querySelector('[data-tone]')).toHaveAttribute('data-tone', 'own');
    expect(rows[3].querySelector('[data-fill]')).toHaveStyle({ width: '35.7%' });
    expect(rows[3].querySelector('[data-fill]')?.className).toMatch(/bg-own\b/);
    expect(rows[0].querySelector('[data-fill]')?.className).toMatch(/bg-blue\b/);
    expect(rows[0].querySelector('[data-fill]')).toHaveStyle({ width: '100%' });
    expect(within(rows[4]).getByText(LONG_RULE)).toHaveAttribute('title', LONG_RULE);
    expect(within(rows[5]).getByText(LONG_RULE)).toBeInTheDocument();
    expect(errors.mock.calls.flat().join(' ')).not.toMatch(/same key|unique "key"/);
  });
});

describe('按审核员', () => {
  it('admin: everyone, 审核员 · 复核 · 改判 · 改判率 · 个人规则; 改判率 is 「—」 when there are no reviews', async () => {
    await openDashboard();
    const table = within(region('按审核员')).getByRole('table', { name: '按审核员' });
    expect(within(table).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['审核员', '复核', '改判', '改判率', '个人规则']);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map(row => row.querySelector('[data-name]')?.textContent)).toEqual(['审核员（我）', '复核人（虚构）', '李航（虚构）', '王悦（虚构）']);
    expect(rows.map(row => within(row).getAllByRole('cell').slice(1).map(cell => cell.textContent))).toEqual([
      ['86', '3', '3.5%', '2 份'], ['64', '4', '6.3%', '1 份'], ['48', '1', '2.1%', '—'], ['0', '0', '—', '3 份'],
    ]);
    expect(rows[0]).toHaveAttribute('data-me', 'true');
    expect(within(region('按审核员')).getByText('近 14 天')).toBeInTheDocument();
  });

  it('analyst: only their own row, and no 上传制度', async () => {
    const { bench } = await openDashboard({ role: 'analyst' });
    const rows = within(within(region('按审核员')).getByRole('table')).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector('[data-name]')?.textContent).toBe('复核人（我）');
    expect(within(rows[0]).getAllByRole('cell').slice(1).map(cell => cell.textContent)).toEqual(['12', '1', '8.3%', '1 份']);
    expect(screen.queryByRole('button', { name: '上传制度' })).not.toBeInTheDocument();
    expect(bench.calls.filter(call => call.path.startsWith('/api/analysis/v1/poc/kb/'))).toEqual([]);
  });

  it('policy_reviewer: says there is nothing to count for this account, and no 上传制度', async () => {
    await openDashboard({ role: 'policy_reviewer' });
    // 这个角色不复核：上排第一个数叫「待复核」，不说「待我复核」
    expect(screen.getByRole('link', { name: /^待复核/ })).toHaveAttribute('href', '#/documents');
    expect(screen.queryByRole('link', { name: /^待我复核/ })).not.toBeInTheDocument();
    const panel = region('按审核员');
    expect(within(panel).queryByRole('table')).not.toBeInTheDocument();
    expect(within(panel).getByText('你的账号不做复核，这里没有按审核员的统计。')).toBeInTheDocument();
    // 没有「我的规则」：表头不写「0 份」
    expect(within(region('我的规则')).getByText('你的账号没有「我的规则」。')).toBeInTheDocument();
    expect(within(region('我的规则')).queryByText(/份/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '上传制度' })).not.toBeInTheDocument();
  });
});

describe('知识库 · 最常引用的规则 · 我的规则', () => {
  it('知识库: Agent status, 制度 N 份, 规则 N 条, 最近入库', async () => {
    await openDashboard();
    const panel = region('知识库');
    expect(within(panel).getByText('Agent 就绪').closest('[data-tone]')).toHaveAttribute('data-tone', 'pass');
    expect(within(panel).getByText('3 份')).toBeInTheDocument();
    expect(within(panel).getByText('1,102 条')).toBeInTheDocument();
    expect(within(panel).getByText('10-30')).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: '打开知识库' })).toHaveAttribute('href', '#/knowledge');
  });

  it('知识库: not configured / not enabled say so; analysts get no link to the admin-only page', async () => {
    const off = { ...fortnight(), knowledge: { mode: 'pg', configured: false, ready: false, sources: 0, rules: 0, lastIngestAt: null } };
    await openDashboard({ role: 'analyst', data: { '14d': off } });
    const panel = region('知识库');
    expect(within(panel).getByText('Agent 未配置').closest('[data-tone]')).toHaveAttribute('data-tone', 'neutral');
    expect(within(panel).getByText('—')).toBeInTheDocument();
    expect(within(panel).queryByRole('link')).not.toBeInTheDocument();
  });

  it('知识库: configured but not enabled', async () => {
    const off = { ...fortnight(), knowledge: { mode: 'pg', configured: true, ready: false, sources: 1, rules: 12, lastIngestAt: null } };
    await openDashboard({ data: { '14d': off } });
    expect(within(region('知识库')).getByText('Agent 未启用').closest('[data-tone]')).toHaveAttribute('data-tone', 'wait');
  });

  it('最常引用的规则: up to 5 rule ids with their counts', async () => {
    await openDashboard();
    const items = within(region('最常引用的规则')).getAllByRole('listitem');
    expect(items.map(item => [item.querySelector('[data-rule]')?.textContent, item.querySelector('[data-count]')?.textContent])).toEqual([
      ['C05-2.3', '31 次'], ['C05-3.4', '18 次'], ['C07-7.11', '9 次'], ['G-01', '4 次'], ['C05-NOTE', '2 次'],
    ]);
  });

  it('我的规则: 已用 N / 5,000 字 with a bar, and N 份', async () => {
    await openDashboard();
    const panel = region('我的规则');
    expect(within(panel).getByText('1,320 / 5,000 字')).toBeInTheDocument();
    expect(within(panel).getByText('2 份')).toBeInTheDocument();
    const meter = within(panel).getByRole('meter', { name: '已用字数' });
    expect(meter).toHaveAttribute('aria-valuenow', '1320');
    expect(meter).toHaveAttribute('aria-valuemax', '5000');
    expect(meter.querySelector('[data-fill]')).toHaveStyle({ width: '26.4%' });
    expect(meter.querySelector('[data-fill]')?.className).toMatch(/bg-own\b/);
    expect(within(panel).getByRole('link', { name: '管理我的规则' })).toHaveAttribute('href', '#/my-rules');
  });
});

describe('an empty bench (Review Focus 4)', () => {
  it('every number is 0 or 「—」, charts say what will appear, lists have empty states, nothing divides by zero', async () => {
    const { user, bench } = await openDashboard({ data: window => empty(window) });
    await waitFor(() => expect(valueOf('待我复核')).toBe('0张'));
    expect(detailOf('待我复核')).toBe('其中 0 张 AI 不建议通过');
    expect(valueOf('AI 已出建议')).toBe('0张');
    expect(detailOf('AI 已出建议')).toBe('人工改判 0 张');
    expect(valueOf('建议通过')).toBe('—');
    expect(detailOf('建议通过')).toBe('0 / 0');
    expect(valueOf('出建议用时')).toBe('—');
    expect(within(region('每天的 AI 建议')).getByText('这段时间还没有 AI 建议：出了建议，这里按天画出通过、不通过和审核中的张数。')).toBeInTheDocument();
    expect(within(region('每天的 AI 建议')).queryByRole('group')).not.toBeInTheDocument();
    expect(within(region('每天的 AI 建议')).queryByRole('button', { name: '表格' })).not.toBeInTheDocument();
    expect(within(region('人工改判率')).getByText('这段时间还没有人复核：复核之后，这里按天画出改判的比例。')).toBeInTheDocument();
    expect(within(region('人工改判率')).queryByRole('group')).not.toBeInTheDocument();
    expect(within(region('不通过最常见的依据')).getByText('这段时间 AI 没有不建议通过的单据：有了，这里列出最常引用的依据。')).toBeInTheDocument();
    expect(within(region('不通过最常见的依据')).getByText('0 张不建议通过')).toBeInTheDocument();
    expect(within(region('最常引用的规则')).getByText('这段时间的 AI 建议还没有引用公司制度：引用了，这里列出最常用的规则编号。')).toBeInTheDocument();
    const rows = within(within(region('按审核员')).getByRole('table')).getAllByRole('row').slice(1);
    expect(rows.map(row => within(row).getAllByRole('cell').slice(1).map(cell => cell.textContent))).toEqual([['0', '0', '—', '—'], ['0', '0', '—', '—']]);
    expect(within(region('知识库')).getByText('0 份')).toBeInTheDocument();
    expect(within(region('知识库')).getByText('0 条')).toBeInTheDocument();
    expect(within(region('我的规则')).getByText('0 / 5,000 字')).toBeInTheDocument();
    expect(within(region('我的规则')).getByRole('meter').querySelector('[data-fill]')).toHaveStyle({ width: '0%' });
    expectNoBadNumbers();
    for (const [name, window] of [['今天', 'today'], ['本月', 'month']]) {
      await user.click(screen.getByRole('radio', { name }));
      await waitFor(() => expect(searches(bench).at(-1)).toBe(`?window=${window}`));
      await settled();
      expect(within(region('每天的 AI 建议')).getByText(/这段时间还没有 AI 建议/)).toBeInTheDocument();
      expectNoBadNumbers();
    }
  });

  it('a payload with missing or broken fields still shows 0 / 「—」 and empty states, never NaN', async () => {
    await openDashboard({ data: () => ({ advice: { completed: '3', passRate: 'x' }, daily: [{ date: '2026-10-30', pass: 'x', fail: null }], overrideRate: 'nope', reviewers: [{ name: '虚构', reviews: -1 }], myRules: { usedChars: 10, limitChars: 0 } }) });
    await waitFor(() => expect(valueOf('AI 已出建议')).toBe('0张'));
    expect(valueOf('建议通过')).toBe('—');
    expect(within(region('每天的 AI 建议')).getByText(/这段时间还没有 AI 建议/)).toBeInTheDocument();
    expect(within(region('人工改判率')).getByText(/这段时间还没有人复核/)).toBeInTheDocument();
    // 合计上限没给：按 5,000 字算
    expect(within(region('我的规则')).getByText('10 / 5,000 字')).toBeInTheDocument();
    expect(within(region('我的规则')).getByRole('meter').querySelector('[data-fill]')).toHaveStyle({ width: '0.2%' });
    expectNoBadNumbers();
  });

  it('only zero-review days and a reviewed day with no overrides: the 0% line has a real scale', async () => {
    const data = { ...empty('14d'), overrideRate: empty('14d').overrideRate.map((day, at) => (at === 3 ? { ...day, reviews: 5, overrides: 0 } : day)) };
    await openDashboard({ data: { '14d': data } });
    const chart = lineChart();
    expect([...chart.querySelectorAll('text[data-label]')].map(label => label.textContent)).toEqual(['0.0%']);
    expect([...chart.querySelectorAll('text[data-axis="y"]')].map(tick => tick.textContent)).toEqual(['0%', '1%', '2%', '3%', '4%']);
    expectNoBadNumbers();
  });
});

describe('上传制度 on the dashboard (T7a: admins only)', () => {
  it('opens the knowledge base\'s upload modal (Task 6)', async () => {
    const { user } = await openDashboard();
    await user.click(screen.getByRole('button', { name: '上传制度' }));
    const dialog = await screen.findByRole('dialog', { name: '上传制度' });
    expect(await within(dialog).findByText('把制度 .docx 拖到这里，或')).toBeInTheDocument();
    expect(document.querySelectorAll('style')).toHaveLength(0);
  });

  it('closing while it still ingests leaves a notice with a link to the knowledge page', async () => {
    const { user } = await openDashboard();
    // 读屏只念「后来填进去的」：提示区一开始就在、是空的，提示的字后填进同一个节点
    const live = document.querySelector('[data-notice]')!;
    expect(live).toHaveAttribute('role', 'status');
    expect(live).toBeEmptyDOMElement();
    await user.click(screen.getByRole('button', { name: '上传制度' }));
    const dialog = await screen.findByRole('dialog', { name: '上传制度' });
    await within(dialog).findByText('把制度 .docx 拖到这里，或');
    await user.upload(dialog.querySelector<HTMLInputElement>('input[type="file"]')!, docxFile('new-policy.docx'));
    await user.click(within(dialog).getByRole('button', { name: '上传并入库' }));
    await within(dialog).findByText('入库中');
    await user.click(within(dialog).getByRole('button', { name: '稍后再看' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const notice = screen.getByText('入库在后台继续，稍后在知识库页的上传记录里看结果').closest('[role="status"]')!;
    expect(notice).toBe(live);
    expect(within(notice as HTMLElement).getByRole('link', { name: '打开知识库' })).toHaveAttribute('href', '#/knowledge');
    await user.click(within(notice as HTMLElement).getByRole('button', { name: '关掉提示' }));
    expect(screen.queryByText('入库在后台继续，稍后在知识库页的上传记录里看结果')).not.toBeInTheDocument();
    expect(document.querySelector('[data-notice]')).toBe(live);
    expect(live).toBeEmptyDOMElement();
  });

  it('closing without an upload leaves no notice', async () => {
    const { user } = await openDashboard();
    await user.click(screen.getByRole('button', { name: '上传制度' }));
    const dialog = await screen.findByRole('dialog', { name: '上传制度' });
    await within(dialog).findByText('把制度 .docx 拖到这里，或');
    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByText('入库在后台继续，稍后在知识库页的上传记录里看结果')).not.toBeInTheDocument();
  });

  it('nothing on the dashboard puts a <style> element into the page, hovering a chart included', async () => {
    const { user } = await openDashboard();
    await user.hover(within(barChart()).getAllByRole('img')[3]);
    await screen.findByRole('tooltip');
    await user.click(within(region('人工改判率')).getByRole('button', { name: '表格' }));
    expect(document.querySelectorAll('style')).toHaveLength(0);
  });
});

describe('switching window while hovering (fix round 1)', () => {
  const windowOf = (search: string) => new URLSearchParams(search).get('window');

  it('keeps the old numbers faded (aria-busy) while a shorter window loads; a day hovered meanwhile does not crash the page when the new days arrive', async () => {
    const slow = deferred();
    const { user, bench } = await openDashboard({ route: call => (windowOf(call.search) === 'today' ? slow.route() : { body: { data: fortnight() } }) });
    await waitFor(() => expect(valueOf('AI 已出建议')).toBe('221张'));
    await user.click(screen.getByRole('radio', { name: '今天' }));
    await waitFor(() => expect(searches(bench)).toEqual(['?window=14d', '?window=today']));
    // 新窗口的数还没到：旧的 14 天留着、变淡、标「正在读取」
    const content = screen.getByTestId('dashboard-content');
    expect(content).toHaveAttribute('aria-busy', 'true');
    expect(content.className).toMatch(/opacity-60/);
    expect(screen.getByRole('radio', { name: '今天' })).toHaveAttribute('aria-checked', 'true');
    expect(valueOf('AI 已出建议')).toBe('221张');
    expect(within(lineChart()).getAllByRole('img')).toHaveLength(14);
    // 这时指到旧图后面的一天（新窗口只有 1 天）
    await user.hover(within(lineChart()).getAllByRole('img')[12]);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('10 月 29 日');
    await act(async () => { slow.resolve({ body: { data: today() } }); });
    await settled();
    expect(screen.getByTestId('dashboard-content')).toHaveAttribute('aria-busy', 'false');
    expect(screen.queryByText('这一页没有打开')).not.toBeInTheDocument();
    expect(valueOf('AI 已出建议')).toBe('3张');
    expect(within(lineChart()).getAllByRole('img')).toHaveLength(1);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expectNoBadNumbers();
  });

  it('a hovered bar does not carry its index into the next window (no tooltip for the wrong day); moving the pointer shows the new day', async () => {
    const slow = deferred();
    await openDashboard({ route: call => (windowOf(call.search) === 'month' ? slow.route() : { body: { data: fortnight() } }) });
    const user = (await import('@testing-library/user-event')).default.setup();
    await user.hover(within(barChart()).getAllByRole('img')[3]);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('10 月 20 日');
    // 指针不动，点「本月」（键盘或别的方式，不经过柱子以外的地方）
    fireEvent.click(screen.getByRole('radio', { name: '本月' }));
    await act(async () => { slow.resolve({ body: { data: month() } }); });
    await settled();
    expect(within(barChart()).getAllByRole('img')).toHaveLength(30);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    const bars = within(barChart()).getAllByRole('img');
    fireEvent.pointerMove(bars[3]);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('10 月 4 日');
  });

  it('a day focused by keyboard past the end of the new window leaves no stale tooltip either', async () => {
    const slow = deferred();
    await openDashboard({ route: call => (windowOf(call.search) === 'today' ? slow.route() : { body: { data: fortnight() } }) });
    const days = within(lineChart()).getAllByRole('img');
    act(() => { (days[13] as unknown as HTMLElement).focus(); });
    expect(await screen.findByRole('tooltip')).toHaveTextContent('10 月 30 日');
    fireEvent.click(screen.getByRole('radio', { name: '今天' }));
    await act(async () => { slow.resolve({ body: { data: today() } }); });
    await settled();
    expect(screen.queryByText('这一页没有打开')).not.toBeInTheDocument();
    expect(within(lineChart()).getAllByRole('img')).toHaveLength(1);
  });
});
