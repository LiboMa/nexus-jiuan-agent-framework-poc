/**
 * 测试台的平台部分，组装方式照九安 scripts/start-analysis.mjs：平台存储 → 连接器登记 → 调用中间件 → 流水线运行器 → 调度 → 平台接口。
 * 不接汇联易、钉钉：什么密钥都不绑定（docker 模式下密钥只从环境变量和文件来，这里两样都给空）；会调汇联易的那几站换成暂停。
 * 不调 gateway.acquire：它会长期占住连接池 5 条里的 2 条。
 */
import {
  createAgentRunner, createCallGateway, createConnectorRegistry, createDetailProjectionAdapter, createPausedAdapter,
  createPipelineProgress, createPlatformRoutes, createPlatformStore, createScheduler, createSecretSource,
} from '../jiuan-mysql.mjs';

const PAUSED = ['hly.list-sync', 'hly.report-detail', 'hly.attachment-fetch', 'local.attachment-extract', 'audit.ai-advice', 'audit.draft-evidence',
  'audit.published-rule-trial', 'finance.expense-type-agents'];

/** key 是九安数据密钥（Buffer，32 字节）：明细整理那一站要用它解开存着的明细。 */
export function createBenchPlatform({ pool, store, config, key }) {
  const getConfig = () => config;
  const platformStore = createPlatformStore({ pool });
  const secretSource = createSecretSource({ config: { ...config, protectedSecrets: {} }, env: {} });
  const connectors = createConnectorRegistry({ secretSource, transports: {}, huilianyiSource: config });
  const gateway = createCallGateway({ store: platformStore, registry: connectors, lockPool: pool, processTag: 'poc-bench' });
  const adapters = Object.fromEntries(PAUSED.map(id => [id, createPausedAdapter()]));
  adapters['hly.detail-projection'] = createDetailProjectionAdapter({ pool, key });
  const runner = createAgentRunner({ pool, platformStore, gateway, adapters, log: code => console.error(`PLATFORM_${code}`) });
  const scheduler = createScheduler({ runner, platformStore, getConfig, scope: config.scope, lanes: ['corporate', 'employee'], mode: 'incremental', chain: false });
  const pipelineProgress = createPipelineProgress({ pool });
  const platformRoutes = createPlatformRoutes({ pool, store, platformStore, pipelineProgress, scheduler, getConfig, gateway, connectors, runner });
  let closing = null;
  return {
    platformRoutes, runner, scheduler, gateway, connectors,
    close() {
      closing ??= (async () => { await scheduler.close(); await runner.close(); await gateway.close(); })();
      return closing;
    },
  };
}
