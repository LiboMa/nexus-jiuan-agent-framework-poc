/**
 * 测试台的存储：九安自己的 MySQL 存储（和九安 scripts/start-analysis.mjs 一样经 createAnalysisDatabase 打开并迁移），
 * 再把 state.mjs 里只依赖存储接口的几样一起导出。
 */
import { createAnalysisDatabase } from '../jiuan-mysql.mjs';

export { writeRaws, seedBench, rememberRaw, lookupRaw, nextIntakeSequence } from './state.mjs';

/** 打开九安的 MySQL 存储并迁移。dataKey 是 32 字节的 base64；同一个库只能用同一把（九安会核对连接行）。 */
export async function openBenchStore({ database, password, dataKey, connectionId }) {
  const db = createAnalysisDatabase({ config: { database: { engine: 'mysql', ...database } }, secrets: { databasePassword: password } });
  try {
    const store = await db.open({ key: Buffer.from(dataKey, 'base64'), connectionId });
    await store.migrate();
    return {
      store, pool: db.pool, health: db.health,
      async close() { await store.close(); await db.pool.end(); },
    };
  } catch (error) {
    await db.pool.end().catch(() => {});
    throw error;
  }
}
