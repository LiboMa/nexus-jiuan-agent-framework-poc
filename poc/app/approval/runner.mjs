/**
 * 审批流的后台执行：九安预审（当前快照的基础检查与规则试跑）→ 九安 AI 建议服务（模型客户端经 A2A 调 Nexus）→ 写回状态机。
 * 只调用状态机的系统回调；结果只进 ai 字段。超时、九安的失败记录和入队被拒，都落到「AI 初审失败」：
 * 系统隔一会儿自动重试一次（每轮审批一次），再失败就等人重试或转人工。来单时由 autoStart 自动发起，不需要有人点。
 */
import { createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const DONE = new Set(['completed', 'failed', 'cancelled', 'stale']);
const codeOf = (error, fallback) => (typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,60}$/.test(error.code) ? error.code : fallback);

export function precheckSummary(precheck, ruleTrial) {
  const count = items => (Array.isArray(items) ? items : []).reduce((counts, item) => {
    const status = String(item?.status ?? 'unknown');
    counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  }, {});
  return { baseChecks: Array.isArray(precheck?.checks) ? precheck.checks.length : 0, baseByStatus: count(precheck?.checks),
    rules: Array.isArray(ruleTrial?.items) ? ruleTrial.items.length : 0, rulesByStatus: count(ruleTrial?.items) };
}

export function adviceOf(record) {
  const advice = record?.advice ?? {};
  return { modelRecommendation: advice.modelRecommendation ?? null, effectiveOutcome: advice.effectiveOutcome ?? null, riskLevel: advice.riskLevel ?? null,
    confidence: advice.confidence ?? null, summary: advice.summary ?? '', keyFindings: advice.keyFindings ?? [], requiredActions: advice.requiredActions ?? [],
    unresolvedQuestions: advice.unresolvedQuestions ?? [], conflictFlags: advice.conflictFlags ?? [] };
}

export function createApprovalRunner({ workflow, registry, tenantId, publishId = null, pollMs = 1000, timeoutMs = 300_000, autoRetryDelayMs = 5000,
  clock = Date.now, wait = sleep, onError = () => {} }) {
  let closed = false;
  const timers = new Set();
  // 旧一轮的回调被状态机拒绝（POC_APPROVAL_TRANSITION）是正常情况，其余错误上报。
  const apply = step => { try { step(); } catch (error) { if (error?.code !== 'POC_APPROVAL_TRANSITION') onError(error); } };
  // 失败之后：这一轮还没自动重试过，就隔 autoRetryDelayMs 再来一次
  function autoRetryLater(documentId, attempt, job) {
    if (closed || !workflow.canAutoRetry(documentId)) return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (closed) return;
      let record;
      try { record = workflow.autoRetry(documentId, attempt); } catch (error) { if (error?.code !== 'POC_APPROVAL_TRANSITION') onError(error); return; }
      run(record, job);
    }, autoRetryDelayMs);
    timer.unref?.();
    timers.add(timer);
  }

  async function precheck(documentId, attempt, job) {
    try {
      const current = await registry.get(job.companyId).readCurrent({ actor: job.actor, tenantId, companyId: job.companyId, documentId });
      apply(() => workflow.precheckDone(documentId, attempt, { summary: precheckSummary(current.precheck, current.ruleTrial),
        precheckHash: digest(current.precheck), rulesHash: digest(current.ruleTrial) }));
      return true;
    } catch (error) {
      apply(() => workflow.precheckFailed(documentId, attempt, { errorCode: codeOf(error, 'POC_PRECHECK_FAILED') }));
      autoRetryLater(documentId, attempt, job);
      return false;
    }
  }

  async function advise(documentId, attempt, job) {
    const started = clock();
    const scope = { actor: job.actor, companyId: job.companyId, documentId };
    let record;
    try {
      record = await registry.adviceService.enqueue({ ...scope, sourceVersion: job.sourceVersion });
      while (!DONE.has(record?.status)) {
        if (closed) return;
        if (clock() - started >= timeoutMs) {
          apply(() => workflow.aiFailed(documentId, attempt, { errorCode: 'POC_AI_TIMEOUT', message: `Agent 在 ${Math.round(timeoutMs / 1000)} 秒内没有返回。`,
            latencyMs: clock() - started }));
          autoRetryLater(documentId, attempt, job);
          return;
        }
        await wait(pollMs);
        record = await registry.adviceService.view(scope);
      }
    } catch (error) {
      apply(() => workflow.aiFailed(documentId, attempt, { errorCode: codeOf(error, 'AI_UNAVAILABLE'), latencyMs: clock() - started }));
      autoRetryLater(documentId, attempt, job);
      return;
    }
    const latencyMs = clock() - started;
    if (record.status === 'completed') {
      const generated = Date.parse(record.generatedAt);
      apply(() => workflow.aiDone(documentId, attempt, { advice: adviceOf(record), model: record.model ?? null, publishId, rulesHash: record.rulesHash ?? null,
        evidenceHash: record.evidenceHash ?? null, contextHash: record.contextHash ?? null, generatedAt: record.generatedAt ?? null,
        reused: Number.isFinite(generated) && generated < started, latencyMs }));
    } else {
      apply(() => workflow.aiFailed(documentId, attempt, { errorCode: record.errorCode || (record.status === 'stale' ? 'ANALYSIS_AI_SOURCE_CHANGED' : 'AI_UNAVAILABLE'),
        message: record.message ?? null, latencyMs }));
      autoRetryLater(documentId, attempt, job);
    }
  }

  function run(record, job) {
    const task = record.status === 'prechecking'
      ? precheck(record.documentId, record.attempt, job).then(ok => (ok ? advise(record.documentId, record.attempt, job) : undefined))
      : advise(record.documentId, record.attempt, job);
    void task.catch(onError);
  }

  return {
    // 来单：系统发起。actor 是九安运行时要求的操作人（PoC 用审核员账号的身份在后台读原件、跑预审和 AI 初审，和启动时读原件一样）
    autoStart({ document, actor }) {
      const record = workflow.autoStart({ document });
      run(record, { actor, companyId: document.companyId, sourceVersion: record.sourceVersion });
      return record;
    },
    start({ document, user, actor, sourceVersion }) {
      const record = workflow.start({ document, user, sourceVersion });
      run(record, { actor, companyId: document.companyId, sourceVersion: record.sourceVersion });
      return record;
    },
    retry({ document, user, actor, sourceVersion }) {
      const record = workflow.retry({ documentId: document.id, user, sourceVersion });
      run(record, { actor, companyId: document.companyId, sourceVersion: record.sourceVersion });
      return record;
    },
    close() { closed = true; for (const timer of timers) clearTimeout(timer); timers.clear(); },
  };
}
