/** 各发布的 A2A 调用密钥（来自密钥配置文件）。页面上点「刷新」时重新读取；读取失败时保留原来的密钥。状态里只有数量。 */
export function createKeyStore({ load }) {
  let keys = new Map(), loadedAt = null, error = null;
  return {
    async reload() {
      try {
        keys = new Map(await load());
        loadedAt = new Date().toISOString();
        error = null;
      } catch {
        error = 'POC_KEYS_UNAVAILABLE';
      }
      return { count: keys.size, loadedAt, error };
    },
    get: publishId => keys.get(publishId) ?? null,
    has: publishId => keys.has(publishId),
    ids: () => [...keys.keys()],
    status: () => ({ count: keys.size, loadedAt, error }),
  };
}
