import test from 'node:test';
import assert from 'node:assert/strict';
import { nexusAccessRoutes } from '../../nexus-access.mjs';

const ORIGIN = 'https://nxs-beine1013.tinyboat.blog';
const BASE = '/api/analysis/v1/platform/agent-access';
const API_KEY = 'nxc_' + 'k'.repeat(43);
const card = tasks => ({ name: '九安审核AI（PoC）', description: `说明\n契约：jiuan.agent/v1\n任务：${tasks}`, capabilities: { streaming: true },
  defaultInputModes: ['application/json'], securitySchemes: { bearer: {} } });

function fakeCli({ connected = true } = {}) {
  const calls = [];
  let online = connected;
  return { calls,
    whoami: async () => { calls.push('whoami'); return online ? { exitCode: 0, json: { user: { name: 'admin' } } } : { exitCode: 3, json: null }; },
    login: async key => { calls.push(`login ${key === API_KEY ? 'right' : 'wrong'}`); if (key !== API_KEY) return { exitCode: 3, json: null }; online = true; return { exitCode: 0, json: {} }; },
    logout: async () => { calls.push('logout'); online = false; return { exitCode: 0, json: {} }; },
    get: async path => { calls.push(`get ${path}`); if (!online) return { exitCode: 3, json: null }; return { exitCode: 0, json: { data: { items: [
      { publish_id: 'pub_5c53e70d8dc7ddea', display_name: '九安审核AI（PoC）', status: 'active', channels: [{ channel: 'a2a', enabled: true, ready: true, rpc_url: `${ORIGIN}/a2a/pub_5c53e70d8dc7ddea` }] },
      { publish_id: 'pub_2cc24c29d2e5b2c9', display_name: '九安知识Agent（PoC）', description: '知识问答', status: 'active', channels: [{ channel: 'a2a', enabled: true, ready: true }] },
      { publish_id: 'pub_mcponly0001', display_name: '只开了 MCP', status: 'active', channels: [{ channel: 'mcp', enabled: true, ready: true }] },
    ] } } }; } };
}
// 九安的名片检查（agent-contract/checks.mjs 的 checkCard）由组合根注入；这里按「任务：」那一行认任务
const checkCard = value => {
  const line = String(value?.description ?? '').split('\n').find(item => item.startsWith('任务：'));
  return { ok: Boolean(line), problems: line ? [] : [{ path: 'description', message: '名片没有声明任务' }], tasks: line ? line.slice(3).split('、') : [] };
};
// 名片的说明就是发布的说明（Nexus 只让改名称和说明）
const fetchCard = async url => (url.includes('pub_5c53e70d8dc7ddea') ? card('review_advice@1')
  : url.includes('pub_2cc24c29d2e5b2c9') ? { name: '知识', description: '没有任务行' } : null);

async function call(routes, method, path, { role = 'admin', body } = {}) {
  let status = null, payload = null;
  const res = { writeHead(code) { status = code; return this; }, setHeader() {}, end(text) { payload = JSON.parse(text); } };
  const handled = await routes.handle({ req: { method }, path, session: { user: { id: 'poc-reviewer', role } }, res, body });
  return { handled, status, payload };
}

test('没连 Nexus：显示未连接；贴对 API 密钥就连上，贴错回能照着做的说明，密钥不回显', async () => {
  const cli = fakeCli({ connected: false });
  const routes = nexusAccessRoutes({ cli, origin: ORIGIN, fetchCard, checkCard });
  assert.deepEqual((await call(routes, 'GET', `${BASE}/nexus`)).payload.data, { connected: false, user: null });
  const wrong = await call(routes, 'POST', `${BASE}/nexus`, { body: { apiKey: 'nxc_' + 'w'.repeat(43) } });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.payload.error.code, 'AGENT_NEXUS_KEY_INVALID');
  assert.match(wrong.payload.error.message, /个人设置 › API 密钥/);
  assert.equal((await call(routes, 'POST', `${BASE}/nexus`, { body: { apiKey: 'not-a-key' } })).status, 400);
  const ok = await call(routes, 'POST', `${BASE}/nexus`, { body: { apiKey: API_KEY } });
  assert.deepEqual(ok.payload.data, { connected: true, user: 'admin' });
  assert.doesNotMatch(JSON.stringify([wrong.payload, ok.payload]), /nxc_/);
});

test('发布列表：只列开了 A2A 的发布，带名称和任务；名片只差说明里的契约 / 任务两行的照样能启用，任务由平台指定', async () => {
  const routes = nexusAccessRoutes({ cli: fakeCli(), origin: ORIGIN, fetchCard, checkCard, platformTasks: ['review_advice@1'] });
  const { payload } = await call(routes, 'GET', `${BASE}/publications`);
  assert.deepEqual(payload.data.items.map(item => [item.publishId, item.name, item.tasks, item.declaredBy, item.enableable]), [
    ['pub_5c53e70d8dc7ddea', '九安审核AI（PoC）', ['review_advice@1'], 'card', true],
    ['pub_2cc24c29d2e5b2c9', '九安知识Agent（PoC）', ['review_advice@1'], 'platform', true],
  ]);
  assert.deepEqual(payload.data.items.map(item => item.problems), [[], []], '只差那两行不算问题（补丁 0003）');
});

test('名片还有别的问题、或读不到名片：不能启用，标出原因', async () => {
  const broken = async url => (url.includes('pub_5c53e70d8dc7ddea') ? null : { name: '知识', description: '没有任务行' });
  const strict = value => ({ ok: false, problems: [{ path: 'description', message: '名片没有声明任务' }, { path: 'capabilities.streaming', message: '不支持流式' }], tasks: [] });
  const routes = nexusAccessRoutes({ cli: fakeCli(), origin: ORIGIN, fetchCard: broken, checkCard: strict, platformTasks: ['review_advice@1'] });
  const { payload } = await call(routes, 'GET', `${BASE}/publications`);
  assert.deepEqual(payload.data.items.map(item => [item.enableable, item.declaredBy, item.problems]), [
    [false, null, ['读不到名片：发布可能暂停了，或者 A2A 没打开']],
    [false, null, ['名片没有声明任务', '不支持流式']],
  ]);
});

test('名片声明的任务九安这里都不接：不能启用，写明是哪些任务', async () => {
  const other = () => ({ ok: true, problems: [], tasks: ['knowledge_answer@1'] });
  const routes = nexusAccessRoutes({ cli: fakeCli(), origin: ORIGIN, fetchCard, checkCard: other, platformTasks: ['review_advice@1'] });
  const { payload } = await call(routes, 'GET', `${BASE}/publications`);
  assert.deepEqual([payload.data.items[0].enableable, payload.data.items[0].problems], [false, ['名片声明的任务（knowledge_answer@1）九安这里不接']]);
});

test('没连上就不能列发布；断开只删本机凭证；只有管理员能用；别的路径交还九安', async () => {
  const cli = fakeCli({ connected: false });
  const routes = nexusAccessRoutes({ cli, origin: ORIGIN, fetchCard, checkCard });
  const list = await call(routes, 'GET', `${BASE}/publications`);
  assert.equal(list.status, 409);
  assert.equal(list.payload.error.code, 'AGENT_NEXUS_NOT_CONNECTED');
  await call(routes, 'POST', `${BASE}/nexus`, { body: { apiKey: API_KEY } });
  assert.deepEqual((await call(routes, 'POST', `${BASE}/nexus/disconnect`, { body: {} })).payload.data, { connected: false, user: null });
  assert.ok(cli.calls.includes('logout'));
  assert.equal((await call(routes, 'GET', `${BASE}/nexus`, { role: 'analyst' })).status, 403);
  assert.equal((await call(routes, 'GET', BASE)).handled, false);
  assert.equal((await call(routes, 'POST', `${BASE}/pub_5c53e70d8dc7ddea/rotate`, { body: {} })).handled, false);
});
