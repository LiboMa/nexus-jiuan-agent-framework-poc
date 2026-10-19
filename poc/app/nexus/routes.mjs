/**
 * Nexus Agent 页的调用测试、调用记录、附件规则与示例附件（/api/analysis/v1/poc/nexus/*），挂在九安的 platformRoutes 钩子上：会话、来源与 CSRF 已由九安校验。
 * 「我的 Nexus」接口（连接、启用）在 access/routes.mjs。调用测试的请求体可以带附件（base64），上限按附件合计大小放宽。
 */
import { createInvoker } from './invoke.mjs';
import { ATTACHMENT_POLICY } from './attachments.mjs';
import { fail, onlyFields, onlyQuery, readJson, sendJson } from '../http.mjs';

const BASE = '/api/analysis/v1/poc/nexus';
const RUN_ID = /^run_[a-z0-9]+_[a-z0-9]+$/;
const SAMPLE_ID = /^[a-z0-9-]{1,60}$/;
/** 附件合计上限按 base64 膨胀（× 4/3）后，再留出文字与 JSON 外壳的余量。 */
export const INVOKE_BODY_MAX = Math.ceil(ATTACHMENT_POLICY.maxTotalBytes / 3) * 4 + 64_000;
const NO_SAMPLES = Object.freeze({ list: () => [], get: () => null });

export function nexusRoutes({ me, runLog, governanceEnv, perMinute, samples = NO_SAMPLES }) {
  return ctx => {
    const invoker = createInvoker({ resolve: (user, publishId) => me.credentialFor(user, publishId), onAuthInvalid: (user, publishId) => me.markInvalid(user, publishId),
      runLog, registry: ctx.registry, store: ctx.store, tenantId: ctx.tenantId, governanceEnv, ...(perMinute ? { perMinute } : {}) });
    return {
      async handle({ req, url, path, session, res }) {
        if (!path.startsWith(`${BASE}/`)) return false;
        const route = path.slice(BASE.length);
        if (route === '/attachment-policy' && req.method === 'GET') {
          onlyQuery(url, []);
          sendJson(res, 200, { data: { attachmentPolicy: ATTACHMENT_POLICY } });
          return true;
        }
        if (route === '/invoke' && req.method === 'POST') {
          onlyQuery(url, []);
          const body = await readJson(req, { maximum: INVOKE_BODY_MAX });
          onlyFields(body, ['publishId', 'mode', 'text', 'documentId', 'attachments']);
          sendJson(res, 202, { data: await invoker.start({ user: session.user, ...body }) });
          return true;
        }
        if (route === '/samples' && req.method === 'GET') {
          onlyQuery(url, []);
          sendJson(res, 200, { data: { items: samples.list() } });
          return true;
        }
        const sample = /^\/samples\/([^/]+)$/.exec(route);
        if (sample && req.method === 'GET') {
          onlyQuery(url, []);
          const found = SAMPLE_ID.test(sample[1]) ? samples.get(sample[1]) : null;
          if (!found) fail('NOT_FOUND', 404);
          sendJson(res, 200, { data: found });
          return true;
        }
        // 调用测试的记录只给发起人看；审批流（source=jiuan）的记录所有人都能看。
        const visible = run => run.source !== 'invoke' || run.actorId === session.user.id;
        if (route === '/runs' && req.method === 'GET') {
          onlyQuery(url, ['limit']);
          const limit = Math.min(50, Math.max(1, Number.parseInt(url.searchParams.get('limit') || '20', 10) || 20));
          sendJson(res, 200, { data: { items: runLog.list(50).filter(visible).slice(0, limit) } });
          return true;
        }
        const match = /^\/runs\/([^/]+)$/.exec(route);
        if (match && req.method === 'GET') {
          onlyQuery(url, []);
          const run = RUN_ID.test(match[1]) ? runLog.get(match[1]) : null;
          if (!run || !visible(run)) fail('NOT_FOUND', 404);
          sendJson(res, 200, { data: run });
          return true;
        }
        return false;
      },
    };
  };
}
