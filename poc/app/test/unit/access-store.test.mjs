import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createUserStore } from '../../access/store.mjs';

const root = () => mkdtemp(path.join(tmpdir(), 'poc-users-'));
const item = (publishId, extra = {}) => ({ publishId, displayName: publishId, credential: { cipher: 'v1.a.b.c', fingerprint: '00000000', verifiedAt: 't' },
  status: 'active', enabledAt: 't', updatedAt: 't', ...extra });
const mode = async file => (await stat(file)).mode & 0o777;

test('目录 0700、文件 0600；put 按发布编号替换；get / list / remove', async () => {
  const dir = await root();
  const store = createUserStore({ root: dir });
  assert.deepEqual(await store.list('poc-reviewer'), []);
  await store.put('poc-reviewer', item('pub_aaaa'));
  await store.put('poc-reviewer', item('pub_bbbb'));
  await store.put('poc-reviewer', item('pub_aaaa', { displayName: '新名字' }));
  assert.deepEqual((await store.list('poc-reviewer')).map(entry => [entry.publishId, entry.displayName]), [['pub_bbbb', 'pub_bbbb'], ['pub_aaaa', '新名字']]);
  assert.equal((await store.get('poc-reviewer', 'pub_aaaa')).displayName, '新名字');
  assert.equal(await store.get('poc-reviewer', 'pub_none'), null);
  assert.equal(await mode(path.join(dir, 'poc-reviewer')), 0o700);
  assert.equal(await mode(path.join(dir, 'poc-reviewer', 'enabled.json')), 0o600);
  assert.equal(await store.remove('poc-reviewer', 'pub_aaaa'), true);
  assert.equal(await store.remove('poc-reviewer', 'pub_aaaa'), false);
  assert.deepEqual((await store.list('poc-reviewer')).map(entry => entry.publishId), ['pub_bbbb']);
});

test('同一账号同时写很多次：排队执行，文件始终是合法 JSON，同一个发布只有一项（Review Focus 1）', async () => {
  const dir = await root();
  const store = createUserStore({ root: dir });
  await Promise.all([
    ...Array.from({ length: 10 }, (_, index) => store.put('poc-reviewer', item(`pub_${String(index).padStart(4, '0')}`))),
    ...Array.from({ length: 5 }, (_, index) => store.put('poc-reviewer', item('pub_same', { updatedAt: String(index) }))),
  ]);
  const data = JSON.parse(await readFile(path.join(dir, 'poc-reviewer', 'enabled.json'), 'utf8'));
  assert.equal(data.items.length, 11);
  assert.equal(data.items.filter(entry => entry.publishId === 'pub_same').length, 1);
});

test('update 只改给的字段；不存在时返回 null', async () => {
  const store = createUserStore({ root: await root() });
  await store.put('poc-reviewer', item('pub_aaaa'));
  assert.equal((await store.update('poc-reviewer', 'pub_aaaa', { status: 'key_invalid' })).status, 'key_invalid');
  assert.equal((await store.get('poc-reviewer', 'pub_aaaa')).credential.fingerprint, '00000000');
  assert.equal(await store.update('poc-reviewer', 'pub_none', { status: 'x' }), null);
});

test('nexusHomeFor 建好 0700 的 nexus 目录；连接记录可存、可读、可清；留痕只追加', async () => {
  const dir = await root();
  const store = createUserStore({ root: dir, now: () => '2026-10-17T00:00:00.000Z' });
  const home = await store.nexusHomeFor('poc-checker');
  assert.equal(home, path.join(dir, 'poc-checker', 'nexus'));
  assert.equal(await mode(home), 0o700);
  assert.equal(await store.readConnection('poc-checker'), null);
  await store.saveConnection('poc-checker', { connectedAt: 'x', nexusUser: { name: 'admin' } });
  assert.equal((await store.readConnection('poc-checker')).nexusUser.name, 'admin');
  await store.clearConnection('poc-checker');
  assert.equal(await store.readConnection('poc-checker'), null);
  await store.audit('poc-checker', { action: 'connect' });
  await store.audit('poc-checker', { action: 'disconnect' });
  assert.deepEqual(await store.readAudit('poc-checker'), [{ at: '2026-10-17T00:00:00.000Z', action: 'connect' }, { at: '2026-10-17T00:00:00.000Z', action: 'disconnect' }]);
  assert.equal(await mode(path.join(dir, 'poc-checker', 'audit.jsonl')), 0o600);
});

test('账号名不合规（含路径）一律拒绝；enabled.json 损坏时报 POC_STORE_CORRUPT', async () => {
  const dir = await root();
  const store = createUserStore({ root: dir });
  for (const bad of ['../etc', 'A', '', 'a/b', null]) await assert.rejects(store.list(bad), { code: 'POC_ACCOUNT_INVALID' });
  await store.nexusHomeFor('poc-reviewer');
  await writeFile(path.join(dir, 'poc-reviewer', 'enabled.json'), '{bad');
  await assert.rejects(store.list('poc-reviewer'), { code: 'POC_STORE_CORRUPT' });
});

test('putIf：在写入队列里看当前那一项，条件不满足就不写、返回 null', async () => {
  const store = createUserStore({ root: await root() });
  await store.put('poc-reviewer', item('pub_aaaa'));
  const same = current => current?.credential.fingerprint === '00000000';
  assert.equal((await store.putIf('poc-reviewer', item('pub_aaaa', { status: 'x' }), same)).status, 'x');
  await store.remove('poc-reviewer', 'pub_aaaa');
  assert.equal(await store.putIf('poc-reviewer', item('pub_aaaa'), same), null);
  assert.equal(await store.get('poc-reviewer', 'pub_aaaa'), null);
});

test('accounts：列出有目录的账号（按名字排序），不合规的名字和文件都不算；根目录还不存在时是空的', async () => {
  const dir = await root();
  const store = createUserStore({ root: dir });
  await store.nexusHomeFor('poc-reviewer');
  await store.nexusHomeFor('poc-checker');
  await mkdir(path.join(dir, 'Bad Name'));
  await writeFile(path.join(dir, 'stray.txt'), 'x');
  assert.deepEqual(await store.accounts(), ['poc-checker', 'poc-reviewer']);
  assert.deepEqual(await createUserStore({ root: path.join(dir, 'missing') }).accounts(), []);
});
