import test from 'node:test';
import assert from 'node:assert/strict';
import { loadManifest, verifyCallKey } from '../../access/verify.mjs';
import { answerEvents, startFakeA2a, writeEvents } from './helpers/fake-a2a.mjs';

const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

test('verifyCallKey：发的是 tasks/get（不是 message/stream），带 Bearer；200 有效，401 / 404 无效（2026-10-17 实测的三种返回）', async t => {
  const replies = [
    res => json(res, 200, { jsonrpc: '2.0', id: 'x', error: { code: -32603, message: 'Task not found', data: null } }),
    res => json(res, 401, { jsonrpc: '2.0', id: 'x', error: { code: -32010, message: 'credential_invalid' } }),
    res => json(res, 404, { jsonrpc: '2.0', id: 'x', error: { code: -32011, message: 'publication_not_found' } }),
  ];
  let index = 0;
  const fake = await startFakeA2a(({ res }) => replies[index++](res));
  t.after(() => fake.close());
  assert.equal(await verifyCallKey({ url: fake.url, key: 'nxa_good' }), 'valid');
  assert.equal(await verifyCallKey({ url: fake.url, key: 'nxa_bad' }), 'invalid');
  assert.equal(await verifyCallKey({ url: fake.url, key: 'nxa_other' }), 'invalid');
  assert.equal(fake.requests[0].body.method, 'tasks/get');
  assert.match(fake.requests[0].body.params.id, /^[0-9a-f-]{36}$/);
  assert.equal(fake.requests[0].headers.authorization, 'Bearer nxa_good');
});

test('verifyCallKey：Nexus 出错（5xx）或连不上，算 POC_NEXUS_UNREACHABLE（502）', async t => {
  const fake = await startFakeA2a(({ res }) => json(res, 503, { error: 'gateway_unavailable' }));
  t.after(() => fake.close());
  await assert.rejects(verifyCallKey({ url: fake.url, key: 'nxa_x' }), { code: 'POC_NEXUS_UNREACHABLE', status: 502 });
  await assert.rejects(verifyCallKey({ url: 'http://127.0.0.1:9/a2a/pub_x', key: 'nxa_x', timeoutMs: 500 }), { code: 'POC_NEXUS_UNREACHABLE' });
});

test('loadManifest：describe 返回能力清单时取出版本；不是能力清单或调用失败时只给错误码，不抛', async t => {
  const manifest = { task: 'describe', version: 'knowledge-agent-2026-10-17.2', tasks: [{ name: 'answer', purpose: '问知识库' }] };
  const replies = [JSON.stringify(manifest), '```json\n' + JSON.stringify(manifest) + '\n```', '{"recommendation":"MANUAL_REVIEW"}'];
  let index = 0;
  const fake = await startFakeA2a(({ res, body }) => {
    if (index >= replies.length) { json(res, 401, { error: { data: { code: 'credential_invalid' } } }); return; }
    assert.equal(body.params.message.parts[0].text, '{"task":"describe"}');
    writeEvents(res, answerEvents(replies[index++]));
  });
  t.after(() => fake.close());
  assert.deepEqual(await loadManifest({ url: fake.url, key: 'k' }), { manifest, version: 'knowledge-agent-2026-10-17.2', error: null });
  assert.equal((await loadManifest({ url: fake.url, key: 'k' })).version, 'knowledge-agent-2026-10-17.2');
  assert.deepEqual(await loadManifest({ url: fake.url, key: 'k' }), { manifest: null, version: null, error: 'POC_NOT_A_MANIFEST' });
  assert.deepEqual(await loadManifest({ url: fake.url, key: 'k' }), { manifest: null, version: null, error: 'AI_AUTH_INVALID' });
});
