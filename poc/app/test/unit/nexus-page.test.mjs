import test from 'node:test';
import assert from 'node:assert/strict';
import { POC_SAFE_ERRORS, agentCard, groupPublications, invocable, myConnectionPanel, nexusAgentsPage, problemOf } from '../../public-src/nexus-poc.js';

function fakeUi() {
  const node = (tagName, attrs = {}, children = []) => ({ tagName, attrs, hidden: Boolean(attrs.hidden), value: '', options: [],
    children: children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false),
    replaceChildren(...next) { this.children = next; }, focus() {}, scrollIntoView() {} });
  return {
    element: (tagName, attrs = {}, ...children) => node(tagName, attrs, children),
    button: (label, handler, options = {}) => Object.assign(node('button', { ...options }, [label]), { click: handler }),
    tag: (text, tone = '') => node('tag', { tone }, [text]),
    panel: (title, description, body) => node('panel', { title, description }, [title, description, body]),
    facts: items => node('facts', {}, items.flat()),
    empty: (title, description) => node('empty', {}, [title, description]),
    loading: text => node('loading', {}, [text]),
    errorPanel: () => node('error'),
    errorMessage: error => String(error?.message ?? error),
    icon: name => node('icon', { name }),
    announce() {},
    dateText: value => `时间(${value})`,
  };
}
const textOf = tree => (typeof tree === 'string' || typeof tree === 'number' ? String(tree)
  : Array.isArray(tree?.children) ? `${tree.attrs?.title ?? ''} ${tree.children.map(textOf).join(' ')}` : '');
const findAll = (tree, predicate, out = []) => {
  if (!tree || typeof tree !== 'object') return out;
  if (predicate(tree)) out.push(tree);
  for (const child of tree.children ?? []) findAll(child, predicate, out);
  return out;
};

const pub = extra => ({ publishId: 'pub_mine', displayName: '九安知识Agent（PoC）', description: '审批知识服务', status: 'active', version: 1, followUpdates: true,
  model: 'global.anthropic.claude-sonnet-5', a2a: { enabled: true, ready: true, rpcUrl: 'https://nexus.example/a2a/pub_mine' }, listed: true,
  card: { protocolVersion: '0.3', streaming: true, inputModes: ['text/plain', 'application/pdf'], error: null }, enablement: null, capabilities: null, ...extra });
const enabled = (extra = {}) => pub({ enablement: { status: 'active', fingerprint: '3f9c1a2b', verifiedAt: '2026-10-17T00:00:00Z', capabilitiesVersion: 'v2', enabledAt: 't', versionChanged: false, ...extra } });
const ctx = () => ({ ui: fakeUi(), api: async () => ({}), isCurrent: () => true, reload() {}, onAuthLost() {} });

test('problemOf 与 groupPublications：密钥失效、暂停、A2A 关闭、名片读不到算有问题；断开后仍记着的已启用项算已启用', () => {
  assert.equal(problemOf(pub()), null);
  assert.match(problemOf(enabled({ status: 'key_invalid' })), /调用密钥失效/);
  assert.match(problemOf(pub({ status: 'paused' })), /已暂停/);
  assert.match(problemOf(pub({ a2a: { enabled: false } })), /没有打开 A2A/);
  assert.match(problemOf(pub({ card: { error: 'POC_CARD_UNAVAILABLE' } })), /名片/);
  assert.equal(problemOf({ ...enabled(), status: 'unverified', listed: false, card: null }), null);
  const groups = groupPublications([pub({ publishId: 'pub_a' }), enabled(), pub({ publishId: 'pub_c', status: 'paused' })]);
  assert.deepEqual([groups.pending.map(item => item.publishId), groups.enabled.map(item => item.publishId), groups.problem.map(item => item.publishId)], [['pub_a'], ['pub_mine'], ['pub_c']]);
});

test('连接区：未连接时是 API 密钥输入框（密码框）和「连接」，说明在哪里生成；连上后显示 Nexus 账号、档位，和「刷新」「断开」', () => {
  const offline = myConnectionPanel({ connection: { status: 'not_connected' } }, ctx());
  const input = findAll(offline, item => item.tagName === 'input')[0];
  assert.equal(input.attrs.type, 'password');
  assert.match(textOf(offline), /个人设置 › API 密钥/);
  assert.ok(findAll(offline, item => item.tagName === 'button' && textOf(item).includes('连接')).length === 1);
  const online = myConnectionPanel({ connection: { status: 'connected', nexusUser: { name: 'admin', role: 'editor' }, preset: 'read_only', connectedAt: 't', refreshedAt: 't' } }, ctx());
  for (const expected of ['已连接', 'admin（editor）', 'read_only', '刷新', '断开']) assert.match(textOf(online), new RegExp(expected));
});

test('卡片：待启用有「启用」和隐藏的启用表单（密码框、默认勾选读能力清单）；已启用有指纹与四个操作；有问题写明原因', () => {
  const pending = agentCard(pub(), ctx(), { group: 'pending' });
  assert.ok(findAll(pending, item => item.tagName === 'button' && textOf(item).trim() === '启用').length === 1);
  const form = findAll(pending, item => item.attrs?.class === 'poc-enable-form')[0];
  assert.equal(form.hidden, true);
  assert.equal(findAll(form, item => item.tagName === 'input' && item.attrs.type === 'password').length, 1);
  assert.equal(findAll(form, item => item.tagName === 'input' && item.attrs.type === 'checkbox')[0].attrs.checked, true);
  assert.match(textOf(pending), /A2A 0\.3/);
  const on = agentCard(enabled({ versionChanged: true }), ctx(), { group: 'enabled' });
  for (const expected of ['3f9c1a2b', '调用测试', '换密钥', '重新读能力清单', '停用', '版本有变化']) assert.match(textOf(on), new RegExp(expected));
  const broken = agentCard(enabled({ status: 'key_invalid' }), ctx(), { group: 'problem' });
  assert.match(textOf(broken), /调用密钥失效/);
  assert.match(textOf(broken), /换密钥/);
});

test('invocable：调用测试只列已启用的和系统提供的（标「系统提供」），能力清单从启用时缓存的取', () => {
  const me = { publications: [pub({ publishId: 'pub_pending' }), enabled(), { ...enabled(), publishId: 'pub_bad', enablement: { status: 'key_invalid' } }],
    system: [{ publishId: 'pub_5c53e70d8dc7ddea', displayName: '九安审核AI（PoC）', purpose: 'advisory', card: null }] };
  me.publications[1].capabilities = { task: 'describe', tasks: [{ name: 'answer' }] };
  const { callable, manifests } = invocable(me);
  assert.deepEqual(callable.map(item => [item.publishId, item.canInvoke]), [['pub_mine', true], ['pub_5c53e70d8dc7ddea', true]]);
  assert.match(callable[1].displayName, /系统提供/);
  assert.deepEqual([...manifests.keys()], ['pub_mine']);
});

test('整页：连接区、我的 Agent（分组标题带数量）、未发布的 Agent、调用测试、调用记录', () => {
  const me = { connection: { status: 'connected', nexusUser: { name: 'admin', role: 'editor' } }, publications: [pub({ publishId: 'pub_a' }), enabled()],
    unpublished: [{ agentId: 'agent_draft', name: '草稿 Agent', status: 'draft', version: '1' }], system: [] };
  const page = nexusAgentsPage({ me, runs: [], policy: null }, { ...ctx(), api: async () => ({ items: [] }) });
  for (const expected of ['我的 Nexus 连接', '我的 Agent', '待启用（1）', '已启用（1）', '我还没发布的 Agent（1）', '草稿 Agent', '调用测试', '最近的调用记录']) assert.match(textOf(page), new RegExp(expected.replace(/[()（）]/g, '.')));
});

test('新错误码都有中文说明', () => {
  for (const code of ['POC_NEXUS_API_KEY_INVALID', 'POC_NEXUS_UNREACHABLE', 'POC_NEXUS_NOT_CONNECTED', 'POC_PUBLICATION_NOT_MINE', 'POC_CARD_UNAVAILABLE',
    'POC_CALL_KEY_INVALID', 'POC_AGENT_NOT_ENABLED', 'POC_ISSUE_NOT_ALLOWED', 'POC_ME_RATE_LIMIT']) assert.ok(POC_SAFE_ERRORS[code], code);
});

test('连接区：读不到列表（error）时也有「刷新」「断开」，提示先刷新重试，不让人去换新的 API 密钥', () => {
  const panel = myConnectionPanel({ connection: { status: 'error', error: 'POC_NEXUS_UNREACHABLE', nexusUser: null, preset: null, connectedAt: null, refreshedAt: 't' } }, ctx());
  for (const expected of ['刷新', '断开', 'POC_NEXUS_UNREACHABLE']) assert.match(textOf(panel), new RegExp(expected));
  assert.equal(findAll(panel, item => item.tagName === 'input').length, 0);
  assert.doesNotMatch(textOf(panel), /新建一把 API 密钥/);
});

test('卡片：一个操作还没结束时，卡片上的其他按钮也都不能点；失败后恢复', async () => {
  let finish;
  const context = { ...ctx(), api: () => new Promise((resolve, reject) => { finish = { resolve, reject }; }) };
  const card = agentCard(enabled(), context, { group: 'enabled' });
  const actions = findAll(card, item => item.attrs?.class === 'poc-actions')[0];
  const buttons = findAll(actions, item => item.tagName === 'button');
  const reread = buttons.find(item => textOf(item).includes('重新读能力清单'));
  const pending = reread.click();
  assert.ok(buttons.every(item => item.disabled === true), buttons.map(item => `${textOf(item)}:${item.disabled}`).join(','));
  finish.reject(Object.assign(new Error('暂时连不上'), { status: 502 }));
  await pending;
  assert.ok(buttons.every(item => !item.disabled));
});

test('页面文案和现在的做法一致：调用密钥在「我的 Agent」里启用，不让用户去改 infra/secrets.env；不说单据会在重启后重置', async () => {
  const { readFile } = await import('node:fs/promises');
  const invoke = await readFile(new URL('../../public-src/nexus-invoke.js', import.meta.url), 'utf8');
  const poc = await readFile(new URL('../../public-src/nexus-poc.js', import.meta.url), 'utf8');
  for (const [name, text] of [['nexus-invoke.js', invoke], ['nexus-poc.js', poc]]) {
    assert.doesNotMatch(text, /secrets\.env[^'`\n]{0,20}(填好)?调用密钥|填好调用密钥/, `${name} 不能让用户把调用密钥写进 secrets.env`);
    assert.doesNotMatch(text, /单据与审批记录会重置/, `${name}：测试台上单据存在库里，重启不丢`);
  }
  assert.match(invoke, /目前没有可调用的发布：[^'`\n]*「我的 Agent」/);
});
