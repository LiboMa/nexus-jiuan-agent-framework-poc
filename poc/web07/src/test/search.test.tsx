import { describe, expect, it } from 'vitest';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { startApp } from './startApp';
import { deferred, fakeKb, type KbOptions } from './knowledgeFake';

// 「检索」弹框（Spec 第 6 节；补丁 0005）：问题必填，板块、金额可空（空的不传）；条数 8；工具失败（200 + success:false）当失败显示；一次一个请求。
async function openSearch(options: KbOptions = {}) {
  const bench = fakeKb(options);
  const app = await startApp('#/knowledge');
  await screen.findByRole('table', { name: '制度清单' });
  await app.user.click(screen.getByRole('button', { name: '检索' }));
  const dialog = await screen.findByRole('dialog', { name: '检索规则' });
  return { ...app, bench, dialog };
}
const searches = (bench: ReturnType<typeof fakeKb>) => bench.find('GET', '/api/analysis/v1/poc/kb/search').map(call => Object.fromEntries(new URLSearchParams(call.search)));

describe('检索', () => {
  it('sends only the question (and k) when 板块 and 金额 are empty, and lists the hits', async () => {
    const { user, bench, dialog } = await openSearch();
    expect(within(dialog).getByText(/和 AI 审单时用的是同一个检索/)).toBeInTheDocument();
    await user.type(within(dialog).getByRole('textbox', { name: '问题' }), '房租 年度框架合同 谁最终审批');
    await user.click(within(dialog).getByRole('button', { name: '检索' }));
    const results = await within(dialog).findByRole('list', { name: '检索结果' });
    expect(searches(bench)).toEqual([{ q: '房租 年度框架合同 谁最终审批', k: '8' }]);
    const hits = within(results).getAllByRole('listitem');
    expect(hits).toHaveLength(2);
    expect(within(hits[0]).getByText('R-07')).toBeInTheDocument();
    expect(within(hits[0]).getByText('九安、柯顿')).toBeInTheDocument();
    expect(within(hits[0]).getByText('距离 0.123')).toBeInTheDocument();
    expect(within(hits[0]).getByText(/R-07 虚构付款审批：10–20 万元/)).toBeInTheDocument();
    expect(within(hits[1]).getByText('全部板块')).toBeInTheDocument();
  });

  it('sends 板块 and 金额 when given; the amount may have thousands separators', async () => {
    const { user, bench, dialog } = await openSearch();
    await user.type(within(dialog).getByRole('textbox', { name: '问题' }), '采购合同用印');
    await user.type(within(dialog).getByRole('textbox', { name: '板块' }), '九安');
    await user.type(within(dialog).getByRole('textbox', { name: '金额（元）' }), '300,000');
    await user.click(within(dialog).getByRole('button', { name: '检索' }));
    await within(dialog).findByRole('list', { name: '检索结果' });
    expect(searches(bench)).toEqual([{ q: '采购合同用印', segment: '九安', amount: '300000', k: '8' }]);
  });

  it('asks for a question, and for an amount in yuan, before sending anything', async () => {
    const { user, bench, dialog } = await openSearch();
    await user.click(within(dialog).getByRole('button', { name: '检索' }));
    expect(within(dialog).getByText('请写一个问题')).toBeInTheDocument();
    await user.type(within(dialog).getByRole('textbox', { name: '问题' }), '房租');
    await user.type(within(dialog).getByRole('textbox', { name: '金额（元）' }), '三十万');
    await user.click(within(dialog).getByRole('button', { name: '检索' }));
    expect(within(dialog).getByText('金额写以元为单位的数字，例如 300000')).toBeInTheDocument();
    expect(searches(bench)).toEqual([]);
  });

  it('a tool failure (HTTP 200, success:false) is shown as a failure', async () => {
    const { user, dialog } = await openSearch({ overrides: {
      'GET /api/analysis/v1/poc/kb/search': { body: { data: { success: false, error_type: 'embed_failed', message: '向量服务暂时不可用（虚构）。', suggestion: '稍后再试' } } },
    } });
    await user.type(within(dialog).getByRole('textbox', { name: '问题' }), '房租');
    await user.click(within(dialog).getByRole('button', { name: '检索' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('向量服务暂时不可用（虚构）。（稍后再试）');
    expect(within(dialog).queryByRole('list', { name: '检索结果' })).not.toBeInTheDocument();
  });

  it('says so when nothing matched', async () => {
    const { user, dialog } = await openSearch({ overrides: {
      'GET /api/analysis/v1/poc/kb/search': { body: { data: { success: true, filter: {}, results: [] } } },
    } });
    await user.type(within(dialog).getByRole('textbox', { name: '问题' }), '房租');
    await user.click(within(dialog).getByRole('button', { name: '检索' }));
    expect(await within(dialog).findByText('没有找到规则')).toBeInTheDocument();
  });

  it('two clicks on 检索 in the same tick send one search', async () => {
    const slow = deferred();
    const { user, bench, dialog } = await openSearch({ overrides: { 'GET /api/analysis/v1/poc/kb/search': slow.route } });
    await user.type(within(dialog).getByRole('textbox', { name: '问题' }), '房租');
    const go = within(dialog).getByRole('button', { name: '检索' });
    // 同一拍里点两下（同一个 act 里，中间不重新渲染）：只有在途标记挡得住第二下
    act(() => { fireEvent.click(go); fireEvent.click(go); });
    expect(await within(dialog).findByText('正在处理（约 10–20 秒）')).toBeInTheDocument();
    expect(searches(bench)).toHaveLength(1);
    slow.resolve({ body: { data: { success: true, filter: {}, results: [] } } });
    expect(await within(dialog).findByText('没有找到规则')).toBeInTheDocument();
  });
});
