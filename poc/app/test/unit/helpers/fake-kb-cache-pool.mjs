/**
 * 内存里的 poc_kb_cache：九安 PG 适配层的 pool.query 形状（[rows]），只认 kb-cache.mjs 写的那几条 SQL，别的 SQL 直接报错。
 * timestamp 按 UTC 回 Date。fail = true 时每条 SQL 都抛错（库连不上）。
 */
export function fakeKbCachePool() {
  const rows = new Map();   // `${scope}\u0000${key}` → { scope, cache_key, body, fetched_at }
  const sql = [];
  const pool = {
    fail: false,
    sql,
    table: () => [...rows.values()],
    async query(text, params = []) {
      sql.push(text);
      if (pool.fail) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      const flat = text.replace(/\s+/g, ' ').trim();
      if (flat.startsWith('CREATE TABLE IF NOT EXISTS poc_kb_cache (')) return [{}];
      if (flat === 'SELECT body, fetched_at FROM poc_kb_cache WHERE scope=? AND cache_key=?') {
        const row = rows.get(`${params[0]}\u0000${params[1]}`);
        return [row ? [{ body: row.body, fetched_at: new Date(`${row.fetched_at.replace(' ', 'T')}Z`) }] : []];
      }
      if (flat === 'INSERT INTO poc_kb_cache (scope, cache_key, body, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT (scope, cache_key) DO UPDATE SET body=EXCLUDED.body, fetched_at=EXCLUDED.fetched_at') {
        const [scope, key, body, at] = params;
        rows.set(`${scope}\u0000${key}`, { scope, cache_key: key, body, fetched_at: at });
        return [{ affectedRows: 1 }];
      }
      if (flat === 'DELETE FROM poc_kb_cache WHERE scope=? AND cache_key = ANY(?)') {
        for (const key of params[1]) rows.delete(`${params[0]}\u0000${key}`);
        return [{}];
      }
      if (flat === 'DELETE FROM poc_kb_cache WHERE scope=? AND cache_key LIKE ?') {
        const prefix = params[1].replace(/%$/, '');
        for (const [id, row] of rows) if (row.scope === params[0] && row.cache_key.startsWith(prefix)) rows.delete(id);
        return [{}];
      }
      throw new Error(`假 pool 不认这条 SQL：${flat}`);
    },
  };
  return pool;
}
