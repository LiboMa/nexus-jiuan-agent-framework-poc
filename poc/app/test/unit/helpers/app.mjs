/** 集成测试夹具：在 127.0.0.1 的临时端口起 PoC（九安服务端 + 内存存储），用假的模型客户端。 */
import { request } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPocApp } from '../../../poc-app.mjs';

export const TEST_ORIGIN = 'http://poc.test';
export const PASSWORDS = new Map([['poc-reviewer', 'reviewer-pass-123'], ['poc-checker', 'checker-pass-123']]);

export function advisoryResult(overrides = {}) {
  return { recommendation: 'MANUAL_REVIEW', riskLevel: 'medium', confidence: 'medium', summary: '测试建议：附件需要人工核对（虚构）。',
    keyFindings: ['金额与表单一致'], requiredActions: ['补充酒店发票'], unresolvedQuestions: ['培训通知是否已审批'], conflictFlags: [], rejectionDraft: null, ...overrides };
}

export function fakeModel(behavior = async () => advisoryResult()) {
  const calls = [];
  return { calls, client: { model: 'fake-model', async advisory(input) { calls.push(input); return behavior(input, calls.length); } } };
}

export async function startApp(t, { modelClient = fakeModel().client, plugins = [], warm = true, origin = TEST_ORIGIN, port: listenPort = 0, ...rest } = {}) {
  const publicDir = await mkdtemp(path.join(tmpdir(), 'poc-public-'));
  await writeFile(path.join(publicDir, 'analysis.html'), '<!doctype html><title>PoC stub</title>');
  const app = createPocApp({ origin, publicDir, passwords: PASSWORDS, modelClient, plugins, ...rest });
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(listenPort, '127.0.0.1', resolve); });
  t.after(() => app.close());
  if (warm) await app.warmUp();
  const port = app.server.address().port;
  return { app, port, client: () => createClient(port, { origin }) };
}

/** 先占一个空闲端口再放掉：让 PoC 的站点地址就是 http://127.0.0.1:<端口>，外部程序（例如 Python 脚本）不用改 Host 头就能访问。 */
export async function freePort() {
  const server = (await import('node:net')).createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}


/** 带 Cookie 与 CSRF 的小客户端：Host / Origin 按 TEST_ORIGIN 填写（九安会校验）。headers 可以覆盖任何一项。 */
export function createClient(port, { origin = TEST_ORIGIN } = {}) {
  const host = new URL(origin).host;
  let cookie = '', csrf = '';
  function http(pathname, { method = 'GET', body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const req = request({ host: '127.0.0.1', port, path: pathname, method, agent: false, headers: {
        Host: host, Accept: 'application/json',
        ...(method !== 'GET' ? { Origin: origin } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(csrf && method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        ...headers,
      } }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const set = (res.headers['set-cookie'] || []).find(value => value.startsWith('jiuan_analysis='));
          if (set) cookie = set.split(';')[0];
          let json = null;
          try { json = JSON.parse(text); } catch { /* 静态文件不是 JSON */ }
          resolve({ status: res.statusCode, headers: res.headers, body: json, text });
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
  return {
    http,
    api: (pathname, options) => http(`/api/analysis/v1${pathname}`, options),
    async login(account, password) {
      const ticket = await http('/api/analysis/v1/poc/login', { method: 'POST', body: { account, password } });
      if (ticket.status !== 200) return ticket;
      const exchanged = await http('/api/analysis/v1/auth/exchange', { method: 'POST', body: { ticket: ticket.body.data.ticket } });
      if (exchanged.status !== 200) return exchanged;
      const session = await http('/api/analysis/v1/session');
      csrf = session.body?.data?.csrfToken || '';
      return session;
    },
  };
}
