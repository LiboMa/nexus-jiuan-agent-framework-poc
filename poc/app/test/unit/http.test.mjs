import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PAGE_CSP, clientIp, createStaticFiles, onlyFields, onlyQuery, readJson, sendError } from '../../http.mjs';

const request = (body, contentType = 'application/json') => ({ headers: { 'content-type': contentType }, async *[Symbol.asyncIterator]() { yield Buffer.from(body); } });
function response() {
  return { status: 0, headers: {}, body: null, headersSent: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; }, end(body) { this.body = body ?? null; } };
}

test('readJson：只收 JSON，限制大小，拒绝坏 JSON', async () => {
  assert.deepEqual(await readJson(request('{"a":1}')), { a: 1 });
  await assert.rejects(readJson(request('{}', 'text/plain')), { code: 'INVALID_CONTENT_TYPE', status: 415 });
  await assert.rejects(readJson(request('x'.repeat(20)), { maximum: 10 }), { code: 'BODY_LIMIT', status: 413 });
  await assert.rejects(readJson(request('{bad')), { code: 'INVALID_JSON', status: 400 });
});

test('onlyFields 与 onlyQuery 拒绝多余或重复的键', () => {
  assert.doesNotThrow(() => onlyFields({ a: 1 }, ['a', 'b']));
  assert.throws(() => onlyFields({ c: 1 }, ['a']), { code: 'INVALID_REQUEST' });
  assert.throws(() => onlyFields([], ['a']), { code: 'INVALID_REQUEST' });
  assert.doesNotThrow(() => onlyQuery(new URL('http://x/?ids=1'), ['ids']));
  assert.throws(() => onlyQuery(new URL('http://x/?ids=1&ids=2'), ['ids']), { code: 'INVALID_QUERY' });
  assert.throws(() => onlyQuery(new URL('http://x/?other=1'), ['ids']), { code: 'INVALID_QUERY' });
});

test('来源 IP 取 X-Forwarded-For 的最后一段（CloudFront 追加的），前面伪造的不算', () => {
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '1.1.1.1, 203.0.113.9' }, socket: { remoteAddress: '10.0.0.1' } }), '203.0.113.9');
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '10.0.0.1' } }), '10.0.0.1');
});

test('错误外壳与九安一致：{error:{code,message}}', () => {
  const res = response();
  sendError(res, Object.assign(new Error('x'), { code: 'POC_APPROVAL_TRANSITION', status: 409 }));
  assert.equal(res.status, 409);
  assert.deepEqual(JSON.parse(res.body), { error: { code: 'POC_APPROVAL_TRANSITION', message: '请求未通过校验。' } });
  const crash = response();
  sendError(crash, new Error('boom'));
  assert.equal(crash.status, 500);
  assert.equal(JSON.parse(crash.body).error.code, 'INTERNAL_ERROR');
});

test('前端副本只托管白名单路径，响应头带九安同样的 CSP；非入口页带查询串返回 404', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'poc-static-'));
  await writeFile(path.join(dir, 'analysis.html'), '<!doctype html>');
  await writeFile(path.join(dir, 'analysis.js'), 'export {};');
  const statics = createStaticFiles({ dir, files: { '/': 'analysis.html', '/analysis.js': 'analysis.js', '/missing.css': 'missing.css' } });
  const page = response();
  assert.equal(await statics.serve(page, new URL('http://x/?from=dingtalk')), true);
  assert.equal(page.status, 200);
  assert.equal(page.headers['Content-Security-Policy'], PAGE_CSP);
  assert.match(page.headers['Content-Type'], /^text\/html/);
  assert.equal(await statics.serve(response(), new URL('http://x/unknown.js')), false);
  await assert.rejects(statics.serve(response(), new URL('http://x/analysis.js?v=2')), { code: 'NOT_FOUND', status: 404 });
  await assert.rejects(statics.serve(response(), new URL('http://x/missing.css')), { code: 'NOT_FOUND', status: 404 });
});

test('readJson：超出上限不多时先读完再报 413（客户端能收到应答）；超出上限一倍以上才立即中断', async () => {
  let destroyed = false;
  const chunks = (count, size) => ({ headers: { 'content-type': 'application/json' }, destroy() { destroyed = true; },
    async *[Symbol.asyncIterator]() { for (let index = 0; index < count; index += 1) yield Buffer.alloc(size, 0x78); } });
  const moderate = chunks(3, 6);
  await assert.rejects(readJson(moderate, { maximum: 10 }), { code: 'BODY_LIMIT', status: 413 });
  assert.equal(destroyed, false);
  await assert.rejects(readJson(chunks(10, 6), { maximum: 10 }), { code: 'BODY_LIMIT', status: 413 });
  assert.equal(destroyed, true);
});
