/**
 * 要 MySQL 的测试的公共部分。没有 MYSQL_TEST_URL 就跳过（本机不起 MySQL；在测试台上用 poc/infra/bench-test.sh 跑）。
 * 库名必须以 _test 结尾（照九安自己的 MySQL 测试），清库时删掉库里的全部表。
 * mysql2 从九安副本（JIUAN_CODE_DIR）里取：PoC 自己不装依赖。
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { JIUAN_CODE_DIR } from '../../../jiuan-path.mjs';

export const mysqlTestUrl = () => process.env.MYSQL_TEST_URL || null;
export const SKIP_WITHOUT_MYSQL = mysqlTestUrl() ? false : '需要 MYSQL_TEST_URL（在测试台上用 poc/infra/bench-test.sh 跑）';

/** MYSQL_TEST_URL → openBenchStore 要的连接参数与密码。 */
export function benchDatabaseFromUrl(url = mysqlTestUrl()) {
  const parsed = new URL(url);
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (!database.endsWith('_test')) throw new Error(`测试库名必须以 _test 结尾：${database}`);
  return { database: { host: parsed.hostname, port: Number(parsed.port || 3306), database, user: decodeURIComponent(parsed.username) },
    password: decodeURIComponent(parsed.password) };
}

/** 删掉测试库里的全部表（外键检查先关掉）。 */
export async function resetTestDatabase(url = mysqlTestUrl()) {
  const { database, password } = benchDatabaseFromUrl(url);
  const mysql = createRequire(path.join(JIUAN_CODE_DIR, 'package.json'))('mysql2/promise');
  const connection = await mysql.createConnection({ host: database.host, port: database.port, user: database.user, password, database: database.database });
  try {
    const [rows] = await connection.query('SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()');
    await connection.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const { name } of rows) await connection.query(`DROP TABLE IF EXISTS \`${name.replaceAll('`', '``')}\``);
    await connection.query('SET FOREIGN_KEY_CHECKS = 1');
  } finally {
    await connection.end();
  }
}

/** 在测试库上跑一条查询（只给断言用）。 */
export async function queryTestDatabase(sql, params = [], url = mysqlTestUrl()) {
  const { database, password } = benchDatabaseFromUrl(url);
  const mysql = createRequire(path.join(JIUAN_CODE_DIR, 'package.json'))('mysql2/promise');
  const connection = await mysql.createConnection({ host: database.host, port: database.port, user: database.user, password, database: database.database });
  try { return (await connection.query(sql, params))[0]; } finally { await connection.end(); }
}
