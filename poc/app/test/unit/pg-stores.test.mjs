import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createKbCache } from '../../kb-cache.mjs';
import { createReviews } from '../../reviews.mjs';
import { readSettings, jiuanConfig } from '../../settings.mjs';

// 外壳自己的两张表（知识库缓存、复核记录）在九安的 PostgreSQL 库里：在真 PG 上写进去、读出来（要 PG_TEST_URL，库名以 _test 结尾；
// 连接池取九安副本里的适配层，和外壳运行时用的同一个）；外壳连库的缺省设置是测试台的 PG。
const PG_TEST_URL = process.env.PG_TEST_URL || null;
const skip = PG_TEST_URL ? false : '需要 PG_TEST_URL';
const here = path.dirname(fileURLToPath(import.meta.url));
const JIUAN = path.resolve(process.env.JIUAN_DIR || path.join(here, '../../../../.build/jiuan'));

/** A pool on the test database whose one after hook drops `table` and then closes the pool (hooks run in the order added). */
async function pool(t, table) {
  const { createPgPool, parsePgUrl } = await import(pathToFileURL(path.join(JIUAN, 'src/pg-database.mjs')).href);
  assert.ok(parsePgUrl(PG_TEST_URL).database.endsWith('_test'));
  const value = createPgPool({ url: PG_TEST_URL, connectionLimit: 4 });
  await value.query(`DROP TABLE IF EXISTS ${table}`);
  t.after(async () => { try { await value.query(`DROP TABLE IF EXISTS ${table}`); } finally { await value.end(); } });
  return value;
}

test('设置：外壳缺省连测试台的 PostgreSQL（127.0.0.1:5433 / jiuan / jiuan_app），九安配置写 postgres、口令文件 db_app_password', () => {
  const env = { POC_ORIGIN: 'https://jiuan-v0710.tinyboat.blog', NEXUS_ORIGIN: 'https://nxs-beine1013.tinyboat.blog', NEXUS_OPERATOR: '/opt/andon-finance/current/operator/scripts/nexus.py' };
  const settings = readSettings(env);
  assert.deepEqual(settings.database, { host: '127.0.0.1', port: 5433, database: 'jiuan', user: 'jiuan_app' });
  const moved = readSettings({ ...env, POC_DB_HOST: 'db.internal', POC_DB_PORT: '6432', POC_DB_NAME: 'jiuan_other', POC_DB_USER: 'other_app' });
  assert.deepEqual(moved.database, { host: 'db.internal', port: 6432, database: 'jiuan_other', user: 'other_app' });
  const config = jiuanConfig(settings, { tenantId: 't', connectionId: 'c', companies: [{ id: 'co-a' }] });
  assert.equal(config.database.engine, 'postgres');
  assert.equal(config.secretFiles.databasePassword, '/etc/andon-finance/jiuan/db_app_password');
});

test('知识库缓存在真 PG 上：同一项第二次写覆盖、读到的时间跟着变；删几项、按前缀删', { skip }, async t => {
  const db = await pool(t, 'poc_kb_cache');
  let clock = Date.parse('2026-11-06T01:02:03.456Z');
  const cache = createKbCache({ pool: db, scope: 'pg:pub_0123456789abcdef', now: () => clock });
  await cache.start();
  await cache.start();
  assert.equal(await cache.put('describe', { name: '第一次' }), '2026-11-06T01:02:03.456Z');
  clock += 61_000;
  await cache.put('describe', { name: '第二次', 中文: '制度' });
  assert.deepEqual(await cache.get('describe'), { body: { name: '第二次', 中文: '制度' }, fetchedAt: '2026-11-06T01:03:04.456Z' });
  for (const key of ['detail:a', 'detail:b', 'list']) await cache.put(key, { key });
  await cache.drop('list', 'missing');
  assert.equal(await cache.get('list'), null);
  await cache.dropPrefix('detail:');
  assert.deepEqual([await cache.get('detail:a'), await cache.get('detail:b')], [null, null]);
  assert.ok(await cache.get('describe'));
  const [[{ n }]] = await db.query('SELECT count(*) AS n FROM poc_kb_cache');
  assert.equal(n, 1);
});

test('复核记录在真 PG 上：编号由库给（RETURNING id），一条接一条往上长', { skip }, async t => {
  const db = await pool(t, 'poc_review_decisions');
  const reviews = createReviews({ pool: db, readCurrentAdvice: async () => null });
  await reviews.start();
  await reviews.start();
  const insert = async n => (await db.query('INSERT INTO poc_review_decisions (document_id, document_version, advice_round, ai_result, decision, final_result, reason, note, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
    [`d${n}`, 'v1', 1, 'pass', 'adopt', 'pass', null, null, 'poc-reviewer', '2026-11-06 01:02:03.456']))[0].insertId;
  const first = await insert(1), second = await insert(2);
  assert.equal(second, first + 1);
  const all = await reviews.all({ since: '2026-11-06T01:02:03.456Z' });
  assert.deepEqual(all.map(item => [item.id, item.documentId, item.createdAt]), [[first, 'd1', '2026-11-06T01:02:03.456Z'], [second, 'd2', '2026-11-06T01:02:03.456Z']]);
});
