/**
 * 测试台的平台部分：九安的平台存储、连接器、调用中间件、运行器、调度、平台接口。要 MySQL：在测试台上用 poc/infra/bench-test.sh 跑。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_WITHOUT_MYSQL, benchDatabaseFromUrl, mysqlTestUrl, resetTestDatabase } from './helpers/mysql.mjs';
import { TEST_ORIGIN, createClient } from './helpers/app.mjs';
import { createAnalysisApp, createAnalysisAuth } from '../../jiuan.mjs';
import { COMPANIES, TENANT_ID } from '../../seed.mjs';

const live = mysqlTestUrl();
const store = live ? await import('../../bench/store.mjs') : null;
const platform = live ? await import('../../bench/platform.mjs') : null;
const KEY = Buffer.alloc(32, 7).toString('base64');
const companyIds = COMPANIES.map(company => company.id);
const accounts = [
  { id: 'poc-reviewer', name: '审核员', enabled: true, role: 'admin', mode: 'local_owner', companyIds },
  { id: 'poc-checker', name: '复核人', enabled: true, role: 'analyst', mode: 'local_owner', companyIds },
];
const config = Object.freeze({
  deployment: 'ecs-docker', environment: 'prod', instance: 'test', mode: 'read_only_analysis', accounts, connectionId: 'poc-bench-test',
  scope: { tenantId: TENANT_ID, companyId: companyIds[0], allCompaniesInTenant: true }, automaticSync: false, syncIntervalMs: 0, schedulerChain: false,
  source: { kind: 'huilianyi-stage-oauth', appIdFile: '/nonexistent/hly_stage_app_id', appSecretFile: '/nonexistent/hly_stage_app_secret' },
});

async function start(t) {
  await resetTestDatabase();
  const { database, password } = benchDatabaseFromUrl();
  const handle = await store.openBenchStore({ database, password, dataKey: KEY, connectionId: config.connectionId });
  const bench = platform.createBenchPlatform({ pool: handle.pool, store: handle.store, config, key: Buffer.from(KEY, 'base64') });
  const auth = createAnalysisAuth({ getAccounts: () => accounts });
  const app = createAnalysisApp({ store: handle.store, auth: { ...auth, exchange: ticket => auth.exchange(ticket, { loopback: true }) },
    platformRoutes: bench.platformRoutes, origin: TEST_ORIGIN, instance: 'test', source: 'poc-bench', loginAttemptLimit: 600, healthCheck: async () => true });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); await bench.close(); await handle.close(); });
  const as = async accountId => {
    const client = createClient(app.server.address().port);
    const exchanged = await client.http('/api/analysis/v1/auth/exchange', { method: 'POST', body: { ticket: auth.issueLocalTicket(accountId) } });
    assert.equal(exchanged.status, 200);
    return client;
  };
  return { bench, as };
}

test('九安的平台接口挂上了：审核员（admin）和复核人（analyst）都能读 Agent 中心，复核人改不了设置', { skip: SKIP_WITHOUT_MYSQL }, async t => {
  const { as } = await start(t);
  const reviewer = await as('poc-reviewer');
  const listed = await reviewer.api('/platform/agents');
  assert.equal(listed.status, 200);
  assert.match(JSON.stringify(listed.body), /hly\.list-sync/);
  const checker = await as('poc-checker');
  assert.equal((await checker.api('/platform/agents')).status, 200);
  const changed = await checker.api('/platform/agents/hly.list-sync/settings', { method: 'PUT', body: { expectedRevision: 0, settings: {} } });
  assert.equal(changed.status, 403);
});

test('汇联易一直没绑定，探测它也不发出任何网络请求', { skip: SKIP_WITHOUT_MYSQL }, async t => {
  const { bench, as } = await start(t);
  assert.equal(bench.connectors.secretPresence('hly'), 'unbound');
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('不应该发出网络请求'); };
  t.after(() => { globalThis.fetch = original; });
  const reviewer = await as('poc-reviewer');
  const probed = await reviewer.api('/platform/connectors/hly/probe', { method: 'POST', body: { reason: '测试台检查' } });
  assert.notEqual(probed.status, 500);
  assert.equal(calls, 0);
});

test('关掉之后调度不在运行', { skip: SKIP_WITHOUT_MYSQL }, async t => {
  const { bench } = await start(t);
  await bench.close();
  assert.equal(bench.scheduler.status().active, false);
});
