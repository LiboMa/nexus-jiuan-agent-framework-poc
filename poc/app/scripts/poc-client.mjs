/**
 * 调 PoC 后端接口的小客户端（命令行脚本 try-agent.mjs 与端到端测试共用）：口令登录 → 取 CSRF → 读「我的 Nexus」与示例附件 → 启用 / 停用 → 发起调用 → 轮询结果。
 * 走的是浏览器同一条路（CloudFront → PoC 服务端 → A2A → Nexus）。口令由调用方给，这里不打印、不落盘。
 */
import { readFileSync } from 'node:fs';

/** 从 infra/secrets.env 读一项（KEY=VALUE）。 */
export function readSecret(file, name) {
  const line = readFileSync(file, 'utf8').split(/\r?\n/).find(item => item.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).trim().replace(/^(['"])(.*)\1$/, '$2') : null;
}

export function createPocClient({ base, fetchImpl = globalThis.fetch }) {
  const origin = new URL(base).origin;
  let cookie = '', csrf = '';
  async function call(path, { method = 'GET', body } = {}) {
    const res = await fetchImpl(`${origin}/api/analysis/v1${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { Accept: 'application/json', ...(method !== 'GET' ? { Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}),
        ...(csrf && method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) } });
    const set = res.headers.getSetCookie?.().find(value => value.startsWith('jiuan_analysis='));
    if (set) cookie = set.split(';')[0];
    const json = await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error(json?.error?.message || `HTTP ${res.status}`), { status: res.status, code: json?.error?.code ?? null });
    return json?.data;
  }
  return {
    async login(account, password) {
      const { ticket } = await call('/poc/login', { method: 'POST', body: { account, password } });
      await call('/auth/exchange', { method: 'POST', body: { ticket } });
      csrf = (await call('/session'))?.csrfToken || '';
    },
    me: () => call('/poc/nexus/me'),
    attachmentPolicy: () => call('/poc/nexus/attachment-policy'),
    enable: (publishId, body) => call(`/poc/nexus/me/agents/${publishId}/enable`, { method: 'POST', body }),
    disable: publishId => call(`/poc/nexus/me/agents/${publishId}/disable`, { method: 'POST', body: {} }),
    samples: async () => (await call('/poc/nexus/samples')).items,
    sample: id => call(`/poc/nexus/samples/${encodeURIComponent(id)}`),
    documents: async () => (await call('/documents?limit=50')).items,
    run: id => call(`/poc/nexus/runs/${encodeURIComponent(id)}`),
    async invoke(body) { return (await call('/poc/nexus/invoke', { method: 'POST', body })).runId; },
    async waitRun(runId, { timeoutMs = 300_000, intervalMs = 3000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const run = await this.run(runId);
        if (run.status !== 'running') return run;
        if (Date.now() > deadline) throw Object.assign(new Error(`运行记录 ${runId} 在 ${timeoutMs / 1000} 秒内没有结束`), { code: 'TIMEOUT' });
        await new Promise(resolve => setTimeout(resolve, intervalMs));
      }
    },
  };
}

/** 去掉一层 ```json 代码围栏后按 JSON 解析；不是 JSON 返回 null。 */
export function parseAnswer(rawText) {
  const trimmed = String(rawText ?? '').trim();
  const match = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/u.exec(trimmed);
  try { return JSON.parse(match ? match[1] : trimmed); } catch { return null; }
}
