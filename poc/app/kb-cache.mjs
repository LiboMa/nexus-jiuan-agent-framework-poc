/**
 * 知识库页的缓存：知识库 Agent 回的 describe、制度清单、每份制度的详情存在九安 jiuan 库的 poc_kb_cache 里，页面打开时不必每次问 Agent
 * （一次 A2A 调用要 4–10 秒；规则入库之后很少再改）。什么时候重新问 Agent 由 kb-steward-routes.mjs 定。
 *   scope = 方式 + 发布编号（换了知识库 Agent 就看不到原来那个存的）；cache_key = describe | list | detail:<制度标识>；
 *   body = Agent 回的 JSON（不进日志）；fetched_at = 外壳从 Agent 读到它的时间（UTC 的 timestamp(3)）。
 * 表在 start() 时建；端到端测试的重置删库重建，随之清空（下次打开页面再问一次 Agent）。读写出错由调用方兜底（照常去问 Agent）。
 */
const SCHEMA = `CREATE TABLE IF NOT EXISTS poc_kb_cache (
  scope varchar(96) NOT NULL,
  cache_key varchar(191) NOT NULL,
  body text NOT NULL,
  fetched_at timestamp(3) NOT NULL,
  PRIMARY KEY (scope, cache_key)
)`;
/** ISO 时间 ↔ UTC 的 timestamp(3) 文字（'2026-11-03 01:02:03.456'），不经 pool 的时区换算（同 reviews.mjs）。 */
const sqlTime = ms => new Date(ms).toISOString().slice(0, 23).replace('T', ' ');
const isoOf = value => (value instanceof Date ? value : new Date(`${String(value).replace(' ', 'T')}Z`)).toISOString();

export function createKbCache({ pool, scope, now = Date.now }) {
  return {
    async start() { await pool.query(SCHEMA); },
    /** → { body, fetchedAt }，没有（或存坏了）回 null。 */
    async get(key) {
      const [rows] = await pool.query('SELECT body, fetched_at FROM poc_kb_cache WHERE scope=? AND cache_key=?', [scope, key]);
      if (!rows.length) return null;
      try { return { body: JSON.parse(rows[0].body), fetchedAt: isoOf(rows[0].fetched_at) }; } catch { return null; }
    },
    /** 存这一份（同一项覆盖），回读到的时间（ISO）。 */
    async put(key, body) {
      const at = now();
      await pool.query('INSERT INTO poc_kb_cache (scope, cache_key, body, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT (scope, cache_key) DO UPDATE SET body=EXCLUDED.body, fetched_at=EXCLUDED.fetched_at',
        [scope, key, JSON.stringify(body), sqlTime(at)]);
      return new Date(at).toISOString();
    },
    async drop(...keys) { if (keys.length) await pool.query('DELETE FROM poc_kb_cache WHERE scope=? AND cache_key = ANY(?)', [scope, keys]); },
    /** 删一类，例如 dropPrefix('detail:') 删全部详情（前缀是写死的常量，不含 % 和 _）。 */
    async dropPrefix(prefix) { await pool.query('DELETE FROM poc_kb_cache WHERE scope=? AND cache_key LIKE ?', [scope, `${prefix}%`]); },
  };
}
