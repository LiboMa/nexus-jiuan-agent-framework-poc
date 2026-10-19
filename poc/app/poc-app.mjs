/**
 * 组装 PoC：九安原服务端（createAnalysisApp）+ 内存存储 + 两家虚构公司的九安运行时 + 口令登录 + 前端副本托管。
 * 运行时的组合与九安 scripts/start-analysis.mjs 相同：锚定公司一个运行时，其余公司经运行时注册表按需创建。
 * PoC 自己的接口以插件形式挂在九安的 platformRoutes 钩子上（/api/analysis/v1/poc/*）：主机名、来源、会话与 CSRF 都由九安先校验。
 * 测试台（server.mjs 的 mysql 模式）注入九安的 MySQL 存储和九安的平台接口：PoC 插件先处理，不认的交给九安的平台接口。
 */
import {
  createAnalysisApp, createAnalysisAuth, createAnalysisRuntimeServices, createAnalysisRuntimeRegistry, createAnalysisRuleWorkspace,
  analysisPrincipal, analysisProviderScopes, normalizeAnalysisReport,
} from './jiuan.mjs';
import { createMemoryStore } from './memory-store.mjs';
import { COMPANIES, CONNECTION_ID, FILES, FILE_HOST, TENANT_ID, buildSeedDocuments, createRawLookup, rawForNumber } from './seed.mjs';
import { nextIntakeSequence } from './bench/state.mjs';
import { ACCOUNTS } from './accounts.mjs';
import { createPasswordLogin } from './login.mjs';
import { clientIp, createStaticFiles, fail, onlyFields, readJson, sendError, sendJson } from './http.mjs';

const LOGIN_PATH = '/api/analysis/v1/poc/login';
export const STATIC_FILES = Object.freeze({
  '/': 'analysis.html', '/analysis.html': 'analysis.html', '/analysis.js': 'analysis.js', '/analysis.css': 'analysis.css',
  '/platform-center.js': 'platform-center.js', '/platform-center.css': 'platform-center.css', '/platform-ops.js': 'platform-ops.js',
  '/workspace-ui.js': 'workspace-ui.js', '/workspace-theme.css': 'workspace-theme.css', '/favicon.svg': 'favicon.svg',
  '/date-format.js': 'date-format.js', '/audit-terms.js': 'audit-terms.js', '/nexus-poc.js': 'nexus-poc.js', '/nexus-invoke.js': 'nexus-invoke.js', '/nexus-poc.css': 'nexus-poc.css',
});

/** 运行时服务要求的「操作人」：与九安 /session 里的 user 同形（id、角色、模式、主体、公司范围）。 */
export function actorFor(account) {
  return { id: account.id, name: account.name, role: account.role, companyIds: [...account.companyIds], mode: account.mode,
    principalId: analysisPrincipal(account), providerScopes: analysisProviderScopes(account.providerScopes, account.companyIds) };
}

/** 九安的配置对象（PoC 在代码里拼，不经九安的配置加载器）。测试台经 extra 多加几项（bench/settings.mjs）。 */
export function jiuanConfig({ extra = {} } = {}) {
  const companyIds = COMPANIES.map(company => company.id);
  const accounts = Object.freeze(ACCOUNTS.map(account => Object.freeze({ id: account.id, name: account.name, enabled: true, role: account.role,
    mode: 'local_owner', companyIds: [...companyIds] })));
  return Object.freeze({ ...extra, environment: 'prod', instance: 'test', accounts,
    scope: Object.freeze({ tenantId: TENANT_ID, companyId: companyIds[0], allCompaniesInTenant: true }) });
}

/**
 * 可注入（测试台用；不给就是内存模式的做法）：
 *   store：九安的存储；jiuanPlatformRoutes：九安的平台接口；config：jiuanConfig() 的结果；
 *   writeDocument({ raw }) → { document }：写入一张单据原文，返回九安存好的单据；rawLookup(number) → 原文或 null。
 */
export function createPocApp({ origin, publicDir, passwords, modelClient, plugins = [], onError = () => {},
  store: injectedStore = null, jiuanPlatformRoutes = null, config: injectedConfig = null, writeDocument: injectedWrite = null, rawLookup: injectedLookup = null, dbHealth = null }) {
  const host = new URL(origin).host;
  const companyIds = COMPANIES.map(company => company.id);
  const config = injectedConfig ?? jiuanConfig();
  const { accounts } = config;
  const documents = injectedStore ? [] : buildSeedDocuments();
  const store = injectedStore ?? createMemoryStore({ documents, companies: COMPANIES });
  const rawLookup = injectedLookup ?? createRawLookup({ arrived: async number => rawForNumber(number) });
  // 内存模式：九安规整后直接放进内存存储（原文已由 simulateArrival 登记在本进程里）。
  const writeDocument = injectedWrite ?? (async ({ raw }) => {
    const document = { ...normalizeAnalysisReport(structuredClone(raw), { scope: { tenantId: TENANT_ID, companyId: raw.docCompanyOID }, connectionId: CONNECTION_ID }),
      collectedAt: new Date().toISOString() };
    await store.addDocument(document);
    return { document };
  });
  const auth = createAnalysisAuth({ getAccounts: () => config.accounts });
  const ruleProvider = createAnalysisRuleWorkspace({ store, tenantId: TENANT_ID, getAccounts: () => config.accounts });
  const pagesBySha = new Map([...FILES.values()].map(file => [file.sha256, file.pages]));
  const runtimeOptions = {
    config, getConfig: () => config, store, ruleProvider, modelClient,
    sourceClient: {
      async getReportDetail({ businessCode }) {
        const raw = await rawLookup(businessCode);
        if (!raw) fail('NOT_FOUND', 404);
        return { response: raw };
      },
    },
    evidenceFetch: async url => {
      const file = FILES.get(String(url));
      return file
        ? new Response(file.bytes, { headers: { 'content-type': 'application/pdf', 'content-length': String(file.bytes.length) } })
        : new Response(null, { status: 404 });
    },
    attachmentHosts: [FILE_HOST],
    extractor: async file => {
      const pages = pagesBySha.get(file.sha256);
      return pages
        ? { status: 'ready', method: 'poc-text', totalPages: pages.length, errors: [], pages: pages.map((text, index) => ({ page: index + 1, text })) }
        : { status: 'failed', method: 'none', totalPages: null, errors: ['POC_NO_TEXT'], pages: [] };
    },
  };
  const anchor = createAnalysisRuntimeServices({ ...runtimeOptions, scopeCompanyId: companyIds[0] });
  const registry = createAnalysisRuntimeRegistry({ anchorCompanyId: companyIds[0],
    createRuntime: companyId => (companyId === companyIds[0] ? anchor : createAnalysisRuntimeServices({ ...runtimeOptions, scopeCompanyId: companyId })) });
  const pocUser = user => {
    const account = ACCOUNTS.find(item => item.id === user?.id);
    return account ? { id: account.id, name: account.name, pocRole: account.pocRole } : null;
  };
  // 后台任务（读原件、来单后自动预审和 AI 初审）用的运行时操作人：九安运行时只接受 admin / analyst，PoC 借用审核员账号的身份。并入九安时换成服务身份。
  const systemActor = () => actorFor(accounts.find(account => account.id === 'poc-reviewer'));
  const mounted = plugins.map(plugin => plugin({ tenantId: TENANT_ID, companies: COMPANIES, accounts, store, registry, pocUser, actorFor, systemActor,
    writeDocument, nextIntakeSequence: () => nextIntakeSequence(store) }));
  let ready = false;
  const app = createAnalysisApp({
    store, ruleProvider, origin, instance: 'test', source: injectedStore ? 'poc-bench' : 'poc-memory', loginAttemptLimit: 600, onError,
    // 九安的 /auth/exchange 只认本机回环来源；PoC 的票据只在口令校验通过后才签发，所以这里放行。
    auth: { ...auth, exchange: ticket => auth.exchange(ticket, { loopback: true }) },
    evidenceService: registry.evidenceService, adviceService: registry.adviceService, draftEvidenceService: registry.draftEvidenceService,
    adviceSummaryProvider: { list: registry.listAdviceSummaries },
    // 九安的平台接口还有审计回调（recordAuth 等），原样透传；handle 先轮 PoC 插件，都不认再交给九安。
    platformRoutes: { ...(jiuanPlatformRoutes ?? {}), async handle(args) {
      for (const route of mounted) if (await route.handle(args)) return true;
      return jiuanPlatformRoutes ? jiuanPlatformRoutes.handle(args) : false;
    } },
    // 测试台：健康检查同时问一次库（九安的 SELECT 1，3 秒超时）；库断了就回 503，database 是 unavailable。
    healthCheck: async () => ready && (dbHealth ? (await dbHealth()) === true : true),
  });
  const login = createPasswordLogin({ passwords, issueTicket: accountId => auth.issueLocalTicket(accountId) });
  const statics = createStaticFiles({ dir: publicDir, files: STATIC_FILES });
  const [jiuanHandler] = app.server.listeners('request');
  app.server.removeAllListeners('request');
  app.server.on('request', (req, res) => { void dispatch(req, res); });

  async function dispatch(req, res) {
    try {
      const url = new URL(req.url, origin);
      // 实例内部与部署脚本用的健康检查：不经 CloudFront，所以不校验主机名。
      if (req.method === 'GET' && url.pathname === '/poc/healthz') {
        res.writeHead(ready ? 200 : 503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(ready ? 'ok' : 'starting');
        return;
      }
      if (req.headers.host !== host || req.headers['sec-fetch-site'] === 'cross-site') fail('ORIGIN_INVALID', 403);
      if (url.pathname === LOGIN_PATH) {
        if (req.method !== 'POST') fail('NOT_FOUND', 404);
        if (req.headers.origin !== origin) fail('ORIGIN_INVALID', 403);
        const body = await readJson(req, { maximum: 2000 });
        onlyFields(body, ['account', 'password']);
        sendJson(res, 200, { data: login.login({ account: body.account, password: body.password, ip: clientIp(req) }) });
        return;
      }
      if (req.method === 'GET' && !url.pathname.startsWith('/api/') && await statics.serve(res, url)) return;
      jiuanHandler(req, res);
    } catch (error) {
      sendError(res, error);
    }
  }

  /** 服务启动后先把各单据的原件读一遍（九安要求先读原件再做 AI 建议，否则建议的缓存键会变）。读完才报告健康。 */
  async function warmUp() {
    const actor = systemActor();
    const heads = (await store.listDocuments({ companyIds, limit: 50 })).items;
    for (const document of heads) {
      try {
        await registry.evidenceService.enqueue({ actor, companyId: document.companyId, documentId: document.id, sourceVersion: document.version });
      } catch (error) {
        onError({ code: typeof error?.code === 'string' ? error.code : 'POC_WARMUP_FAILED' });
      }
    }
    await registry.evidenceService.idle();
    ready = true;
  }

  return {
    server: app.server, warmUp, store, registry, auth, documents, config,
    async close() {
      for (const route of mounted) await route.close?.();
      await registry.close();
      app.server.closeIdleConnections?.();
      await app.close();
    },
  };
}
