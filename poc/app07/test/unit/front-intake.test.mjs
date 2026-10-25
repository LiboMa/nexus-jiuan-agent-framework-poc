import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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

test('首页：没登录过就跳到口令登录页；登录页和脚本自带 CSP，不用内联脚本', async t => {
  const call = await serve(t, createFrontDoor({ origin: ORIGIN, login }));
  const home = await call('GET', '/');
  assert.equal(home.status, 302);
  assert.equal(home.headers.location, '/poc/login');
  assert.equal((await call('GET', '/', { headers: { cookie: `${MARKER_COOKIE}=1` } })).status, 599);
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
