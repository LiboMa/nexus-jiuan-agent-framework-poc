import test from 'node:test';
import assert from 'node:assert/strict';
import { createKbCache } from '../../kb-cache.mjs';
import { fakeKbCachePool } from './helpers/fake-kb-cache-pool.mjs';

// 知识库页的缓存（九安 jiuan 库里的 poc_kb_cache）：按 scope（方式 + 发布编号）分开存 Agent 的回复和读到的时间。
const AT = Date.parse('2026-11-03T01:02:03.456Z');

test('start 建表；put 存 JSON 和读到的时间（UTC 的 DATETIME(3)），get 原样拿回；没有的回 null', async () => {
  const pool = fakeKbCachePool();
  const cache = createKbCache({ pool, scope: 'pg:pub_0123456789abcdef', now: () => AT });
  await cache.start();
  assert.match(pool.sql[0], /CREATE TABLE IF NOT EXISTS poc_kb_cache \(/);
  assert.match(pool.sql[0], /PRIMARY KEY \(scope, cache_key\)/);
  assert.equal(await cache.get('list'), null);
  const body = { success: true, sources: [{ source_id: 'risk-cards', rules_total: 449, title: '审批风险判断卡' }] };
  assert.equal(await cache.put('list', body), '2026-11-03T01:02:03.456Z');
  assert.equal(pool.table()[0].fetched_at, '2026-11-03 01:02:03.456');
  assert.deepEqual(await cache.get('list'), { body, fetchedAt: '2026-11-03T01:02:03.456Z' });
});

test('scope 分开：换了发布编号或方式就看不到别的 Agent 存的东西', async () => {
  const pool = fakeKbCachePool();
  await createKbCache({ pool, scope: 'pg:pub_0123456789abcdef', now: () => AT }).put('list', { success: true, sources: [] });
  assert.equal(await createKbCache({ pool, scope: 'pg:pub_fedcba9876543210', now: () => AT }).get('list'), null);
  assert.equal(await createKbCache({ pool, scope: 's3vectors:pub_0123456789abcdef', now: () => AT }).get('list'), null);
});

test('drop 删指定的几项，dropPrefix 删一类（例如全部详情）；只动自己的 scope', async () => {
  const pool = fakeKbCachePool();
  const mine = createKbCache({ pool, scope: 'pg:a', now: () => AT }), other = createKbCache({ pool, scope: 'pg:b', now: () => AT });
  for (const key of ['describe', 'list', 'detail:risk-cards', 'detail:finance-approval-v4']) await mine.put(key, { success: true });
  await other.put('detail:risk-cards', { success: true });
  await mine.drop('list', 'detail:risk-cards');
  assert.deepEqual(pool.table().filter(row => row.scope === 'pg:a').map(row => row.cache_key).sort(), ['describe', 'detail:finance-approval-v4']);
  await mine.dropPrefix('detail:');
  assert.deepEqual(pool.table().map(row => `${row.scope} ${row.cache_key}`).sort(), ['pg:a describe', 'pg:b detail:risk-cards']);
});

test('库里存的不是合法 JSON 当没有（回 null）', async () => {
  const pool = fakeKbCachePool();
  const cache = createKbCache({ pool, scope: 'pg:a', now: () => AT });
  await cache.put('list', { success: true });
  pool.table()[0].body = '{broken';
  assert.equal(await cache.get('list'), null);
});
