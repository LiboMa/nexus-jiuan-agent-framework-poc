import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { startApp } from './startApp';
import { DOCX, OWN_RULES, RULE_TEXT, deferred, docxFile, fakeKb, mdFile, type KbOptions } from './knowledgeFake';

// 我的规则（Spec 第 6 节；补丁 0005 的 ownRules）：列表、「已用 N / 5,000 字」、上传 .md / .docx（上传后弹框显示转出的文字）、查看全文、删除；
// 限额由外壳核对，超了照它的中文提示显示；一次一个请求，进行中按钮不可点。
async function openRules(options: KbOptions = {}) {
  const bench = fakeKb(options);
  const app = await startApp('#/my-rules');
  await screen.findByRole('heading', { level: 1, name: '我的规则' });
  return { ...app, bench };
}
const input = () => document.querySelector<HTMLInputElement>('input[type="file"]')!;
const rulesTable = () => screen.findByRole('table', { name: '我的规则' });
const rowOf = async (title: string) => (await within(await rulesTable()).findAllByRole('row')).find(row => row.getAttribute('data-title') === title)!;
const dropZone = () => screen.getByText('把规则文件拖到这里，或').closest('[data-drop]')!;

describe('我的规则: list and usage', () => {
  it('lists title, chars and time, with 「已用 N / 5,000 字」 and the file count', async () => {
    await openRules();
    const table = await rulesTable();
    expect(within(table).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['标题', '字数', '上传时间', '操作']);
    const first = await rowOf('运维费规则（虚构）.md');
    expect(within(first).getByText('1,200')).toBeInTheDocument();
    expect(within(first).getByText('10-29 11:00')).toBeInTheDocument();
    expect(screen.getByText('已用 1,234 / 5,000 字')).toBeInTheDocument();
    expect(screen.getByText('2 / 10 份')).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: '已用字数' })).toHaveAttribute('aria-valuenow', '1234');
  });

  it('says what to do when there are none', async () => {
    await openRules({ rules: [] });
    expect(await screen.findByText('还没有上传规则')).toBeInTheDocument();
    expect(screen.getByText('已用 0 / 5,000 字')).toBeInTheDocument();
  });
});

describe('我的规则: upload', () => {
  it('uploads a .md as raw text, shows the converted text in a modal, and the usage follows the list', async () => {
    const { user, bench } = await openRules();
    await rulesTable();
    const text = '# 推广费须附投放截图（虚构）\n\n推广费付款要附投放截图。';
    const file = mdFile('推广费规则（虚构）.md', text);
    await user.upload(input(), file);
    const dialog = await screen.findByRole('dialog', { name: '核对转出来的文字' });
    expect(within(dialog).getByText(/已上传「推广费规则（虚构）.md」：29 字/)).toBeInTheDocument();
    expect(within(dialog).getByTestId('rule-text').textContent).toBe(text);
    const [post] = bench.find('POST', '/api/analysis/v1/poc/custom-rules');
    expect(post.headers.get('X-File-Name')).toBe(encodeURIComponent('推广费规则（虚构）.md'));
    expect(post.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
    expect(post.headers.get('X-CSRF-Token')).toBe('csrf-1');
    expect(post.body).toBe(file);
    expect(await screen.findByText('已用 1,263 / 5,000 字')).toBeInTheDocument();
    expect(screen.getByText('3 / 10 份')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: '核对无误' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await rowOf('推广费规则（虚构）.md')).toBeInTheDocument();
  });

  it('sends a .docx with the Word type; drag and drop works too', async () => {
    const { bench } = await openRules({ overrides: {
      'POST /api/analysis/v1/poc/custom-rules': { status: 201, body: { data: { id: 'r-9', title: '虚构.docx', format: 'docx', chars: 5, uploadedAt: '2026-10-30T05:00:00.000Z', text: '虚构规则。' } } },
    } });
    await rulesTable();
    fireEvent.drop(dropZone(), { dataTransfer: { files: [docxFile('虚构.docx')] } });
    await screen.findByRole('dialog', { name: '核对转出来的文字' });
    expect(bench.find('POST', '/api/analysis/v1/poc/custom-rules')[0].headers.get('Content-Type')).toBe(DOCX);
  });

  it('over the limit: the shell\'s Chinese message as it came, and no modal', async () => {
    const { user, bench } = await openRules();
    await rulesTable();
    await user.upload(input(), mdFile('长规则（虚构）.md', '字'.repeat(4000)));
    expect(await screen.findByRole('alert')).toHaveTextContent('每人的规则合计不超过 5,000 字：这份有 4,000 字，现在还剩 3,766 字。');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(bench.find('POST', '/api/analysis/v1/poc/custom-rules')).toHaveLength(1);
    expect(screen.getByText('已用 1,234 / 5,000 字')).toBeInTheDocument();
  });

  it('checks the type and the 2 MB size on the page before sending', async () => {
    const { bench } = await openRules();
    await rulesTable();
    fireEvent.drop(dropZone(), { dataTransfer: { files: [new File(['x'], '规则.txt', { type: 'text/plain' })] } });
    expect(await screen.findByText('只收 Markdown（.md）或 Word（.docx）文件。')).toBeInTheDocument();
    const big = mdFile('大规则.md', 'x');
    Object.defineProperty(big, 'size', { value: 2 * 1024 * 1024 + 1 });
    fireEvent.drop(dropZone(), { dataTransfer: { files: [big] } });
    expect(await screen.findByText('文件超过 2 MB。')).toBeInTheDocument();
    expect(bench.find('POST', '/api/analysis/v1/poc/custom-rules')).toEqual([]);
  });

  it('while a request runs, 选择文件 and every row button are disabled, and another file is not sent', async () => {
    const slow = deferred();
    const { bench } = await openRules({ overrides: { 'POST /api/analysis/v1/poc/custom-rules': slow.route } });
    await rulesTable();
    const user = userEvent.setup({ applyAccept: false });
    await user.upload(input(), mdFile('一（虚构）.md', '一'));
    expect(await screen.findByText('正在上传「一（虚构）.md」并转成文字…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '选择文件' })).toBeDisabled();
    for (const button of within(await rulesTable()).getAllByRole('button')) expect(button).toBeDisabled();
    fireEvent.drop(dropZone(), { dataTransfer: { files: [mdFile('二（虚构）.md', '二')] } });
    expect(bench.find('POST', '/api/analysis/v1/poc/custom-rules')).toHaveLength(1);
    slow.resolve({ status: 201, body: { data: { id: 'r-9', title: '一（虚构）.md', format: 'md', chars: 1, uploadedAt: '2026-10-30T05:00:00.000Z', text: '一' } } });
    await user.click(within(await screen.findByRole('dialog', { name: '核对转出来的文字' })).getByRole('button', { name: '核对无误' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: '选择文件' })).toBeEnabled();
  });
});

describe('我的规则: full text and delete', () => {
  it('查看全文 opens the rule in a modal', async () => {
    const { user, bench } = await openRules();
    await user.click(within(await rowOf('运维费规则（虚构）.md')).getByRole('button', { name: '查看全文' }));
    const dialog = await screen.findByRole('dialog', { name: '运维费规则（虚构）.md' });
    expect((await within(dialog).findByTestId('rule-text')).textContent).toBe(RULE_TEXT);
    expect(within(dialog).getByText(/1,200 字/)).toBeInTheDocument();
    expect(bench.find('GET', '/api/analysis/v1/poc/custom-rules/r-1')).toHaveLength(1);
  });

  it('删除 asks first; 确认删除 deletes it, and the list and usage follow', async () => {
    const { user, bench } = await openRules();
    await user.click(within(await rowOf(OWN_RULES[0].title)).getByRole('button', { name: '删除' }));
    let dialog = await screen.findByRole('dialog', { name: '删除规则' });
    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(bench.find('POST', '/api/analysis/v1/poc/custom-rules/r-1/delete')).toEqual([]);

    await user.click(within(await rowOf(OWN_RULES[0].title)).getByRole('button', { name: '删除' }));
    dialog = await screen.findByRole('dialog', { name: '删除规则' });
    expect(within(dialog).getByText(/删除「运维费规则（虚构）.md」（1,200 字）/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: '确认删除' }));
    expect(await screen.findByText('已删除「运维费规则（虚构）.md」。')).toBeInTheDocument();
    expect(bench.find('POST', '/api/analysis/v1/poc/custom-rules/r-1/delete')[0].headers.get('X-CSRF-Token')).toBe('csrf-1');
    expect(await screen.findByText('已用 34 / 5,000 字')).toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByRole('table', { name: '我的规则' })).queryByText(OWN_RULES[0].title)).not.toBeInTheDocument());
  });

  it('删掉这份 from the upload modal goes through the same confirmation', async () => {
    const { user, bench } = await openRules();
    await rulesTable();
    await user.upload(input(), mdFile('错的规则（虚构）.md', '错的'));
    const dialog = await screen.findByRole('dialog', { name: '核对转出来的文字' });
    await user.click(within(dialog).getByRole('button', { name: '删掉这份' }));
    const confirm = await screen.findByRole('dialog', { name: '删除规则' });
    await user.click(within(confirm).getByRole('button', { name: '确认删除' }));
    expect(await screen.findByText('已删除「错的规则（虚构）.md」。')).toBeInTheDocument();
    expect(bench.find('POST', '/api/analysis/v1/poc/custom-rules/r-10/delete')).toHaveLength(1);
  });

  it('an analyst has the same page', async () => {
    await openRules({ role: 'analyst' });
    expect(await rowOf('运维费规则（虚构）.md')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '选择文件' })).toBeEnabled();
  });
});
