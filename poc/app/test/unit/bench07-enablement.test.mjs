import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

// 补丁 0003：九安 v0.7.10 的启用服务。启用只让 Agent「就绪」；审批流只调管理员指定的那一个「审批 Agent」。
// 用构建出来的副本（打过补丁）测，不碰 source/。
const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../../../bench/build-jiuan07.sh', import.meta.url));
let dir, createAgentEnablement;
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'jiuan07-enable-'));
  await run('bash', [SCRIPT, '--out', path.join(dir, 'out')], { maxBuffer: 16 * 1024 * 1024 });
  ({ createAgentEnablement } = await import(pathToFileURL(path.join(dir, 'out/src/agent-enablement.mjs')).href));
});
after(() => rm(dir, { recursive: true, force: true }));

function memoryStore(initial = null) {
  const states = new Map(initial ? [['agent-enablement:v1:t1', initial]] : []);
  return { states, readState: async key => structuredClone(states.get(key) ?? null),
    compareAndWriteState: async (key, { expectedRevision, value }) => {
      if ((states.get(key)?.revision ?? 0) !== expectedRevision) throw Object.assign(new Error('conflict'), { status: 409 });
      states.set(key, structuredClone(value));
    } };
}
const DESCRIPTION_PROBLEMS = [{ code: 'CARD_CHECK_FAILED', path: 'description', message: '缺契约行' }, { code: 'CARD_CHECK_FAILED', path: 'description', message: '缺任务行' }];
const cards = new Map([
  ['pub_audit00001', { ok: true, problems: [], tasks: ['review_advice@1'], name: '审核' }],
  ['pub_knowledge1', { ok: false, problems: DESCRIPTION_PROBLEMS, tasks: [], name: '知识' }],
  ['pub_answer0001', { ok: true, problems: [], tasks: ['knowledge_answer@1'], name: '问答' }],
  ['pub_broken0001', { ok: false, problems: [...DESCRIPTION_PROBLEMS, { code: 'CARD_CHECK_FAILED', path: 'capabilities.streaming', message: '不支持流式' }], tasks: [], name: '坏' }],
]);
const client = { probe: async ({ publishId }) => cards.get(publishId), verifyKey: async () => 'valid' };
const ADMIN = { role: 'admin', principal: 'local:poc-reviewer' };
const KEY = 'nxa_' + 'g'.repeat(43);
const service = store => createAgentEnablement({ store: store ?? memoryStore(), tenantId: 't1', acceptedTasks: ['review_advice@1'], client, perMinute: 50 });
const enable = (enablement, publishId) => enablement.enable({ actor: ADMIN, publishId, key: KEY, reason: '测试' });

test('启用只验名片的 A2A 基本要求和密钥：名片说明里没有契约 / 任务两行、或只声明了别的任务，都照样启用，状态「就绪」，不进审批流', async () => {
  const enablement = service();
  for (const id of ['pub_knowledge1', 'pub_answer0001', 'pub_audit00001']) assert.equal((await enable(enablement, id)).status, 'active');
  const knowledge = await enablement.publication('pub_knowledge1');
  assert.deepEqual([knowledge.card.declaredTasks, knowledge.card.tasks, knowledge.approval], [[], [], false]);
  assert.deepEqual((await enablement.publication('pub_answer0001')).card.tasks, ['knowledge_answer@1']);
  // 名片自己声明了 review_advice@1，没被指定成审批 Agent 也不接审批流的任务（九安的任务服务按 card.tasks 判断能不能派单）
  const audit = await enablement.publication('pub_audit00001');
  assert.deepEqual([audit.card.declaredTasks, audit.card.tasks, audit.approval], [['review_advice@1'], [], false]);
  assert.equal((await enablement.list()).approval, null);
});

test('名片还有别的问题（例如不支持流式）：照旧拒绝启用', async () => {
  await assert.rejects(enable(service(), 'pub_broken0001'), error => error.code === 'AGENT_CARD_INVALID');
});

test('设为审批 Agent：只能有一个，指定新的就替换旧的；只有它的 card.tasks 带审批流的任务；留痕', async () => {
  const enablement = service();
  await enable(enablement, 'pub_knowledge1');
  await enable(enablement, 'pub_audit00001');
  await enablement.approve({ actor: ADMIN, publishId: 'pub_audit00001', reason: '设为审批 Agent' });
  assert.deepEqual((await enablement.publication('pub_audit00001')).card.tasks, ['review_advice@1']);
  assert.equal((await enablement.publication('pub_audit00001')).approval, true);
  const replaced = await enablement.approve({ actor: ADMIN, publishId: 'pub_knowledge1', reason: '换一个' });
  assert.equal(replaced.approval, true);
  assert.deepEqual((await enablement.publication('pub_audit00001')).card.tasks, [], '旧的不再接审批流');
  assert.deepEqual((await enablement.publication('pub_knowledge1')).card.tasks, ['review_advice@1']);
  const listed = await enablement.list();
  assert.equal(listed.approval.publishId, 'pub_knowledge1');
  assert.deepEqual(listed.records.filter(record => record.approval).map(record => record.publishId), ['pub_knowledge1']);
  assert.deepEqual(listed.audit.filter(item => item.action === 'approve').map(item => [item.publishId, item.previousPublishId, item.result]),
    [['pub_audit00001', null, 'ok'], ['pub_knowledge1', 'pub_audit00001', 'ok']]);
});

test('取消审批 Agent：审批流没有 Agent；没就绪的不能设为审批 Agent；不是管理员不行', async () => {
  const enablement = service();
  await enable(enablement, 'pub_audit00001');
  await enablement.approve({ actor: ADMIN, publishId: 'pub_audit00001', reason: '设为审批 Agent' });
  await enablement.unapprove({ actor: ADMIN, publishId: 'pub_audit00001', reason: '取消' });
  assert.equal((await enablement.list()).approval, null);
  assert.deepEqual((await enablement.publication('pub_audit00001')).card.tasks, []);
  await assert.rejects(enablement.unapprove({ actor: ADMIN, publishId: 'pub_audit00001', reason: '再取消' }), error => error.code === 'AGENT_ACCESS_NOT_APPROVAL');
  await enablement.disable({ actor: ADMIN, publishId: 'pub_audit00001', reason: '停用' });
  await assert.rejects(enablement.approve({ actor: ADMIN, publishId: 'pub_audit00001', reason: '设' }), error => error.code === 'AGENT_ACCESS_NOT_ACTIVE');
  await assert.rejects(enablement.approve({ actor: ADMIN, publishId: 'pub_nosuch0001', reason: '设' }), error => error.code === 'AGENT_ACCESS_NOT_FOUND');
  await assert.rejects(enablement.approve({ actor: { role: 'analyst', principal: 'local:x' }, publishId: 'pub_audit00001', reason: '设' }), error => error.code === 'AGENT_ACCESS_FORBIDDEN');
});

test('审批 Agent 密钥失效后仍是审批 Agent，但不接单（card.tasks 为空）；换好钥匙后自动恢复', async () => {
  const enablement = service();
  await enable(enablement, 'pub_audit00001');
  await enablement.approve({ actor: ADMIN, publishId: 'pub_audit00001', reason: '设为审批 Agent' });
  await enablement.markInvalid('pub_audit00001', 'AI_AUTH_INVALID');
  const stale = await enablement.publication('pub_audit00001');
  assert.deepEqual([stale.status, stale.approval, stale.card.tasks], ['invalid', true, []]);
  await enablement.rotate({ actor: ADMIN, publishId: 'pub_audit00001', key: 'nxa_' + 'n'.repeat(43), reason: '换钥匙' });
  assert.deepEqual((await enablement.publication('pub_audit00001')).card.tasks, ['review_advice@1']);
});

test('迁移：以前的启用记录没有审批 Agent 这一项时，名片声明了审批流任务、正在就绪的那个自动设为审批 Agent（只做一次，留痕）', async () => {
  const at = '2026-10-25T16:04:00.000Z';
  const old = { revision: 3, version: 1, audit: [], records: {
    pub_audit00001: { publishId: 'pub_audit00001', status: 'active', key: KEY, fingerprint: 'ab12cd34', card: { name: '审核', tasks: ['review_advice@1'] }, enabledBy: 'local:poc-reviewer', enabledAt: at, verifiedAt: at, invalidReason: null, updatedAt: at },
    pub_answer0001: { publishId: 'pub_answer0001', status: 'active', key: KEY, fingerprint: 'cd34ef56', card: { name: '问答', tasks: ['knowledge_answer@1'] }, enabledBy: 'local:poc-reviewer', enabledAt: at, verifiedAt: at, invalidReason: null, updatedAt: at } } };
  const enablement = service(memoryStore(old));
  assert.equal(await enablement.adoptDeclaredApproval(), 'pub_audit00001');
  assert.equal((await enablement.list()).approval.publishId, 'pub_audit00001');
  assert.equal((await enablement.list()).audit.at(-1).action, 'approve');
  await enablement.unapprove({ actor: ADMIN, publishId: 'pub_audit00001', reason: '取消' });
  assert.equal(await enablement.adoptDeclaredApproval(), null, '迁移只做一次：取消之后不会再自动设回来');
  assert.equal((await enablement.list()).approval, null);
});

test('旧补丁 0003 由平台指定的任务（记录上 declaredBy: platform）不算名片声明的，也不参与迁移', async () => {
  const at = '2026-10-26T00:28:18.819Z';
  const legacy = (publishId, extra) => ({ publishId, status: 'active', key: KEY, fingerprint: 'd248619a', enabledBy: 'local:poc-reviewer', enabledAt: at, verifiedAt: at, invalidReason: null, updatedAt: at, ...extra });
  const old = { revision: 5, version: 1, audit: [], records: {
    pub_deepres0001: legacy('pub_deepres0001', { card: { name: 'Deep Research', tasks: ['review_advice@1'], declaredBy: 'platform' } }) } };
  const enablement = service(memoryStore(old));
  assert.equal(await enablement.adoptDeclaredApproval(), null, '平台指定的不算声明，不自动成为审批 Agent');
  const shown = await enablement.publication('pub_deepres0001');
  assert.deepEqual([shown.card.declaredTasks, shown.card.tasks, shown.approval], [[], [], false]);
});
