import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { meRoutes } from '../../access/routes.mjs';
import { createMeService } from '../../access/me.mjs';
import { createUserStore } from '../../access/store.mjs';
import { PASSWORDS, startApp } from './helpers/app.mjs';

const NEXUS = 'https://nexus.example', GOOD = 'nxa_' + 'g'.repeat(43), API_KEY = 'nxc_' + 'k'.repeat(43);
const ok = json => ({ exitCode: 0, json });
function cli() {
  const state = { connected: false };
  return { async whoami() { return state.connected ? ok({ user: { user_id: 'u-1', name: 'admin', role: 'editor' }, connection: { preset: 'read_only' } }) : { exitCode: 3, json: null }; },
    async login() { state.connected = true; return { exitCode: 0, json: null }; }, async logout() { state.connected = false; return { exitCode: 0, json: null }; },
    async get(pathname) { return pathname === '/api/v2/publications' ? ok({ data: { items: [{ publish_id: 'pub_mine', display_name: '我的 Agent', status: 'active', current_version: 1,
      channels: [{ channel: 'a2a', enabled: true, ready: true, rpc_url: `${NEXUS}/a2a/pub_mine` }] }] } }) : ok({ data: [] }); } };
}

async function setup(t) {
  const clis = { 'poc-reviewer': cli(), 'poc-checker': cli() };
  const me = createMeService({ store: createUserStore({ root: await mkdtemp(path.join(tmpdir(), 'poc-me-routes-')) }), registryKey: randomBytes(32), nexusOrigin: NEXUS,
    advisoryPublishId: 'pub_5c53e70d8dc7ddea', cliFor: async id => clis[id], keyStore: { ids: () => [], has: () => false, get: () => null },
    fetchCard: async () => ({ name: '我的 Agent', protocolVersion: '0.3' }), verifyKey: async ({ key }) => (key === GOOD ? 'valid' : 'invalid'),
    loadManifest: async () => ({ manifest: null, version: null, error: 'POC_NOT_A_MANIFEST' }) });
  const env = await startApp(t, { plugins: [meRoutes({ me })] });
  const reviewer = env.client(), checker = env.client();
  await reviewer.login('poc-reviewer', PASSWORDS.get('poc-reviewer'));
  await checker.login('poc-checker', PASSWORDS.get('poc-checker'));
  return { ...env, reviewer, checker };
}
const post = (http, route, body) => http.api(`/poc/nexus/me${route}`, { method: 'POST', body });

test('没登录是 401；GET /me 返回接口版本与未连接', async t => {
  const { client, reviewer } = await setup(t);
  assert.equal((await client().api('/poc/nexus/me')).status, 401);
  const view = await reviewer.api('/poc/nexus/me');
  assert.equal(view.status, 200);
  assert.equal(view.body.data.interfaceVersion, 'agent-access-v1');
  assert.equal(view.body.data.connection.status, 'not_connected');
});

test('连接 → 启用 → 停用：返回里没有任何密钥；复核人看不到审核员启用的', async t => {
  const { reviewer, checker } = await setup(t);
  const connected = await post(reviewer, '/connect', { apiKey: API_KEY, client: 'web' });
  assert.equal(connected.body.data.connection.status, 'connected');
  const enabled = await post(reviewer, '/agents/pub_mine/enable', { token: GOOD, loadCapabilities: false, client: 'web' });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.data.enablement.status, 'active');
  assert.equal(enabled.text.includes(GOOD) || connected.text.includes(API_KEY), false);
  await post(checker, '/connect', { apiKey: API_KEY });
  assert.equal((await checker.api('/poc/nexus/me')).body.data.publications[0].enablement, null);
  assert.equal((await post(reviewer, '/agents/pub_mine/disable', {})).body.data.publications[0].enablement, null);
});

test('错误码与状态：多余字段 400；密钥被拒 400；不在列表 404；未知子路径 404；请求体过大 413', async t => {
  const { reviewer } = await setup(t);
  assert.equal((await post(reviewer, '/connect', { apiKey: API_KEY, extra: 1 })).status, 400);
  assert.equal((await post(reviewer, '/refresh', {})).body.error.code, 'POC_NEXUS_NOT_CONNECTED');
  await post(reviewer, '/connect', { apiKey: API_KEY });
  const rejected = await post(reviewer, '/agents/pub_mine/enable', { token: 'nxa_' + 'b'.repeat(43) });
  assert.deepEqual([rejected.status, rejected.body.error.code], [400, 'POC_CALL_KEY_INVALID']);
  assert.deepEqual([(await post(reviewer, '/agents/pub_other/enable', { token: GOOD })).status], [404]);
  assert.equal((await post(reviewer, '/agents/pub_mine/frobnicate', {})).status, 404);
  assert.equal((await post(reviewer, '/connect', { apiKey: 'x'.repeat(6000) })).status, 413);   // 超出上限不到一倍：读完再回 413
});

test('POST 没带 CSRF 令牌：九安拒绝（403），不会走到连接', async t => {
  const { reviewer } = await setup(t);
  const response = await reviewer.http('/api/analysis/v1/poc/nexus/me/connect', { method: 'POST', body: { apiKey: API_KEY }, headers: { 'X-CSRF-Token': '' } });
  assert.equal(response.status, 403);
});
