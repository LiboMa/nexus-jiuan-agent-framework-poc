import test from 'node:test';
import assert from 'node:assert/strict';
import { createOperatorCli, execFileJson } from '../../nexus/cli.mjs';

test('命令行：Python 隔离模式、profile、--json；连接密钥只经环境变量传入', async () => {
  const calls = [];
  const cli = createOperatorCli({ script: '/opt/op/nexus.py', nexusHome: '/var/lib/x/nexus', profile: 'andon', origin: 'https://nexus.example',
    exec: async (file, args, options) => { calls.push({ file, args, env: options.env }); return { exitCode: 0, json: { ok: true } }; } });
  await cli.whoami();
  await cli.login('nxc_secret_value');
  await cli.get('/api/v2/agents', { limit: 100 });
  assert.equal(calls[0].file, 'python3');
  assert.deepEqual(calls[0].args, ['-I', '/opt/op/nexus.py', '--profile', 'andon', '--json', 'whoami']);
  assert.deepEqual(calls[1].args.slice(5), ['login', '--origin', 'https://nexus.example', '--token-env', 'NEXUS_POC_CONNECTION_KEY', '--client', 'other']);
  assert.equal(calls[1].env.NEXUS_POC_CONNECTION_KEY, 'nxc_secret_value');
  assert.equal(calls[1].args.join(' ').includes('nxc_secret_value'), false);
  assert.equal(calls[0].env.NEXUS_POC_CONNECTION_KEY, undefined);
  assert.deepEqual(calls[2].args.slice(5), ['call', 'GET', '/api/v2/agents', '-q', 'limit=100']);
  for (const call of calls) assert.equal(call.env.NEXUS_HOME, '/var/lib/x/nexus');
});

test('execFileJson：解析 JSON 输出与退出码；程序不存在算平台不可用（8）', async () => {
  const options = { env: process.env, timeoutMs: 10_000 };
  assert.deepEqual(await execFileJson(process.execPath, ['-e', 'console.log(JSON.stringify({ok:true,data:[1]}))'], options), { exitCode: 0, json: { ok: true, data: [1] } });
  const reconnect = await execFileJson(process.execPath, ['-e', 'console.log(JSON.stringify({ok:false,exit_code:3,error:{code:"reconnect"}}));process.exit(3)'], options);
  assert.equal(reconnect.exitCode, 3);
  assert.equal(reconnect.json.error.code, 'reconnect');
  assert.deepEqual(await execFileJson('/nonexistent/python3', [], options), { exitCode: 8, json: null });
});

test('logout 只删本机凭证（不带 --revoke）', async () => {
  const calls = [];
  const cli = createOperatorCli({ script: '/opt/op/nexus.py', nexusHome: '/var/lib/x/users/poc-reviewer/nexus', profile: 'default', origin: 'https://nexus.example',
    exec: async (file, args, options) => { calls.push({ args, env: options.env }); return { exitCode: 0, json: { ok: true, removed: true } }; } });
  assert.equal((await cli.logout()).exitCode, 0);
  assert.deepEqual(calls[0].args, ['-I', '/opt/op/nexus.py', '--profile', 'default', '--json', 'logout']);
  assert.equal(calls[0].env.NEXUS_HOME, '/var/lib/x/users/poc-reviewer/nexus');
});
