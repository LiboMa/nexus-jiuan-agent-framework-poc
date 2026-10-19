import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { INTERFACE_VERSION, createMeService } from '../../access/me.mjs';
import { createUserStore } from '../../access/store.mjs';
import { seal } from '../../access/crypto.mjs';

const NEXUS = 'https://nexus.example';
const REVIEWER = { id: 'poc-reviewer', name: '审核员（虚构）' };
const CHECKER = { id: 'poc-checker', name: '复核人（虚构）' };
const GOOD = 'nxa_' + 'g'.repeat(43), OTHER = 'nxa_' + 'o'.repeat(43), API_KEY = 'nxc_' + 'k'.repeat(43);
const ok = json => ({ exitCode: 0, json });
const publication = (id, extra = {}) => ({ publish_id: id, display_name: `发布 ${id}`, description: '虚构', agent_id: `agent_${id}`, effective_agent_id: `agent_${id}`,
  agent_name: `agent ${id}`, status: 'active', owner_name: 'admin', follow_updates: true, current_version: 1, pinned_version: null,
  agent_default_model: 'global.anthropic.claude-sonnet-5', channels: [{ channel: 'a2a', enabled: true, status: 'ready', ready: true, rpc_url: `${NEXUS}/a2a/${id}` }], ...extra });
const CARD = { name: '九安知识Agent（PoC）', description: '审批知识服务', protocolVersion: '0.3', capabilities: { streaming: true }, defaultInputModes: ['text/plain', 'application/pdf'] };
const MANIFEST = { task: 'describe', version: 'knowledge-agent-2026-10-17.2', tasks: [{ name: 'answer', purpose: '问知识库' }] };

function nexusAccount({ connected = false, loginExit = 0, publications = [publication('pub_mine'), publication('pub_paused', { status: 'paused' })],
  agents = [{ agent_id: 'agent_draft', agent_name: 'draft', agent_name_cn: '草稿 Agent', status: 'draft', version: '1', creator_user_id: 'u-1' }] } = {}) {
  const state = { connected, loginExit, publications, agents, calls: [], down: false };
  const unreachable = { exitCode: 8, json: { ok: false, error: { code: 'nexus_unreachable' } } };
  state.cli = {
    async whoami() { state.calls.push('whoami'); if (state.down) return unreachable; return state.connected ? ok({ ok: true, user: { user_id: 'u-1', name: 'admin', role: 'editor' }, connection: { name: 'andon', preset: 'read_only' } })
      : { exitCode: 3, json: { ok: false, error: { code: 'not_connected' } } }; },
    async login(key) { state.calls.push(['login', key]); if (state.loginExit === 0) state.connected = true; return { exitCode: state.loginExit, json: null }; },
    async logout() { state.calls.push('logout'); state.connected = false; return { exitCode: 0, json: { ok: true } }; },
    async get(pathname) { state.calls.push(['get', pathname]); if (state.down) return unreachable; return pathname === '/api/v2/publications' ? ok({ ok: true, data: { items: state.publications } }) : ok({ ok: true, data: state.agents }); },
  };
  return state;
}

async function setup({ accounts = { 'poc-reviewer': nexusAccount(), 'poc-checker': nexusAccount() }, verify = async ({ key }) => (key === GOOD ? 'valid' : 'invalid'),
  manifest = async () => ({ manifest: MANIFEST, version: MANIFEST.version, error: null }), registryKey = randomBytes(32), root, systemKeys = { pub_5c53e70d8dc7ddea: 'nxa_system' } } = {}) {
  const dir = root ?? await mkdtemp(path.join(tmpdir(), 'poc-me-'));
  let time = 1_000_000;
  const calls = { verify: [], manifest: [], cards: [] };
  const store = createUserStore({ root: dir });
  const me = createMeService({ store, registryKey, nexusOrigin: NEXUS, advisoryPublishId: 'pub_5c53e70d8dc7ddea', clock: () => time, now: () => new Date(time).toISOString(),
    cliFor: async accountId => accounts[accountId].cli,
    keyStore: { ids: () => Object.keys(systemKeys), has: id => Object.hasOwn(systemKeys, id), get: id => systemKeys[id] ?? null },
    fetchCard: async url => { calls.cards.push(url); if (url.includes('pub_paused')) throw Object.assign(new Error('x'), { code: 'POC_CARD_UNAVAILABLE' }); return CARD; },
    verifyKey: async args => { calls.verify.push(args); return verify(args); },
    loadManifest: async args => { calls.manifest.push(args); return manifest(args); } });
  return { me, store, dir, calls, accounts, registryKey, tick: ms => { time += ms; } };
}

test('没连接：视图带接口版本、未连接状态、系统提供的审批 Agent（带名片）', async () => {
  const { me } = await setup();
  const view = await me.view(REVIEWER);
  assert.equal(view.interfaceVersion, INTERFACE_VERSION);
  assert.equal(view.connection.status, 'not_connected');
  assert.deepEqual(view.publications, []);
  assert.deepEqual(view.system.map(item => [item.publishId, item.purpose, item.card.protocolVersion]), [['pub_5c53e70d8dc7ddea', 'advisory', '0.3']]);
  assert.equal(JSON.stringify(view).includes('nxa_system'), false);
});

test('连接：经 CLI 登录、whoami；列出我的发布（带名片）和我未发布的 Agent；记下连接时间与留痕；返回里没有密钥', async () => {
  const { me, store, accounts } = await setup();
  const view = await me.connect(REVIEWER, API_KEY, { client: 'web' });
  assert.deepEqual(accounts['poc-reviewer'].calls.find(call => Array.isArray(call) && call[0] === 'login'), ['login', API_KEY]);
  assert.equal(view.connection.status, 'connected');
  assert.deepEqual(view.connection.nexusUser, { id: 'u-1', name: 'admin', role: 'editor' });
  assert.equal(view.connection.preset, 'read_only');
  assert.ok(view.connection.connectedAt);
  assert.deepEqual(view.publications.map(item => [item.publishId, item.listed, item.card.error, item.enablement]), [['pub_mine', true, null, null], ['pub_paused', true, 'POC_CARD_UNAVAILABLE', null]]);
  assert.deepEqual(view.unpublished.map(item => item.name), ['草稿 Agent']);
  assert.equal(JSON.stringify(view).includes(API_KEY), false);
  assert.deepEqual((await store.readAudit('poc-reviewer')).map(entry => [entry.action, entry.client]), [['connect', 'web']]);
});

test('连接失败：格式不对不调 CLI；CLI 拒绝 → POC_NEXUS_API_KEY_INVALID；平台不可用 → POC_NEXUS_UNREACHABLE', async () => {
  const bad = nexusAccount({ loginExit: 3 }), down = nexusAccount({ loginExit: 8 });
  const { me } = await setup({ accounts: { 'poc-reviewer': bad, 'poc-checker': down } });
  await assert.rejects(me.connect(REVIEWER, 'not-a-key', {}), { code: 'POC_NEXUS_API_KEY_INVALID', status: 400 });
  assert.equal(bad.calls.length, 0);
  await assert.rejects(me.connect(REVIEWER, API_KEY, {}), { code: 'POC_NEXUS_API_KEY_INVALID', status: 400 });
  await assert.rejects(me.connect(CHECKER, API_KEY, {}), { code: 'POC_NEXUS_UNREACHABLE', status: 502 });
});

test('已经连上之后用无效的 API 密钥重连：400，原来的连接保持（Review Focus 3）', async () => {
  const account = nexusAccount();
  const { me } = await setup({ accounts: { 'poc-reviewer': account, 'poc-checker': nexusAccount() } });
  await me.connect(REVIEWER, API_KEY, {});
  account.loginExit = 3;
  await assert.rejects(me.connect(REVIEWER, 'nxc_' + 'u'.repeat(43), {}), { code: 'POC_NEXUS_API_KEY_INVALID' });
  assert.equal((await me.view(REVIEWER)).connection.status, 'connected');
});

test('列表 60 秒内直接用快照；超过 60 秒或 refresh 时重读；没连接时 refresh 是 409', async () => {
  const { me, accounts, tick } = await setup();
  await assert.rejects(me.refresh(REVIEWER), { code: 'POC_NEXUS_NOT_CONNECTED', status: 409 });
  await me.connect(REVIEWER, API_KEY, {});
  const count = () => accounts['poc-reviewer'].calls.filter(call => call === 'whoami').length;
  const before = count();
  await me.view(REVIEWER);
  assert.equal(count(), before);
  tick(61_000);
  await me.view(REVIEWER);
  assert.equal(count(), before + 1);
  await me.refresh(REVIEWER);
  assert.equal(count(), before + 2);
});

test('启用：发布在我的列表里 → 读名片 → tasks/get 验证 → 加密保存（文件里没有明文）→ 读能力清单；视图里是已启用，带指纹和能力清单', async () => {
  const { me, dir, calls, store } = await setup();
  await me.connect(REVIEWER, API_KEY, {});
  const view = await me.enable(REVIEWER, 'pub_mine', { token: ` ${GOOD} `, client: 'claude_code' });
  assert.equal(calls.verify[0].url, `${NEXUS}/a2a/pub_mine`);
  assert.equal(calls.verify[0].key, GOOD);
  assert.equal(calls.manifest.length, 1);
  assert.equal(view.enablement.status, 'active');
  assert.match(view.enablement.fingerprint, /^[0-9a-f]{8}$/);
  assert.equal(view.enablement.capabilitiesVersion, MANIFEST.version);
  assert.deepEqual(view.capabilities, MANIFEST);
  const file = await readFile(path.join(dir, 'poc-reviewer', 'enabled.json'), 'utf8');
  assert.equal(file.includes(GOOD), false);
  assert.equal(JSON.stringify(view).includes(GOOD), false);
  assert.deepEqual((await store.readAudit('poc-reviewer')).map(entry => entry.action), ['connect', 'enable']);
  assert.equal((await store.readAudit('poc-reviewer'))[1].client, 'claude_code');
});

test('启用失败：没连接、不在我的列表、名片读不到、密钥格式不对、密钥被拒、issue、从没启用又不带密钥', async () => {
  const { me, calls } = await setup();
  await assert.rejects(me.enable(REVIEWER, 'pub_mine', { token: GOOD }), { code: 'POC_NEXUS_NOT_CONNECTED', status: 409 });
  await me.connect(REVIEWER, API_KEY, {});
  await assert.rejects(me.enable(REVIEWER, 'pub_elsewhere', { token: GOOD }), { code: 'POC_PUBLICATION_NOT_MINE', status: 404 });
  await assert.rejects(me.enable(REVIEWER, 'pub_paused', { token: GOOD }), { code: 'POC_CARD_UNAVAILABLE', status: 409 });
  await assert.rejects(me.enable(REVIEWER, 'pub_mine', { token: 'nxa_short' }), { code: 'POC_CALL_KEY_INVALID', status: 400 });
  assert.equal(calls.verify.length, 0);
  await assert.rejects(me.enable(CHECKER, 'pub_mine', { issue: true }), { code: 'POC_ISSUE_NOT_ALLOWED', status: 403 });
  await me.connect(CHECKER, API_KEY, {});
  await assert.rejects(me.enable(CHECKER, 'pub_mine', { token: OTHER }), { code: 'POC_CALL_KEY_INVALID', status: 400 });
  await assert.rejects(me.enable(CHECKER, 'pub_mine', {}), { code: 'POC_AGENT_NOT_ENABLED', status: 409 });
  assert.equal((await me.view(CHECKER)).publications[0].enablement, null);
});

test('不带密钥再启用：用已保存的那把重新验证、刷新能力清单；loadCapabilities=false 不读；换新密钥失败时旧的保留', async () => {
  const { me, calls, store } = await setup();
  await me.connect(REVIEWER, API_KEY, {});
  const first = await me.enable(REVIEWER, 'pub_mine', { token: GOOD });
  await me.enable(REVIEWER, 'pub_mine', {});
  assert.equal(calls.verify[1].key, GOOD);
  assert.equal(calls.manifest.length, 2);
  await me.enable(REVIEWER, 'pub_mine', { loadCapabilities: false });
  assert.equal(calls.manifest.length, 2);
  await assert.rejects(me.enable(REVIEWER, 'pub_mine', { token: OTHER }), { code: 'POC_CALL_KEY_INVALID' });
  assert.equal((await me.view(REVIEWER)).publications[0].enablement.fingerprint, first.enablement.fingerprint);
  assert.deepEqual((await store.readAudit('poc-reviewer')).map(entry => entry.action), ['connect', 'enable', 'reverify', 'reverify']);
});

test('停用：删掉这一项，可以重复调用；留痕', async () => {
  const { me, store } = await setup();
  await me.connect(REVIEWER, API_KEY, {});
  await me.enable(REVIEWER, 'pub_mine', { token: GOOD });
  assert.equal((await me.disable(REVIEWER, 'pub_mine', { client: 'web' })).publications[0].enablement, null);
  await me.disable(REVIEWER, 'pub_mine', {});
  assert.deepEqual((await store.readAudit('poc-reviewer')).map(entry => entry.action), ['connect', 'enable', 'disable']);
});

test('credentialFor：先找我启用的，再找系统提供的，都没有返回 null；markInvalid 后不再用我的', async () => {
  const { me } = await setup({ systemKeys: { pub_5c53e70d8dc7ddea: 'nxa_system', pub_mine: 'nxa_system_mine' } });
  await me.connect(REVIEWER, API_KEY, {});
  await me.enable(REVIEWER, 'pub_mine', { token: GOOD });
  assert.deepEqual(await me.credentialFor(REVIEWER, 'pub_mine'), { key: GOOD, rpcUrl: `${NEXUS}/a2a/pub_mine`, source: 'user' });
  assert.deepEqual(await me.credentialFor(CHECKER, 'pub_mine'), { key: 'nxa_system_mine', rpcUrl: `${NEXUS}/a2a/pub_mine`, source: 'system' });
  assert.equal(await me.credentialFor(CHECKER, 'pub_unknown'), null);
  await me.markInvalid(REVIEWER, 'pub_mine');
  assert.equal((await me.view(REVIEWER)).publications[0].enablement.status, 'key_invalid');
  assert.equal((await me.credentialFor(REVIEWER, 'pub_mine')).source, 'system');
});

test('REGISTRY_KEY 换了：解不开的启用显示为密钥失效，调用时不再给出，服务不崩（Review Focus 5）', async () => {
  const setupA = await setup();
  await setupA.me.connect(REVIEWER, API_KEY, {});
  await setupA.me.enable(REVIEWER, 'pub_mine', { token: GOOD });
  const setupB = await setup({ root: setupA.dir, registryKey: randomBytes(32), accounts: setupA.accounts });
  assert.equal((await setupB.me.view(REVIEWER)).publications[0].enablement.status, 'key_invalid');
  assert.equal(await setupB.me.credentialFor(REVIEWER, 'pub_mine'), null);
});

test('重启（新的服务实例、同一个目录）：连接时间和启用都还在，不用重新粘贴（Review Focus 2）', async () => {
  const first = await setup();
  await first.me.connect(REVIEWER, API_KEY, {});
  await first.me.enable(REVIEWER, 'pub_mine', { token: GOOD });
  const second = await setup({ root: first.dir, registryKey: first.registryKey, accounts: first.accounts });
  const view = await second.me.view(REVIEWER);
  assert.equal(view.connection.status, 'connected');
  assert.ok(view.connection.connectedAt);
  assert.equal(view.publications[0].enablement.status, 'active');
  assert.equal((await second.me.credentialFor(REVIEWER, 'pub_mine')).key, GOOD);
});

test('断开：调 CLI logout，清掉连接记录；已启用的 Agent 仍列出（listed=false）并可调用', async () => {
  const { me, accounts, store } = await setup();
  await me.connect(REVIEWER, API_KEY, {});
  await me.enable(REVIEWER, 'pub_mine', { token: GOOD });
  const view = await me.disconnect(REVIEWER, { client: 'web' });
  assert.ok(accounts['poc-reviewer'].calls.includes('logout'));
  assert.equal(view.connection.status, 'not_connected');
  assert.equal(view.connection.connectedAt, null);
  assert.deepEqual(view.publications.map(item => [item.publishId, item.listed, item.enablement.status]), [['pub_mine', false, 'active']]);
  assert.equal((await me.credentialFor(REVIEWER, 'pub_mine')).source, 'user');
  assert.deepEqual((await store.readAudit('poc-reviewer')).map(entry => entry.action), ['connect', 'enable', 'disconnect']);
});

test('用户之间隔离：A 启用的，B 看不到、用不了', async () => {
  const { me } = await setup();
  await me.connect(REVIEWER, API_KEY, {});
  await me.connect(CHECKER, API_KEY, {});
  await me.enable(REVIEWER, 'pub_mine', { token: GOOD });
  assert.equal((await me.view(CHECKER)).publications.find(item => item.publishId === 'pub_mine').enablement, null);
  assert.equal(await me.credentialFor(CHECKER, 'pub_mine'), null);
});

test('连接与启用合计每个账号每分钟 5 次；第 6 次 429；过了一分钟恢复', async () => {
  const { me, tick } = await setup();
  for (let index = 0; index < 5; index += 1) await me.connect(REVIEWER, API_KEY, {});
  await assert.rejects(me.enable(REVIEWER, 'pub_mine', { token: GOOD }), { code: 'POC_ME_RATE_LIMIT', status: 429 });
  tick(60_001);
  assert.equal((await me.enable(REVIEWER, 'pub_mine', { token: GOOD })).enablement.status, 'active');
});

test('发布版本变了：已启用的那一项标出 versionChanged', async () => {
  const account = nexusAccount();
  const { me } = await setup({ accounts: { 'poc-reviewer': account, 'poc-checker': nexusAccount() } });
  await me.connect(REVIEWER, API_KEY, {});
  await me.enable(REVIEWER, 'pub_mine', { token: GOOD });
  account.publications = [publication('pub_mine', { current_version: 2 })];
  assert.equal((await me.view(REVIEWER, 'force')).publications[0].enablement.versionChanged, true);
});

test('Nexus 暂时连不上：refresh 和启用都是 502 POC_NEXUS_UNREACHABLE（不是「没连接」）；出错的列表只缓存几秒，恢复后马上重读', async () => {
  const { me, accounts, tick } = await setup();
  await me.connect(REVIEWER, API_KEY, {});
  accounts['poc-reviewer'].down = true;
  tick(61_000);
  assert.equal((await me.view(REVIEWER)).connection.status, 'error');
  await assert.rejects(me.refresh(REVIEWER), { code: 'POC_NEXUS_UNREACHABLE', status: 502 });
  await assert.rejects(me.enable(REVIEWER, 'pub_mine', { token: GOOD }), { code: 'POC_NEXUS_UNREACHABLE', status: 502 });
  accounts['poc-reviewer'].down = false;
  tick(6_000);
  assert.equal((await me.view(REVIEWER)).connection.status, 'connected');
});

test('停用时正好有一次重新验证还没结束：停用不会被它撤销，那次重新验证返回 409 POC_AGENT_NOT_ENABLED', async () => {
  let hold = false, release;
  const { me, store, calls } = await setup({ manifest: async () => {
    if (hold) await new Promise(resolve => { release = resolve; });
    return { manifest: MANIFEST, version: MANIFEST.version, error: null };
  } });
  await me.connect(REVIEWER, API_KEY, {});
  await me.enable(REVIEWER, 'pub_mine', { token: GOOD });
  hold = true;
  const reverify = me.enable(REVIEWER, 'pub_mine', {});
  while (calls.manifest.length < 2) await new Promise(resolve => setImmediate(resolve));
  await me.disable(REVIEWER, 'pub_mine', {});
  release();
  await assert.rejects(reverify, { code: 'POC_AGENT_NOT_ENABLED', status: 409 });
  assert.equal(await store.get('poc-reviewer', 'pub_mine'), null);
  assert.equal((await me.view(REVIEWER)).publications[0].enablement, null);
  assert.deepEqual((await store.readAudit('poc-reviewer')).map(entry => entry.action), ['connect', 'enable', 'disable']);
});

test('systemCredential（审批流用）：先用发起人自己在页面上启用的，再用别的账号启用的（最近验证的那把），最后才用 secrets.env；失效的跳过', async () => {
  const { me, tick } = await setup({ accounts: { 'poc-reviewer': nexusAccount({ connected: true }), 'poc-checker': nexusAccount({ connected: true }) },
    verify: async () => 'valid', systemKeys: { pub_mine: 'nxa_system_fallback' } });
  await me.enable(REVIEWER, 'pub_mine', { token: GOOD, loadCapabilities: false });
  tick(1000);
  await me.enable(CHECKER, 'pub_mine', { token: OTHER, loadCapabilities: false });
  assert.deepEqual(await me.systemCredential('pub_mine', { preferAccountId: 'poc-reviewer' }), { key: GOOD, source: 'user', accountId: 'poc-reviewer' });
  assert.deepEqual(await me.systemCredential('pub_mine', { preferAccountId: 'poc-checker' }), { key: OTHER, source: 'user', accountId: 'poc-checker' });
  assert.equal((await me.systemCredential('pub_mine')).accountId, 'poc-checker');
  await me.markInvalid(CHECKER, 'pub_mine');
  assert.equal((await me.systemCredential('pub_mine', { preferAccountId: 'poc-checker' })).accountId, 'poc-reviewer');
  await me.disable(REVIEWER, 'pub_mine', {});
  assert.deepEqual(await me.systemCredential('pub_mine'), { key: 'nxa_system_fallback', source: 'system', accountId: null });
  assert.equal(await me.systemCredential('pub_paused'), null);
});
