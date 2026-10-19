import test from 'node:test';
import assert from 'node:assert/strict';
import { createKeyStore } from '../../nexus/keys.mjs';

test('调用密钥可以刷新；刷新失败时保留原来的密钥；状态里没有密钥本身', async () => {
  let next = new Map([['pub_a', 'k1']]);
  const store = createKeyStore({ load: async () => { if (next instanceof Error) throw next; return next; } });
  await store.reload();
  assert.equal(store.get('pub_a'), 'k1');
  next = new Error('ssm down');
  assert.equal((await store.reload()).error, 'POC_KEYS_UNAVAILABLE');
  assert.equal(store.get('pub_a'), 'k1');
  next = new Map([['pub_b', 'k2']]);
  await store.reload();
  assert.equal(store.has('pub_a'), false);
  assert.equal(store.get('pub_b'), 'k2');
  assert.equal(store.get('pub_none'), null);
  assert.deepEqual(Object.keys(store.status()).sort(), ['count', 'error', 'loadedAt']);
});

test('ids() 列出已配置调用密钥的发布编号', async () => {
  const store = createKeyStore({ load: async () => new Map([['pub_a', 'k1'], ['pub_b', 'k2']]) });
  await store.reload();
  assert.deepEqual(store.ids(), ['pub_a', 'pub_b']);
});
