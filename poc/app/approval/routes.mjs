/**
 * 审批流接口（/api/analysis/v1/poc/approvals*）和模拟来单（/api/analysis/v1/poc/intake*），挂在九安的 platformRoutes 钩子上：
 * 会话、来源与 CSRF 已由九安校验。每次读写前先核对单据当前版本；版本变了，未结束的审批即失效。
 * 模拟来单：按模板生成一张新的虚构单据放进单据池，读一遍原件，系统自动发起审批（九安生产上是汇联易同步写入新单据之后触发）。
 */
import { APPROVAL_STATUS, approvalView, createApprovalWorkflow } from './workflow.mjs';
import { createApprovalRunner } from './runner.mjs';
import { fail, onlyFields, onlyQuery, readJson, sendJson } from '../http.mjs';
import { intakeTemplates, simulateArrival } from '../seed.mjs';

const BASE = '/api/analysis/v1/poc/approvals';
const ITEM = /^\/api\/analysis\/v1\/poc\/approvals\/([^/]+)(?:\/([a-z]+))?$/;
const ID = /^[A-Za-z0-9_-]{1,160}$/;
const INTAKE = '/api/analysis/v1/poc/intake';
const ACTIONS = Object.freeze({ start: ['sourceVersion'], retry: ['sourceVersion'], manual: ['sourceVersion'], decide: ['sourceVersion', 'decision', 'reason', 'returnNote'] });
// 单据卡片上显示的初审建议：只带结论、风险和一句摘要
const cardOf = (record, status) => ({ status, label: APPROVAL_STATUS[status], auto: record?.startedBy?.id === 'system',
  advice: record?.ai?.advice ? { modelRecommendation: record.ai.advice.modelRecommendation ?? null, effectiveOutcome: record.ai.advice.effectiveOutcome ?? null,
    riskLevel: record.ai.advice.riskLevel ?? null, summary: String(record.ai.advice.summary ?? '').slice(0, 160) } : null,
  failure: record?.failure ? { stage: record.failure.stage, errorCode: record.failure.errorCode } : null });

export function approvalRoutes({ publishId = null, pollMs, timeoutMs, autoRetryDelayMs, onError, workflow: shared, intakePerMinute = 5 } = {}) {
  return ctx => {
    // 组合根可以传入共用的状态机：审批流取调用密钥时要按单据找发起人（nexus/system-key.mjs）。
    const workflow = shared ?? createApprovalWorkflow();
    const runner = createApprovalRunner({ workflow, registry: ctx.registry, tenantId: ctx.tenantId, publishId,
      ...(pollMs ? { pollMs } : {}), ...(timeoutMs ? { timeoutMs } : {}), ...(autoRetryDelayMs ? { autoRetryDelayMs } : {}), ...(onError ? { onError } : {}) });
    const windows = new Map();
    function limitIntake(userId) {
      const at = Date.now(), entry = windows.get(userId);
      const current = entry && entry.until > at ? entry : { until: at + 60_000, count: 0 };
      if (current.count >= intakePerMinute) fail('POC_INTAKE_RATE_LIMIT', 429);
      current.count += 1;
      windows.set(userId, current);
    }
    // 来单编号存在存储里（测试台重启后接着往下排）；单据经组合根的 writeDocument 写入（测试台：九安同步的写法进 MySQL）。
    async function intake(template, session) {
      const sequence = await ctx.nextIntakeSequence();
      const { raw } = simulateArrival({ template, sequence });
      if (!session.user.companyIds.includes(raw.docCompanyOID)) fail('NOT_FOUND', 404);
      const { document } = await ctx.writeDocument({ raw });
      const actor = ctx.systemActor();
      await ctx.registry.evidenceService.enqueue({ actor, companyId: document.companyId, documentId: document.id, sourceVersion: document.version });
      await ctx.registry.evidenceService.idle();
      runner.autoStart({ document, actor });
      return document;
    }
    async function visibleDocument(id, session) {
      if (!ID.test(id)) fail('NOT_FOUND', 404);
      const document = await ctx.store.getDocument({ id, companyIds: session.user.companyIds });
      if (!document) fail('NOT_FOUND', 404);
      workflow.invalidateIfChanged(document.id, document.version);
      return document;
    }
    return {
      async handle({ req, url, path, session, res }) {
        if (path === INTAKE || path === `${INTAKE}/templates`) {
          const user = ctx.pocUser(session.user);
          if (!user) fail('POC_APPROVAL_FORBIDDEN', 403);
          if (path === `${INTAKE}/templates`) {
            if (req.method !== 'GET') return false;
            onlyQuery(url, []);
            sendJson(res, 200, { data: { items: intakeTemplates() } });
            return true;
          }
          if (req.method !== 'POST') return false;
          onlyQuery(url, []);
          const body = await readJson(req);
          onlyFields(body, ['template']);
          if (typeof body.template !== 'string') fail('INVALID_REQUEST', 400);
          limitIntake(user.id);
          const document = await intake(body.template, session);
          sendJson(res, 201, { data: { document: { id: document.id, number: document.number, companyId: document.companyId, version: document.version },
            approval: approvalView(workflow.get(document.id), user, document.id) } });
          return true;
        }
        if (path !== BASE && !path.startsWith(`${BASE}/`)) return false;
        const user = ctx.pocUser(session.user);
        if (!user) fail('POC_APPROVAL_FORBIDDEN', 403);
        if (path === BASE) {
          if (req.method !== 'GET') return false;
          onlyQuery(url, ['ids']);
          const ids = String(url.searchParams.get('ids') || '').split(',').filter(Boolean);
          if (ids.length > 50 || ids.some(id => !ID.test(id))) fail('INVALID_QUERY', 400);
          const items = {};
          for (const id of ids) {
            const document = await ctx.store.getDocument({ id, companyIds: session.user.companyIds });
            if (!document) continue;
            workflow.invalidateIfChanged(id, document.version);
            items[id] = cardOf(workflow.get(id), workflow.statusOf(id));
          }
          sendJson(res, 200, { data: { items } });
          return true;
        }
        const match = ITEM.exec(path);
        if (!match) return false;
        const [, id, action] = match;
        if (!action) {
          if (req.method !== 'GET') return false;
          onlyQuery(url, []);
          const document = await visibleDocument(id, session);
          sendJson(res, 200, { data: approvalView(workflow.get(document.id), user, document.id) });
          return true;
        }
        if (req.method !== 'POST' || !Object.hasOwn(ACTIONS, action)) return false;
        onlyQuery(url, []);
        const document = await visibleDocument(id, session);
        const body = await readJson(req);
        onlyFields(body, ACTIONS[action]);
        const actor = { ...session.user };
        const { sourceVersion } = body;
        if (action === 'start') runner.start({ document, user, actor, sourceVersion });
        else if (action === 'retry') runner.retry({ document, user, actor, sourceVersion });
        else if (action === 'manual') workflow.manual({ documentId: document.id, user, sourceVersion });
        else workflow.decide({ documentId: document.id, user, sourceVersion, decision: body.decision, reason: body.reason, returnNote: body.returnNote });
        sendJson(res, 200, { data: approvalView(workflow.get(document.id), user, document.id) });
        return true;
      },
      close() { runner.close(); },
    };
  };
}
