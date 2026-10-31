import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { startApp } from './startApp';
import { ALL_OPS, PG_OPS, deferred, fakeKb, uploadOf, type KbOptions } from './knowledgeFake';

// 知识库页（Spec 第 6 节；补丁 0005 的 kb-page.js；Ruling T6c 与角色）：先问 /poc/kb/mode；没配置 / 没启用整页只说明怎么办；
// 就绪时制度清单（下线 / 恢复按 describe 的 ops，删除二次确认）、上传记录、检索；工具失败（200 + success:false）当失败显示；分析员只读。
async function openKnowledge(options: KbOptions = {}) {
  const bench = fakeKb(options);
  const app = await startApp('#/knowledge');
  await screen.findByRole('heading', { level: 1, name: '知识库' });
  return { ...app, bench };
}
const sourcesTable = () => screen.findByRole('table', { name: '制度清单' });
const rowOf = async (sourceId: string) => (await within(await sourcesTable()).findAllByRole('row')).find(row => row.getAttribute('data-source') === sourceId)!;

describe('知识库: before the agent is ready, the whole page only says what to do', () => {
  it('not configured: names the agent, says what to do, and asks for nothing else', async () => {
    const { bench } = await openKnowledge({ mode: { mode: 'pg', configured: false, ready: false, ops: [] } });
    expect(await screen.findByText('知识库 Agent 还没配置')).toBeInTheDocument();
    expect(screen.getByText(/部署配置里还没有它的发布编号/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '上传制度' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '检索' })).not.toBeInTheDocument();
    expect(bench.calls.filter(call => call.path.startsWith('/api/analysis/v1/poc/kb/') && !call.path.endsWith('/mode'))).toEqual([]);
  });

  it('not enabled: 「先在『Agent 接入』页启用知识库 Agent」 with a link there for the admin', async () => {
    const { bench } = await openKnowledge({ mode: { mode: 'pg', configured: true, ready: false, ops: [] } });
    expect(await screen.findByText('先在『Agent 接入』页启用知识库 Agent')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '打开 Agent 接入' })).toHaveAttribute('href', '#/agents');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '上传制度' })).not.toBeInTheDocument();
    expect(bench.find('GET', '/api/analysis/v1/poc/kb/sources')).toEqual([]);
  });

  it('names the s3vectors agent 知识库文档管家', async () => {
    await openKnowledge({ mode: { mode: 's3vectors', configured: true, ready: false, ops: [] } });
    expect(await screen.findByText('先在『Agent 接入』页启用知识库文档管家')).toBeInTheDocument();
  });

  it('an analyst is told to ask an admin, with no link to a page they cannot open', async () => {
    await openKnowledge({ role: 'analyst', mode: { mode: 'pg', configured: true, ready: false, ops: [] } });
    expect(await screen.findByText('先在『Agent 接入』页启用知识库 Agent')).toBeInTheDocument();
    expect(screen.getByText(/请管理员/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '打开 Agent 接入' })).not.toBeInTheDocument();
  });

  it('when /mode fails, shows the shell message as it came and 「重试」 asks again', async () => {
    let fail = true;
    const { user, bench } = await openKnowledge({ overrides: {
      'GET /api/analysis/v1/poc/kb/mode': () => (fail
        ? { status: 503, body: { error: { code: 'KB_UNAVAILABLE', message: '知识库 Agent 暂时连不上，或没在限定时间内答完：稍后再试。' } } }
        : { body: { data: { mode: 'pg', configured: true, ready: true, ops: PG_OPS } } }),
    } });
    expect(await screen.findByText('知识库 Agent 暂时连不上，或没在限定时间内答完：稍后再试。', {}, { timeout: 4000 })).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(await sourcesTable()).toBeInTheDocument();
    expect(bench.find('GET', '/api/analysis/v1/poc/kb/mode').length).toBeGreaterThanOrEqual(2);
  });
});

describe('知识库: ready', () => {
  it('lists the sources with title, id, version, count, status and time, and shows the agent as ready', async () => {
    await openKnowledge();
    const table = await sourcesTable();
    expect(within(table).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['标题', '制度标识', '版本', '条数', '状态', '时间', '操作']);
    const fin = await rowOf('fin-approval');
    expect(within(fin).getByText('虚构财务审批办法V4.docx')).toBeInTheDocument();
    expect(within(fin).getByText('V4.0 虚构版')).toBeInTheDocument();
    expect(within(fin).getByText('128')).toBeInTheDocument();
    expect(within(fin).getByText('有效').closest('[data-tone]')).toHaveAttribute('data-tone', 'pass');
    expect(within(fin).getByText('10-29 10:10')).toBeInTheDocument();
    expect(within(await rowOf('travel-rules')).getByText('已下线').closest('[data-tone]')).toHaveAttribute('data-tone', 'wait');
    expect(screen.getByText('知识库 Agent').closest('[data-agent]')).toHaveTextContent('就绪');
    expect(screen.getByRole('button', { name: '上传制度' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '检索' })).toBeInTheDocument();
  });

  it('says what to do when the library is empty', async () => {
    await openKnowledge({ sources: [] });
    expect(await screen.findByText('规则库里还没有制度')).toBeInTheDocument();
    expect(screen.getByText(/点右上角「上传制度」/)).toBeInTheDocument();
  });

  it('describe ops decide 下线 / 恢复: without deactivate / restore (the PG agent adds preview) only 查看 and 删除 show', async () => {
    await openKnowledge({ mode: { mode: 'pg', configured: true, ready: true, ops: PG_OPS } });
    for (const id of ['fin-approval', 'travel-rules']) {
      const row = await rowOf(id);
      expect(within(row).getAllByRole('button').map(button => button.textContent)).toEqual(['查看', '删除']);
    }
  });

  it('with deactivate and restore listed: 下线 on an active source, 恢复 on an inactive one; 下线 goes through and the list is read again', async () => {
    const { user, bench } = await openKnowledge({ mode: { mode: 'pg', configured: true, ready: true, ops: ALL_OPS } });
    expect(within(await rowOf('fin-approval')).getAllByRole('button').map(button => button.textContent)).toEqual(['查看', '下线', '删除']);
    expect(within(await rowOf('travel-rules')).getAllByRole('button').map(button => button.textContent)).toEqual(['查看', '恢复', '删除']);
    const reads = bench.find('GET', '/api/analysis/v1/poc/kb/sources').length;
    await user.click(within(await rowOf('fin-approval')).getByRole('button', { name: '下线' }));
    expect(await screen.findByText('已下线「虚构财务审批办法V4.docx」（128 条规则）：审核 Agent 检索不到了，可以恢复。')).toBeInTheDocument();
    const [call] = bench.find('POST', '/api/analysis/v1/poc/kb/sources/fin-approval/deactivate');
    expect(call.headers.get('X-CSRF-Token')).toBe('csrf-1');
    expect(bench.find('GET', '/api/analysis/v1/poc/kb/sources').length).toBe(reads + 1);
    expect(within(await rowOf('fin-approval')).getByText('已下线')).toBeInTheDocument();
  });

  it('while one operation runs (10–20 s), every row button and 刷新 is disabled, and a second click sends nothing', async () => {
    const slow = deferred();
    const { user, bench } = await openKnowledge({ overrides: { 'POST /api/analysis/v1/poc/kb/sources/travel-rules/restore': slow.route } });
    const restore = within(await rowOf('travel-rules')).getByRole('button', { name: '恢复' });
    await user.click(restore);
    expect(await screen.findByText('正在处理（约 10–20 秒）')).toBeInTheDocument();
    for (const button of within(await sourcesTable()).getAllByRole('button')) expect(button).toBeDisabled();
    expect(screen.getByRole('button', { name: '刷新清单' })).toBeDisabled();
    await user.click(restore);
    expect(bench.find('POST', '/api/analysis/v1/poc/kb/sources/travel-rules/restore')).toHaveLength(1);
    slow.resolve({ body: { data: { success: true, source_id: 'travel-rules', affected: 12 } } });
    expect(await screen.findByText('已恢复「虚构差旅制度」（12 条规则）：又能检索到了。')).toBeInTheDocument();
    expect(within(await rowOf('travel-rules')).getByRole('button', { name: '恢复' })).toBeEnabled();
  });

  it('删除 asks a second time in a modal: 取消 sends nothing; 确认删除 deletes and the row goes away', async () => {
    const { user, bench } = await openKnowledge();
    await user.click(within(await rowOf('fin-approval')).getByRole('button', { name: '删除' }));
    let dialog = await screen.findByRole('dialog', { name: '删除制度' });
    expect(within(dialog).getByText(/删除「虚构财务审批办法V4.docx」（fin-approval）的全部 128 条规则和登记，删了不能恢复。/)).toBeInTheDocument();
    expect(within(dialog).getByText(/只是暂时不用的话，点「下线」。/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(bench.find('POST', '/api/analysis/v1/poc/kb/sources/fin-approval/delete')).toEqual([]);

    await user.click(within(await rowOf('fin-approval')).getByRole('button', { name: '删除' }));
    dialog = await screen.findByRole('dialog', { name: '删除制度' });
    await user.click(within(dialog).getByRole('button', { name: '确认删除' }));
    expect(await screen.findByText('已删除「虚构财务审批办法V4.docx」：128 条规则和登记都删掉了。')).toBeInTheDocument();
    expect(bench.find('POST', '/api/analysis/v1/poc/kb/sources/fin-approval/delete')).toHaveLength(1);
    await waitFor(() => expect(within(screen.getByRole('table', { name: '制度清单' })).queryByText('虚构财务审批办法V4.docx')).not.toBeInTheDocument());
  });

  it('without deactivate the delete warning does not point at 下线', async () => {
    const { user } = await openKnowledge({ mode: { mode: 'pg', configured: true, ready: true, ops: PG_OPS } });
    await user.click(within(await rowOf('fin-approval')).getByRole('button', { name: '删除' }));
    const dialog = await screen.findByRole('dialog', { name: '删除制度' });
    expect(within(dialog).queryByText(/下线/)).not.toBeInTheDocument();
  });

  it('a tool failure (HTTP 200, success:false) on the list shows its message and suggestion, not an empty list', async () => {
    await openKnowledge({ overrides: {
      'GET /api/analysis/v1/poc/kb/sources': { body: { data: { success: false, error_type: 'db_error', message: '规则库暂时读不了（虚构）。', suggestion: '稍后再试' } } },
    } });
    expect(await screen.findByText('规则库暂时读不了（虚构）。（稍后再试）')).toBeInTheDocument();
    expect(screen.queryByText('规则库里还没有制度')).not.toBeInTheDocument();
  });

  it('a tool failure on 删除 is shown as a failure, and the row stays', async () => {
    const { user } = await openKnowledge({ overrides: {
      'POST /api/analysis/v1/poc/kb/sources/fin-approval/delete': { body: { data: { success: false, error_type: 'db_error', message: '没有删掉（虚构）。' } } },
    } });
    await user.click(within(await rowOf('fin-approval')).getByRole('button', { name: '删除' }));
    await user.click(within(await screen.findByRole('dialog', { name: '删除制度' })).getByRole('button', { name: '确认删除' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('没有删掉（虚构）。');
    expect(screen.queryByText(/已删除/)).not.toBeInTheDocument();
    expect(await rowOf('fin-approval')).toBeInTheDocument();
  });

  it('KB_AGENT_NOT_READY in the middle (the key went away) turns the page into the enable notice', async () => {
    let ready = true;
    await openKnowledge({ overrides: {
      'GET /api/analysis/v1/poc/kb/mode': () => ({ body: { data: { mode: 'pg', configured: true, ready, ops: ready ? ALL_OPS : [] } } }),
      'GET /api/analysis/v1/poc/kb/sources': () => { ready = false; return { status: 409, body: { error: { code: 'KB_AGENT_NOT_READY', message: '先在『Agent 接入』页启用知识库 Agent' } } }; },
    } });
    expect(await screen.findByText('先在『Agent 接入』页启用知识库 Agent', {}, { timeout: 3000 })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: '上传制度' })).not.toBeInTheDocument());
  });

  it('查看 opens the source details with its rule ids', async () => {
    const { user, bench } = await openKnowledge();
    await user.click(within(await rowOf('fin-approval')).getByRole('button', { name: '查看' }));
    const dialog = await screen.findByRole('dialog', { name: '虚构财务审批办法V4.docx' });
    expect(await within(dialog).findByText('R-07')).toBeInTheDocument();
    expect(within(dialog).getByText('规则编号 3 条')).toBeInTheDocument();
    expect(within(dialog).getByText('fin-approval')).toBeInTheDocument();
    expect(bench.find('GET', '/api/analysis/v1/poc/kb/sources/fin-approval')).toHaveLength(1);
  });

  it('上传记录 lists the shell\'s upload history with the outcome of each', async () => {
    await openKnowledge({ uploads: [
      uploadOf(1),
      uploadOf(2, { status: 'skipped', written: 0, removed: 0, unchanged: 128 }),
      uploadOf(3, { status: 'failed', rulesTotal: null, error: { code: 'KB_RULE_CONFLICT', message: '有规则编号已属于库里另一份文档，入库会覆盖那份文档的规则，所以不能入库。' } }),
    ] });
    const table = await screen.findByRole('table', { name: '上传记录' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map(row => row.getAttribute('data-upload'))).toEqual(['3', '2', '1']);
    expect(within(rows[0]).getByText('失败').closest('[data-tone]')).toHaveAttribute('data-tone', 'fail');
    expect(within(rows[0]).getByText(/有规则编号已属于库里另一份文档/)).toBeInTheDocument();
    expect(within(rows[1]).getByText('没有变化')).toBeInTheDocument();
    expect(within(rows[1]).getByText('和库里的一样，没有重写')).toBeInTheDocument();
    expect(within(rows[2]).getByText('已入库').closest('[data-tone]')).toHaveAttribute('data-tone', 'pass');
    expect(within(rows[2]).getByText('写入 3 / 删除 1 / 不变 124')).toBeInTheDocument();
    expect(within(rows[2]).getByText('90 秒')).toBeInTheDocument();
  });
});

describe('知识库: an analyst reads only (spec §6 roles)', () => {
  it('sees the list, 查看 and 检索 — no 上传制度, 下线, 恢复, 删除, nor the upload history', async () => {
    const { bench } = await openKnowledge({ role: 'analyst' });
    const fin = await rowOf('fin-approval');
    expect(within(fin).getAllByRole('button').map(button => button.textContent)).toEqual(['查看']);
    expect(within(await rowOf('travel-rules')).getAllByRole('button').map(button => button.textContent)).toEqual(['查看']);
    expect(screen.getByRole('button', { name: '检索' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '上传制度' })).not.toBeInTheDocument();
    expect(screen.queryByRole('table', { name: '上传记录' })).not.toBeInTheDocument();
    expect(bench.find('GET', '/api/analysis/v1/poc/kb/uploads')).toEqual([]);
  });

  it('when the shell refuses, its message is shown as it came', async () => {
    await openKnowledge({ role: 'analyst', overrides: {
      'GET /api/analysis/v1/poc/kb/mode': { status: 403, body: { error: { code: 'KB_FORBIDDEN', message: '只有管理员能管理制度知识库。' } } },
    } });
    expect(await screen.findByText('只有管理员能管理制度知识库。')).toBeInTheDocument();
  });
});
