import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_POLL_MS, TEST_WAIT_MS } from '../api/agents';
import { startApp } from './startApp';
import { AUDIT_PUB, BASIS, CALLS, DESCRIBE_REQUEST, KB_PUB, REVIEW_REQUEST, deferred, fakeAgents, type AgentsOptions } from './agentsFake';

// 「Agent 接入」的测试和调用记录（补丁 0002 的 testForm / callsCard；Ruling T8d）：三种测法照外壳 agent-tests.mjs 的请求体，
// 开始后每 3 秒问一次 /tests/:id，停在结果上；结果显示结论、依据、回复或原始回答、用时，失败时的错误码。调用记录默认收起，展开看备注和依据。
const BASE = '/api/analysis/v1/platform/agent-access';
afterEach(() => { vi.useRealTimers(); });

async function openAgents(options: AgentsOptions = {}) {
  const bench = fakeAgents(options);
  const app = await startApp('#/agents');
  await screen.findByRole('heading', { level: 1, name: 'Agent 接入' });
  return { ...app, bench };
}
async function rowOf(id: string) {
  const table = await screen.findByRole('table', { name: 'Agent 列表' });
  await waitFor(() => expect(table.querySelector(`tr[data-publish="${id}"]`)).not.toBeNull());
  return table.querySelector(`tr[data-publish="${id}"]`) as HTMLElement;
}
async function openTest(user: ReturnType<typeof userEvent.setup>, id: string, name: string) {
  await user.click(within(await rowOf(id)).getByRole('button', { name: '测试' }));
  return screen.findByRole('dialog', { name: `测试「${name}」` });
}
const polls = (bench: ReturnType<typeof fakeAgents>, testId: string) => bench.find('GET', `${BASE}/tests/${testId}`).length;
const pretty = (value: unknown) => JSON.stringify(value, null, 2);

describe('Agent 测试: 单据', () => {
  it('the approval Agent opens on 单据; one document is sent as {mode, documentId}; /tests/:id is polled every 3 s; the result shows; polling stops', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { bench } = await openAgents();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const dialog = await openTest(user, AUDIT_PUB, '审单 Agent（虚构）');
    expect(within(dialog).getByRole('tab', { name: '单据' })).toHaveAttribute('aria-selected', 'true');
    expect(within(dialog).getAllByRole('tab').map(tab => tab.textContent)).toEqual(['单据', '文本', '请求信封']);
    const select = await within(dialog).findByLabelText('对公付款单');
    await waitFor(() => expect(within(select).getAllByRole('option').map(option => option.textContent)).toEqual(['DGZF-F07-001 · 虚构运维服务费', 'DGZF-F07-002 · 虚构房租']));
    await user.selectOptions(select, 'doc-2');
    await user.click(within(dialog).getByRole('button', { name: '开始测试' }));

    const [post] = bench.find('POST', `${BASE}/${AUDIT_PUB}/test`);
    expect(post.body).toEqual({ mode: 'document', documentId: 'doc-2' });
    expect(post.headers.get('X-CSRF-Token')).toBe('csrf-1');
    expect(await within(dialog).findByText('已发给「审单 Agent（虚构）」，一般几秒到两分钟…')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '开始测试' })).toBeDisabled();

    const testId = 'test_000000000001';
    const first = polls(bench, testId);
    await act(async () => { await vi.advanceTimersByTimeAsync(TEST_POLL_MS); });
    expect(polls(bench, testId)).toBe(first + 1);
    expect(TEST_POLL_MS).toBe(3000);

    const callReads = bench.find('GET', `${BASE}/calls`).length;
    bench.finish(testId, { result: 'fail', note: '合同金额与付款金额不一致（虚构）', basis: BASIS, agentVersion: '1.2.0', repaired: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(TEST_POLL_MS); });
    const result = await within(dialog).findByRole('region', { name: '测试结果' });
    expect(within(result).getByText('不建议通过').closest('[data-tone]')).toHaveAttribute('data-tone', 'fail');
    expect(within(result).getByText('DGZF-F07-002')).toBeInTheDocument();
    expect(within(result).getByText(/用时 41 秒/)).toBeInTheDocument();
    expect(within(result).getByText('合同金额与付款金额不一致（虚构）')).toBeInTheDocument();
    const basis = within(result).getByRole('list', { name: '依据' });
    expect(within(basis).getAllByRole('listitem').map(item => item.querySelector('[data-basis-tag]')?.textContent)).toEqual(['公司制度', '单据字段', '原件']);
    expect(within(basis).getByText('C05-2.3')).toBeInTheDocument();
    expect(within(basis).getByText('abababababab…')).toBeInTheDocument();
    expect(within(basis).getByText('第 2 页')).toBeInTheDocument();
    expect(within(result).getByText(/Agent 版本 1\.2\.0/)).toBeInTheDocument();
    expect(within(dialog).getByText('测试完成，已记进下面的调用记录。')).toBeInTheDocument();
    await waitFor(() => expect(bench.find('GET', `${BASE}/calls`).length).toBeGreaterThan(callReads));

    const settled = polls(bench, testId);
    await act(async () => { await vi.advanceTimersByTimeAsync(TEST_POLL_MS * 4); });
    expect(polls(bench, testId)).toBe(settled);
    expect(within(dialog).getByRole('button', { name: '开始测试' })).toBeEnabled();
  });

  it('a failed test shows what went wrong and the error code', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { bench } = await openAgents();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const dialog = await openTest(user, AUDIT_PUB, '审单 Agent（虚构）');
    await waitFor(() => expect(within(dialog).getAllByRole('option')).toHaveLength(2));
    await user.click(within(dialog).getByRole('button', { name: '开始测试' }));
    await within(dialog).findByText(/已发给/);
    bench.finish('test_000000000001', { status: 'failed', errorCode: 'AI_UNAVAILABLE', latencyMs: 120_000 });
    await act(async () => { await vi.advanceTimersByTimeAsync(TEST_POLL_MS); });
    const result = await within(dialog).findByRole('region', { name: '测试结果' });
    expect(within(result).getByText('没有完成：Nexus 暂时答不了（或超时）')).toBeInTheDocument();
    expect(within(result).getByText('错误码 AI_UNAVAILABLE')).toBeInTheDocument();
    expect(within(dialog).getByText('这次没有完成，原因见下。')).toBeInTheDocument();
  });

  it('after 5 minutes without a result the modal says so, stops polling and 开始测试 works again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { bench } = await openAgents();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const dialog = await openTest(user, AUDIT_PUB, '审单 Agent（虚构）');
    await waitFor(() => expect(within(dialog).getAllByRole('option')).toHaveLength(2));
    await user.click(within(dialog).getByRole('button', { name: '开始测试' }));
    await within(dialog).findByText('已发给「审单 Agent（虚构）」，一般几秒到两分钟…');
    // 一直「进行中」：每次问到的都一样（结构共享，data 不变），只有计时器能让页面知道等够了
    await act(async () => { await vi.advanceTimersByTimeAsync(TEST_WAIT_MS); });
    expect(await within(dialog).findByText('等了五分钟还没有结果：测试还在 Agent 那边跑，结果出来后会记进下面的调用记录。')).toBeInTheDocument();
    expect(within(dialog).queryByText(/一般几秒到两分钟/)).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '开始测试' })).toBeEnabled();
    const stopped = polls(bench, 'test_000000000001');
    await act(async () => { await vi.advanceTimersByTimeAsync(TEST_POLL_MS * 4); });
    expect(polls(bench, 'test_000000000001')).toBe(stopped);
  });

  it('switching to another Agent\'s test starts clean: no result, status or polling carries over, either way', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { bench } = await openAgents();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    let dialog = await openTest(user, AUDIT_PUB, '审单 Agent（虚构）');
    await waitFor(() => expect(within(dialog).getAllByRole('option')).toHaveLength(2));
    await user.click(within(dialog).getByRole('button', { name: '开始测试' }));
    await within(dialog).findByText(/已发给「审单 Agent（虚构）」/);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    dialog = await openTest(user, KB_PUB, '知识库文档管家（PG 版）');
    expect(within(dialog).queryByRole('status')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('region', { name: '测试结果' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '发送' })).toBeEnabled();
    // 审单 Agent 那次测试不再问（它的面板已经换掉了），也不会显示在这里
    const first = polls(bench, 'test_000000000001');
    bench.finish('test_000000000001', { result: 'fail', note: '审单 Agent 的结论（虚构）', basis: [] });
    await act(async () => { await vi.advanceTimersByTimeAsync(TEST_POLL_MS * 3); });
    expect(polls(bench, 'test_000000000001')).toBe(first);
    expect(within(dialog).queryByText('审单 Agent 的结论（虚构）')).not.toBeInTheDocument();

    await user.type(within(dialog).getByLabelText('发给 Agent 的文字'), '你好（虚构）');
    await user.click(within(dialog).getByRole('button', { name: '发送' }));
    expect(bench.find('POST', `${BASE}/${KB_PUB}/test`)).toHaveLength(1);
    bench.finish('test_000000000002', { reply: '知识库 Agent 的回复（虚构）' });
    await act(async () => { await vi.advanceTimersByTimeAsync(TEST_POLL_MS); });
    const result = await within(dialog).findByRole('region', { name: '测试结果' });
    expect(within(result).getByText('知识库 Agent 的回复（虚构）')).toBeInTheDocument();
    expect(within(result).queryByText('审单 Agent 的结论（虚构）')).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    dialog = await openTest(user, AUDIT_PUB, '审单 Agent（虚构）');
    expect(within(dialog).queryByRole('region', { name: '测试结果' })).not.toBeInTheDocument();
    expect(within(dialog).queryByText('知识库 Agent 的回复（虚构）')).not.toBeInTheDocument();
    const second = polls(bench, 'test_000000000002');
    await act(async () => { await vi.advanceTimersByTimeAsync(TEST_POLL_MS * 3); });
    expect(polls(bench, 'test_000000000002')).toBe(second);
  });

  it('the knowledge-base Agent opens on 文本 (it does not review documents)', async () => {
    const { user } = await openAgents();
    const dialog = await openTest(user, KB_PUB, '知识库文档管家（PG 版）');
    expect(within(dialog).getByRole('tab', { name: '文本' })).toHaveAttribute('aria-selected', 'true');
  });

  it('two clicks on 开始测试 in the same tick start one test', async () => {
    const slow = deferred();
    const { bench, user } = await openAgents({ overrides: { [`POST ${BASE}/${AUDIT_PUB}/test`]: slow.route } });
    const dialog = await openTest(user, AUDIT_PUB, '审单 Agent（虚构）');
    await waitFor(() => expect(within(dialog).getAllByRole('option')).toHaveLength(2));
    const go = within(dialog).getByRole('button', { name: '开始测试' });
    act(() => { fireEvent.click(go); fireEvent.click(go); });
    expect(await within(dialog).findByText('已发给「审单 Agent（虚构）」，一般几秒到两分钟…')).toBeInTheDocument();
    expect(bench.find('POST', `${BASE}/${AUDIT_PUB}/test`)).toHaveLength(1);
    slow.resolve({ status: 429, body: { error: { code: 'AGENT_TEST_RATE_LIMIT', message: '测试每分钟最多 5 次，请稍后再试。' } } });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('测试每分钟最多 5 次，请稍后再试。');
  });

  it('closing the modal mid-test keeps it going: reopening the same Agent shows the result', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { bench } = await openAgents();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    let dialog = await openTest(user, AUDIT_PUB, '审单 Agent（虚构）');
    await waitFor(() => expect(within(dialog).getAllByRole('option')).toHaveLength(2));
    await user.click(within(dialog).getByRole('button', { name: '开始测试' }));
    await within(dialog).findByText(/已发给/);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    bench.finish('test_000000000001', { result: 'pass', note: '虚构：通过', basis: [] });
    await act(async () => { await vi.advanceTimersByTimeAsync(TEST_POLL_MS); });
    dialog = await openTest(user, AUDIT_PUB, '审单 Agent（虚构）');
    const result = await within(dialog).findByRole('region', { name: '测试结果' });
    expect(within(result).getByText('建议通过').closest('[data-tone]')).toHaveAttribute('data-tone', 'pass');
  });
});

describe('Agent 测试: 文本', () => {
  it('sends the text as written ({mode:"text", text}); 用示例 fills the box; shows what was sent and the reply', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { bench } = await openAgents();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const dialog = await openTest(user, KB_PUB, '知识库文档管家（PG 版）');
    const area = within(dialog).getByLabelText('发给 Agent 的文字') as HTMLTextAreaElement;
    await user.click(within(dialog).getByRole('button', { name: '发送' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('请写一段话');
    expect(bench.find('POST', `${BASE}/${KB_PUB}/test`)).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: '用示例' }));
    expect(area.value).toBe('你好，请用一句话说明你能做什么');
    await user.clear(area);
    await user.type(area, '你好（虚构）');
    await user.click(within(dialog).getByRole('button', { name: '发送' }));
    expect(bench.find('POST', `${BASE}/${KB_PUB}/test`)[0].body).toEqual({ mode: 'text', text: '你好（虚构）' });
    await within(dialog).findByText(/已发给/);
    bench.finish('test_000000000001', { reply: '我能管理知识库（虚构）', latencyMs: 3000 });
    await act(async () => { await vi.advanceTimersByTimeAsync(TEST_POLL_MS); });
    const result = await within(dialog).findByRole('region', { name: '测试结果' });
    expect(within(result).getByText('已回复')).toBeInTheDocument();
    expect(within(result).getByText('发出的文字')).toBeInTheDocument();
    expect(within(result).getByText('你好（虚构）')).toBeInTheDocument();
    expect(within(result).getByText('Agent 的回复')).toBeInTheDocument();
    expect(within(result).getByText('我能管理知识库（虚构）')).toBeInTheDocument();
    expect(within(result).getByText(/用时 3 秒/)).toBeInTheDocument();
  });
});

describe('Agent 测试: 请求信封', () => {
  it('the template fills an editable envelope; bad JSON is caught before sending; contract problems from the shell are listed', async () => {
    const { bench, user } = await openAgents();
    const dialog = await openTest(user, AUDIT_PUB, '审单 Agent（虚构）');
    await user.click(within(dialog).getByRole('tab', { name: '请求信封' }));
    const task = await within(dialog).findByLabelText('任务');
    await waitFor(() => expect(within(task).getAllByRole('option').map(option => option.textContent)).toEqual(['单据审核建议（review_advice@1）', '能力清单（describe@1）']));
    const area = within(dialog).getByLabelText('请求信封（JSON）') as HTMLTextAreaElement;
    expect(area.value).toBe(pretty(REVIEW_REQUEST));
    await user.selectOptions(task, 'describe@1');
    expect(area.value).toBe(pretty(DESCRIBE_REQUEST));

    fireEvent.change(area, { target: { value: '{ "envelope": ' } });
    await user.click(within(dialog).getByRole('button', { name: '发送' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent(/^不是合法的 JSON/);
    expect(bench.find('POST', `${BASE}/${AUDIT_PUB}/test`)).toEqual([]);

    fireEvent.change(area, { target: { value: pretty({ ...DESCRIBE_REQUEST, task: 'nope' }) } });
    await user.click(within(dialog).getByRole('button', { name: '发送' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('这个请求信封不合契约，没有发出去：按下面列出的地方改好再发。');
    expect(alert).toHaveTextContent('/task：契约里没有任务 nope@1');

    await user.click(within(dialog).getByRole('button', { name: '恢复示例' }));
    expect(area.value).toBe(pretty(DESCRIBE_REQUEST));
  });

  it('sends {mode:"envelope", request}; a conforming answer shows 合格, the checked envelope and the raw answer (folded)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { bench } = await openAgents();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const dialog = await openTest(user, AUDIT_PUB, '审单 Agent（虚构）');
    await user.click(within(dialog).getByRole('tab', { name: '请求信封' }));
    await waitFor(() => expect((within(dialog).getByLabelText('请求信封（JSON）') as HTMLTextAreaElement).value).toBe(pretty(REVIEW_REQUEST)));
    await user.click(within(dialog).getByRole('button', { name: '发送' }));
    expect(bench.find('POST', `${BASE}/${AUDIT_PUB}/test`)[0].body).toEqual({ mode: 'envelope', request: REVIEW_REQUEST });
    await within(dialog).findByText(/已发给/);
    const envelope = { envelope: 'jiuan.agent/v1', task: 'review_advice', taskVersion: 1, requestId: 'req-fake-1', output: { result: 'pass', note: '虚构', basis: [] } };
    bench.finish('test_000000000001', { conforms: true, reply: '```json\n{"envelope":"jiuan.agent/v1"}\n```', envelope, result: 'pass', problems: [] });
    await act(async () => { await vi.advanceTimersByTimeAsync(TEST_POLL_MS); });
    const result = await within(dialog).findByRole('region', { name: '测试结果' });
    expect(within(result).getByText('合格').closest('[data-tone]')).toHaveAttribute('data-tone', 'pass');
    expect(within(result).getByText('结果信封（已按契约检查）')).toBeInTheDocument();
    expect(within(result).getByText('原始回答')).toBeInTheDocument();
    expect(within(result).getByText(/"envelope":"jiuan.agent\/v1"/)).toBeInTheDocument();
  });

  it('a non-conforming answer shows 不合格 and where it falls short', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { bench } = await openAgents();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const dialog = await openTest(user, AUDIT_PUB, '审单 Agent（虚构）');
    await user.click(within(dialog).getByRole('tab', { name: '请求信封' }));
    await waitFor(() => expect((within(dialog).getByLabelText('请求信封（JSON）') as HTMLTextAreaElement).value).not.toBe(''));
    await user.click(within(dialog).getByRole('button', { name: '发送' }));
    await within(dialog).findByText(/已发给/);
    bench.finish('test_000000000001', { conforms: false, reply: '我不知道（虚构）', problems: [{ code: 'NOT_JSON', path: '', message: '回答里必须恰好是一个 JSON 对象（最多包一层 ```json 代码块）。' }] });
    await act(async () => { await vi.advanceTimersByTimeAsync(TEST_POLL_MS); });
    const result = await within(dialog).findByRole('region', { name: '测试结果' });
    expect(within(result).getByText('不合格').closest('[data-tone]')).toHaveAttribute('data-tone', 'wait');
    expect(within(result).getByText('/：回答里必须恰好是一个 JSON 对象（最多包一层 ```json 代码块）。')).toBeInTheDocument();
  });
});

describe('调用记录', () => {
  const table = () => screen.findByRole('table', { name: '调用记录' });
  it('time, document number, task, publication, trigger, status, conclusion, duration and error code; folded until 展开 shows the note and basis', async () => {
    const { user } = await openAgents();
    const calls = await table();
    expect(within(calls).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['时间', '单据号', '任务', '发给', '触发', '状态', '结论', '用时', '错误码', '详情']);
    await waitFor(() => expect(within(calls).getAllByRole('row').filter(row => row.hasAttribute('data-call'))).toHaveLength(3));
    const rows = within(calls).getAllByRole('row').filter(row => row.hasAttribute('data-call'));
    const cells = (row: HTMLElement) => within(row).getAllByRole('cell').slice(0, 9).map(cell => cell.textContent);
    expect(cells(rows[0])).toEqual(['10-31 10:10', 'DGZF-F07-001', '单据审核建议', '审单 Agent（虚构）', '自动初审', '已完成', '建议通过', '52 秒', '—']);
    expect(cells(rows[1])).toEqual(['10-31 09:50', 'DGZF-F07-002', '单据审核建议', '审单 Agent（虚构）', '单据页发起', '没有完成', '—', '120 秒', 'AI_UNAVAILABLE']);
    expect(cells(rows[2])).toEqual(['10-31 09:30', '—', '文本', '知识库文档管家（PG 版）', '测试 · 文本', '已完成', '已回复', '3 秒', '—']);
    expect(within(rows[0]).getByText('建议通过').closest('[data-tone]')).toHaveAttribute('data-tone', 'pass');

    expect(screen.queryByText('原件齐全，金额一致（虚构）')).not.toBeInTheDocument();
    const open = within(rows[0]).getByRole('button', { name: '展开' });
    expect(open).toHaveAttribute('aria-expanded', 'false');
    await user.click(open);
    expect(within(rows[0]).getByRole('button', { name: '收起' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('原件齐全，金额一致（虚构）')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: '依据' })).getByText('C05-2.3')).toBeInTheDocument();
    await user.click(within(rows[1]).getByRole('button', { name: '展开' }));
    expect(screen.getByText('没有完成：Nexus 暂时答不了（或超时）')).toBeInTheDocument();
  });

  it('an opened row stays open after 刷新 brings in a newer call (rows are keyed by the call, not by position)', async () => {
    const { bench, user } = await openAgents();
    const calls = await table();
    await waitFor(() => expect(within(calls).getAllByRole('row').filter(row => row.hasAttribute('data-call'))).toHaveLength(3));
    await user.click(within(calls).getAllByRole('row').filter(row => row.hasAttribute('data-call'))[0].querySelector('button')!);
    expect(screen.getByText('原件齐全，金额一致（虚构）')).toBeInTheDocument();
    bench.state.calls.unshift({ ...CALLS()[0], at: '2026-10-31T03:30:00.000Z', documentId: 'doc-9', number: 'DGZF-F07-009', round: 1, note: '新的一轮（虚构）' });
    await user.click(within(screen.getByRole('region', { name: '调用记录' })).getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(within(calls).getAllByRole('row').filter(row => row.hasAttribute('data-call'))).toHaveLength(4));
    const rows = within(calls).getAllByRole('row').filter(row => row.hasAttribute('data-call'));
    expect(within(rows[0]).getByRole('button', { name: '展开' })).toHaveAttribute('aria-expanded', 'false');
    expect(within(rows[1]).getByRole('button', { name: '收起' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('原件齐全，金额一致（虚构）')).toBeInTheDocument();
    expect(screen.queryByText('新的一轮（虚构）')).not.toBeInTheDocument();
  });

  it('says so when there are no calls yet', async () => {
    await openAgents({ calls: [] });
    expect(await screen.findByText('还没有调用记录')).toBeInTheDocument();
  });

  it('a failed read shows the shell message as it came, and 重新读取 asks again', async () => {
    let fail = true;
    const { bench, user } = await openAgents({ overrides: {
      [`GET ${BASE}/calls`]: () => (fail ? { status: 503, body: { error: { code: 'AGENT_CALLS_UNAVAILABLE', message: '调用记录暂时读不到，稍后刷新。' } } } : { body: { data: { items: CALLS() } } }),
    } });
    expect(await screen.findByText('调用记录暂时读不到，稍后刷新。', {}, { timeout: 4000 })).toBeInTheDocument();
    fail = false;
    await user.click(within(screen.getByRole('region', { name: '调用记录' })).getByRole('button', { name: '重新读取' }));
    expect(await table()).toBeInTheDocument();
    expect(bench.find('GET', `${BASE}/calls`).length).toBeGreaterThanOrEqual(2);
  });

  it('nothing on the page puts a <style> element in — the modals and tabs included', async () => {
    const { user } = await openAgents();
    const dialog = await openTest(user, AUDIT_PUB, '审单 Agent（虚构）');
    await user.click(within(dialog).getByRole('tab', { name: '文本' }));
    expect(document.querySelectorAll('style').length).toBe(0);
    await user.keyboard('{Escape}');
    await user.click(within(await rowOf(KB_PUB)).getByRole('button', { name: '设为审批 Agent' }));
    await screen.findByRole('dialog', { name: '设为审批 Agent' });
    expect(document.querySelectorAll('style').length).toBe(0);
  });
});
