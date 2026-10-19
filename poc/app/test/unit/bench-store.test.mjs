/**
 * 测试台的存储：九安自己的 MySQL 存储 + 原文写入 + 种子 + 原文与来单编号的持久化。要 MySQL：在测试台上用 poc/infra/bench-test.sh 跑。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_WITHOUT_MYSQL, benchDatabaseFromUrl, mysqlTestUrl, queryTestDatabase, resetTestDatabase } from './helpers/mysql.mjs';
import { COMPANIES, SEED_RAWS, TENANT_ID, simulateArrival } from '../../seed.mjs';

const bench = mysqlTestUrl() ? await import('../../bench/store.mjs') : null;
const KEY = Buffer.alloc(32, 7).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 9).toString('base64');
const companyIds = COMPANIES.map(company => company.id);
const seedRaws = () => SEED_RAWS.map(item => item.raw);

async function open(dataKey = KEY) {
  const { database, password } = benchDatabaseFromUrl();
  return bench.openBenchStore({ database, password, dataKey, connectionId: 'poc-bench-test' });
}
const versions = async store => Object.fromEntries((await store.listDocuments({ companyIds, limit: 50 })).items.map(item => [item.number, item.version]));

test('种子：8 张单据都进了九安的库', { skip: SKIP_WITHOUT_MYSQL }, async () => {
  await resetTestDatabase();
  const handle = await open();
  try {
    await bench.seedBench(handle.store, { tenantId: TENANT_ID, raws: seedRaws() });
    const listed = await handle.store.listDocuments({ companyIds, limit: 50 });
    assert.equal(listed.total, 8);
    assert.deepEqual(listed.items.map(item => item.number).sort(), seedRaws().map(raw => raw.businessCode).sort());
  } finally { await handle.close(); }
});

test('种子写两遍等于写一遍：版本不变，版本表不多行', { skip: SKIP_WITHOUT_MYSQL }, async () => {
  await resetTestDatabase();
  const handle = await open();
  try {
    await bench.seedBench(handle.store, { tenantId: TENANT_ID, raws: seedRaws() });
    const before = await versions(handle.store);
    const [{ count: rowsBefore }] = await queryTestDatabase('SELECT COUNT(*) AS count FROM analysis_document_versions');
    await bench.seedBench(handle.store, { tenantId: TENANT_ID, raws: seedRaws() });
    assert.deepEqual(await versions(handle.store), before);
    const [{ count: rowsAfter }] = await queryTestDatabase('SELECT COUNT(*) AS count FROM analysis_document_versions');
    assert.equal(Number(rowsAfter), Number(rowsBefore));
  } finally { await handle.close(); }
});

test('模拟来单的原文存在库里：关掉再打开还能按单据号取回', { skip: SKIP_WITHOUT_MYSQL }, async () => {
  await resetTestDatabase();
  const { raw } = simulateArrival({ template: 'FYBX-POC-001', sequence: 1 });
  let handle = await open();
  try {
    await bench.writeRaws(handle.store, { tenantId: TENANT_ID, raws: [raw] });
    await bench.rememberRaw(handle.store, raw);
  } finally { await handle.close(); }
  handle = await open();
  try {
    assert.deepEqual(await bench.lookupRaw(handle.store, 'FYBX-SIM-001'), raw);
    assert.equal(await bench.lookupRaw(handle.store, 'FYBX-SIM-999'), null);
    assert.equal((await handle.store.listDocuments({ companyIds, q: 'FYBX-SIM-001', limit: 1 })).total, 1);
  } finally { await handle.close(); }
});

test('来单编号存在库里，并发取号也不重复', { skip: SKIP_WITHOUT_MYSQL }, async () => {
  await resetTestDatabase();
  const handle = await open();
  try {
    const numbers = await Promise.all(Array.from({ length: 5 }, () => bench.nextIntakeSequence(handle.store)));
    assert.deepEqual([...numbers].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
    assert.equal(await bench.nextIntakeSequence(handle.store), 6);
  } finally { await handle.close(); }
});

test('换了数据密钥就打不开同一个库', { skip: SKIP_WITHOUT_MYSQL }, async () => {
  await resetTestDatabase();
  const handle = await open();
  await bench.seedBench(handle.store, { tenantId: TENANT_ID, raws: seedRaws() });
  await handle.close();
  await assert.rejects(open(OTHER_KEY));
});
