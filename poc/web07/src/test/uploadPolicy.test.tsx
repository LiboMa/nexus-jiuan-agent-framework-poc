import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '../api/queryClient';
import { KB_POLL_MS } from '../api/knowledge';
import { UploadPolicyModal } from '../knowledge/UploadPolicyModal';
import { startApp } from './startApp';
import { DOCX, deferred, docxFile, fakeKb, type KbOptions } from './knowledgeFake';

// 「上传制度」弹框（Spec 第 6 节；补丁 0005；Ruling T6b 与上传流程）：只收 .docx；制度标识按文件名预填；文档名预填库里那份的标题，
// 否则是完整的原文件名（带 .docx）；上传后每 2.5 秒问一次上传记录，停在 ingested / skipped / failed 上；进行中「上传并入库」不可点，关弹框不中断入库。
afterEach(() => { vi.useRealTimers(); });

async function openUpload(options: KbOptions = {}) {
  const bench = fakeKb(options);
  const app = await startApp('#/knowledge');
  await screen.findByRole('table', { name: '制度清单' });
  await app.user.click(screen.getByRole('button', { name: '上传制度' }));
  const dialog = await screen.findByRole('dialog', { name: '上传制度' });
  await within(dialog).findByText('把制度 .docx 拖到这里，或');
  return { ...app, bench, dialog };
}
const fileInput = (dialog: HTMLElement) => dialog.querySelector<HTMLInputElement>('input[type="file"]')!;
const field = (dialog: HTMLElement, name: string) => within(dialog).getByRole('textbox', { name }) as HTMLInputElement;
const drop = (dialog: HTMLElement, file: File) => fireEvent.drop(within(dialog).getByText('把制度 .docx 拖到这里，或').closest('[data-drop]')!, { dataTransfer: { files: [file] } });

describe('上传制度: prefill (T6b)', () => {
  it('a new English file name: the id from the name, the title is the FULL file name with .docx', async () => {
    const { user, dialog } = await openUpload();
    await user.upload(fileInput(dialog), docxFile('New Policy V2.docx'));
    expect(field(dialog, '制度标识').value).toBe('new-policy-v2');
    expect(field(dialog, '文档名').value).toBe('New Policy V2.docx');
    expect(field(dialog, '版本说明').value).toBe('');
    expect(within(dialog).queryByText(/规则库里已有/)).not.toBeInTheDocument();
    expect(within(dialog).getByText(/「New Policy V2.docx」（2 KB）/)).toBeInTheDocument();
  });

  it('a Chinese file name: the id stays empty for the user to fill, the title is the full file name', async () => {
    const { user, dialog } = await openUpload();
    await user.upload(fileInput(dialog), docxFile('虚构报销制度.docx'));
    expect(field(dialog, '制度标识').value).toBe('');
    expect(field(dialog, '文档名').value).toBe('虚构报销制度.docx');
  });

  it('a file already in the list (same file name): its id and its recorded title, with the new-version warning', async () => {
    const { user, dialog } = await openUpload();
    await user.upload(fileInput(dialog), docxFile('travel-rules.docx'));
    expect(field(dialog, '制度标识').value).toBe('travel-rules');
    expect(field(dialog, '文档名').value).toBe('虚构差旅制度');
    expect(within(dialog).getByText(/规则库里已有「虚构差旅制度」用这个标识（版本 V1，12 条规则）：这次上传会作为它的新版本/)).toBeInTheDocument();
  });

  it('typing a known id switches an untouched title to that source\'s title, and back to the file name for an unknown id; an edited title stays', async () => {
    const { user, dialog } = await openUpload();
    await user.upload(fileInput(dialog), docxFile('虚构报销制度.docx'));
    await user.type(field(dialog, '制度标识'), 'fin-approval');
    expect(field(dialog, '文档名').value).toBe('虚构财务审批办法V4.docx');
    expect(within(dialog).getByText(/规则库里已有「虚构财务审批办法V4.docx」用这个标识/)).toBeInTheDocument();
    await user.type(field(dialog, '制度标识'), '-2');
    expect(field(dialog, '文档名').value).toBe('虚构报销制度.docx');
    await user.clear(field(dialog, '文档名'));
    await user.type(field(dialog, '文档名'), '我改的标题（虚构）');
    await user.clear(field(dialog, '制度标识'));
    await user.type(field(dialog, '制度标识'), 'fin-approval');
    expect(field(dialog, '文档名').value).toBe('我改的标题（虚构）');
  });

  it('caps the prefilled title at 200 characters', async () => {
    const { user, dialog } = await openUpload();
    const long = `${'虚'.repeat(250)}.docx`;
    await user.upload(fileInput(dialog), docxFile(long));
    expect(Array.from(field(dialog, '文档名').value)).toHaveLength(200);
  });
});

describe('上传制度: checks before sending', () => {
  it('a cleared 文档名 is sent as the prefilled one, never as an empty title', async () => {
    const { user, bench, dialog } = await openUpload();
    await user.upload(fileInput(dialog), docxFile('travel-rules.docx'));
    await user.clear(field(dialog, '文档名'));
    await user.type(field(dialog, '文档名'), '   ');
    await user.click(within(dialog).getByRole('button', { name: '上传并入库' }));
    await within(dialog).findByText('入库中');
    expect(new URLSearchParams(bench.find('POST', '/api/analysis/v1/poc/kb/sources')[0].search).get('title')).toBe('虚构差旅制度');
  });

  it('a cleared 文档名 for a new id falls back to the full file name', async () => {
    const { user, bench, dialog } = await openUpload();
    await user.upload(fileInput(dialog), docxFile('new-policy.docx'));
    await user.clear(field(dialog, '文档名'));
    await user.click(within(dialog).getByRole('button', { name: '上传并入库' }));
    await within(dialog).findByText('入库中');
    expect(new URLSearchParams(bench.find('POST', '/api/analysis/v1/poc/kb/sources')[0].search).get('title')).toBe('new-policy.docx');
  });

  it('takes only .docx (drag and drop too) and at most 20 MB', async () => {
    const { bench, dialog } = await openUpload();
    drop(dialog, new File(['x'], '虚构制度.pdf', { type: 'application/pdf' }));
    expect(await within(dialog).findByText('只收 .docx 文件（审批矩阵格式的 Word 文档）')).toBeInTheDocument();
    const big = docxFile('big-policy.docx', 10);
    Object.defineProperty(big, 'size', { value: 20 * 1024 * 1024 + 1 });
    drop(dialog, big);
    expect(await within(dialog).findByText('文件超过 20 MB')).toBeInTheDocument();
    expect(within(dialog).queryByRole('textbox', { name: '制度标识' })).not.toBeInTheDocument();
    drop(dialog, docxFile('dropped-policy.docx'));
    expect((await within(dialog).findByRole('textbox', { name: '制度标识' }) as HTMLInputElement).value).toBe('dropped-policy');
    expect(bench.find('POST', '/api/analysis/v1/poc/kb/sources')).toEqual([]);
  });

  it('an id that breaks the rule is refused on the page and nothing is sent', async () => {
    const { user, bench, dialog } = await openUpload();
    await user.upload(fileInput(dialog), docxFile('虚构报销制度.docx'));
    await user.click(within(dialog).getByRole('button', { name: '上传并入库' }));
    expect(within(dialog).getByText('制度标识只能用小写字母、数字和连字符（2–63 位，字母或数字开头），例如 fin-approval。')).toBeInTheDocument();
    await user.type(field(dialog, '制度标识'), 'Bad_ID');
    await user.click(within(dialog).getByRole('button', { name: '上传并入库' }));
    expect(bench.find('POST', '/api/analysis/v1/poc/kb/sources')).toEqual([]);
  });
});

describe('上传制度: upload, then poll the upload record until it settles', () => {
  it('sends the raw .docx with the id, version and title; polls every 2.5 s with the button disabled; shows the numbers; stops polling', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { bench, dialog } = await openUpload();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const file = docxFile('New Policy V2.docx');
    await user.upload(fileInput(dialog), file);
    await user.type(field(dialog, '版本说明'), 'V2 虚构版');
    await user.click(within(dialog).getByRole('button', { name: '上传并入库' }));

    const [post] = bench.find('POST', '/api/analysis/v1/poc/kb/sources');
    expect(Object.fromEntries(new URLSearchParams(post.search))).toEqual({ sourceId: 'new-policy-v2', sourceVersion: 'V2 虚构版', title: 'New Policy V2.docx' });
    expect(post.headers.get('Content-Type')).toBe(DOCX);
    expect(post.headers.get('X-File-Name')).toBe(encodeURIComponent('New Policy V2.docx'));
    expect(post.headers.get('X-CSRF-Token')).toBe('csrf-1');
    expect(post.body).toBe(file);

    expect(await within(dialog).findByText('入库中')).toBeInTheDocument();
    expect(within(dialog).getByText(/入库在后台继续，稍后在上传记录里看结果/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '上传并入库' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: '稍后再看' })).toBeEnabled();

    const polls = () => bench.find('GET', '/api/analysis/v1/poc/kb/uploads/1').length;
    const first = polls();
    await act(async () => { await vi.advanceTimersByTimeAsync(KB_POLL_MS); });
    expect(polls()).toBe(first + 1);
    expect(KB_POLL_MS).toBeGreaterThanOrEqual(2000);
    expect(KB_POLL_MS).toBeLessThanOrEqual(3000);

    const listReads = bench.find('GET', '/api/analysis/v1/poc/kb/sources').length;
    bench.finish(1, { status: 'ingested', rulesTotal: 40, written: 38, removed: 2, unchanged: 0, conflicts: [] });
    await act(async () => { await vi.advanceTimersByTimeAsync(KB_POLL_MS); });
    expect(await within(dialog).findByText('入库完成：「New Policy V2.docx」共 40 条规则（写入 38、删除 2、不变 0）。AI 下一次审单就用上新规则。')).toBeInTheDocument();
    const numbers = within(dialog).getByRole('list', { name: '入库结果' });
    expect(within(numbers).getAllByRole('listitem').map(item => item.textContent)).toEqual(['规则40', '写入38', '删除2', '不变0', '冲突0']);
    await waitFor(() => expect(bench.find('GET', '/api/analysis/v1/poc/kb/sources').length).toBeGreaterThan(listReads));
    const settled = polls();
    await act(async () => { await vi.advanceTimersByTimeAsync(KB_POLL_MS * 4); });
    expect(polls()).toBe(settled);
    expect(within(dialog).getByRole('button', { name: '完成' })).toBeEnabled();
  });

  it('two clicks in the same tick send one upload', async () => {
    const slow = deferred();
    const { user, bench, dialog } = await openUpload({ overrides: { 'POST /api/analysis/v1/poc/kb/sources': slow.route } });
    await user.upload(fileInput(dialog), docxFile('new-policy.docx'));
    const go = within(dialog).getByRole('button', { name: '上传并入库' });
    // 同一拍里点两下（同一个 act 里，中间不重新渲染）：按钮还没来得及变灰，只有在途标记挡得住第二下
    act(() => { fireEvent.click(go); fireEvent.click(go); });
    await within(dialog).findByText('正在上传「new-policy.docx」…');
    expect(bench.find('POST', '/api/analysis/v1/poc/kb/sources')).toHaveLength(1);
    expect(within(dialog).getByRole('button', { name: '上传并入库' })).toBeDisabled();
    expect(within(dialog).getByText('正在上传「new-policy.docx」…')).toBeInTheDocument();
    slow.resolve({ status: 202, body: { data: { id: 7, status: 'ingesting' } } });
  });

  it('skipped: says the library already has this version', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { bench, dialog } = await openUpload();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.upload(fileInput(dialog), docxFile('travel-rules.docx'));
    await user.click(within(dialog).getByRole('button', { name: '上传并入库' }));
    await within(dialog).findByText('入库中');
    bench.finish(1, { status: 'skipped', rulesTotal: 12, written: 0, removed: 0, unchanged: 12, conflicts: [] });
    await act(async () => { await vi.advanceTimersByTimeAsync(KB_POLL_MS); });
    expect(await within(dialog).findByText('规则库里的「虚构差旅制度」已经是这一版（共 12 条规则），没有重写。')).toBeInTheDocument();
  });

  it('failed: the reason as the shell wrote it, the conflicting rule ids and the suggestion', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { bench, dialog } = await openUpload();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.upload(fileInput(dialog), docxFile('new-policy.docx'));
    await user.click(within(dialog).getByRole('button', { name: '上传并入库' }));
    await within(dialog).findByText('入库中');
    bench.finish(1, { status: 'failed', conflicts: ['R-01', 'R-02'],
      error: { code: 'KB_INGEST_FAILED', message: '第 3 章的表头不对（虚构）。', suggestion: '表头第一列改成「序号」再上传' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(KB_POLL_MS); });
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('没有入库：第 3 章的表头不对（虚构）。');
    expect(alert).toHaveTextContent('冲突的规则编号 2 条：R-01、R-02。若这是库里那份制度的新版本，用它原来的制度标识再上传。');
    expect(alert).toHaveTextContent('建议：表头第一列改成「序号」再上传');
    expect(within(dialog).getByRole('button', { name: '上传并入库' })).toBeEnabled();
  });

  it('a refusal from the shell is shown as it came', async () => {
    const { user, dialog } = await openUpload({ overrides: {
      'POST /api/analysis/v1/poc/kb/sources': { status: 409, body: { error: { code: 'KB_INGEST_BUSY', message: '已经有一份文档在入库，等它完成再试。' } } },
    } });
    await user.upload(fileInput(dialog), docxFile('new-policy.docx'));
    await user.click(within(dialog).getByRole('button', { name: '上传并入库' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('已经有一份文档在入库，等它完成再试。');
    expect(within(dialog).getByRole('button', { name: '上传并入库' })).toBeEnabled();
  });

  it('a 4xx on the upload record ends the wait: back to the form with the message, no more polling, and closing resets', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { bench, dialog } = await openUpload({ overrides: {
      'GET /api/analysis/v1/poc/kb/uploads/1': { status: 404, body: { error: { code: 'KB_NOT_FOUND', message: '找不到这条上传记录，刷新后再试。' } } },
    } });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.upload(fileInput(dialog), docxFile('new-policy.docx'));
    await user.click(within(dialog).getByRole('button', { name: '上传并入库' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('找不到这条上传记录，刷新后再试。');
    expect(within(dialog).queryByText('入库中')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '上传并入库' })).toBeEnabled();
    const polls = bench.find('GET', '/api/analysis/v1/poc/kb/uploads/1').length;
    await act(async () => { await vi.advanceTimersByTimeAsync(KB_POLL_MS * 4); });
    expect(bench.find('GET', '/api/analysis/v1/poc/kb/uploads/1')).toHaveLength(polls);
    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: '上传制度' }));
    const again = await screen.findByRole('dialog', { name: '上传制度' });
    expect(await within(again).findByText('把制度 .docx 拖到这里，或')).toBeInTheDocument();
  });

  it('closing mid-ingest does not cancel it; opening again shows the same upload, and it keeps polling', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { bench, dialog } = await openUpload();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.upload(fileInput(dialog), docxFile('new-policy.docx'));
    await user.click(within(dialog).getByRole('button', { name: '上传并入库' }));
    await within(dialog).findByText('入库中');
    await user.click(within(dialog).getByRole('button', { name: '稍后再看' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const polls = () => bench.find('GET', '/api/analysis/v1/poc/kb/uploads/1').length;
    const closed = polls();
    await act(async () => { await vi.advanceTimersByTimeAsync(KB_POLL_MS); });
    expect(polls()).toBe(closed + 1);
    expect(bench.calls.filter(call => call.method === 'POST')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: '上传制度' }));
    const again = await screen.findByRole('dialog', { name: '上传制度' });
    expect(within(again).getByText('入库中')).toBeInTheDocument();
    expect(within(again).getByRole('button', { name: '上传并入库' })).toBeDisabled();
  });
});

describe('<UploadPolicyModal open onClose /> on another page (for 工作台)', () => {
  function mount(options: KbOptions = {}) {
    const bench = fakeKb(options);
    const onClose = vi.fn();
    render(<QueryClientProvider client={queryClient}><UploadPolicyModal open onClose={onClose} /></QueryClientProvider>);
    return { bench, onClose };
  }

  it('reads the mode and the source list itself, prefills from them, and calls onClose', async () => {
    const { bench, onClose } = mount();
    const dialog = await screen.findByRole('dialog', { name: '上传制度' });
    await within(dialog).findByText('把制度 .docx 拖到这里，或');
    expect(bench.find('GET', '/api/analysis/v1/poc/kb/mode')).toHaveLength(1);
    await waitFor(() => expect(bench.find('GET', '/api/analysis/v1/poc/kb/sources')).toHaveLength(1));
    const user = userEvent.setup();
    await user.upload(fileInput(dialog), docxFile('travel-rules.docx'));
    await waitFor(() => expect(field(dialog, '文档名').value).toBe('虚构差旅制度'));
    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(onClose).toHaveBeenCalledWith({ ingesting: false });
  });

  it('closing mid-ingest tells the host page: onClose({ ingesting: true })', async () => {
    const { onClose } = mount();
    const dialog = await screen.findByRole('dialog', { name: '上传制度' });
    await within(dialog).findByText('把制度 .docx 拖到这里，或');
    const user = userEvent.setup();
    await user.upload(fileInput(dialog), docxFile('new-policy.docx'));
    await user.click(within(dialog).getByRole('button', { name: '上传并入库' }));
    await within(dialog).findByText('入库中');
    await user.click(within(dialog).getByRole('button', { name: '稍后再看' }));
    expect(onClose).toHaveBeenLastCalledWith({ ingesting: true });
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenLastCalledWith({ ingesting: true });
  });

  it('says what to do when the agent is not enabled, with no drop zone', async () => {
    mount({ mode: { mode: 'pg', configured: true, ready: false, ops: [] } });
    const dialog = await screen.findByRole('dialog', { name: '上传制度' });
    expect(await within(dialog).findByText('先在『Agent 接入』页启用知识库 Agent')).toBeInTheDocument();
    expect(within(dialog).queryByText('把制度 .docx 拖到这里，或')).not.toBeInTheDocument();
  });

  it('an analyst gets no form: only admins upload policies', async () => {
    const { bench } = mount({ role: 'analyst' });
    const dialog = await screen.findByRole('dialog', { name: '上传制度' });
    expect(await within(dialog).findByText('只有管理员能上传制度')).toBeInTheDocument();
    expect(within(dialog).queryByText('把制度 .docx 拖到这里，或')).not.toBeInTheDocument();
    expect(bench.find('GET', '/api/analysis/v1/poc/kb/mode')).toEqual([]);
  });
});
