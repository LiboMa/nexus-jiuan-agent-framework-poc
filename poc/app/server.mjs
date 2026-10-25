/**
 * 入口（EC2 上由 systemd 以 /usr/bin/node-24 启动）：读环境变量与密钥配置文件 → 组装（每个账号的 Nexus 连接与启用、调用测试、审批流）→ 监听 → 读一遍原件。
 * 测试里直接调用 main()，用临时的密钥配置文件与账号目录，不连 AWS；fetchCard、verifyKey、describe、cliFor 都可以换成桩，不连 Nexus。
 * 测试台（POC_STORE=mysql）：先起一个只回「starting」的服务占住端口，等到 MySQL 能连上（一直等，不退出，免得崩溃重启覆盖回滚点），
 * 写种子单据、组装九安的平台部分，再把端口交给 PoC。openStore、createPlatform 可以换成桩（本机测试不起 MySQL）。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createPocApp, jiuanConfig } from './poc-app.mjs';
import { SEED_RAWS, TENANT_ID, createRawLookup } from './seed.mjs';
import { lookupRaw, rememberRaw, seedBench, writeRaws } from './bench/state.mjs';
import { BENCH_CONNECTION_ID, BENCH_JIUAN_CONFIG } from './bench/settings.mjs';
import { readEnvConfig } from './config.mjs';
import { a2aKeysFrom, passwordsFrom, readSecretsFile, registryKeyFrom } from './secrets.mjs';
import { approvalRoutes } from './approval/routes.mjs';
import { createApprovalWorkflow } from './approval/workflow.mjs';
import { createOperatorCli } from './nexus/cli.mjs';
import { createKeyStore } from './nexus/keys.mjs';
import { fetchAgentCard } from './nexus/catalog.mjs';
import { loadSamples } from './nexus/samples.mjs';
import { createNexusModelClient } from './nexus/model-client.mjs';
import { createSystemKeyResolver } from './nexus/system-key.mjs';
import { createRunLog } from './nexus/runs.mjs';
import { governanceEnv } from './nexus/governance.mjs';
import { nexusRoutes } from './nexus/routes.mjs';
import { createUserStore } from './access/store.mjs';
import { createMeService } from './access/me.mjs';
import { meRoutes } from './access/routes.mjs';
import { loadManifest, verifyCallKey } from './access/verify.mjs';

export async function main({ env = process.env, log = console, fetchCard = url => fetchAgentCard(url), verifyKey = verifyCallKey, describe = loadManifest, cliFor,
  openStore = null, createPlatform = null, dbRetryMs = 2000, maxDbAttempts = Infinity } = {}) {
  const settings = readEnvConfig(env);
  const { nexus } = settings;
  const secrets = () => readSecretsFile(settings.secretsFile);
  const initial = await secrets();
  const passwords = passwordsFrom(initial);
  const registryKey = registryKeyFrom(initial);
  // 系统提供的 Agent：secrets.env 里 NEXUS_A2A_KEY_<发布编号>，所有人可见、不用启用；审批流的密钥先从页面上的启用记录里读，这一把只是兜底。
  const keyStore = createKeyStore({ load: async () => a2aKeysFrom(await secrets()) });
  await keyStore.reload();
  const runLog = createRunLog();
  const store = createUserStore({ root: settings.usersDir });
  const me = createMeService({ store, registryKey, keyStore, fetchCard, verifyKey, loadManifest: describe, nexusOrigin: nexus.origin, advisoryPublishId: nexus.advisoryPublishId,
    cliFor: cliFor ?? (async accountId => createOperatorCli({ script: nexus.operatorScript, nexusHome: await store.nexusHomeFor(accountId), profile: 'default', origin: nexus.origin })) });
  // 示例附件不合规是代码问题（单元测试会先发现）；万一发生，调用测试照常可用，只是没有示例附件。
  const samples = await loadSamples().catch(error => { log.error(`SAMPLES_ERROR ${error?.code ?? 'UNKNOWN'}`); return undefined; });
  const governance = governanceEnv();
  // 审批流的调用密钥从系统里读：发起人在 Agent 页启用的那把 → 别的账号启用的 → secrets.env（nexus/system-key.mjs）。
  const approvals = createApprovalWorkflow();
  const systemKey = createSystemKeyResolver({ me, workflow: approvals, publishId: nexus.advisoryPublishId });
  const modelClient = createNexusModelClient({ publishId: nexus.advisoryPublishId, rpcUrl: `${nexus.origin}/a2a/${nexus.advisoryPublishId}`,
    getKey: systemKey.getKey, onAuthRejected: systemKey.onAuthRejected, env: governance, runLog, source: 'jiuan' });
  const plugins = [
    approvalRoutes({ publishId: nexus.advisoryPublishId, workflow: approvals, onError: error => log.error(`APPROVAL_ERROR ${error?.code ?? 'UNKNOWN'}`) }),
    meRoutes({ me }),
    nexusRoutes({ me, runLog, governanceEnv: governance, samples }),
  ];
  const onError = ({ code } = {}) => log.error(`APP_ERROR ${code ?? 'UNKNOWN'}`);
  const common = { origin: settings.origin, publicDir: settings.publicDir, passwords, modelClient, plugins, onError, forward: settings.forward };
  if (settings.store.kind === 'mysql') return startBench({ settings, common, log, me, keyStore, openStore, createPlatform, dbRetryMs, maxDbAttempts });
  const app = createPocApp(common);
  tuneServer(app.server);
  await listen(app.server, settings.port, settings.bindHost);
  log.info(`andon-finance-poc listening on ${settings.bindHost}:${app.server.address().port}`);
  await app.warmUp();
  return { app, server: app.server, me, keyStore, stop: () => app.close() };
}

// CloudFront 与源站的空闲长连接最多保持 5 秒；源站保持得更久，避免 CloudFront 复用一条刚被源站关掉的连接（502）。
function tuneServer(server) {
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
}
const listen = (server, port, host) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); }); });
const closeServer = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); });

async function startBench({ settings, common, log, me, keyStore, openStore, createPlatform, dbRetryMs, maxDbAttempts }) {
  const { store: storeSettings } = settings;
  const password = (await readFile(storeSettings.passwordFile, 'utf8')).trim();
  const dataKey = (await readFile(storeSettings.dataKeyFile, 'utf8')).trim();
  // 等库期间先占住端口：健康检查回 503「starting」，CloudFront 看到的是「还没好」，不是连不上。
  const starting = createServer((req, res) => { res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end('starting'); });
  tuneServer(starting);
  await listen(starting, settings.port, settings.bindHost);
  const port = starting.address().port;
  log.info(`andon-finance-poc starting on ${settings.bindHost}:${port} (waiting for MySQL)`);
  const open = openStore ?? (await import('./bench/store.mjs')).openBenchStore;
  let handle;
  for (let attempt = 1; ; attempt += 1) {
    try {
      handle = await open({ database: storeSettings.database, password, dataKey, connectionId: BENCH_CONNECTION_ID });
      break;
    } catch (error) {
      if (attempt >= maxDbAttempts) { await closeServer(starting); throw error; }
      if (attempt === 1 || attempt % 15 === 0) log.error(`BENCH_DB_WAIT ${error?.code ?? 'UNKNOWN'}`);
      await delay(dbRetryMs);
    }
  }
  const { store } = handle;
  await seedBench(store, { tenantId: TENANT_ID, raws: SEED_RAWS.map(item => item.raw) });
  const config = jiuanConfig({ extra: BENCH_JIUAN_CONFIG });
  const build = createPlatform ?? (await import('./bench/platform.mjs')).createBenchPlatform;
  const platform = build({ pool: handle.pool, store, config, key: Buffer.from(dataKey, 'base64') });
  // 模拟来单：照九安同步的写法写进库，原文另存一份（九安读单据详情时按单据号来取），编号和版本由九安算。
  const writeDocument = async ({ raw }) => {
    await writeRaws(store, { tenantId: TENANT_ID, raws: [raw] });
    await rememberRaw(store, raw);
    const companyIds = [raw.docCompanyOID];
    const head = (await store.listDocuments({ companyIds, q: raw.businessCode, limit: 1 })).items[0];
    const document = head ? await store.getDocument({ id: head.id, companyIds }) : null;
    if (!document) throw Object.assign(new Error('POC_DOCUMENT_NOT_STORED'), { code: 'POC_DOCUMENT_NOT_STORED', status: 500 });
    return { document };
  };
  const app = createPocApp({ ...common, store, config, jiuanPlatformRoutes: platform.platformRoutes, writeDocument, dbHealth: handle.health,
    rawLookup: createRawLookup({ arrived: number => lookupRaw(store, number) }) });
  tuneServer(app.server);
  await closeServer(starting);
  await listen(app.server, port, settings.bindHost);
  log.info(`andon-finance-poc listening on ${settings.bindHost}:${port} (mysql)`);
  await app.warmUp();
  return {
    app, server: app.server, me, keyStore,
    async stop() { await app.close(); await platform.close(); await handle.close(); },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { stop } = await main();
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void stop().finally(() => process.exit(0)); });
}
