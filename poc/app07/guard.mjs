/**
 * 出网守卫：九安代码里写死了真汇联易、钉钉、第三方 AI 中转等地址。测试台上的九安只该连 Nexus（假汇联易在进程内，
 * 不走 fetch），所以全局 fetch 换成只放行名单里 https 主机的版本，其余一律拒绝（错误码 POC_EGRESS_BLOCKED）并记下主机名。
 * 不经 fetch 的连接（https.request 等）由测试台的 /etc/hosts 和 systemd 的 IPAddressDeny 兜底。
 */
const blockedError = host => Object.assign(new TypeError(`出网被拦截：${host}`), { code: 'POC_EGRESS_BLOCKED' });

export function guardedFetch({ allowHosts, fetchImpl = globalThis.fetch, onBlocked = () => {} }) {
  const allowed = new Set(allowHosts);
  return async function fetch(input, init) {
    let url;
    try { url = new URL(input instanceof Request ? input.url : typeof input === 'string' || input instanceof URL ? String(input) : String(input?.url)); }
    catch { url = null; }
    const host = url?.hostname ?? 'invalid';
    if (url?.protocol !== 'https:' || !allowed.has(host)) {
      onBlocked(host);
      throw blockedError(host);
    }
    return fetchImpl(input, init);
  };
}

/** 换掉全局 fetch；返回还原函数。 */
export function installOutboundGuard({ allowHosts, onBlocked }) {
  const original = globalThis.fetch;
  globalThis.fetch = guardedFetch({ allowHosts, fetchImpl: original, onBlocked });
  return () => { globalThis.fetch = original; };
}
