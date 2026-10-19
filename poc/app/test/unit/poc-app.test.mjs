import test from 'node:test';
import assert from 'node:assert/strict';
import { PASSWORDS, fakeModel, startApp } from './helpers/app.mjs';
import { waitUntil } from './helpers/wait.mjs';

test('读完原件之前健康检查报告 starting，之后报告 ok', async t => {
  const { app, client } = await startApp(t, { warm: false });
  const http = client();
  assert.equal((await http.http('/poc/healthz', { headers: { Host: 'ip-10-0-0-1' } })).status, 503);
  assert.equal((await http.http('/api/health')).status, 503);
  await app.warmUp();
  assert.equal((await http.http('/poc/healthz', { headers: { Host: 'ip-10-0-0-1' } })).status, 200);
  assert.equal((await http.http('/api/health')).body.status, 'ok');
  assert.equal((await http.http('/api/health')).body.source, 'poc-memory');
});

test('主机名不是站点地址的请求，在九安之前就被拒绝', async t => {
  const { client } = await startApp(t);
  const response = await client().http('/api/health', { headers: { Host: 'evil.test' } });
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, 'ORIGIN_INVALID');
});

test('口令登录换到九安会话：账号、两家公司与 AI 能力都在', async t => {
  const { client } = await startApp(t);
  const wrong = await client().login('poc-checker', 'wrong-password');
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error.code, 'INVALID_CREDENTIALS');
  const session = await client().login('poc-checker', PASSWORDS.get('poc-checker'));
  assert.equal(session.status, 200);
  assert.equal(session.body.data.user.name, '复核人（虚构）');
  assert.equal(session.body.data.companies.length, 2);
  assert.equal(session.body.data.capabilities.analysisAdvice, true);
  assert.equal(session.body.data.instance, 'test');
});

test('登录接口要求站点自己的 Origin', async t => {
  const { client } = await startApp(t);
  const response = await client().http('/api/analysis/v1/poc/login', { method: 'POST', body: { account: 'poc-reviewer', password: 'x' },
    headers: { Origin: 'http://evil.test' } });
  assert.equal(response.status, 403);
});

test('单据池列出 8 张虚构单据，单据详情取得到九安预审', async t => {
  const { client } = await startApp(t);
  const http = client();
  await http.login('poc-reviewer', PASSWORDS.get('poc-reviewer'));
  const list = await http.api('/documents?limit=50');
  assert.equal(list.status, 200);
  assert.equal(list.body.data.total, 8);
  const rent = list.body.data.items.find(item => item.number === 'DGZF-POC-001');
  const precheck = await http.api(`/documents/${rent.id}/precheck`);
  assert.equal(precheck.status, 200);
  assert.equal(precheck.body.data.source.readOnly, true);
});

test('预热时读过原件：有原件的三张单据证据状态为 completed', async t => {
  const { client } = await startApp(t);
  const http = client();
  await http.login('poc-reviewer', PASSWORDS.get('poc-reviewer'));
  const { body } = await http.api('/documents?limit=50');
  for (const number of ['DGZF-POC-001', 'DGZF-POC-002', 'DGZF-POC-003']) {
    const id = body.data.items.find(item => item.number === number).id;
    assert.equal((await http.api(`/documents/${id}/evidence`)).body.data.status, 'completed', number);
  }
});

test('九安的「AI 独立建议」经注入的模型客户端跑完', async t => {
  const model = fakeModel();
  const { client } = await startApp(t, { modelClient: model.client });
  const http = client();
  await http.login('poc-reviewer', PASSWORDS.get('poc-reviewer'));
  const { body } = await http.api('/documents?limit=50');
  const document = body.data.items.find(item => item.number === 'FYBX-POC-001');
  const queued = await http.api(`/documents/${document.id}/advice`, { method: 'POST', body: { sourceVersion: document.version } });
  assert.equal(queued.status, 202);
  const done = await waitUntil(async () => {
    const view = await http.api(`/documents/${document.id}/advice`);
    return view.body.data.status === 'completed' && view.body.data;
  });
  assert.equal(done.modelCalled, true);
  assert.equal(model.calls.length, 1);
  assert.equal(model.calls[0].facts.number, 'FYBX-POC-001');
});

test('前端副本由包装层托管，带九安的 CSP', async t => {
  const { client } = await startApp(t);
  const page = await client().http('/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-security-policy'], /script-src 'self'/);
  assert.match(page.text, /PoC stub/);
});

test('PoC 插件先处理，不认的交给九安的平台接口；九安平台接口的审计回调原样透传', async t => {
  const calls = [];
  const reply = (res, data) => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ data })); return true; };
  const jiuanPlatformRoutes = {
    async handle({ path, res }) { if (path !== '/api/analysis/v1/platform/ping') return false; calls.push('jiuan'); return reply(res, 'jiuan'); },
    recordAuth: event => calls.push(`auth:${event.method}:${event.outcome}`), recordAccessDenied() {}, recordPreAuthDenied() {}, auditStatus: () => ({}),
  };
  const plugin = () => ({ async handle({ path, res }) { if (path !== '/api/analysis/v1/poc/ping') return false; calls.push('plugin'); return reply(res, 'plugin'); } });
  const { client } = await startApp(t, { plugins: [plugin], jiuanPlatformRoutes });
  const http = client();
  assert.equal((await http.login('poc-reviewer', PASSWORDS.get('poc-reviewer'))).status, 200);
  assert.ok(calls.includes('auth:local:ok'), '登录的审计回调要透传给九安的平台接口');
  assert.equal((await http.api('/poc/ping')).body.data, 'plugin');
  assert.equal((await http.api('/platform/ping')).body.data, 'jiuan');
  assert.equal((await http.api('/platform/nothing')).status, 404);
  assert.deepEqual(calls.filter(call => !call.startsWith('auth:')), ['plugin', 'jiuan']);
});
