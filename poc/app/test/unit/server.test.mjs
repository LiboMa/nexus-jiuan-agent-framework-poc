import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main } from '../../server.mjs';
import { readEnvConfig } from '../../config.mjs';
import { createClient } from './helpers/app.mjs';
import { answerEvents, rejectJson, startFakeA2a, writeEvents } from './helpers/fake-a2a.mjs';
import { waitUntil } from './helpers/wait.mjs';

const SECRETS = `REVIEWER_PASSWORD=reviewer-pass-123\nCHECKER_PASSWORD=checker-pass-123\nNEXUS_A2A_KEY_pub_5c53e70d8dc7ddea=nxa_test\nREGISTRY_KEY=${randomBytes(32).toString('base64')}\n`;

async function environment(secrets) {
  const publicDir = await mkdtemp(path.join(tmpdir(), 'poc-public-'));
  await writeFile(path.join(publicDir, 'analysis.html'), '<!doctype html><title>PoC stub</title>');
  const usersDir = await mkdtemp(path.join(tmpdir(), 'poc-users-'));
  const secretsFile = path.join(await mkdtemp(path.join(tmpdir(), 'poc-secrets-')), 'secrets.env');
  if (secrets !== null) await writeFile(secretsFile, secrets);
  return { POC_ORIGIN: 'http://poc.test', POC_PORT: '0', POC_BIND: '127.0.0.1', POC_PUBLIC_DIR: publicDir, AWS_REGION: 'us-east-1', POC_SECRETS_FILE: secretsFile,
    POC_USERS_DIR: usersDir, NEXUS_ORIGIN: 'https://nexus.example', NEXUS_ADVISORY_PUBLICATION: 'pub_5c53e70d8dc7ddea', NEXUS_OPERATOR: '/nonexistent/nexus.py' };
}
const silent = { info() {}, error() {} };

test('入口从密钥配置文件读口令、REGISTRY_KEY 与系统提供的调用密钥起服务；operator 不可用时「我的 Nexus」报连接出错，单据照常可用；日志里没有口令', async t => {
  const logs = [];
  const { app, stop } = await main({ env: await environment(SECRETS), log: { info: message => logs.push(message), error: message => logs.push(message) },
    fetchCard: async () => ({ name: '九安审核AI（PoC）', protocolVersion: '0.3' }) });
  t.after(() => stop());
  const http = createClient(app.server.address().port);
  assert.equal((await http.http('/poc/healthz', { headers: { Host: 'ip-10-0-0-1' } })).status, 200);
  assert.equal((await http.login('poc-reviewer', 'reviewer-pass-123')).status, 200);
  const me = (await http.api('/poc/nexus/me')).body.data;
  assert.equal(me.connection.status, 'error');   // operator 脚本不存在：CLI 起不来
  assert.deepEqual(me.system.map(item => [item.publishId, item.purpose]), [['pub_5c53e70d8dc7ddea', 'advisory']]);
  assert.equal((await http.api('/documents?limit=50')).body.data.total, 8);
  assert.ok(logs.some(message => /listening/.test(message)));
  assert.equal(logs.join('\n').includes('reviewer-pass-123'), false);
});

test('没有密钥配置文件、缺口令或缺 REGISTRY_KEY 时拒绝启动，并说明怎么办', async () => {
  await assert.rejects(main({ env: await environment(null), log: silent }), /secrets\.env/);
  await assert.rejects(main({ env: await environment('REVIEWER_PASSWORD=reviewer-pass-123\n'), log: silent }), /CHECKER_PASSWORD/);
  await assert.rejects(main({ env: await environment('REVIEWER_PASSWORD=reviewer-pass-123\nCHECKER_PASSWORD=checker-pass-123\n'), log: silent }), /REGISTRY_KEY/);
});

test('readEnvConfig 校验站点地址、发布编号与必填项；密钥文件与账号目录有缺省值', async () => {
  const env = await environment('');
  assert.equal(readEnvConfig(env).nexus.origin, 'https://nexus.example');
  assert.equal(readEnvConfig({ ...env, POC_SECRETS_FILE: '' }).secretsFile, '/etc/andon-finance/secrets.env');
  assert.equal(readEnvConfig({ ...env, POC_USERS_DIR: '' }).usersDir, '/var/lib/andon-finance/users');
  assert.throws(() => readEnvConfig({ ...env, POC_ORIGIN: 'https://andon-finance.tinyboat.blog/' }), /POC_ORIGIN/);
  assert.throws(() => readEnvConfig({ ...env, NEXUS_ADVISORY_PUBLICATION: 'agent_x' }), /NEXUS_ADVISORY_PUBLICATION/);
  assert.throws(() => readEnvConfig({ ...env, NEXUS_OPERATOR: '' }), /NEXUS_OPERATOR/);
});

test('入口接上示例附件库与 A2A 名片：系统提供的发布带名片，附件规则单独下发，示例附件可以取', async t => {
  const cards = [];
  const { app, stop } = await main({ env: await environment(SECRETS), log: silent,
    fetchCard: async url => { cards.push(url); return { name: '九安审核AI（PoC）', protocolVersion: '0.3', defaultInputModes: ['text/plain', 'application/pdf'] }; } });
  t.after(() => stop());
  const http = createClient(app.server.address().port);
  await http.login('poc-reviewer', 'reviewer-pass-123');
  const me = (await http.api('/poc/nexus/me')).body.data;
  assert.ok(cards.includes('https://nexus.example/a2a/pub_5c53e70d8dc7ddea/.well-known/agent-card.json'));
  assert.equal(me.system[0].card.protocolVersion, '0.3');
  assert.equal(me.system[0].displayName, '九安审核AI（PoC）');
  assert.equal((await http.api('/poc/nexus/attachment-policy')).body.data.attachmentPolicy.maxFiles, 5);
  const samples = (await http.api('/poc/nexus/samples')).body.data.items;
  assert.equal(samples.length, 6);
  const pdf = (await http.api('/poc/nexus/samples/hotel-invoice-pdf')).body.data;
  assert.equal(Buffer.from(pdf.data, 'base64').subarray(0, 5).toString('latin1'), '%PDF-');
});

test('审批流的调用密钥从系统里读：secrets.env 里那把 Nexus 不认，审核员在 Agent 页启用了审批 Agent，发起审批照样拿到建议，用的是页面上那把', async t => {
  const PAGE_KEY = 'nxa_' + 'p'.repeat(43);
  const advice = { recommendation: 'MANUAL_REVIEW', riskLevel: 'low', confidence: 'medium', summary: '需要人工核对附件（虚构）', keyFindings: [],
    requiredActions: ['补充酒店发票'], unresolvedQuestions: [], conflictFlags: [], rejectionDraft: null };
  const used = [];
  const fake = await startFakeA2a(({ req, res }) => {
    if (req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ name: '九安审核AI（PoC）', protocolVersion: '0.3', capabilities: { streaming: true } })); return; }
    const pageKey = req.headers.authorization === `Bearer ${PAGE_KEY}`;
    used.push(pageKey ? 'page' : 'other');
    if (!pageKey) { rejectJson(res, 401, 'credential_revoked'); return; }
    writeEvents(res, answerEvents(JSON.stringify(advice)));
  });
  t.after(() => fake.close());
  const publication = { publish_id: 'pub_5c53e70d8dc7ddea', display_name: '九安审核AI（PoC）', status: 'active', current_version: 1,
    channels: [{ channel: 'a2a', enabled: true, ready: true, rpc_url: `${fake.origin}/a2a/pub_5c53e70d8dc7ddea` }] };
  const cli = {
    async whoami() { return { exitCode: 0, json: { user: { user_id: 'u-1', name: 'admin', role: 'editor' }, connection: { preset: 'read_only' } } }; },
    async login() { return { exitCode: 0, json: null }; },
    async logout() { return { exitCode: 0, json: null }; },
    async get(pathname) { return { exitCode: 0, json: pathname === '/api/v2/publications' ? { data: { items: [publication] } } : { data: [] } }; },
  };
  const { app, stop } = await main({ env: { ...(await environment(SECRETS)), NEXUS_ORIGIN: fake.origin }, log: silent, cliFor: async () => cli,
    verifyKey: async ({ key }) => (key === PAGE_KEY ? 'valid' : 'invalid'), describe: async () => ({ manifest: null, version: null, error: null }) });
  t.after(() => stop());
  const http = createClient(app.server.address().port);
  await http.login('poc-reviewer', 'reviewer-pass-123');
  assert.equal((await http.api('/poc/nexus/me/agents/pub_5c53e70d8dc7ddea/enable', { method: 'POST', body: { token: PAGE_KEY, loadCapabilities: false } })).status, 200);
  const document = (await http.api('/documents?limit=50')).body.data.items.find(item => item.number === 'FYBX-POC-001');
  used.length = 0;
  assert.equal((await http.api(`/poc/approvals/${document.id}/start`, { method: 'POST', body: { sourceVersion: document.version } })).status, 200);
  const settled = await waitUntil(async () => {
    const view = (await http.api(`/poc/approvals/${document.id}`)).body.data;
    return ['pending_review', 'ai_failed'].includes(view.status) && view;
  }, { timeoutMs: 20_000, intervalMs: 100 });
  assert.equal(settled.status, 'pending_review', JSON.stringify(settled.failure));
  assert.deepEqual([...new Set(used)], ['page']);
});

test('readEnvConfig 读测试台设置：默认内存存储；POC_STORE=mysql 时给出连接参数和密钥文件；取值不对就报 POC_CONFIG_INVALID', async () => {
  const base = await environment(SECRETS);
  assert.deepEqual(readEnvConfig(base).store, { kind: 'memory' });
  const mysql = readEnvConfig({ ...base, POC_STORE: 'mysql', BENCH_SECRETS_DIR: '/etc/x/bench' }).store;
  assert.deepEqual(mysql, { kind: 'mysql', database: { host: '127.0.0.1', port: 3306, database: 'jiuan_analysis', user: 'jiuan_app' },
    passwordFile: '/etc/x/bench/mysql_app_password', dataKeyFile: '/etc/x/bench/analysis_data_key' });
  const custom = readEnvConfig({ ...base, POC_STORE: 'mysql', BENCH_MYSQL_HOST: 'db.local', BENCH_MYSQL_PORT: '3307', BENCH_MYSQL_DATABASE: 'jiuan_bench_test', BENCH_MYSQL_USER: 'root' }).store;
  assert.deepEqual(custom.database, { host: 'db.local', port: 3307, database: 'jiuan_bench_test', user: 'root' });
  for (const bad of [{ POC_STORE: 'redis' }, { POC_STORE: 'mysql', BENCH_MYSQL_PORT: 'abc' }, { POC_STORE: 'mysql', BENCH_SECRETS_DIR: 'relative/dir' }]) {
    assert.throws(() => readEnvConfig({ ...base, ...bad }), error => error.code === 'POC_CONFIG_INVALID', JSON.stringify(bad));
  }
});

test('mysql 模式下先等库：库连不上时健康检查回 503 starting、进程不退出；库好了以后正常起来', async t => {
  const env = await environment(SECRETS);
  const secretsDir = await mkdtemp(path.join(tmpdir(), 'poc-bench-secrets-'));
  await writeFile(path.join(secretsDir, 'mysql_app_password'), 'app-pass');
  await writeFile(path.join(secretsDir, 'analysis_data_key'), randomBytes(32).toString('base64'));
  const { createMemoryStore } = await import('../../memory-store.mjs');
  const { COMPANIES, buildSeedDocuments } = await import('../../seed.mjs');
  const fakeStore = Object.assign(createMemoryStore({ documents: buildSeedDocuments(), companies: COMPANIES }), {
    async createBatch() { return { id: 'batch-1' }; }, async upsertPage() {}, async updateBatch() {},
  });
  let attempts = 0;
  const openStore = async ({ password, dataKey }) => {
    attempts += 1;
    assert.equal(password, 'app-pass');
    assert.match(dataKey, /^[A-Za-z0-9+/]{43}=$/);
    if (attempts < 3) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    return { store: fakeStore, pool: {}, health: async () => true, async close() {} };
  };
  const createPlatform = () => ({ platformRoutes: { async handle() { return false; } }, async close() {} });
  const started = main({ env: { ...env, POC_STORE: 'mysql', BENCH_SECRETS_DIR: secretsDir }, log: silent, openStore, createPlatform, dbRetryMs: 100,
    fetchCard: async () => ({ name: 'x', protocolVersion: '0.3' }) });
  const early = await waitUntil(async () => (attempts >= 1 ? attempts : null));
  assert.ok(early >= 1);
  const { server, stop } = await started.then(result => result, error => { throw error; });
  t.after(() => stop());
  assert.equal(attempts, 3);
  const http = createClient(server.address().port);
  assert.equal((await http.http('/poc/healthz', { headers: { Host: 'ip-10-0-0-1' } })).status, 200);
  assert.equal((await http.login('poc-reviewer', 'reviewer-pass-123')).status, 200);
  assert.equal((await http.api('/documents?limit=50')).body.data.total, 8);
});

test('mysql 模式起来以后，/api/health 真的去查库：库断了就回 503、database 是 unavailable', async t => {
  const env = await environment(SECRETS);
  const secretsDir = await mkdtemp(path.join(tmpdir(), 'poc-bench-secrets-'));
  await writeFile(path.join(secretsDir, 'mysql_app_password'), 'app-pass');
  await writeFile(path.join(secretsDir, 'analysis_data_key'), randomBytes(32).toString('base64'));
  const { createMemoryStore } = await import('../../memory-store.mjs');
  const { COMPANIES, buildSeedDocuments } = await import('../../seed.mjs');
  const fakeStore = Object.assign(createMemoryStore({ documents: buildSeedDocuments(), companies: COMPANIES }), {
    async createBatch() { return { id: 'batch-1' }; }, async upsertPage() {}, async updateBatch() {},
  });
  let dbUp = true;
  const health = async () => { if (!dbUp) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); return true; };
  const { server, stop } = await main({ env: { ...env, POC_STORE: 'mysql', BENCH_SECRETS_DIR: secretsDir }, log: silent,
    openStore: async () => ({ store: fakeStore, pool: {}, health, async close() {} }),
    createPlatform: () => ({ platformRoutes: { async handle() { return false; } }, async close() {} }),
    fetchCard: async () => ({ name: 'x', protocolVersion: '0.3' }) });
  t.after(() => stop());
  const http = createClient(server.address().port);
  const up = await http.http('/api/health');
  assert.equal(up.status, 200);
  assert.equal(up.body.database, 'ok');
  dbUp = false;
  const down = await http.http('/api/health');
  assert.equal(down.status, 503);
  assert.equal(down.body.database, 'unavailable');
});

test('mysql 模式等库期间就在监听：健康检查回 503 starting', async t => {
  const env = await environment(SECRETS);
  const secretsDir = await mkdtemp(path.join(tmpdir(), 'poc-bench-secrets-'));
  await writeFile(path.join(secretsDir, 'mysql_app_password'), 'app-pass');
  await writeFile(path.join(secretsDir, 'analysis_data_key'), randomBytes(32).toString('base64'));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const listening = [];
  const openStore = async () => { await gate; throw Object.assign(new Error('stop'), { code: 'TEST_STOP' }); };
  const started = main({ env: { ...env, POC_STORE: 'mysql', BENCH_SECRETS_DIR: secretsDir }, log: { info: message => listening.push(message), error() {} },
    openStore, createPlatform: () => ({ platformRoutes: { async handle() { return false; } }, async close() {} }), dbRetryMs: 50, maxDbAttempts: 1 });
  const port = await waitUntil(async () => listening.map(message => message.match(/starting on [^:]+:(\d+)/)?.[1]).find(Boolean) ?? null);
  const http = createClient(Number(port));
  const health = await http.http('/poc/healthz', { headers: { Host: 'ip-10-0-0-1' } });
  assert.equal(health.status, 503);
  assert.equal(health.text, 'starting');
  release();
  await assert.rejects(started, /stop/);
});
