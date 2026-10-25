import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHostProxy } from '../../host-proxy.mjs';
import { readEnvConfig } from '../../config.mjs';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });

function send(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method, path, headers }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

test('按 Host 转发：这个站点的请求原样交给本机上游（方法、路径、头、请求体、Set-Cookie），别的 Host 不管', async t => {
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      res.writeHead(201, { 'Content-Type': 'application/json', 'Set-Cookie': ['a=1; Path=/', 'b=2; Path=/api'] });
      res.end(JSON.stringify({ method: req.method, url: req.url, host: req.headers.host, cookie: req.headers.cookie, origin: req.headers.origin, body }));
    });
  });
  const upstreamPort = await listen(upstream);
  const proxy = createHostProxy({ host: 'jiuan-v0710.tinyboat.blog', port: upstreamPort });
  const front = http.createServer((req, res) => {
    if (proxy.matches(req)) { proxy.forward(req, res); return; }
    res.writeHead(200); res.end('poc');
  });
  const frontPort = await listen(front);
  t.after(async () => { await close(front); await close(upstream); });

  const forwarded = await send(frontPort, { method: 'POST', path: '/api/analysis/v1/auth/exchange?x=1', body: '{"ticket":"t"}',
    headers: { host: 'jiuan-v0710.tinyboat.blog', cookie: 'jiuan_analysis=s', origin: 'https://jiuan-v0710.tinyboat.blog', 'content-type': 'application/json' } });
  assert.equal(forwarded.status, 201);
  assert.deepEqual(JSON.parse(forwarded.text), { method: 'POST', url: '/api/analysis/v1/auth/exchange?x=1', host: 'jiuan-v0710.tinyboat.blog',
    cookie: 'jiuan_analysis=s', origin: 'https://jiuan-v0710.tinyboat.blog', body: '{"ticket":"t"}' });
  assert.deepEqual(forwarded.headers['set-cookie'], ['a=1; Path=/', 'b=2; Path=/api']);
  assert.equal((await send(frontPort, { headers: { host: 'andon-finance.tinyboat.blog' } })).text, 'poc');
});

test('上游没起来：回 502，不挂住', async t => {
  const dead = http.createServer();
  const deadPort = await listen(dead);
  await close(dead);
  const proxy = createHostProxy({ host: 'jiuan-v0710.tinyboat.blog', port: deadPort });
  const front = http.createServer((req, res) => proxy.forward(req, res));
  const frontPort = await listen(front);
  t.after(() => close(front));
  const result = await send(frontPort, { headers: { host: 'jiuan-v0710.tinyboat.blog' } });
  assert.equal(result.status, 502);
});

test('配置：转发的主机和端口一起给，主机名、端口要合规；不给就不转发', () => {
  const base = { POC_ORIGIN: 'https://andon-finance.tinyboat.blog', NEXUS_ADVISORY_PUBLICATION: 'pub_5c53e70d8dc7ddea',
    NEXUS_ORIGIN: 'https://nxs-beine1013.tinyboat.blog', NEXUS_OPERATOR: '/opt/x/nexus.py' };
  assert.equal(readEnvConfig(base).forward, null);
  assert.deepEqual(readEnvConfig({ ...base, POC_FORWARD_HOST: 'jiuan-v0710.tinyboat.blog', POC_FORWARD_PORT: '4181' }).forward,
    { host: 'jiuan-v0710.tinyboat.blog', port: 4181 });
  assert.throws(() => readEnvConfig({ ...base, POC_FORWARD_HOST: 'andon-finance.tinyboat.blog', POC_FORWARD_PORT: '4181' }), /POC_FORWARD_HOST/);
  assert.throws(() => readEnvConfig({ ...base, POC_FORWARD_HOST: 'bad host', POC_FORWARD_PORT: '4181' }), /POC_FORWARD_HOST/);
  assert.throws(() => readEnvConfig({ ...base, POC_FORWARD_HOST: 'jiuan-v0710.tinyboat.blog' }), /POC_FORWARD_PORT/);
});

test('PoC 应用：Host 是转发站点的请求整站交给上游（连 /poc/healthz 也是上游的），PoC 自己的站点照旧', async t => {
  const { startApp } = await import('./helpers/app.mjs');
  const upstream = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(`v0710 ${req.url}`); });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const { port } = await startApp(t, { forward: { host: 'jiuan-v0710.tinyboat.blog', port: upstreamPort } });
  assert.equal((await send(port, { path: '/poc/healthz', headers: { host: 'jiuan-v0710.tinyboat.blog' } })).text, 'v0710 /poc/healthz');
  assert.equal((await send(port, { path: '/api/analysis/v1/session', headers: { host: 'jiuan-v0710.tinyboat.blog' } })).text, 'v0710 /api/analysis/v1/session');
  assert.equal((await send(port, { path: '/poc/healthz', headers: { host: 'poc.test' } })).text, 'ok');
});
