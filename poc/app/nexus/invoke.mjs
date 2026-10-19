/**
 * Agent 页的「调用测试」：调用我启用的 Agent（我的调用密钥），或系统提供的 Agent（secrets.env 里的密钥），用自由文本、按任务或某张单据的审批建议输入调用一次。
 * 调用在后台进行（Nexus 一轮 30–60 秒，超过 CloudFront 的回源时限），接口立即返回运行记录编号，页面轮询结果。
 * 两种模式都可以带附件（attachments.mjs 先检查），经 A2A 文件 Part 交给 Nexus；运行记录只记附件的名称、类型、大小与 sha256。
 */
import { a2aCall, unwrapJson, keyRejected } from './a2a-client.mjs';
import { createNexusModelClient } from './model-client.mjs';
import { captureAdvisoryInput } from './advisory-input.mjs';
import { RAW_TEXT_LIMIT } from './runs.mjs';
import { attachmentMeta, normalizeAttachments } from './attachments.mjs';
import { fail } from '../http.mjs';

const PUBLISH_ID = /^pub_[A-Za-z0-9_-]{4,80}$/;
const DOCUMENT_ID = /^[A-Za-z0-9_-]{1,160}$/;
const codeOf = error => (typeof error?.code === 'string' ? error.code : 'AI_UNAVAILABLE');
/** 发给知识 Agent 这类按任务分工的 Agent 时（文本是 {"task": …} 的 JSON），运行记录的任务记成 task:<任务名>，便于在列表里区分。 */
export function taskOf(text) {
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.task === 'string' && /^[a-z][a-z_]{0,39}$/.test(value.task)) return `task:${value.task}`;
  } catch { /* 不是 JSON：自由文本 */ }
  return 'text';
}

// 只有 Nexus 明说「这把密钥无效」（HTTP 401）才算启用失效；404（发布暂停、不存在）等只是这一次调用失败。

export function createInvoker({ resolve, onAuthInvalid = async () => {}, runLog, registry, store, tenantId, governanceEnv, perMinute = 5, now = Date.now,
  timeoutMs = 180_000, clientFor = createNexusModelClient, call = a2aCall, capture = captureAdvisoryInput }) {
  const windows = new Map();
  function limit(userId) {
    const at = now(), entry = windows.get(userId);
    const current = entry && entry.until > at ? entry : { until: at + 60_000, count: 0 };
    if (current.count >= perMinute) fail('POC_INVOKE_RATE_LIMIT', 429);
    current.count += 1;
    windows.set(userId, current);
  }
  const flagIfRejected = async (error, user, publishId, credential) => {
    if (credential.source === 'user' && keyRejected(error)) await onAuthInvalid(user, publishId).catch(() => {});
  };
  async function runText(runId, user, publishId, credential, text, files) {
    try {
      const result = await call({ url: credential.rpcUrl, key: credential.key, text, files, timeoutMs });
      runLog.finish(runId, { status: 'ok', validation: 'not_applicable', fenced: unwrapJson(result.text).fenced, timings: result.timings,
        latencyMs: result.timings.done, rawText: result.text.slice(0, RAW_TEXT_LIMIT) });
    } catch (error) {
      runLog.finish(runId, { status: 'error', errorCode: codeOf(error), validation: 'not_applicable', latencyMs: null, detail: error?.detail ?? null });
      await flagIfRejected(error, user, publishId, credential);
    }
  }
  return {
    async start({ user, publishId, mode, text, documentId, attachments }) {
      if (typeof publishId !== 'string' || !PUBLISH_ID.test(publishId) || !['text', 'advisory'].includes(mode)) fail('INVALID_REQUEST', 400);
      const files = normalizeAttachments(attachments);
      const credential = await resolve(user, publishId);
      if (!credential) fail('POC_AGENT_NOT_ENABLED', 409);
      const base = { source: 'invoke', publishId, actor: user.name, actorId: user.id, credentialSource: credential.source, attachments: attachmentMeta(files) };
      if (mode === 'text') {
        const message = typeof text === 'string' ? text.trim() : '';
        if (!message || message.length > 8000) fail('INVALID_REQUEST', 400);
        limit(user.id);
        const runId = runLog.start({ ...base, task: taskOf(message), documentId: null, documentNumber: null });
        void runText(runId, user, publishId, credential, message, files);
        return { runId };
      }
      if (typeof documentId !== 'string' || !DOCUMENT_ID.test(documentId)) fail('INVALID_REQUEST', 400);
      const document = await store.getDocument({ id: documentId, companyIds: user.companyIds });
      if (!document) fail('NOT_FOUND', 404);
      limit(user.id);
      const input = await capture({ runtime: registry.get(document.companyId), tenantId, actor: user, document });
      const client = clientFor({ publishId, rpcUrl: credential.rpcUrl, getKey: () => credential.key, env: governanceEnv, runLog, source: 'invoke', timeoutMs });
      const runId = runLog.start({ ...base, task: 'advisory', documentId: document.id, documentNumber: document.number });
      void client.advisory(input, { runId, files }).catch(async error => {
        // 结果（含校验失败）已记进运行记录；只有调用前就失败、记录还停在「进行中」时才补记。
        if (runLog.get(runId)?.status === 'running') runLog.finish(runId, { status: 'error', errorCode: codeOf(error), validation: 'not_run' });
        await flagIfRejected(error, user, publishId, credential);
      });
      return { runId };
    },
  };
}
