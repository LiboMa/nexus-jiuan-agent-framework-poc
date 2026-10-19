/**
 * 启用时的两件事：
 * 1. 不花钱地验证调用密钥：发 JSON-RPC tasks/get（随机任务编号）。Nexus 先认证、再分发（a2a_endpoint.py:528），tasks/get 不占用 Agent。
 *    2026-10-17 实测：有效 → HTTP 200 + JSON-RPC 错误 "Task not found"；无效 → 401 credential_invalid；别的发布的密钥 → 404 publication_not_found。
 * 2. 读能力清单：经 A2A 发 {"task":"describe"}（约 0.03 美元）；读不到不算启用失败，只给错误码。
 */
import { randomUUID } from 'node:crypto';
import { a2aCall, unwrapJson } from '../nexus/a2a-client.mjs';

const unreachable = () => Object.assign(new Error('POC_NEXUS_UNREACHABLE'), { code: 'POC_NEXUS_UNREACHABLE', status: 502 });

export async function verifyCallKey({ url, key, fetchImpl = globalThis.fetch, timeoutMs = 10_000 }) {
  let res;
  try {
    res = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tasks/get', params: { id: randomUUID() } }) });
    await res.arrayBuffer();
  } catch {
    throw unreachable();
  }
  if (res.status === 200) return 'valid';
  if ([401, 403, 404].includes(res.status)) return 'invalid';
  throw unreachable();
}

export async function loadManifest({ url, key, call = a2aCall, timeoutMs = 120_000 }) {
  try {
    const { text } = await call({ url, key, text: JSON.stringify({ task: 'describe' }), timeoutMs });
    const value = JSON.parse(unwrapJson(text).text);
    if (value && value.task === 'describe' && Array.isArray(value.tasks)) {
      return { manifest: value, version: typeof value.version === 'string' ? value.version.slice(0, 80) : null, error: null };
    }
    return { manifest: null, version: null, error: 'POC_NOT_A_MANIFEST' };
  } catch (error) {
    return { manifest: null, version: null, error: error instanceof SyntaxError ? 'POC_NOT_A_MANIFEST' : typeof error?.code === 'string' ? error.code : 'AI_UNAVAILABLE' };
  }
}
