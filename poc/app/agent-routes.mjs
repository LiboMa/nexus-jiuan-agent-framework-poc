/**
 * AI 独立建议发给哪个发布不写死，也不按名片猜：只发给「Agent 接入」页上管理员指定的那一个审批 Agent（补丁 0003），而且它要就绪（active）。
 * 别的 Agent 启用后只是就绪，供前端工作流调用，名片声明了什么都不进审批流。没有审批 Agent（或它停用、密钥失效）时路由为空，
 * 这一轮记成 AGENT_TASK_UNROUTED；指定之后九安的流水线自动重排。九安的任务服务另按 publication().card.tasks 再查一遍（同样只有审批 Agent 带这个任务）。
 * 九安每次同步调 getConfig()，所以这里缓存一份：包住九安的启用服务，启用、换钥匙、复核、停用、标记失效、设为 / 取消审批 Agent 之后都刷新，另每 30 秒兜底。
 */
export const ROUTED_TASKS = Object.freeze({ review_advice: Object.freeze({ contractTask: 'review_advice@1', when: Object.freeze({ documentType: 'corporate_payment' }) }) });
const WRITES = ['enable', 'rotate', 'refresh', 'disable', 'markInvalid', 'approve', 'unapprove'];
const deepFreeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; };

export function routesFrom(records) {
  const approval = (Array.isArray(records) ? records : []).filter(item => item?.approval === true && item.status === 'active');
  return Object.fromEntries(Object.entries(ROUTED_TASKS).map(([task, { when }]) => [task, approval.map(item => ({ when: { ...when }, publishId: item.publishId }))]));
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
