import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGE_CSP } from '../../../app/http.mjs';
import { createFrontDoor, MARKER_COOKIE } from '../../front.mjs';
import { intakeRoutes } from '../../intake.mjs';

const ORIGIN = 'https://jiuan-v0710.tinyboat.blog';
const HOST = 'jiuan-v0710.tinyboat.blog';

async function serve(t, door) {
  const server = http.createServer(async (req, res) => {
    if (!(await door.serve(req, res, new URL(req.url, ORIGIN)))) { res.writeHead(599); res.end('passed-through'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return (method, path, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: server.address().port, method, path,
      headers: { host: HOST, ...(body ? { 'content-type': 'application/json' } : {}), ...headers } }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text }));
    });
    request.on('error', reject);
    request.end(body ? JSON.stringify(body) : undefined);
  });
}

const login = { login: ({ account, password }) => {
  if (account === 'poc-reviewer' && password === 'right') return { ticket: 'ticket-1' };
  throw Object.assign(new Error('INVALID_CREDENTIALS'), { code: 'INVALID_CREDENTIALS', status: 401 });
} };

test('口令登录页和脚本照旧，自带 CSP，不用内联脚本；九安的文件交还九安', async t => {
  const call = await serve(t, createFrontDoor({ origin: ORIGIN, login }));
  const page = await call('GET', '/poc/login');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-security-policy'], /script-src 'self'/);
  assert.match(page.text, /<script src="\/poc\/login\.js"/);
  assert.doesNotMatch(page.text, /<script>/);
  assert.equal((await call('GET', '/poc/login.js')).status, 200);
  assert.equal((await call('GET', '/analysis.js')).status, 599);
});

test('口令登录：同源、口令对才给票据，并设登录提示 Cookie；口令错回 401', async t => {
  const call = await serve(t, createFrontDoor({ origin: ORIGIN, login }));
  const ok = await call('POST', '/api/analysis/v1/poc/login', { headers: { origin: ORIGIN }, body: { account: 'poc-reviewer', password: 'right' } });
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.text), { data: { ticket: 'ticket-1' } });
  assert.match(ok.headers['set-cookie'][0], new RegExp(`^${MARKER_COOKIE}=1; Path=/; Max-Age=28800; SameSite=Strict; Secure`));
  assert.equal((await call('POST', '/api/analysis/v1/poc/login', { headers: { origin: ORIGIN }, body: { account: 'poc-reviewer', password: 'wrong' } })).status, 401);
  assert.equal((await call('POST', '/api/analysis/v1/poc/login', { headers: { origin: 'https://evil.invalid' }, body: { account: 'poc-reviewer', password: 'right' } })).status, 403);
  assert.equal((await call('POST', '/api/analysis/v1/poc/login', { headers: { origin: ORIGIN }, body: { account: 'poc-reviewer', password: 'right', extra: 1 } })).status, 400);
  assert.equal((await call('GET', '/poc/login', { headers: { host: 'other.invalid' } })).status, 403);
});

// ---- 新前端（poc/web07 的构建产物）：GET / 给 index.html，/assets/ 下只给构建产物里真实存在的文件 ----
const INDEX = '<!doctype html><html><head><script type="module" src="/assets/index-AbC123.js"></script></head><body><div id="root"></div></body></html>';
const ASSETS = { 'index-AbC123.js': 'console.log(1);', 'index-AbC123.css': 'body{margin:0}', 'logo-AbC123.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  'mark-AbC123.png': 'png', 'font-AbC123.woff2': 'woff2', 'index-AbC123.js.map': '{}', 'stray.html': '<p>x</p>', 'notes.txt': 'x' };
async function webBuild(t, { index = INDEX, assets = ASSETS } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'front-web-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  if (index !== null) await writeFile(path.join(dir, 'index.html'), index);
  await mkdir(path.join(dir, 'assets', 'nested'), { recursive: true });
  await writeFile(path.join(dir, 'assets', 'nested', 'deep.js'), 'nested');
  for (const [name, text] of Object.entries(assets)) await writeFile(path.join(dir, 'assets', name), text);
  await writeFile(path.join(dir, 'server.mjs'), 'SECRET-SOURCE');
  return dir;
}
const PAGE_HEADERS = headers => {
  assert.equal(headers['content-security-policy'], PAGE_CSP);
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['referrer-policy'], 'no-referrer');
};

test('首页：不管有没有登录提示 Cookie 都给新前端的 index.html（不缓存、带 CSP）；带查询串也给；别的方法交还九安；主机名不对 403', async t => {
  const call = await serve(t, createFrontDoor({ origin: ORIGIN, login, webDir: await webBuild(t) }));
  for (const [target, headers] of [['/', {}], ['/', { cookie: `${MARKER_COOKIE}=1` }], ['/?x=1', {}]]) {
    const home = await call('GET', target, { headers });
    assert.equal(home.status, 200, target);
    assert.equal(home.text, INDEX);
    assert.equal(home.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(home.headers['cache-control'], 'no-store');
    PAGE_HEADERS(home.headers);
  }
  assert.equal((await call('POST', '/')).status, 599);
  assert.equal((await call('GET', '/', { headers: { host: 'other.invalid' } })).status, 403);
  assert.equal((await call('GET', '/analysis.html')).status, 599, '九安的旧页面照旧交给九安');
});

test('/assets/：只给构建产物里真实存在、类型认得的文件（长缓存、带 CSP）；别的一律 404，含 ../ 和编码过的 ..', async t => {
  const dir = await webBuild(t);
  const call = await serve(t, createFrontDoor({ origin: ORIGIN, login, webDir: dir }));
  const types = { 'index-AbC123.js': 'text/javascript; charset=utf-8', 'index-AbC123.css': 'text/css; charset=utf-8', 'logo-AbC123.svg': 'image/svg+xml',
    'mark-AbC123.png': 'image/png', 'font-AbC123.woff2': 'font/woff2' };
  for (const [name, type] of Object.entries(types)) {
    const asset = await call('GET', `/assets/${name}`);
    assert.equal(asset.status, 200, name);
    assert.equal(asset.text, ASSETS[name]);
    assert.equal(asset.headers['content-type'], type);
    assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable');
    PAGE_HEADERS(asset.headers);
  }
  await writeFile(path.join(dir, 'assets', 'later-AbC123.js'), 'added after start');
  for (const target of ['/assets/missing.js', '/assets/index-AbC123.js.map', '/assets/stray.html', '/assets/notes.txt', '/assets/nested', '/assets/nested/deep.js',
    '/assets/', '/assets/../server.mjs', '/assets/%2e%2e/server.mjs', '/assets/..%2fserver.mjs', '/assets/.%2e/server.mjs', '/assets/%2E%2E/%2E%2E/server.mjs',
    '/assets/later-AbC123.js', '/assets/INDEX-ABC123.JS']) {
    const miss = await call('GET', target);
    assert.equal(miss.status, 404, target);
    assert.equal(JSON.parse(miss.text).error.code, 'NOT_FOUND', target);
    assert.doesNotMatch(miss.text, /SECRET-SOURCE|nested|added after start/, target);
  }
  assert.equal((await call('POST', '/assets/index-AbC123.js')).status, 404);
  assert.equal((await call('GET', '/assets/index-AbC123.js', { headers: { host: 'other.invalid' } })).status, 403);
});

test('HEAD / 和 HEAD /assets/*：前门照 GET 答（同样的状态和头、Content-Length 是 GET 的长度），只是没有正文；不交给九安的旧页面', async t => {
  const call = await serve(t, createFrontDoor({ origin: ORIGIN, login, webDir: await webBuild(t) }));
  for (const [target, length] of [['/', INDEX.length], ['/?x=1', INDEX.length], ['/assets/index-AbC123.js', ASSETS['index-AbC123.js'].length],
    ['/assets/logo-AbC123.svg', ASSETS['logo-AbC123.svg'].length]]) {
    const get = await call('GET', target), head = await call('HEAD', target);
    assert.equal(head.status, 200, target);
    assert.equal(head.text, '', `${target}：HEAD 没有正文`);
    assert.equal(Number(head.headers['content-length']), length, target);
    for (const name of ['content-type', 'cache-control', 'content-security-policy', 'x-content-type-options', 'referrer-policy']) assert.equal(head.headers[name], get.headers[name], `${target} ${name}`);
  }
  for (const target of ['/assets/missing.js', '/assets/../server.mjs', '/assets/index-AbC123.js.map']) {
    const miss = await call('HEAD', target);
    assert.equal(miss.status, 404, target);
    assert.equal(miss.text, '');
  }
  assert.equal((await call('HEAD', '/', { headers: { host: 'other.invalid' } })).status, 403);
  assert.equal((await call('HEAD', '/analysis.html')).status, 599, '九安的旧页面照旧交给九安');
});

test('还没构建新前端：首页回 503「新前端还没构建，请重新部署。」，/assets/ 404；口令登录页和登录接口照常', async t => {
  for (const webDir of [path.join(tmpdir(), 'front-web-no-such-dir'), await webBuild(t, { index: null })]) {
    const call = await serve(t, createFrontDoor({ origin: ORIGIN, login, webDir }));
    const home = await call('GET', '/');
    assert.equal(home.status, 503, webDir);
    assert.deepEqual(JSON.parse(home.text), { error: { code: 'WEB_NOT_BUILT', message: '新前端还没构建，请重新部署。' } });
    const head = await call('HEAD', '/');
    assert.equal(head.status, 503, 'HEAD 也是前门答：还没构建');
    assert.equal(head.text, '');
    assert.equal((await call('GET', '/assets/index-AbC123.js')).status, 404);
    assert.equal((await call('GET', '/poc/login')).status, 200);
    assert.equal((await call('POST', '/api/analysis/v1/poc/login', { headers: { origin: ORIGIN }, body: { account: 'poc-reviewer', password: 'right' } })).status, 200);
  }
});

const REAL_DIST = fileURLToPath(new URL('../../../web07/dist/', import.meta.url));
test('真实的构建产物（poc/web07/dist，前门默认就找它）：首页和它引用的每个 /assets/ 文件都给得出来', {
  skip: existsSync(path.join(REAL_DIST, 'index.html')) ? false : '没有 poc/web07/dist：先 cd poc/web07 && npm run build',
}, async t => {
  const call = await serve(t, createFrontDoor({ origin: ORIGIN, login }));
  const home = await call('GET', '/');
  assert.equal(home.status, 200);
  assert.equal(home.text, await readFile(path.join(REAL_DIST, 'index.html'), 'utf8'));
  const refs = [...new Set([...home.text.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(match => match[1]))];
  assert.ok(refs.some(ref => ref.endsWith('.js')) && refs.some(ref => ref.endsWith('.css')), `index.html 里应引用脚本和样式：${refs}`);
  for (const ref of refs) {
    const asset = await call('GET', ref);
    assert.equal(asset.status, 200, ref);
    assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable');
  }
  for (const name of await readdir(path.join(REAL_DIST, 'assets'))) assert.equal((await call('GET', `/assets/${name}`)).status, 200, name);
});

function capture() {
  const res = { status: null, body: null, writeHead(status) { this.status = status; return this; }, setHeader() {}, end(text) { this.body = JSON.parse(text); } };
  return res;
}
const fake = { templates: () => [{ businessCode: 'DGZF-V07-001', formName: '常规对公付款单', companyName: '甲（虚构）', title: '房租' }],
  arrive: ({ template }) => {
    if (template !== 'DGZF-V07-001') throw Object.assign(new Error('POC_INTAKE_TEMPLATE_UNKNOWN'), { code: 'POC_INTAKE_TEMPLATE_UNKNOWN', status: 400 });
    return { businessCode: 'DGZF-SIM-001' };
  } };
const session = role => ({ user: { id: role === 'admin' ? 'poc-reviewer' : 'poc-checker', role } });

test('模拟来单：登录后能看模板；只有管理员能来单，每分钟最多 5 次；别的路径交还九安', async () => {
  const routes = intakeRoutes({ fake });
  const ask = async (method, path, who, body) => {
    const res = capture();
    const handled = await routes.handle({ req: { method }, url: new URL(path, ORIGIN), path, session: who, res, body });
    return { handled, ...res };
  };
  const list = await ask('GET', '/api/analysis/v1/poc/intake/templates', session('analyst'));
  assert.deepEqual(list.body.data.items.map(item => item.businessCode), ['DGZF-V07-001']);
  const arrived = await ask('POST', '/api/analysis/v1/poc/intake', session('admin'), { template: 'DGZF-V07-001' });
  assert.equal(arrived.status, 201);
  assert.equal(arrived.body.data.businessCode, 'DGZF-SIM-001');
  assert.equal((await ask('POST', '/api/analysis/v1/poc/intake', session('analyst'), { template: 'DGZF-V07-001' })).status, 403);
  assert.equal((await ask('POST', '/api/analysis/v1/poc/intake', session('admin'), { template: 'NOPE' })).status, 400);
  assert.equal((await ask('POST', '/api/analysis/v1/poc/intake', session('admin'), { template: 'DGZF-V07-001', x: 1 })).status, 400);
  for (let index = 0; index < 3; index += 1) await ask('POST', '/api/analysis/v1/poc/intake', session('admin'), { template: 'DGZF-V07-001' });
  assert.equal((await ask('POST', '/api/analysis/v1/poc/intake', session('admin'), { template: 'DGZF-V07-001' })).status, 429);
  assert.equal((await ask('GET', '/api/analysis/v1/platform/agents', session('admin'))).handled, false);
});

test('模拟来单的请求体九安不替我们读（它只读 /platform 下的）：来单接口自己读 JSON', async () => {
  const { Readable } = await import('node:stream');
  const routes = intakeRoutes({ fake });
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ template: 'DGZF-V07-001' }))]), { method: 'POST', headers: { 'content-type': 'application/json' } });
  const res = capture();
  await routes.handle({ req, url: new URL('/api/analysis/v1/poc/intake', ORIGIN), path: '/api/analysis/v1/poc/intake', session: session('admin'), res, body: undefined });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.businessCode, 'DGZF-SIM-001');
});
