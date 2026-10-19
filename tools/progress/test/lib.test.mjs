import test from 'node:test';
import assert from 'node:assert/strict';
import { STATUS_LABEL, deriveState, validateManifest } from '../lib.mjs';

const manifest = () => ({
  version: 1,
  project: '九安 × Nexus PoC',
  milestones: [{ id: 'm1', name: '第一期' }, { id: 'm2', name: '上生产前' }],
  capabilities: [
    { id: 'access', name: '我的 Nexus', modules: [
      { id: 'access.store', name: '账号目录', size: 2, status: 'done', milestone: 'm1', tests: ['poc/app/test/unit/access-store.test.mjs'] },
      { id: 'access.me', name: '连接与启用', size: 3, milestone: 'm1', dependsOn: ['access.store'], tests: ['poc/app/test/unit/access-me.test.mjs'],
        tasks: [{ title: '连接', status: 'done' }, { title: '启用', status: 'done' }, { title: '只读档位', status: 'doing' }, { title: '存库', status: 'todo' }] },
    ] },
    { id: 'ops', name: '部署与运维', modules: [
      { id: 'ops.git', name: '代码进 Git', size: 1, status: 'todo', milestone: 'm2' },
      { id: 'ops.tls', name: '源站 HTTPS', size: 3, status: 'blocked', milestone: 'm2', dependsOn: ['ops.git'], blockedReason: '等基础设施评审' },
    ] },
  ],
});

test('validateManifest：合格的清单没有错误；状态都有中文名', () => {
  assert.deepEqual(validateManifest(manifest()).errors, []);
  assert.deepEqual(Object.keys(STATUS_LABEL), ['todo', 'doing', 'testing', 'done', 'blocked']);
});

test('validateManifest：重复编号、未知状态、范围越界、未知依赖、未知里程碑、依赖成环都是错误', () => {
  const bad = manifest();
  bad.capabilities[0].modules.push({ id: 'access.store', name: '重复', size: 1, status: 'done' });
  bad.capabilities[1].modules[0].status = 'finished';
  bad.capabilities[1].modules[1].size = 9;
  bad.capabilities[0].modules[1].dependsOn.push('nope.module');
  bad.capabilities[1].modules[0].milestone = 'm9';
  bad.capabilities[1].modules[0].dependsOn = ['ops.tls'];
  const { errors } = validateManifest(bad);
  for (const expected of [/重复的编号 access\.store/, /ops\.git 的状态 finished/, /ops\.tls 的范围/, /access\.me 依赖了不存在的 nope\.module/, /ops\.git 的里程碑 m9/, /依赖成环：ops\.git → ops\.tls → ops\.git/]) {
    assert.ok(errors.some(error => expected.test(error)), `${expected} 不在 ${JSON.stringify(errors)}`);
  }
});

test('validateManifest：声明的代码和测试文件不存在只是警告；缺 project / capabilities 是错误', () => {
  const { errors, warnings } = validateManifest(manifest(), { exists: file => !file.includes('access-me') });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, ['access.me 的测试文件不存在：poc/app/test/unit/access-me.test.mjs']);
  assert.ok(validateManifest({ version: 1 }).errors.length >= 2);
});

test('deriveState：有任务的模块按任务算状态和进度；能力和总进度按范围加权；依赖的反向关系和还在等的依赖', () => {
  const state = deriveState(manifest());
  const me = state.capabilities[0].modules[1];
  assert.equal(me.status, 'doing');
  assert.equal(me.progress, 0.5);
  assert.deepEqual(state.capabilities[0].modules[0].dependents, ['access.me']);
  const tls = state.capabilities[1].modules[1];
  assert.deepEqual(tls.waitingOn, ['ops.git']);
  assert.equal(state.capabilities[0].progress, (2 * 1 + 3 * 0.5) / 5);
  assert.equal(state.totals.percent, Math.round(((2 * 1 + 3 * 0.5) / 9) * 100));
  assert.deepEqual(state.totals.sizeByStatus, { todo: 1, doing: 3, testing: 0, done: 2, blocked: 3 });
  assert.deepEqual(state.milestones.map(item => [item.id, item.percent]), [['m1', Math.round((3.5 / 5) * 100)], ['m2', 0]]);
});

test('deriveState：测试信号按文件挂到模块上；声称完成但测试没过的标为冲突', () => {
  const signals = { tests: { 'poc/app/test/unit/access-store.test.mjs': { pass: 4, fail: 1 }, 'poc/app/test/unit/access-me.test.mjs': { pass: 9, fail: 0 } } };
  const state = deriveState(manifest(), signals);
  const [store, me] = state.capabilities[0].modules;
  assert.deepEqual(store.tests, { pass: 4, fail: 1, files: 1, missing: 0 });
  assert.deepEqual(store.testFiles, ['poc/app/test/unit/access-store.test.mjs']);
  assert.equal(store.conflict, true);
  assert.deepEqual(me.tests, { pass: 9, fail: 0, files: 1, missing: 0 });
  assert.equal(me.conflict, false);
  assert.equal(state.totals.conflicts, 1);
  assert.equal(deriveState(manifest(), { tests: {} }).capabilities[0].modules[0].tests.missing, 1);
});
