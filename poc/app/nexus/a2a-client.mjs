/**
 * A2A 0.3 客户端（沿用第四轮 PoC 已实测的实现）：JSON-RPC `message/stream`（SSE），Authorization: Bearer <发布的调用密钥>，
 * 每次调用用新的 contextId（不复用会话），回答取名为 answer 的产出物的最终全文。附件作为文件 Part（base64）跟在文字后面。
 * 中止时尽力发 tasks/cancel：调用方断开后，Nexus 上的这一轮仍会跑完并计费。
 */
import { randomUUID } from 'node:crypto';

export class ModelError extends Error {
  constructor(code, message, detail) { super(message); this.name = 'ModelError'; this.code = code; this.detail = detail; }
}
const err = (code, message, detail) => new ModelError(code, message, detail);
/** Nexus 不认这把调用密钥（401，或 credential_invalid）：只有这种情况才把密钥标记为失效；404、5xx 只算这次调用失败。 */
export const keyRejected = error => error?.detail?.status === 401 || error?.detail?.code === 'credential_invalid';

/** Nexus 网关的拒绝 → 九安的错误码（AI_UNAVAILABLE / AI_RATE_LIMIT 在九安里视为可重试）。 */
export function mapHttp(status, code) {
  if (status === 401 || status === 404 || code === 'api_key_required' || code === 'publication_not_found') return 'AI_AUTH_INVALID';
  if (code === 'budget_exceeded') return 'AI_UNAVAILABLE';
  if (status === 429) return 'AI_RATE_LIMIT';
  if (status === 413) return 'AI_REQUEST_INVALID';
  if (status >= 500) return 'AI_UNAVAILABLE';
  return 'AI_REQUEST_INVALID';
}
// -32005 类型不支持、-32602 / -32600 / -32700 请求不合规（附件超限、内容残缺）：都算请求本身的问题。
const RPC_TO_HTTP = { [-32010]: 401, [-32011]: 404, [-32012]: 429, [-32013]: 503, [-32005]: 415, [-32602]: 400, [-32600]: 400, [-32700]: 400 };

/** 去掉模型偶尔加上的一层 ```json 代码围栏；是否去过如实返回，便于统计「原样合格率」。 */
export function unwrapJson(text) {
  const trimmed = String(text ?? '').trim();
  const match = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/u.exec(trimmed);
  return match ? { text: match[1].trim(), fenced: true } : { text: trimmed, fenced: false };
}

// 输出规则：Agent 曾在 JSON 字符串里直接写英文双引号（没转义），JSON 不合法，九安按规定拒收（AI_INVALID_RESPONSE）。
const OUTPUT_RULES = [
  '只输出一个 JSON 对象，符合上面的 output_schema；前后不加任何说明文字。',
  '字符串内容里不要出现英文双引号 "；需要引用原文、词语或字段名时，一律用中文引号「」。',
].join('\n');

export function buildPrompt(task, schema, input) {
  return `<task>\n${task}\n</task>\n\n<output_schema>\n${JSON.stringify(schema)}\n</output_schema>\n\n<output_rules>\n${OUTPUT_RULES}\n</output_rules>\n\n<input>\n${input}\n</input>`;
}

async function* sseEvents(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut;
    while ((cut = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut).replace(/^\r?\n\r?\n/, '');
      const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (data) yield data;
    }
  }
}

/**
 * 一次 A2A 流式调用。返回 { text, taskId, timings }；失败抛带 code 的 ModelError。
 * timings（毫秒，自发起请求起算）：headers 收到响应头、firstEvent 首个事件、firstText 首段文字、done 结束。
 */
export async function a2aStream({ url, key, text, files = [], signal }) {
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  const timings = {};
  const body = {
    jsonrpc: '2.0', id: randomUUID(), method: 'message/stream',
    params: { message: { kind: 'message', messageId: randomUUID(), contextId: randomUUID(), role: 'user', parts: [{ kind: 'text', text },
      ...files.map(file => ({ kind: 'file', file: { name: file.name, mimeType: file.mimeType, bytes: file.bytes.toString('base64') } }))] } },
  };
  let res;
  try {
    res = await fetch(url, { method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
  } catch (error) {
    if (signal?.aborted) throw err('AI_CANCELLED', 'AI 调用已取消。');
    throw err('AI_NETWORK', 'AI 服务网络不可达。', String(error?.cause?.code || error?.message || error));
  }
  timings.headers = ms();
  const type = res.headers.get('content-type') || '';
  if (!res.ok || !type.includes('text/event-stream')) {
    let code;
    try { const json = await res.json(); code = json?.error?.data?.code || json?.error?.message || json?.detail; } catch { /* 非 JSON 的拒绝 */ }
    throw err(mapHttp(res.ok ? 400 : res.status, code), 'AI 服务拒绝了请求。', { status: res.status, code });
  }
  let answer = '', finalText = null, taskId = null, state = null, failure = null;
  const cancel = () => {
    if (!taskId) return;
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tasks/cancel', params: { id: taskId } }) }).catch(() => {});
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    for await (const data of sseEvents(res.body)) {
      if (timings.firstEvent === undefined) timings.firstEvent = ms();
      let message;
      try { message = JSON.parse(data); } catch { continue; }
      if (message.error) {
        const status = RPC_TO_HTTP[message.error.code] || 500;
        throw err(mapHttp(status, message.error?.data?.code), 'AI 服务返回错误。', { rpc: message.error.code, code: message.error?.data?.code });
      }
      const result = message.result || {};
      if (result.kind === 'task') { taskId = result.id; state = result.status?.state; }
      else if (result.kind === 'status-update') {
        taskId = result.taskId || taskId; state = result.status?.state;
        if (['failed', 'rejected', 'canceled'].includes(state)) {
          failure = { state, code: result.metadata?.error_code, message: (result.status?.message?.parts || []).map(part => part.text).join('') };
        }
        if (result.final) break;
      } else if (result.kind === 'artifact-update') {
        taskId = result.taskId || taskId;
        const part = (result.artifact?.parts || []).filter(item => item.kind === 'text').map(item => item.text).join('');
        if (part && timings.firstText === undefined) timings.firstText = ms();
        answer = result.append ? answer + part : part;
        if (result.lastChunk) finalText = answer;
      }
    }
  } catch (error) {
    if (error instanceof ModelError) throw error;
    if (signal?.aborted) throw err('AI_CANCELLED', 'AI 调用已取消。');
    throw err('AI_NETWORK', 'AI 服务流中断。', String(error?.message || error));
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
  timings.done = ms();
  if (failure) {
    const code = failure.state === 'canceled' ? 'AI_CANCELLED' : failure.code === 'rate_limited' ? 'AI_RATE_LIMIT' : 'AI_UNAVAILABLE';
    throw err(code, 'AI 任务未完成。', failure);
  }
  if (state !== 'completed') throw err('AI_OUTPUT_TRUNCATED', 'AI 回答不完整。', { state });
  return { text: finalText ?? answer, taskId, timings };
}

/** a2aStream 加上总时限：时限到了算 AI_UNAVAILABLE（Nexus 没在限定时间内答完）；调用方自己中止仍是 AI_CANCELLED。 */
export async function a2aCall({ url, key, text, files, signal, timeoutMs = 180_000 }) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    return await a2aStream({ url, key, text, files, signal: combined });
  } catch (error) {
    if (error?.code === 'AI_CANCELLED' && timeout.aborted && !signal?.aborted) {
      throw err('AI_UNAVAILABLE', 'Nexus 在限定时间内没有答完。', { reason: 'timeout', timeoutMs });
    }
    throw error;
  }
}
