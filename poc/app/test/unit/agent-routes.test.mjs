import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentRouting, routesFrom } from '../../agent-routes.mjs';

const record = (publishId, { status = 'active', tasks = [], approval = false, enabledAt = '2026-10-26T01:00:00Z' } = {}) =>
  ({ publishId, status, approval, card: tasks ? { name: publishId, tasks, declaredTasks: tasks } : null, enabledAt });

test('审批流只调审批 Agent：路由只有管理员指定的那一个（而且要就绪）；别的 Agent 名片声明了什么都不进审批流', () => {
  const routes = routesFrom([
    record('pub_approval', { approval: true, tasks: ['review_advice@1'] }), record('pub_declares', { tasks: ['review_advice@1'], enabledAt: '2026-10-27T00:00:00Z' }),
    record('pub_knowledge', { tasks: ['knowledge_answer@1'] }), record('pub_nocard', { tasks: null }),
  ]);
  assert.deepEqual(routes, { review_advice: [{ when: { documentType: 'corporate_payment' }, publishId: 'pub_approval' }] });
  assert.deepEqual(routesFrom([record('pub_approval', { approval: true, status: 'invalid' })]), { review_advice: [] }, '审批 Agent 密钥失效：审批流这一轮记成没有可用的 Agent');
  assert.deepEqual(routesFrom([]), { review_advice: [] });
});

function fakeEnablement() {
  const records = new Map();
  let approval = null;
  const shown = () => [...records.values()].map(item => ({ ...item, approval: item.publishId === approval }));
  return {
    load: async () => {}, presence: () => (records.size ? 'bound' : 'unbound'), credentialFor: async () => null, publication: async id => records.get(id) ?? null,
    list: async () => ({ configured: true, records: shown(), audit: [], approval: approval ? { publishId: approval } : null }),
    enable: async ({ publishId }) => { records.set(publishId, record(publishId)); return { publishId }; },
    rotate: async () => ({}), refresh: async () => ({}), markInvalid: async publishId => { records.set(publishId, record(publishId, { status: 'invalid' })); },
    disable: async ({ publishId }) => { records.set(publishId, record(publishId, { status: 'disabled' })); return {}; },
    approve: async ({ publishId }) => { approval = publishId; return {}; }, unapprove: async () => { approval = null; return {}; },
  };
}
const BASE = Object.freeze({ instance: 'test', agents: { nexusOrigin: 'https://nexus.test', tasks: { review_advice: { enabled: true, version: 1, routes: [] } } } });

test('页面上设为 / 取消审批 Agent、停用、标记失效之后，九安下一次取配置就用新的路由；只启用不进审批流；配置的其余部分不变', async t => {
  const routing = await createAgentRouting({ enablement: fakeEnablement(), baseConfig: BASE, refreshMs: 0 });
  t.after(() => routing.close());
  const routesNow = () => routing.getConfig().agents.tasks.review_advice.routes.map(route => route.publishId);
  assert.deepEqual(routesNow(), []);
  assert.equal(routing.getConfig(), routing.getConfig(), '两次刷新之间是同一个对象');
  await routing.enablement.enable({ publishId: 'pub_a', key: 'nxa_x', reason: 'r' });
  assert.deepEqual(routesNow(), [], '只启用：就绪，不进审批流');
  await routing.enablement.approve({ publishId: 'pub_a', reason: 'r' });
  assert.deepEqual(routesNow(), ['pub_a']);
  assert.equal(routing.getConfig().agents.nexusOrigin, 'https://nexus.test');
  assert.equal(routing.getConfig().instance, 'test');
  await routing.enablement.markInvalid('pub_a', 'AI_AUTH_INVALID');
  assert.deepEqual(routesNow(), []);
  await routing.enablement.enable({ publishId: 'pub_a', key: 'nxa_y', reason: 'r' });
  assert.deepEqual(routesNow(), ['pub_a']);
  await routing.enablement.unapprove({ publishId: 'pub_a', reason: 'r' });
  assert.deepEqual(routesNow(), []);
  assert.equal(typeof routing.enablement.credentialFor, 'function');
});
