import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentRouting, routesFrom } from '../../agent-routes.mjs';

const record = (publishId, { status = 'active', tasks = ['review_advice@1'], enabledAt = '2026-10-26T01:00:00Z' } = {}) =>
  ({ publishId, status, card: tasks ? { name: publishId, tasks } : null, enabledAt });

test('路由不写死：只取已启用、名片声明了 review_advice@1 的发布，新启用的排前面', () => {
  const routes = routesFrom([
    record('pub_old', { enabledAt: '2026-10-25T01:00:00Z' }), record('pub_new', { enabledAt: '2026-10-26T02:00:00Z' }),
    record('pub_invalid', { status: 'invalid' }), record('pub_disabled', { status: 'disabled' }),
    record('pub_knowledge', { tasks: ['knowledge_answer@1'] }), record('pub_nocard', { tasks: null }),
  ]);
  assert.deepEqual(routes, { review_advice: [{ when: { documentType: 'corporate_payment' }, publishId: 'pub_new' },
    { when: { documentType: 'corporate_payment' }, publishId: 'pub_old' }] });
  assert.deepEqual(routesFrom([]), { review_advice: [] });
});

function fakeEnablement() {
  const records = new Map();
  return {
    load: async () => {}, presence: () => (records.size ? 'bound' : 'unbound'), credentialFor: async () => null, publication: async id => records.get(id) ?? null,
    list: async () => ({ configured: true, records: [...records.values()], audit: [] }),
    enable: async ({ publishId }) => { records.set(publishId, record(publishId)); return { publishId }; },
    rotate: async () => ({}), refresh: async () => ({}), markInvalid: async publishId => { records.set(publishId, record(publishId, { status: 'invalid' })); },
    disable: async ({ publishId }) => { records.set(publishId, record(publishId, { status: 'disabled' })); return {}; },
  };
}
const BASE = Object.freeze({ instance: 'test', agents: { nexusOrigin: 'https://nexus.test', tasks: { review_advice: { enabled: true, version: 1, routes: [] } } } });

test('页面上启用、停用、标记失效之后，九安下一次取配置就用新的路由；配置的其余部分不变', async t => {
  const routing = await createAgentRouting({ enablement: fakeEnablement(), baseConfig: BASE, refreshMs: 0 });
  t.after(() => routing.close());
  const routesNow = () => routing.getConfig().agents.tasks.review_advice.routes.map(route => route.publishId);
  assert.deepEqual(routesNow(), []);
  assert.equal(routing.getConfig(), routing.getConfig(), '两次刷新之间是同一个对象');
  await routing.enablement.enable({ publishId: 'pub_a', key: 'nxa_x', reason: 'r' });
  assert.deepEqual(routesNow(), ['pub_a']);
  assert.equal(routing.getConfig().agents.nexusOrigin, 'https://nexus.test');
  assert.equal(routing.getConfig().instance, 'test');
  await routing.enablement.markInvalid('pub_a', 'AI_AUTH_INVALID');
  assert.deepEqual(routesNow(), []);
  await routing.enablement.enable({ publishId: 'pub_a', key: 'nxa_y', reason: 'r' });
  await routing.enablement.disable({ publishId: 'pub_a', reason: 'r' });
  assert.deepEqual(routesNow(), []);
  assert.equal(typeof routing.enablement.credentialFor, 'function');
});
