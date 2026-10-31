import { describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { queryClient } from '../api/queryClient';
import type { Role } from '../api/session';
import { startApp } from './startApp';
import {
  AUDIT_PUB, BROKEN_PUB, DRAFT_PUB, FAKE_KEY, FAKE_NEXUS_KEY, KB_PUB, MANUAL_PUB, RECORDS, deferred, fakeAgents, type AgentsOptions,
} from './agentsFake';

// 「Agent 接入」（Spec 第 6 节；补丁 0001–0003；Rulings T8a–T8e）：只给管理员；连接 / 断开 Nexus；发布清单和已启用的合成一张表；
// 粘贴密钥在弹框里（type=password，提交、关闭、出错都清空，哪儿都不显示）；审批 Agent 只有一个；停用、复核、换钥匙。
const BASE = '/api/analysis/v1/platform/agent-access';

async function openAgents(options: AgentsOptions = {}) {
  const bench = fakeAgents(options);
  const app = await startApp('#/agents');
  await screen.findByRole('heading', { level: 1, name: 'Agent 接入' });
  return { ...app, bench };
}
const agentTable = () => screen.findByRole('table', { name: 'Agent 列表' });
async function rowOf(id: string) {
  const table = await agentTable();
  await waitFor(() => expect(table.querySelector(`tr[data-publish="${id}"]`)).not.toBeNull());
  return table.querySelector(`tr[data-publish="${id}"]`) as HTMLElement;
}
const rowIds = async () => [...(await agentTable()).querySelectorAll('tbody tr[data-publish]')].map(row => row.getAttribute('data-publish'));
const buttonsOf = (row: HTMLElement) => within(row).queryAllByRole('button').map(button => button.textContent);
const tags = () => [...document.querySelectorAll('[data-approval-tag]')];
// 查询缓存和变更缓存里的一切（查询键、数据、错误文字、变更的变量）
const caches = () => JSON.stringify([
  ...queryClient.getQueryCache().getAll().map(query => [query.queryKey, query.state.data, query.state.error?.message]),
  ...queryClient.getMutationCache().getAll().map(mutation => [mutation.state.variables, mutation.state.data, mutation.state.error?.message]),
]);
const nowhere = (secret: string) => {
  expect(document.body.innerHTML).not.toContain(secret);
  expect(caches()).not.toContain(secret);
  expect(window.location.href).not.toContain(secret);
};
// 没有 Nexus 清单时只有启用记录：九安按发布编号排好（pub_6ea… 在 pub_audit… 前）
const ONLY_RECORDS = [KB_PUB, AUDIT_PUB, MANUAL_PUB];
const agentAccessCalls = (bench: ReturnType<typeof fakeAgents>) => bench.calls.filter(call => call.path.startsWith(BASE));

describe('Agent 接入: admin only (Review Focus 5, T8e)', () => {
  for (const role of ['analyst', 'policy_reviewer'] as Role[]) {
    it(`${role} who opens #/agents directly gets 没有权限, and the page asks nothing of /platform/agent-access`, async () => {
      const bench = fakeAgents({ role });
      await startApp('#/agents');
      expect(await screen.findByRole('heading', { name: '没有权限' })).toBeInTheDocument();
      expect(screen.queryByRole('heading', { level: 1, name: 'Agent 接入' })).not.toBeInTheDocument();
      expect(within(screen.getByRole('navigation', { name: '主导航' })).queryByRole('link', { name: 'Agent 接入' })).not.toBeInTheDocument();
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
      expect(agentAccessCalls(bench)).toEqual([]);
    });
  }

  it('when Jiuan refuses the list, the page shows its message as it came, with 重新读取', async () => {
    const { bench, user } = await openAgents({ overrides: { [`GET ${BASE}`]: { status: 403, body: { error: { code: 'FORBIDDEN', message: '只有管理员可以管理 Agent 接入。' } } } } });
    expect(await screen.findByText('只有管理员可以管理 Agent 接入。')).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Agent 列表' })).not.toBeInTheDocument();
    const reads = bench.find('GET', BASE).length;
    await user.click(screen.getByRole('button', { name: '重新读取' }));
    await waitFor(() => expect(bench.find('GET', BASE).length).toBe(reads + 1));
  });

  it('without a Nexus address in the deployment, it says so and does not ask Nexus', async () => {
    const { bench } = await openAgents({ configured: false });
    expect(await screen.findByText('部署配置里没有 Nexus 地址，暂不能启用 Agent。')).toBeInTheDocument();
    expect(await rowIds()).toEqual(ONLY_RECORDS);
    expect(bench.find('GET', `${BASE}/nexus`)).toEqual([]);
    expect(bench.find('GET', `${BASE}/publications`)).toEqual([]);
    expect(screen.queryByRole('button', { name: '连接 Nexus' })).not.toBeInTheDocument();
  });
});

describe('Agent 接入: Nexus', () => {
  it('not connected: the enabled Agents still show, with a clear 「连接 Nexus」, and the publication list is not asked for', async () => {
    const { bench } = await openAgents({ connected: false });
    expect(await screen.findByRole('button', { name: '连接 Nexus' })).toBeInTheDocument();
    expect(screen.getByText('连接 Nexus，列出你在 Nexus 上发布的 Agent')).toBeInTheDocument();
    expect(await rowIds()).toEqual(ONLY_RECORDS);
    expect(bench.find('GET', `${BASE}/publications`)).toEqual([]);
  });

  it('连接 Nexus: the API key goes in a password box in a modal, is sent once, and then the publications are listed', async () => {
    const { bench, user } = await openAgents({ connected: false });
    await user.click(await screen.findByRole('button', { name: '连接 Nexus' }));
    const dialog = await screen.findByRole('dialog', { name: '连接 Nexus' });
    const input = within(dialog).getByLabelText('Nexus API 密钥') as HTMLInputElement;
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveAttribute('autocomplete', 'off');
    await user.type(input, FAKE_NEXUS_KEY);
    await user.click(within(dialog).getByRole('button', { name: '连接' }));
    const [post] = bench.find('POST', `${BASE}/nexus`);
    expect(post.body).toEqual({ apiKey: FAKE_NEXUS_KEY });
    expect(post.headers.get('X-CSRF-Token')).toBe('csrf-1');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText('已连接 Nexus')).toBeInTheDocument();
    expect(await rowOf(DRAFT_PUB)).toBeInTheDocument();
    nowhere(FAKE_NEXUS_KEY);
  });

  it('a refused Nexus API key: the shell message as it came, the box emptied, the key nowhere', async () => {
    const message = 'Nexus API 密钥无效、已经用过（第一次连接后平台会换新），或者不属于这个 Nexus：在 Nexus「个人设置 › API 密钥」新建一把再连接。';
    const { user } = await openAgents({ connected: false, overrides: { [`POST ${BASE}/nexus`]: { status: 400, body: { error: { code: 'AGENT_NEXUS_KEY_INVALID', message } } } } });
    await user.click(await screen.findByRole('button', { name: '连接 Nexus' }));
    const dialog = await screen.findByRole('dialog', { name: '连接 Nexus' });
    const input = within(dialog).getByLabelText('Nexus API 密钥') as HTMLInputElement;
    await user.type(input, FAKE_NEXUS_KEY);
    await user.click(within(dialog).getByRole('button', { name: '连接' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
    expect(input.value).toBe('');
    nowhere(FAKE_NEXUS_KEY);
  });

  it('断开 Nexus asks first; afterwards only the enabled Agents and 「连接 Nexus」 are left', async () => {
    const { bench, user } = await openAgents();
    expect(await rowOf(DRAFT_PUB)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '断开 Nexus' }));
    const dialog = await screen.findByRole('dialog', { name: '断开 Nexus' });
    expect(within(dialog).getByText(/已启用的 Agent 照常可用/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: '确认断开' }));
    expect(bench.find('POST', `${BASE}/nexus/disconnect`)).toHaveLength(1);
    expect(await screen.findByRole('button', { name: '连接 Nexus' })).toBeInTheDocument();
    await waitFor(async () => expect(await rowIds()).toEqual(ONLY_RECORDS));
  });

  it('a Nexus connection that went stale offers 「重新连接」 with the same password modal', async () => {
    const message = 'Nexus 连接已失效（API 密钥被停用或闲置过久）：请重新贴一把 API 密钥连接。';
    const { user } = await openAgents({ overrides: { [`GET ${BASE}/publications`]: { status: 409, body: { error: { code: 'AGENT_NEXUS_RECONNECT', message } } } } });
    expect(await screen.findByText(message)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重新连接' }));
    const dialog = await screen.findByRole('dialog', { name: '连接 Nexus' });
    expect(within(dialog).getByLabelText('Nexus API 密钥')).toHaveAttribute('type', 'password');
  });

  it('a failed publication list says why, and the enabled Agents still show', async () => {
    await openAgents({ overrides: { [`GET ${BASE}/publications`]: { status: 502, body: { error: { code: 'AGENT_NEXUS_UNREACHABLE', message: '暂时连不上 Nexus，稍后再试。' } } } } });
    expect(await screen.findByText('暂时连不上 Nexus，稍后再试。', {}, { timeout: 4000 })).toBeInTheDocument();
    expect(await rowIds()).toEqual(ONLY_RECORDS);
  });
});

describe('Agent 接入: one table (T8a)', () => {
  it('one row per publication — Nexus first, then an enabled one that is not on Nexus, with its status from the record', async () => {
    await openAgents();
    await rowOf(DRAFT_PUB);
    expect(await rowIds()).toEqual([AUDIT_PUB, KB_PUB, DRAFT_PUB, BROKEN_PUB, MANUAL_PUB]);
    const table = await agentTable();
    expect(within(table).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['名称', '状态', '用途', '名片声明的任务', '调用密钥', '操作']);
    const status = async (id: string) => within(await rowOf(id)).getByText(/^(就绪|未启用|不能启用|密钥失效|已停用)$/).closest('[data-tone]');
    expect(await status(AUDIT_PUB)).toHaveAttribute('data-tone', 'pass');
    expect(await status(KB_PUB)).toHaveTextContent('就绪');
    expect(await status(DRAFT_PUB)).toHaveTextContent('未启用');
    expect(await status(BROKEN_PUB)).toHaveTextContent('不能启用');
    expect(within(await rowOf(BROKEN_PUB)).getByText('读不到名片：发布可能暂停了，或者 A2A 没打开')).toBeInTheDocument();
    expect(await status(MANUAL_PUB)).toHaveAttribute('data-tone', 'fail');
    expect(within(await rowOf(MANUAL_PUB)).getByText('失效原因：Nexus 不认这把密钥')).toBeInTheDocument();
    expect(within(await rowOf(MANUAL_PUB)).getByText('不在你的 Nexus 发布清单里')).toBeInTheDocument();
    expect(within(await rowOf(AUDIT_PUB)).getByText('指纹 audif00d')).toBeInTheDocument();
    expect(within(await rowOf(AUDIT_PUB)).getByText('单据审核建议（review_advice@1）')).toBeInTheDocument();
    expect(within(await rowOf(KB_PUB)).getByText('名片没有声明任务')).toBeInTheDocument();
  });

  it('exactly one row carries 「审批 Agent」; other ready rows say 「供前端工作流调用（不进审批流）」; actions fit each state', async () => {
    await openAgents();
    await rowOf(DRAFT_PUB);
    expect(tags()).toHaveLength(1);
    expect(tags()[0]).toHaveTextContent('审批 Agent');
    expect(await rowOf(AUDIT_PUB)).toContainElement(tags()[0] as HTMLElement);
    expect(within(await rowOf(KB_PUB)).getByText('供前端工作流调用（不进审批流）')).toBeInTheDocument();
    for (const id of [AUDIT_PUB, DRAFT_PUB, BROKEN_PUB, MANUAL_PUB]) expect(within(await rowOf(id)).queryByText('供前端工作流调用（不进审批流）')).not.toBeInTheDocument();
    expect(buttonsOf(await rowOf(AUDIT_PUB))).toEqual(['测试', '取消审批 Agent', '复核', '停用']);
    expect(buttonsOf(await rowOf(KB_PUB))).toEqual(['测试', '设为审批 Agent', '复核', '停用']);
    expect(buttonsOf(await rowOf(DRAFT_PUB))).toEqual(['启用']);
    expect(buttonsOf(await rowOf(BROKEN_PUB))).toEqual([]);
    expect(buttonsOf(await rowOf(MANUAL_PUB))).toEqual(['换钥匙', '停用']);
    expect(screen.getByText('审批流调用「审单 Agent（虚构）」：单据池里对公付款单的 AI 独立建议都发给它；其他就绪的 Agent 只供前端工作流调用。')).toBeInTheDocument();
  });

  it('with no approval Agent the line says the approval flow is waiting, and no row is tagged', async () => {
    await openAgents({ approval: null });
    expect(await screen.findByText('审批流还没有审批 Agent：单据池的 AI 独立建议停着。在一个就绪的 Agent 上点「设为审批 Agent」。')).toBeInTheDocument();
    await rowOf(DRAFT_PUB);
    expect(tags()).toHaveLength(0);
    expect(within(await rowOf(AUDIT_PUB)).getByText('供前端工作流调用（不进审批流）')).toBeInTheDocument();
  });

  it('an approval Agent whose key went bad keeps the tag and the line says the flow is paused', async () => {
    const records = RECORDS().map(item => (item.publishId === AUDIT_PUB ? { ...item, status: 'invalid', invalidReason: 'AI_AUTH_INVALID' } : item));
    await openAgents({ records });
    expect(await screen.findByText('审批 Agent「审单 Agent（虚构）」现在不可用（密钥失效）：审批流暂停，恢复后自动接上。')).toBeInTheDocument();
    expect(tags()).toHaveLength(1);
    expect(buttonsOf(await rowOf(AUDIT_PUB))).toEqual(['换钥匙', '取消审批 Agent', '停用']);
  });
});

describe('Agent 接入: paste a call key (T8c)', () => {
  it('启用 opens a modal with a password box; on submit the box is emptied at once and the key is nowhere on the page, in the caches or the URL', async () => {
    const slow = deferred();
    const { bench, user } = await openAgents({ overrides: { [`POST ${BASE}`]: slow.route } });
    await user.click(within(await rowOf(DRAFT_PUB)).getByRole('button', { name: '启用' }));
    const dialog = await screen.findByRole('dialog', { name: '启用「报销问答助手（虚构）」' });
    const input = within(dialog).getByLabelText('调用密钥') as HTMLInputElement;
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveAttribute('autocomplete', 'off');
    await user.type(input, FAKE_KEY);
    expect(document.body.innerHTML).not.toContain(FAKE_KEY);
    await user.click(within(dialog).getByRole('button', { name: '验证并启用' }));
    expect(input.value).toBe('');
    nowhere(FAKE_KEY);
    const [post] = bench.find('POST', BASE);
    expect(post.body).toEqual({ publishId: DRAFT_PUB, key: FAKE_KEY, reason: '在「Agent 接入」页启用' });
    expect(post.headers.get('X-CSRF-Token')).toBe('csrf-1');
    expect(within(dialog).getByText('正在向 Nexus 当场验证名片与密钥，最长约三分钟…')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '验证并启用' })).toBeDisabled();
    slow.resolve({ body: { data: { publishId: DRAFT_PUB, status: 'active', fingerprint: 'c0ffee42', approval: false, card: { name: '报销问答助手（虚构）', tasks: [], declaredTasks: [] } } } });
    expect(await screen.findByText('已启用「报销问答助手（虚构）」，密钥指纹 c0ffee42。')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    nowhere(FAKE_KEY);
  });

  it('a refused key: the message as it came, the box emptied, the key nowhere, and 验证并启用 works again', async () => {
    const { user } = await openAgents({ overrides: { [`POST ${BASE}`]: { status: 422, body: { error: { code: 'AGENT_KEY_REJECTED', message: 'Nexus 不认这把调用密钥。' } } } } });
    await user.click(within(await rowOf(DRAFT_PUB)).getByRole('button', { name: '启用' }));
    const dialog = await screen.findByRole('dialog', { name: '启用「报销问答助手（虚构）」' });
    const input = within(dialog).getByLabelText('调用密钥') as HTMLInputElement;
    await user.type(input, FAKE_KEY);
    await user.click(within(dialog).getByRole('button', { name: '验证并启用' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Nexus 不认这把调用密钥。');
    expect(input.value).toBe('');
    expect(within(dialog).getByRole('button', { name: '验证并启用' })).toBeEnabled();
    nowhere(FAKE_KEY);
  });

  it('closing the modal forgets what was typed, and nothing is sent', async () => {
    const { bench, user } = await openAgents();
    await user.click(within(await rowOf(DRAFT_PUB)).getByRole('button', { name: '启用' }));
    let dialog = await screen.findByRole('dialog', { name: '启用「报销问答助手（虚构）」' });
    await user.type(within(dialog).getByLabelText('调用密钥'), FAKE_KEY);
    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    nowhere(FAKE_KEY);
    await user.click(within(await rowOf(DRAFT_PUB)).getByRole('button', { name: '启用' }));
    dialog = await screen.findByRole('dialog', { name: '启用「报销问答助手（虚构）」' });
    expect((within(dialog).getByLabelText('调用密钥') as HTMLInputElement).value).toBe('');
    await user.keyboard('{Escape}');
    expect(bench.find('POST', BASE)).toEqual([]);
  });

  it('an empty box or a Nexus API key (nxc_) in the call-key box is caught before anything is sent', async () => {
    const { bench, user } = await openAgents();
    await user.click(within(await rowOf(DRAFT_PUB)).getByRole('button', { name: '启用' }));
    const dialog = await screen.findByRole('dialog', { name: '启用「报销问答助手（虚构）」' });
    await user.click(within(dialog).getByRole('button', { name: '验证并启用' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('请贴上调用密钥');
    const input = within(dialog).getByLabelText('调用密钥') as HTMLInputElement;
    await user.type(input, FAKE_NEXUS_KEY);
    await user.click(within(dialog).getByRole('button', { name: '验证并启用' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('这是 Nexus API 密钥（nxc_ 开头），不是调用密钥');
    expect(input.value).toBe('');
    expect(bench.find('POST', BASE)).toEqual([]);
    nowhere(FAKE_NEXUS_KEY);
  });

  it('two clicks in the same tick send one enable', async () => {
    const slow = deferred();
    const { bench, user } = await openAgents({ overrides: { [`POST ${BASE}`]: slow.route } });
    await user.click(within(await rowOf(DRAFT_PUB)).getByRole('button', { name: '启用' }));
    const dialog = await screen.findByRole('dialog', { name: '启用「报销问答助手（虚构）」' });
    await user.type(within(dialog).getByLabelText('调用密钥'), FAKE_KEY);
    const go = within(dialog).getByRole('button', { name: '验证并启用' });
    act(() => { fireEvent.click(go); fireEvent.click(go); });
    expect(bench.find('POST', BASE)).toHaveLength(1);
    slow.resolve({ status: 422, body: { error: { code: 'AGENT_KEY_REJECTED', message: 'Nexus 不认这把调用密钥。' } } });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Nexus 不认这把调用密钥。');
  });

  it('closed while Nexus is still checking: a refusal that comes back later is said on the page, and the key is still nowhere', async () => {
    const slow = deferred();
    const { user } = await openAgents({ overrides: { [`POST ${BASE}`]: slow.route } });
    await user.click(within(await rowOf(DRAFT_PUB)).getByRole('button', { name: '启用' }));
    const dialog = await screen.findByRole('dialog', { name: '启用「报销问答助手（虚构）」' });
    await user.type(within(dialog).getByLabelText('调用密钥'), FAKE_KEY);
    await user.click(within(dialog).getByRole('button', { name: '验证并启用' }));
    await user.click(within(dialog).getByRole('button', { name: '关闭（验证照常进行）' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByText('正在向 Nexus 当场验证名片与密钥，最长约三分钟…')).toBeInTheDocument();
    slow.resolve({ status: 422, body: { error: { code: 'AGENT_KEY_REJECTED', message: 'Nexus 不认这把调用密钥。' } } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Nexus 不认这把调用密钥。');
    expect(within(await rowOf(DRAFT_PUB)).getByRole('button', { name: '启用' })).toBeEnabled();
    nowhere(FAKE_KEY);
  });

  it('换钥匙 uses the same modal and sends rotate; the row is ready again', async () => {
    const { bench, user } = await openAgents();
    await user.click(within(await rowOf(MANUAL_PUB)).getByRole('button', { name: '换钥匙' }));
    const dialog = await screen.findByRole('dialog', { name: '给「手动添加的初审 Agent（虚构）」换一把调用密钥' });
    const input = within(dialog).getByLabelText('调用密钥') as HTMLInputElement;
    expect(input).toHaveAttribute('type', 'password');
    await user.type(input, FAKE_KEY);
    await user.click(within(dialog).getByRole('button', { name: '验证并更换' }));
    expect(input.value).toBe('');
    expect(bench.find('POST', `${BASE}/${MANUAL_PUB}/rotate`)[0].body).toEqual({ key: FAKE_KEY, reason: '在「Agent 接入」页换钥匙' });
    expect(await screen.findByText('已给「手动添加的初审 Agent（虚构）」换好调用密钥，新密钥指纹 beadfeed。')).toBeInTheDocument();
    await waitFor(async () => expect(buttonsOf(await rowOf(MANUAL_PUB))).toEqual(['测试', '设为审批 Agent', '复核', '停用']));
    nowhere(FAKE_KEY);
  });

  it('手动添加 Agent: the A2A address names the publication, the key goes in a password box', async () => {
    const { bench, user } = await openAgents({ connected: false });
    await user.click(await screen.findByRole('button', { name: '手动添加 Agent' }));
    const dialog = await screen.findByRole('dialog', { name: '手动添加 Agent' });
    const address = within(dialog).getByLabelText('A2A 地址');
    const key = within(dialog).getByLabelText('调用密钥') as HTMLInputElement;
    expect(key).toHaveAttribute('type', 'password');
    await user.type(address, 'https://nexus.example/somewhere');
    await user.type(key, FAKE_KEY);
    await user.click(within(dialog).getByRole('button', { name: '验证并添加' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('认不出发布：请粘贴这个发布的 A2A 地址（含 /a2a/pub_…）');
    expect(key.value).toBe('');
    expect(bench.find('POST', BASE)).toEqual([]);
    await user.clear(address);
    await user.type(address, 'https://nexus.example/a2a/pub_newone0007gggg/.well-known/agent-card.json');
    await user.type(key, FAKE_KEY);
    await user.click(within(dialog).getByRole('button', { name: '验证并添加' }));
    expect(bench.find('POST', BASE)[0].body).toEqual({ publishId: 'pub_newone0007gggg', key: FAKE_KEY, reason: '在「Agent 接入」页手动添加（A2A 地址 + 调用密钥）' });
    expect(await rowOf('pub_newone0007gggg')).toBeInTheDocument();
    nowhere(FAKE_KEY);
  });
});

describe('Agent 接入: the approval Agent (T8b)', () => {
  it('设为审批 Agent on the knowledge-base Agent: the modal warns its card does not declare the approval flow, a reason is required, then the tag moves', async () => {
    const { bench, user } = await openAgents();
    await user.click(within(await rowOf(KB_PUB)).getByRole('button', { name: '设为审批 Agent' }));
    const dialog = await screen.findByRole('dialog', { name: '设为审批 Agent' });
    expect(within(dialog).getByText('审批流以后只调「知识库文档管家（PG 版）」，不再调「审单 Agent（虚构）」：单据池里新的 AI 独立建议都发给它。')).toBeInTheDocument();
    expect(within(dialog).getByText(/「知识库文档管家（PG 版）」的名片没有声明审批流的任务/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: '确认设为审批 Agent' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('请写一句原因');
    expect(bench.find('POST', `${BASE}/${KB_PUB}/approve`)).toEqual([]);
    await user.type(within(dialog).getByLabelText('原因'), '虚构：试一下');
    await user.click(within(dialog).getByRole('button', { name: '确认设为审批 Agent' }));
    expect(bench.find('POST', `${BASE}/${KB_PUB}/approve`)[0].body).toEqual({ reason: '虚构：试一下' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(async () => expect(await rowOf(KB_PUB)).toContainElement(tags()[0] as HTMLElement));
    expect(tags()).toHaveLength(1);
    expect(within(await rowOf(AUDIT_PUB)).getByText('供前端工作流调用（不进审批流）')).toBeInTheDocument();
    expect(buttonsOf(await rowOf(AUDIT_PUB))).toEqual(['测试', '设为审批 Agent', '复核', '停用']);
  });

  it('an Agent whose card declares review_advice@1 gets no warning; with no approval Agent yet, the text says so', async () => {
    const { bench, user } = await openAgents({ approval: null });
    await user.click(within(await rowOf(AUDIT_PUB)).getByRole('button', { name: '设为审批 Agent' }));
    const dialog = await screen.findByRole('dialog', { name: '设为审批 Agent' });
    expect(within(dialog).getByText('审批流（单据池的 AI 独立建议）以后调「审单 Agent（虚构）」。')).toBeInTheDocument();
    expect(within(dialog).queryByText(/名片没有声明审批流的任务/)).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('原因'), '虚构：审单用它');
    await user.click(within(dialog).getByRole('button', { name: '确认设为审批 Agent' }));
    expect(bench.find('POST', `${BASE}/${AUDIT_PUB}/approve`)).toHaveLength(1);
    await waitFor(() => expect(tags()).toHaveLength(1));
  });

  it('取消审批 Agent asks first, with a reason; 返回 sends nothing; afterwards no row is tagged and the line says the flow is waiting', async () => {
    const { bench, user } = await openAgents();
    await user.click(within(await rowOf(AUDIT_PUB)).getByRole('button', { name: '取消审批 Agent' }));
    let dialog = await screen.findByRole('dialog', { name: '取消审批 Agent' });
    expect(within(dialog).getByText(/取消后审批流没有 Agent/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: '返回' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(bench.find('POST', `${BASE}/${AUDIT_PUB}/unapprove`)).toEqual([]);
    await user.click(within(await rowOf(AUDIT_PUB)).getByRole('button', { name: '取消审批 Agent' }));
    dialog = await screen.findByRole('dialog', { name: '取消审批 Agent' });
    await user.type(within(dialog).getByLabelText('原因'), '虚构：换一个');
    await user.click(within(dialog).getByRole('button', { name: '确认取消审批 Agent' }));
    expect(bench.find('POST', `${BASE}/${AUDIT_PUB}/unapprove`)[0].body).toEqual({ reason: '虚构：换一个' });
    expect(await screen.findByText('审批流还没有审批 Agent：单据池的 AI 独立建议停着。在一个就绪的 Agent 上点「设为审批 Agent」。')).toBeInTheDocument();
    expect(tags()).toHaveLength(0);
  });

  it('a refusal from Jiuan stays in the modal as it came', async () => {
    const { user } = await openAgents({ overrides: { [`POST ${BASE}/${KB_PUB}/approve`]: { status: 409, body: { error: { code: 'AGENT_ACCESS_CONFLICT', message: '记录刚被别人改过，请刷新后重试。' } } } } });
    await user.click(within(await rowOf(KB_PUB)).getByRole('button', { name: '设为审批 Agent' }));
    const dialog = await screen.findByRole('dialog', { name: '设为审批 Agent' });
    await user.type(within(dialog).getByLabelText('原因'), '虚构');
    await user.click(within(dialog).getByRole('button', { name: '确认设为审批 Agent' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('记录刚被别人改过，请刷新后重试。');
    expect(tags()).toHaveLength(1);
  });
});

describe('Agent 接入: disable and re-check', () => {
  it('停用 asks first (it is the approval Agent: the flow pauses); then the row is 已停用 with 重新启用', async () => {
    const { bench, user } = await openAgents();
    await user.click(within(await rowOf(AUDIT_PUB)).getByRole('button', { name: '停用' }));
    const dialog = await screen.findByRole('dialog', { name: '停用 Agent' });
    expect(within(dialog).getByText(/它是审批 Agent：审批流会暂停/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: '确认停用' }));
    expect(bench.find('POST', `${BASE}/${AUDIT_PUB}/disable`)[0].body).toEqual({ reason: '在「Agent 接入」页停用' });
    expect(await screen.findByText('已停用「审单 Agent（虚构）」，存着的调用密钥已清除。')).toBeInTheDocument();
    await waitFor(async () => expect(buttonsOf(await rowOf(AUDIT_PUB))).toEqual(['重新启用', '取消审批 Agent']));
    expect(within(await rowOf(AUDIT_PUB)).getByText('已停用')).toBeInTheDocument();
  });

  it('复核 checks again with the stored key; two clicks in the same tick send one request and every row button waits', async () => {
    const slow = deferred();
    const { bench } = await openAgents({ overrides: { [`POST ${BASE}/${KB_PUB}/refresh`]: slow.route } });
    const button = within(await rowOf(KB_PUB)).getByRole('button', { name: '复核' });
    act(() => { fireEvent.click(button); fireEvent.click(button); });
    expect(await screen.findByText('正在用存着的密钥复核「知识库文档管家（PG 版）」…')).toBeInTheDocument();
    expect(bench.find('POST', `${BASE}/${KB_PUB}/refresh`)).toHaveLength(1);
    expect(bench.find('POST', `${BASE}/${KB_PUB}/refresh`)[0].body).toEqual({ reason: '在「Agent 接入」页复核' });
    for (const each of within(await agentTable()).getAllByRole('button')) expect(each).toBeDisabled();
    slow.resolve({ body: { data: { publishId: KB_PUB, status: 'active', fingerprint: '6ea5f00d', approval: false } } });
    expect(await screen.findByText('复核完成：「知识库文档管家（PG 版）」就绪。')).toBeInTheDocument();
  });

  it('操作记录 is folded and lists the trail, newest first', async () => {
    const { user } = await openAgents();
    const summary = await screen.findByText('操作记录（2 条）');
    await user.click(summary);
    const table = screen.getByRole('table', { name: '操作记录' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(within(rows[0]).getByText('设为审批 Agent')).toBeInTheDocument();
    expect(within(rows[0]).getByText('审单用这个（虚构）')).toBeInTheDocument();
    expect(within(rows[1]).getByText('启用')).toBeInTheDocument();
  });
});
