/**
 * Nexus 发布与 A2A 名片的规整：publicationView（REST 返回的发布 → 页面要用的字段；调用地址只认 Nexus 同源）、
 * cardView（名片里认得出的几项）、fetchAgentCard（读公开名片）。「我的 Nexus」服务（access/me.mjs）用它们。
 */
const sameOrigin = (url, origin) => { try { return new URL(url).origin === origin; } catch { return false; } };
const clip = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
const cardError = code => Object.assign(new Error(code), { code });
/** 调用地址只认 Nexus 自己的域名：发布里配的地址如果指向别处，就改用 <Nexus>/a2a/<发布编号>（调用密钥不会发往别的主机）。 */
export function publicationView(item, origin) {
  if (!item || typeof item.publish_id !== 'string') return null;
  const channel = (Array.isArray(item.channels) ? item.channels : []).find(entry => entry?.channel === 'a2a') ?? null;
  const rpcUrl = channel?.rpc_url && sameOrigin(channel.rpc_url, origin) ? channel.rpc_url : `${origin}/a2a/${item.publish_id}`;
  return {
    publishId: item.publish_id, displayName: item.display_name || item.agent_name || item.publish_id, description: item.description || item.agent_description || '',
    agentId: item.agent_id ?? null, effectiveAgentId: item.effective_agent_id ?? null, agentName: item.agent_name ?? null, agentStatus: null, agentVersion: null,
    status: item.status ?? 'unknown', pausedReason: item.paused_reason ?? null, owner: item.owner_name ?? null,
    version: item.pinned_version ?? item.current_version ?? null, followUpdates: item.follow_updates === true,
    model: item.model_name || item.model_id || item.agent_default_model || null,
    a2a: { enabled: channel?.enabled === true, ready: channel?.ready === true, status: channel?.status ?? null, rpcUrl },
    calls24h: Number.isInteger(item.calls_24h) ? item.calls_24h : null, lastCalledAt: item.last_called_at ?? null,
  };
}

/** A2A 名片 → 页面要用的几项；认不出的字段丢掉，字符串截短。 */
export function cardView(json) {
  const value = json && typeof json === 'object' && !Array.isArray(json) ? json : {};
  return { name: clip(value.name, 200), description: clip(value.description, 2000),
    version: typeof value.version === 'string' ? value.version.slice(0, 40) : null,
    protocolVersion: typeof value.protocolVersion === 'string' ? value.protocolVersion.slice(0, 20) : null,
    streaming: value.capabilities?.streaming === true,
    skills: (Array.isArray(value.skills) ? value.skills : []).filter(skill => skill && typeof skill === 'object').slice(0, 10)
      .map(skill => ({ id: clip(skill.id, 80), name: clip(skill.name, 200) })),
    inputModes: (Array.isArray(value.defaultInputModes) ? value.defaultInputModes : []).filter(mode => typeof mode === 'string' && mode.length <= 100).slice(0, 50) };
}

/** 读一个发布的 A2A 名片（5 秒、64 KB 以内，不跟随跳转）。失败抛带 code 的错误。 */
export async function fetchAgentCard(url, { timeoutMs = 5000, fetchImpl = globalThis.fetch } = {}) {
  let res;
  try { res = await fetchImpl(url, { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) }); }
  catch { throw cardError('POC_CARD_UNAVAILABLE'); }
  if (!res.ok) throw cardError('POC_CARD_UNAVAILABLE');
  const text = await res.text();
  if (text.length > 64_000) throw cardError('POC_CARD_TOO_LARGE');
  try { return JSON.parse(text); } catch { throw cardError('POC_CARD_INVALID'); }
}
