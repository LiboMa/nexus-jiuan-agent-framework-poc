/**
 * 组合根的 mysql 模式：真的连 MySQL、真的组装九安的平台部分。要 MySQL：在测试台上用 poc/infra/bench-test.sh 跑。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SKIP_WITHOUT_MYSQL, benchDatabaseFromUrl, mysqlTestUrl, resetTestDatabase } from './helpers/mysql.mjs';
import { createClient } from './helpers/app.mjs';
import { main } from '../../server.mjs';

const SECRETS = `REVIEWER_PASSWORD=reviewer-pass-123\nCHECKER_PASSWORD=checker-pass-123\nNEXUS_A2A_KEY_pub_5c53e70d8dc7ddea=nxa_test\nREGISTRY_KEY=${randomBytes(32).toString('base64')}\n`;
const DATA_KEY = randomBytes(32).toString('base64');
const silent = { info() {}, error() {} };

async function environment() {
  const dir = await mkdtemp(path.join(tmpdir(), 'poc-bench-'));
  const publicDir = path.join(dir, 'public');
  await import('node:fs/promises').then(fs => fs.mkdir(publicDir));
  await writeFile(path.join(publicDir, 'analysis.html'), '<!doctype html><title>PoC stub</title>');
  await writeFile(path.join(dir, 'secrets.env'), SECRETS);
  const { database, password } = benchDatabaseFromUrl();
  await writeFile(path.join(dir, 'mysql_app_password'), password);
  await writeFile(path.join(dir, 'analysis_data_key'), DATA_KEY);
  return { POC_ORIGIN: 'http://poc.test', POC_PORT: '0', POC_BIND: '127.0.0.1', POC_PUBLIC_DIR: publicDir, AWS_REGION: 'us-east-1',
    POC_SECRETS_FILE: path.join(dir, 'secrets.env'), POC_USERS_DIR: path.join(dir, 'users'), NEXUS_ORIGIN: 'https://nexus.example',
    NEXUS_ADVISORY_PUBLICATION: 'pub_5c53e70d8dc7ddea', NEXUS_OPERATOR: '/nonexistent/nexus.py',
    POC_STORE: 'mysql', BENCH_MYSQL_HOST: database.host, BENCH_MYSQL_PORT: String(database.port), BENCH_MYSQL_DATABASE: database.database,
    BENCH_MYSQL_USER: database.user, BENCH_SECRETS_DIR: dir };
}
const boot = env => main({ env, log: silent, fetchCard: async () => ({ name: 'x', protocolVersion: '0.3' }) });
async function signIn(server, account) {
  const http = createClient(server.address().port);
  assert.equal((await http.login(account, `${account === 'poc-reviewer' ? 'reviewer' : 'checker'}-pass-123`)).status, 200);
  return http;
}

test('mysql 模式起服务：8 张种子单据、九安平台接口能读、我的 Nexus 照常', { skip: SKIP_WITHOUT_MYSQL }, async t => {
  await resetTestDatabase();
  const { server, stop } = await boot(await environment());
  t.after(() => stop());
  const reviewer = await signIn(server, 'poc-reviewer');
  assert.equal((await reviewer.api('/documents?limit=50')).body.data.total, 8);
  assert.equal((await reviewer.http('/api/health')).body.source, 'poc-bench');
  assert.equal((await reviewer.api('/platform/agents')).status, 200);
  assert.equal((await reviewer.api('/poc/nexus/me')).status, 200);
  const checker = await signIn(server, 'poc-checker');
  assert.equal((await checker.api('/platform/agents')).status, 200);
  assert.equal((await checker.api('/platform/agents/hly.list-sync/settings', { method: 'PUT', body: { expectedRevision: 0, settings: {} } })).status, 403);
});

test('重启（不是重置）之后来单编号接着往下排，单据都还在', { skip: SKIP_WITHOUT_MYSQL }, async () => {
  await resetTestDatabase();
  const env = await environment();
  let running = await boot(env);
  let reviewer = await signIn(running.server, 'poc-reviewer');
  const first = await reviewer.api('/poc/intake', { method: 'POST', body: { template: 'FYBX-POC-001' } });
  assert.equal(first.status, 201);
  assert.equal(first.body.data.document.number, 'FYBX-SIM-001');
  await running.stop();
  running = await boot(env);
  try {
    reviewer = await signIn(running.server, 'poc-reviewer');
    const second = await reviewer.api('/poc/intake', { method: 'POST', body: { template: 'FYBX-POC-001' } });
    assert.equal(second.status, 201);
    assert.equal(second.body.data.document.number, 'FYBX-SIM-002');
    assert.equal((await reviewer.api('/documents?limit=50')).body.data.total, 10);
  } finally { await running.stop(); }
});

test('重启之后还能读模拟来单的原件（原文从库里取）', { skip: SKIP_WITHOUT_MYSQL }, async () => {
  await resetTestDatabase();
  const env = await environment();
  let running = await boot(env);
  let reviewer = await signIn(running.server, 'poc-reviewer');
  const created = await reviewer.api('/poc/intake', { method: 'POST', body: { template: 'DGZF-POC-001' } });
  assert.equal(created.status, 201);
  const { number } = created.body.data.document;
  await running.stop();
  running = await boot(env);
  try {
    reviewer = await signIn(running.server, 'poc-reviewer');
    const item = (await reviewer.api(`/documents?q=${encodeURIComponent(number)}&limit=5`)).body.data.items.find(entry => entry.number === number);
    assert.ok(item, number);
    assert.equal((await reviewer.api(`/documents/${item.id}/evidence`)).body.data.status, 'completed');
  } finally { await running.stop(); }
});
