import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { meRoutes } from '../../access/routes.mjs';
import { createMeService } from '../../access/me.mjs';
import { createUserStore } from '../../access/store.mjs';
import { fetchAgentCard } from '../../nexus/catalog.mjs';
import { loadManifest, verifyCallKey } from '../../access/verify.mjs';
import { nexusRoutes } from '../../nexus/routes.mjs';
import { createRunLog } from '../../nexus/runs.mjs';
import { governanceEnv } from '../../nexus/governance.mjs';
import { PASSWORDS, freePort, startApp } from './helpers/app.mjs';
import { answerEvents, startFakeA2a, writeEvents } from './helpers/fake-a2a.mjs';

const SCRIPT = fileURLToPath(new URL('../../../../skills/agent-access/scripts/agent_access.py', import.meta.url));
const GOOD = 'nxa_' + 'g'.repeat(43), BAD = 'nxa_' + 'b'.repeat(43), API_KEY = 'nxc_' + 'k'.repeat(43);
const MANIFEST = { task: 'describe', version: 'knowledge-agent-2026-10-17.2', tasks: [{ name: 'answer', purpose: '问知识库' }] };
const ok = json => ({ exitCode: 0, json });

test('agent_access.py 对本机 PoC 走完一轮：登录 → 状态 → 连接 → 启用（错密钥被拒）→ 调用 → 停用 → 退出；输出里没有任何密钥', async t => {
  const fake = await startFakeA2a(({ req, res, body }) => {
    if (req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ name: '知识', protocolVersion: '0.3', capabilities: { streaming: true } })); return; }
    const valid = req.headers.authorization === `Bearer ${GOOD}`;
    if (body?.method === 'tasks/get') { res.writeHead(valid ? 200 : 401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: valid ? -32603 : -32010, message: valid ? 'Task not found' : 'credential_invalid' } })); return; }
    const text = body?.params?.message?.parts?.[0]?.text ?? '';
    writeEvents(res, answerEvents(text.includes('describe') ? JSON.stringify(MANIFEST) : '{"task":"answer","answer":"每晚不超过 600 元。"}'));
  });
  t.after(() => fake.close());
  const state = { connected: false };
  const cli = { async whoami() { return state.connected ? ok({ user: { user_id: 'u-1', name: 'admin', role: 'editor' }, connection: { preset: 'read_only' } }) : { exitCode: 3, json: null }; },
    async login() { state.connected = true; return { exitCode: 0, json: null }; }, async logout() { state.connected = false; return { exitCode: 0, json: null }; },
    async get(pathname) { return pathname === '/api/v2/publications' ? ok({ data: { items: [{ publish_id: 'pub_knowledge', display_name: '知识 Agent', status: 'active', current_version: 1,
      channels: [{ channel: 'a2a', enabled: true, ready: true, rpc_url: `${fake.origin}/a2a/pub_knowledge` }] }] } }) : ok({ data: [] }); } };
  const me = createMeService({ store: createUserStore({ root: await mkdtemp(path.join(tmpdir(), 'poc-cli-')) }), registryKey: randomBytes(32), nexusOrigin: fake.origin,
    advisoryPublishId: 'pub_5c53e70d8dc7ddea', cliFor: async () => cli, keyStore: { ids: () => [], has: () => false, get: () => null },
    fetchCard: url => fetchAgentCard(url), verifyKey: verifyCallKey, loadManifest });
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  await startApp(t, { origin, port, plugins: [meRoutes({ me }), nexusRoutes({ me, runLog: createRunLog(), governanceEnv: governanceEnv() })] });
  const home = await mkdtemp(path.join(tmpdir(), 'agent-access-'));
  // 子进程必须异步跑：PoC 服务就在本进程里，同步等子进程会卡住事件循环，脚本的请求永远得不到回应。
  const run = async (args, input = '') => {
    const child = spawn('python3', ['-I', SCRIPT, ...args], { env: { PATH: process.env.PATH, AGENT_ACCESS_HOME: home }, timeout: 60_000 });
    const result = { stdout: '', stderr: '' };
    child.stdout.setEncoding('utf8').on('data', chunk => { result.stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { result.stderr += chunk; });
    child.stdin.end(input);
    result.status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    for (const secret of [GOOD, BAD, API_KEY, PASSWORDS.get('poc-reviewer')]) assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false, args.join(' '));
    return result;
  };
  assert.equal((await run(['login', '--origin', origin, '--account', 'poc-reviewer', '--password-stdin', '--client', 'claude_code', '--yes'], `${PASSWORDS.get('poc-reviewer')}\n`)).status, 0);
  assert.equal(JSON.parse((await run(['status', '--json'])).stdout).connection.status, 'not_connected');
  assert.equal((await run(['nexus', 'connect'], `${API_KEY}\n`)).status, 9);
  assert.equal((await run(['nexus', 'connect', '--yes'], `${API_KEY}\n`)).status, 0);
  assert.equal((await run(['enable', 'pub_knowledge', '--key-stdin', '--yes'], `${BAD}\n`)).status, 4);
  const enabled = await run(['enable', 'pub_knowledge', '--key-stdin', '--yes', '--json'], `${GOOD}\n`);
  assert.equal(enabled.status, 0);
  assert.equal(JSON.parse(enabled.stdout).enablement.capabilitiesVersion, MANIFEST.version);
  assert.match((await run(['agents', '--state', 'enabled'])).stdout, /知识 Agent/);
  const invoked = await run(['invoke', 'pub_knowledge', '--task', 'answer', '--input', '{"question":"住宿标准？"}', '--wait', '--yes', '--json']);
  assert.equal(invoked.status, 0, invoked.stderr);
  assert.equal(JSON.parse(invoked.stdout).status, 'ok');
  assert.equal((await run(['enable', 'pub_unknown', '--key-stdin', '--yes'], `${GOOD}\n`)).status, 5);
  assert.equal((await run(['disable', 'pub_knowledge', '--yes'])).status, 0);
  assert.equal((await run(['logout', '--yes'])).status, 0);
  assert.equal((await run(['status'])).status, 3);
});
