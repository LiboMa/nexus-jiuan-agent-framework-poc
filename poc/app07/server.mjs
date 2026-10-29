/**
 * 测试台上的九安 v0.7.10：照九安 scripts/start-analysis.mjs 组装，九安的包一行不改，只换下面几处：
 *   1. 配置在代码里拼（settings.mjs），不读配置文件；两个本机账号，口令登录换九安的本地票据（front.mjs）。
 *   2. 汇联易连接器的传输换成进程内的假汇联易（fake-hly.mjs，九安真正的测试环境客户端照常跑）；钉钉、回写、SAP、产量参考都不接。
 *   3. 全局 fetch 加出网守卫，只放行 Nexus（guard.mjs）。
 *   4. 原件：下载走假汇联易，页文字由抽取器按 fixtures 给；九安流水线里「下载原件」「抽取页文字」两步是暂停的，
 *      所以 AI 独立建议每一轮先把候选单据的原件读完，再交给九安原来的适配器（否则 Agent 只能回「原件未能核验」）。
 *   5. 模拟来单接口挂在九安的 platformRoutes 钩子上（intake.mjs）；健康检查 /poc/healthz。
 * AI 独立建议（review_advice@1）按配置路由到 Nexus 的发布；调用密钥由管理员在九安「平台 › Agent 接入」页粘贴，九安加密存库。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createPasswordLogin } from '../app/login.mjs';
import { sendError } from '../app/http.mjs';
import { readSettings, jiuanConfig } from './settings.mjs';
import { installOutboundGuard } from './guard.mjs';
import { createFrontDoor } from './front.mjs';
import { intakeRoutes } from './intake.mjs';
import { nexusAccessRoutes } from './nexus-access.mjs';
import { createOperatorCli } from '../app/nexus/cli.mjs';
import { agentCallRoutes, everyDocument } from './agent-calls.mjs';
import { createAgentTests } from './agent-tests.mjs';
import { createEnvelopeChecks } from './envelope-tests.mjs';
import { createKbRoutes } from './kb-routes.mjs';
import { createKbRunner } from './kb-runner.mjs';
import { createKbS3vClient } from './kb-s3v-client.mjs';
import { createKbS3vRoutes } from './kb-s3v-routes.mjs';
import { createCustomRules, customRulesRoutes, docxToText } from './custom-rules.mjs';
import { withAdviceActor, withCustomRules } from './custom-rules-advice.mjs';
import { a2aCall } from '../app/nexus/a2a-client.mjs';
import { fetchAgentCard } from '../app/nexus/catalog.mjs';
import { COMPANIES, CONNECTION_ID, FILES, TENANT_ID } from './fixtures.mjs';
import { createFakeHuilianyi } from './fake-hly.mjs';
import { withOriginalsFirst } from './originals-first.mjs';
import { ROUTED_TASKS, createAgentRouting } from './agent-routes.mjs';
import { loadSeedAnchor } from './seed-anchor.mjs';
import * as J from './jiuan.mjs';

const log = code => console.error(code);
const settings = readSettings();
const config = jiuanConfig(settings, { tenantId: TENANT_ID, connectionId: CONNECTION_ID, companies: COMPANIES });
// 发给哪个发布由「Agent 接入」的启用记录现算（agent-routes.mjs）；启用服务建好之前用初始配置（路由为空）
let routing = null;
const getConfig = () => (routing ? routing.getConfig() : config);
installOutboundGuard({ allowHosts: [new URL(settings.nexusOrigin).hostname], onBlocked: host => console.error(`POC_EGRESS_BLOCKED ${host}`) });
const secretText = name => readFileSync(path.join(settings.secretsDir, name), 'utf8').trim();

const secrets = J.config.analysisSecrets(config);
const key = Buffer.from(secrets.dataKey, 'base64');
const database = J.database.createAnalysisDatabase({ config, secrets }), pool = database.pool;
pool.on?.('error', () => log('ANALYSIS_DATABASE_CONNECTION'));
const store = await database.open({ key, connectionId: config.connectionId });
await store.migrate();
const auth = J.auth.createAnalysisAuth({ getAccounts: () => config.accounts });
const platformStore = J.platformStore.createPlatformStore({ pool });
const secretSource = J.secretSource.createSecretSource({ config: { ...config, protectedSecrets: secrets }, env: {} });
const agentClient = J.nexusA2a.createAgentClient({ nexusOrigin: config.agents.nexusOrigin, contract: J.contractChecks.loadContract(), getKey: async () => null });
// 接受的任务按配置里打开的任务推出（补丁 0003：名片没声明任务的发布启用时，由平台指定这些任务）
const acceptedTasks = Object.entries(config.agents.tasks).filter(([, value]) => value.enabled).map(([task]) => ROUTED_TASKS[task]?.contractTask).filter(Boolean);
const agentEnablement = J.enablement.createAgentEnablement({ store, tenantId: config.scope.tenantId, client: agentClient, acceptedTasks });
await agentEnablement.load();
// 补丁 0003 之前的启用记录没有「审批 Agent」这一项：一次性把名片声明了审批流任务、正在就绪的那个设为审批 Agent（以前就是它在接审批流）
const adopted = await agentEnablement.adoptDeclaredApproval();
if (adopted) log(`POC_APPROVAL_AGENT ${adopted}`);
routing = await createAgentRouting({ enablement: agentEnablement, baseConfig: config, log });
const enablement = routing.enablement;   // 包过的启用服务：页面上启用、换钥匙、停用、复核、标记失效之后刷新路由

const fake = createFakeHuilianyi({ restampSeeds: await loadSeedAnchor(path.join(settings.stateDir, 'seed-anchor.json')), onCall: call => { if (call.blocked) console.error(`POC_HLY_WRITE_BLOCKED ${call.method} ${call.path}`); } });
const registry = J.connectors.createConnectorRegistry({ secretSource, huilianyiSource: config, agents: config.agents, agentKeys: enablement,
  transports: { 'hly-prod': { fetchImpl: fake.fetchImpl, downloadFetchImpl: fake.downloadFetchImpl } } });
const lockPool = database.lockPool();
const gateway = J.callMiddleware.createCallGateway({ store: platformStore, registry, lockPool, processTag: 'analysis-server' });
const agentAssemblers = { 'first_review@1': J.taskService.missingAssembler };
const agentTasks = J.taskService.createAgentTaskService({ store, gateway, enablement, getConfig, assemblers: agentAssemblers,
  authorize: J.taskService.authorizePersonRun,
  listKeys: async () => {
    const [rows] = await pool.query('SELECT scope_key FROM analysis_sync_states WHERE connection_id=? AND scope_key LIKE ?', [config.connectionId, `${J.taskService.AGENT_TASK_KEY_PREFIX}%`]);
    return rows.map(row => row.scope_key);
  } });
try { await agentTasks.recover(); } catch (error) { log(`AGENT_TASK_RECOVER_FAILED ${error?.code || ''}`); }
const nexusAdvice = J.catalog.reviewAdviceOnNexus(config);
try { await gateway.acquire('hly-prod'); } catch (error) { log(`常驻服务未取得汇联易调用权：${error?.code || 'CONNECTOR_GATEWAY_BUSY'}`); }
const client = gateway.govern('hly-prod');
const sourceEnvironment = J.huilianyiSource.expectedSourceEnvironment(config);
const sync = J.sync.createAnalysisSync({ client, store, scope: config.scope, sourceEnvironment, maxPagesPerRun: 20, maxRetries: 0 });
const companyDirectory = J.companyDirectory.createCompanyDirectory({ store, client, sourceEnvironment, tenantId: config.scope.tenantId, log });
const departmentDirectory = J.departmentDirectory.createDepartmentDirectory({ store, client, sourceEnvironment, log });
const approvalIdentity = J.approvalIdentity.createApprovalIdentityService({ store, log });
const milestone = J.milestone.createMilestoneRuntime({ config, getAccounts: () => config.accounts, pool, analysisStore: store, companyDirectory,
  readDataKey: () => key, sessions: auth, seedPath: settings.seedPath, clock: () => new Date() });

let runtimeRegistry = null;
const scope = { pool, connectionId: config.connectionId, tenantId: config.scope.tenantId, companyIds: J.companyScope.companyIdsForScope(config.scope) };
/** 九安流水线里下载、抽取原件是暂停的：AI 独立建议每一轮开始前，先用流水线身份把候选单据的原件读完。 */
async function readOriginalsFirst() {
  const candidates = await J.elementCheck.listElementCheckCandidates(scope);
  for (const candidate of candidates) {
    try {
      await runtimeRegistry.evidenceService.enqueue({ actor: J.serviceIdentity.SYSTEM_PIPELINE, companyId: candidate.companyId, documentId: candidate.id, sourceVersion: candidate.version });
    } catch (error) { log(`POC_ORIGINALS_ENQUEUE_FAILED ${error?.code || ''}`); }
  }
  await runtimeRegistry.evidenceService.idle();
}
const reviewAdviceAdapter = J.elementCheck.createReviewAdviceAdapter({ ...scope, getTaskService: () => agentTasks });
const paused = () => J.pausedCatalog.createPausedAdapter();
const pipelineAdapters = {
  'hly.list-sync': J.listSync.createListSyncAdapter({ store, scope: config.scope, connectionId: config.connectionId, platformStore, sourceEnvironment }),
  'hly.report-detail': J.reportDetail.createReportDetailAdapter({ pool, lockPool, analysisStore: store, key, connectionId: config.connectionId, companyIds: scope.companyIds }),
  'hly.detail-projection': J.detailProjection.createDetailProjectionAdapter({ pool: lockPool, key }),
  'hly.attachment-fetch': paused(), 'local.attachment-extract': paused(), 'sap.payment-snapshot': paused(), 'sap.procurement-production': paused(),
  'audit.ai-advice': withOriginalsFirst(reviewAdviceAdapter, { readOriginals: readOriginalsFirst, log }),
  'audit.element-check': J.elementCheck.createElementCheckAdapter({ ...scope, getTaskService: () => agentTasks }),
  'finance.expense-type-agents': paused(),
};
const runner = J.agentRunner.createAgentRunner({ pool, lockPool, platformStore, gateway, adapters: pipelineAdapters,
  catalog: J.catalog.agentCatalogForInstance(config.instance, { reviewAdvice: nexusAdvice }), log });
const scheduler = J.scheduler.createScheduler({ runner, platformStore, getConfig, scope: config.scope, lanes: ['corporate', 'employee'], mode: 'incremental',
  chain: true, downstream: milestone?.downstream });
const pipelineProgress = J.pipelineProgress.createPipelineProgress({ pool });
const jiuanRoutes = J.platformRoutes.createPlatformRoutes({ pool, store, platformStore, pipelineProgress, scheduler, getConfig, gateway, connectors: registry, runner, agentEnablement: enablement });
const shanghai = options => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', ...options });
const syncRange = () => {
  const end = new Date(Date.now() - 5 * 60 * 1000), start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  return { startDate: `${shanghai().format(start)} 00:00:00`, endDate: shanghai({ hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(end), corporateFlag: true };
};
const syncLoop = {
  start: () => scheduler.start(),
  run: (range, options) => J.callMiddleware.runWithAttribution({ agentId: 'hly.list-sync', runId: null }, () => sync.run(range ?? syncRange(), options)),
  status: () => { const source = sync.status(), scheduled = scheduler.status(); return { ...source, ...scheduled, active: Boolean(source.active || scheduled.active) }; },
  close: async () => { await runner.close(); await scheduler.close(); await sync.close(); },
};

const pagesBySha = new Map([...FILES.values()].map(file => [file.sha256, file.pages]));
const extractor = async document => {
  const pages = pagesBySha.get(document?.sha256);
  return pages
    ? { status: 'ready', method: 'poc-text', totalPages: pages.length, errors: [], pages: pages.map((text, index) => ({ page: index + 1, text })) }
    : { status: 'failed', method: 'none', totalPages: null, errors: ['POC_NO_TEXT'], pages: [] };
};
const runtimeOptions = { config, getConfig, store, sourceClient: client, evidenceFetch: gateway.governFetch('hly-prod', 'attachment.download'),
  attachmentHosts: [...registry.connector('hly-prod').downloadHosts], env: {}, gateway, extractor, adviceConcurrency: 4 };
const anchorRuntime = J.runtimeServices.createAnalysisRuntimeServices({ ...runtimeOptions, scopeCompanyId: config.scope.companyId });
runtimeRegistry = J.runtimeRegistry.createAnalysisRuntimeRegistry({ anchorCompanyId: config.scope.companyId,
  createRuntime: companyId => (companyId === config.scope.companyId ? anchorRuntime : J.runtimeServices.createAnalysisRuntimeServices({ ...runtimeOptions, scopeCompanyId: companyId })) });
const readEvidence = ({ companyId, documentId, version }) => runtimeRegistry.evidenceService.context({ actor: J.serviceIdentity.SYSTEM_PIPELINE, companyId, documentId, sourceVersion: version });
// 「我的规则」：审核员（管理员、分析员）自己的 .md / .docx 规则，存在本机 <stateDir>/custom-rules/<账号>/，两种知识库方式都有
const customRules = createCustomRules({ dir: settings.customRulesDir, docxToText });
const contract = J.contractChecks.loadContract();
// 人从单据页发起时附上这个人的「我的规则」（custom-rules-advice.mjs；页面的 reviewAdvice 也包一层）；流水线、「Agent 接入」页的测试不附
if (nexusAdvice) agentAssemblers['review_advice@1'] = withCustomRules(J.reviewAdviceTask.createReviewAdviceAssembler({ analysisStore: store, readEvidence }),
  { rules: customRules, contract, task: contract.tasks.get('review_advice@1'), log });
const runtime = { ...anchorRuntime, evidenceService: runtimeRegistry.evidenceService, adviceService: runtimeRegistry.adviceService,
  listAdviceSummaries: runtimeRegistry.listAdviceSummaries, close: runtimeRegistry.close };

const intake = intakeRoutes({ fake });
// 「规则库 › 制度知识库」按 POC07_KB_MODE 挂其中一套（同一个前缀，两套不同时挂）：
// - pg：上传审批矩阵 .docx → 解析 → 入库预览 → 确认入库；历史、检索、检索日志（知识库 kb/ 在同一台实例的 PG 容器里）
// - s3vectors：经 A2A 调知识库文档管家的发布读写 S3 Vectors；调用密钥取「Agent 接入」页的启用记录，Nexus 不认时标记失效
const kb = settings.kb?.mode === 's3vectors'
  ? createKbS3vRoutes({ client: createKbS3vClient({ origin: config.agents.nexusOrigin, publishId: settings.kb.publishId,
    credentialFor: id => enablement.credentialFor(id), markInvalid: (id, reason) => enablement.markInvalid(id, reason) }), uploadsDir: settings.kb.uploadsDir, log })
  : settings.kb?.mode === 'pg' ? createKbRoutes({ runner: createKbRunner({ python: settings.kb.python, dir: settings.kb.dir, pg: settings.kb.pg }), uploadsDir: settings.kb.uploadsDir, log }) : null;
if (kb) await kb.start();
const myRules = customRulesRoutes({ rules: customRules, log });
// 「Agent 接入」页的 Nexus 发布列表（补丁 0001 的后端）：管理员连一次 Nexus，列出已发布的 Agent；启用仍走九安原有的接口
const operator = { script: settings.operatorScript, nexusHome: settings.nexusHome, profile: 'jiuan07', origin: settings.nexusOrigin };
const cli = createOperatorCli(operator);
const nexusAccess = nexusAccessRoutes({ origin: settings.nexusOrigin, fetchCard: url => fetchAgentCard(url), cli,
  checkCard: card => J.contractChecks.checkCard(card, { contract }) });
// 「Agent 接入」页的单个 Agent 测试：先读原件，照九安组装 review_advice@1，经九安的调用中间件发给选中的发布（专用会话分区）
const companyIds = COMPANIES.map(company => company.id);
// 文本和请求信封两种测法要看 Agent 的原始回答：用这个发布已启用的调用密钥直接发（九安的适配层只给检查过的结果）
const envelopeChecks = createEnvelopeChecks({ contract, contractDir: path.join(J.JIUAN07_DIR, 'src/agent-contract'),
  extractResultObject: J.contractChecks.extractResultObject, checkResultEnvelope: J.contractChecks.checkResultEnvelope,
  scope: { tenantId: config.scope.tenantId, companyId: config.scope.companyId }, firstTasks: acceptedTasks });
async function callRaw({ publishId, parts, timeoutMs }) {
  const key = await enablement.credentialFor(publishId);
  if (!key) throw Object.assign(new Error('AGENT_NOT_READY'), { code: 'AGENT_NOT_READY' });
  const [first, ...rest] = parts;
  return a2aCall({ url: `${config.agents.nexusOrigin}/a2a/${publishId}`, key, text: first.text, data: rest.filter(part => part.kind === 'data').map(part => part.data), timeoutMs });
}
const agentTests = createAgentTests({ ...envelopeChecks, callRaw,
  readDocument: id => store.getDocument({ id, companyIds }),
  listDocuments: () => everyDocument(page => store.listDocuments({ companyIds, type: 'corporate_payment', ...page })),
  prepare: async document => {
    try { await runtimeRegistry.evidenceService.enqueue({ actor: J.serviceIdentity.SYSTEM_PIPELINE, companyId: document.companyId, documentId: document.id, sourceVersion: document.version }); }
    catch (error) { log(`POC_TEST_ORIGINALS_FAILED ${error?.code || ''}`); }
    await runtimeRegistry.evidenceService.idle();
  },
  assemble: subject => agentAssemblers['review_advice@1'].assemble(subject),
  callAgent: ({ publishId, tenantId, companyId, assembled, partition }) => J.callMiddleware.runWithAttribution({ agentId: 'audit.ai-advice', runId: null },
    () => gateway.govern('nexus-a2a', { tenantId, companyIds: [companyId] }).agentTask({ publishId, request: assembled.request, attempt: 1, partition,
      inputFingerprint: assembled.inputFingerprint, dataContext: { environment: 'prod', purpose: 'read_only_analysis', tenantId, companyId } })),
});
// 「Agent 接入」页的调用记录：从单据池的单据反查九安存的每一轮，加上手动测试
const agentCalls = agentCallRoutes({ log, extraRows: () => agentTests.rows(), tenantId: config.scope.tenantId, tasks: Object.keys(ROUTED_TASKS), agentTaskKey: J.taskService.agentTaskKey,
  listDocuments: () => everyDocument(page => store.listDocuments({ companyIds, ...page })), readState: key => store.readState(key) });
const platformRoutes = { ...jiuanRoutes, async handle(args) {
  return (await nexusAccess.handle(args)) || (await agentTests.handle(args)) || (await agentCalls.handle(args)) || (await intake.handle(args))
    || (await myRules.handle(args)) || (kb ? await kb.handle(args) : false) || jiuanRoutes.handle(args);
} };
const app = J.server.createAnalysisApp({ store, companyDirectory, localAccess: null, referenceStore: null, platformRoutes,
  // 九安的 /auth/exchange 只认本机回环来源；外壳的票据只在口令校验通过后才签发，所以这里放行。
  auth: { ...auth, exchange: ticket => auth.exchange(ticket, { loopback: true }) },
  approvalWritebackService: null, approvalSourceKind: config.source.kind, ...runtime, dingtalk: null, healthCheck: database.health, loginAttemptLimit: 600,
  adviceSummaryProvider: { list: runtime.listAdviceSummaries }, sync: syncLoop, syncRange, syncScope: config.scope, origin: config.origin,
  instance: config.instance, source: 'huilianyi-stage', milestone, elementCheck: J.elementCheckState.createElementCheckState({ tasks: agentTasks }),
  reviewAdvice: nexusAdvice ? withAdviceActor(J.reviewAdviceState.createReviewAdviceState({ tasks: agentTasks })) : null, onError: ({ code }) => log(code) });

const login = createPasswordLogin({ passwords: new Map([['poc-reviewer', secretText('reviewer_password')], ['poc-checker', secretText('checker_password')]]),
  issueTicket: accountId => auth.issueLocalTicket(accountId) });
const door = createFrontDoor({ origin: config.origin, login });
const [jiuanHandler] = app.server.listeners('request');
app.server.removeAllListeners('request');
let ready = false;
app.server.on('request', (req, res) => {
  void (async () => {
    try {
      const url = new URL(req.url, config.origin);
      // 部署脚本和实例内部用的健康检查：不经 CloudFront，不校验主机名。
      if (req.method === 'GET' && url.pathname === '/poc/healthz') {
        res.writeHead(ready ? 200 : 503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(ready ? 'ok' : 'starting');
        return;
      }
      if (await door.serve(req, res, url)) return;
      jiuanHandler(req, res);
    } catch (error) {
      sendError(res, error);
    }
  })();
});
await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(settings.port, settings.bindHost, resolve); });
syncLoop.start();
void companyDirectory.start({ enabled: () => config.automaticSync === true });
void departmentDirectory.start({ enabled: () => config.automaticSync === true });
void approvalIdentity.start();
ready = true;
const routed = getConfig().agents.tasks.review_advice.routes.map(route => route.publishId);
console.log(`九安 v0.7.10 测试台已启动：${config.origin}（端口 ${settings.port}；AI 独立建议按「Agent 接入」的启用记录路由，当前 ${routed.length ? routed.join('、') : '无可用发布'}）`);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  routing.close();
  await companyDirectory.close(); await scheduler.close(); await runner.close(); await sync.close(); await runtime.close(); await app.close();
  await gateway.close(); await approvalIdentity.close(); await departmentDirectory.close(); await store.close(); await pool.end(); await lockPool.end();
}
process.on('SIGTERM', () => void stop().then(() => process.exit(0)));
process.on('SIGINT', () => void stop().then(() => process.exit(0)));
