import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

// 补丁 0003：九安 v0.7.10 的启用服务。用构建出来的副本（打过补丁）测，不碰 source/。
const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../../../bench/build-jiuan07.sh', import.meta.url));
let dir, createAgentEnablement;
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'jiuan07-enable-'));
  await run('bash', [SCRIPT, '--out', path.join(dir, 'out')], { maxBuffer: 16 * 1024 * 1024 });
  ({ createAgentEnablement } = await import(pathToFileURL(path.join(dir, 'out/src/agent-enablement.mjs')).href));
});
after(() => rm(dir, { recursive: true, force: true }));

function memoryStore() {
  const states = new Map();
  return { readState: async key => structuredClone(states.get(key) ?? null),
    compareAndWriteState: async (key, { expectedRevision, value }) => {
      if ((states.get(key)?.revision ?? 0) !== expectedRevision) throw Object.assign(new Error('conflict'), { status: 409 });
      states.set(key, structuredClone(value));
    } };
}
const DESCRIPTION_PROBLEMS = [{ code: 'CARD_CHECK_FAILED', path: 'description', message: '缺契约行' }, { code: 'CARD_CHECK_FAILED', path: 'description', message: '缺任务行' }];
const clientWith = probe => ({ probe: async () => ({ name: '新发布的 Agent', ...probe }), verifyKey: async () => 'valid' });
const ADMIN = { role: 'admin', principal: 'local:poc-reviewer' };
const KEY = 'nxa_' + 'g'.repeat(43);
const enable = enablement => enablement.enable({ actor: ADMIN, publishId: 'pub_newagent0001', key: KEY, reason: '测试' });

test('名片只差说明里的「契约 / 任务」两行：照常启用，任务由平台按接入的任务指定，记录上标明「平台指定」', async () => {
  const enablement = createAgentEnablement({ store: memoryStore(), tenantId: 't1', acceptedTasks: ['review_advice@1'],
    client: clientWith({ ok: false, problems: DESCRIPTION_PROBLEMS, tasks: [] }) });
  const record = await enable(enablement);
  assert.equal(record.status, 'active');
  assert.deepEqual(record.card.tasks, ['review_advice@1']);
  assert.equal(record.card.declaredBy, 'platform');
  assert.deepEqual((await enablement.publication('pub_newagent0001')).card.tasks, ['review_advice@1'], '九安的路由按这份任务走');
});

test('名片声明了契约和任务的，照旧以名片为准（declaredBy 为 card）', async () => {
  const enablement = createAgentEnablement({ store: memoryStore(), tenantId: 't1', acceptedTasks: ['review_advice@1'],
    client: clientWith({ ok: true, problems: [], tasks: ['review_advice@1'] }) });
  const record = await enable(enablement);
  assert.deepEqual([record.card.tasks, record.card.declaredBy], [['review_advice@1'], 'card']);
});

test('名片还有别的问题（例如不支持流式）或明确声明了别的任务：照旧拒绝启用', async () => {
  const broken = createAgentEnablement({ store: memoryStore(), tenantId: 't1', acceptedTasks: ['review_advice@1'],
    client: clientWith({ ok: false, problems: [...DESCRIPTION_PROBLEMS, { code: 'CARD_CHECK_FAILED', path: 'capabilities.streaming', message: '不支持流式' }], tasks: [] }) });
  await assert.rejects(enable(broken), error => error.code === 'AGENT_CARD_INVALID');
  const other = createAgentEnablement({ store: memoryStore(), tenantId: 't1', acceptedTasks: ['review_advice@1'],
    client: clientWith({ ok: true, problems: [], tasks: ['knowledge_answer@1'] }) });
  await assert.rejects(enable(other), error => error.code === 'AGENT_TASK_NOT_DECLARED');
});
