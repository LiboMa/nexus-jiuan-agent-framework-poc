import test from 'node:test';
import assert from 'node:assert/strict';
import { nexusAccessRoutes } from '../../nexus-access.mjs';

const ORIGIN = 'https://nxs-beine1013.tinyboat.blog';
const BASE = '/api/analysis/v1/platform/agent-access';
const API_KEY = 'nxc_abcdefghijklmnopqrstuvwxyz012345';
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
      { publish_id: 'pub_2cc24c29d2e5b2c9', display_name: '九安知识Agent（PoC）', status: 'active', channels: [{ channel: 'a2a', enabled: true, ready: true }] },
      { publish_id: 'pub_mcponly0001', display_name: '只开了 MCP', status: 'active', channels: [{ channel: 'mcp', enabled: true, ready: true }] },
    ] } } }; } };
}
// 九安的名片检查（agent-contract/checks.mjs 的 checkCard）由组合根注入；这里按「任务：」那一行认任务
const checkCard = value => {
  const line = String(value?.description ?? '').split('\n').find(item => item.startsWith('任务：'));
  return { ok: Boolean(line), problems: line ? [] : [{ message: '名片没有声明任务' }], tasks: line ? line.slice(3).split('、') : [] };
};
const fetchCard = async url => (url.includes('pub_5c53e70d8dc7ddea') ? card('review_advice@1') : url.includes('pub_2cc24c29d2e5b2c9') ? { name: '知识', description: '没有任务行' } : null);

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
  const wrong = await call(routes, 'POST', `${BASE}/nexus`, { body: { apiKey: 'nxc_wrongwrongwrongwrong' } });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.payload.error.code, 'AGENT_NEXUS_KEY_INVALID');
  assert.match(wrong.payload.error.message, /个人设置 › API 密钥/);
  assert.equal((await call(routes, 'POST', `${BASE}/nexus`, { body: { apiKey: 'not-a-key' } })).status, 400);
  const ok = await call(routes, 'POST', `${BASE}/nexus`, { body: { apiKey: API_KEY } });
  assert.deepEqual(ok.payload.data, { connected: true, user: 'admin' });
  assert.doesNotMatch(JSON.stringify([wrong.payload, ok.payload]), /nxc_/);
});

test('发布列表：只列开了 A2A 的发布，带名片里的名称和声明的任务；名片不合契约的标出原因', async () => {
  const routes = nexusAccessRoutes({ cli: fakeCli(), origin: ORIGIN, fetchCard, checkCard });
  const { payload } = await call(routes, 'GET', `${BASE}/publications`);
  assert.deepEqual(payload.data.items.map(item => [item.publishId, item.name, item.tasks, item.cardOk]), [
    ['pub_5c53e70d8dc7ddea', '九安审核AI（PoC）', ['review_advice@1'], true],
    ['pub_2cc24c29d2e5b2c9', '九安知识Agent（PoC）', [], false],
  ]);
  assert.deepEqual(payload.data.items[1].problems, ['名片没有声明任务']);
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
