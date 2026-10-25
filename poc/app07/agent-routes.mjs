/**
 * AI 独立建议发给哪个发布不写死：「Agent 接入」页上已启用（active）、名片声明了 review_advice@1 的发布，按启用时间从新到旧排；
 * 九安的任务服务取第一条 when 匹配的路由。没有可用的发布时路由为空，这一轮记成 AGENT_TASK_UNROUTED，启用之后九安的流水线自动重排。
 * 九安每次同步调 getConfig()，所以这里缓存一份：包住九安的启用服务，启用、换钥匙、复核、停用、标记失效之后都刷新，另每 30 秒兜底。
 */
export const ROUTED_TASKS = Object.freeze({ review_advice: Object.freeze({ contractTask: 'review_advice@1', when: Object.freeze({ documentType: 'corporate_payment' }) }) });
const WRITES = ['enable', 'rotate', 'refresh', 'disable', 'markInvalid'];
const deepFreeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; };

export function routesFrom(records) {
  const usable = (Array.isArray(records) ? records : []).filter(item => item?.status === 'active' && Array.isArray(item.card?.tasks))
    .sort((left, right) => String(right.enabledAt ?? '').localeCompare(String(left.enabledAt ?? '')));
  return Object.fromEntries(Object.entries(ROUTED_TASKS).map(([task, { contractTask, when }]) =>
    [task, usable.filter(item => item.card.tasks.includes(contractTask)).map(item => ({ when: { ...when }, publishId: item.publishId }))]));
}

export async function createAgentRouting({ enablement, baseConfig, refreshMs = 30_000, log = code => console.error(code) }) {
  let current = baseConfig;
  async function refresh() {
    try {
      const routes = routesFrom((await enablement.list()).records);
      const tasks = Object.fromEntries(Object.entries(baseConfig.agents.tasks).map(([task, value]) => [task, { ...value, ...(routes[task] ? { routes: routes[task] } : {}) }]));
      current = deepFreeze({ ...baseConfig, agents: { ...baseConfig.agents, tasks } });
    } catch (error) { log(`POC_AGENT_ROUTES_REFRESH_FAILED ${error?.code ?? ''}`); }
  }
  const wrapped = Object.freeze({ ...enablement, ...Object.fromEntries(WRITES.filter(name => typeof enablement[name] === 'function')
    .map(name => [name, async (...args) => { try { return await enablement[name](...args); } finally { await refresh(); } }])) });
  await refresh();
  const timer = refreshMs > 0 ? setInterval(() => { void refresh(); }, refreshMs) : null;
  timer?.unref?.();
  return { getConfig: () => current, refresh, enablement: wrapped, close: () => { if (timer) clearInterval(timer); } };
}
