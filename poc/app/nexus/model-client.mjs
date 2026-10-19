/**
 * 九安 createModelClient 契约的 A2A 实现：任务说明、输出 schema、输入与输出校验都取自九安开发包，这里只负责把请求送到 Nexus 上的发布。
 * 调用密钥在每次调用时向 getKey({ documentId }) 取，可以是字符串或 { key, source, accountId }：审批流从页面上的启用记录里读（system-key.mjs），
 * 调用测试用发起人自己的。Nexus 回 401 时回调 onAuthRejected(那把密钥)。每次调用都记一条运行记录（含原始返回和密钥来源，便于查看不合格的输出）。
 * 调用测试可以给审批建议带附件（files，已经过 attachments.mjs 检查），作为 A2A 文件 Part 跟在任务说明后面。
 */
import {
  ADVISORY_TASK, ADVISORY_SCHEMA, validateAdvisoryInput, parseAdvisoryResult,
  DRAFT_EVIDENCE_TASK, DRAFT_EVIDENCE_SCHEMA, validateDraftEvidenceInput, validateDraftEvidenceResult,
  modelDataPolicy, assertModelDataAllowed,
} from '../jiuan.mjs';
import { ModelError, a2aCall, buildPrompt, keyRejected, unwrapJson } from './a2a-client.mjs';
import { RAW_TEXT_LIMIT } from './runs.mjs';

export function createNexusModelClient({ publishId, rpcUrl, getKey, onAuthRejected = () => {}, env, runLog, source, timeoutMs = 180_000 }) {
  const dataPolicy = modelDataPolicy(env);
  async function call({ task, schema, inputText, signal, kind, facts, validate, runId, files }) {
    const id = runId ?? runLog.start({ source, publishId, task: kind, documentId: facts?.documentId ?? null, documentNumber: facts?.number ?? null });
    let rawText = null, fenced = false, timings = null, credential = null;
    try {
      const resolved = await getKey({ documentId: facts?.documentId ?? null });
      credential = typeof resolved === 'string' ? { key: resolved, source: null, accountId: null } : resolved;
      if (!credential?.key) throw new ModelError('AI_AUTH_INVALID', '还没有可用的调用密钥：请先在 Nexus Agent 页启用这个发布（粘贴调用密钥）。', { reason: 'key_missing' });
      const result = await a2aCall({ url: rpcUrl, key: credential.key, text: buildPrompt(task, schema, inputText), files, signal, timeoutMs });
      rawText = result.text;
      timings = result.timings;
      const unwrapped = unwrapJson(result.text);
      fenced = unwrapped.fenced;
      const value = validate(unwrapped.text);
      runLog.finish(id, { status: 'ok', validation: 'passed', fenced, timings, latencyMs: timings.done, rawText: rawText.slice(0, RAW_TEXT_LIMIT),
        credentialSource: credential.source });
      return value;
    } catch (error) {
      if (credential?.key && keyRejected(error)) await Promise.resolve().then(() => onAuthRejected(credential)).catch(() => {});
      runLog.finish(id, { status: 'error', errorCode: typeof error?.code === 'string' ? error.code : 'AI_UNAVAILABLE', credentialSource: credential?.source ?? null,
        validation: rawText === null ? 'not_run' : 'failed', fenced, timings, latencyMs: timings?.done ?? null,
        rawText: rawText === null ? null : rawText.slice(0, RAW_TEXT_LIMIT), detail: error?.detail ?? null });
      throw error;
    }
  }
  return Object.freeze({
    model: `nexus-a2a:${publishId}`,
    dataPolicy,
    async advisory(input = {}, { runId, files } = {}) {
      assertModelDataAllowed(dataPolicy, input.dataContext);
      const serialized = validateAdvisoryInput(input);
      return call({ task: ADVISORY_TASK, schema: ADVISORY_SCHEMA, inputText: serialized, signal: input.signal, kind: 'advisory',
        facts: input.facts, validate: parseAdvisoryResult, runId, files });
    },
    async reviewDraftEvidence(input = {}, { runId } = {}) {
      assertModelDataAllowed(dataPolicy, input.dataContext);
      const prepared = validateDraftEvidenceInput(input);
      return call({ task: DRAFT_EVIDENCE_TASK, schema: DRAFT_EVIDENCE_SCHEMA, inputText: JSON.stringify(prepared), signal: input.signal,
        kind: 'draftEvidence', facts: input.facts, runId,
        validate: text => {
          let value;
          try { value = JSON.parse(text); } catch { throw new ModelError('AI_INVALID_RESPONSE', 'AI返回内容无法解析。'); }
          return validateDraftEvidenceResult(value, prepared);
        } });
    },
  });
}
