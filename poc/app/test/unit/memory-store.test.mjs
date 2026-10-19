import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../memory-store.mjs';

const V = 'f'.repeat(64);
const doc = (id, companyId, extra = {}) => ({ id, environment: 'prod', tenantId: 't', companyId, companyName: companyId === 'a' ? '甲（虚构）' : '乙（虚构）',
  number: `NO-${id}`, formName: '费用报销单', type: 'employee_expense', status: '1003', amount: '10.50', currency: 'CNY',
  modifiedAt: '2026-10-01T00:00:00.000Z', collectedAt: `2026-10-0${id}T00:00:00.000Z`, version: V,
  historyCount: 0, rejectionCount: 0, withdrawalCount: 0, history: [], ...extra });
const companies = [{ id: 'a', tenantId: 't', name: '甲（虚构）' }, { id: 'b', tenantId: 't', name: '乙（虚构）' }];

test('单据按调用方的公司范围过滤，按采集时间倒序', async () => {
  const store = createMemoryStore({ documents: [doc('1', 'a'), doc('2', 'b'), doc('3', 'a')], companies });
  const page = await store.listDocuments({ companyIds: ['a'], limit: 25, offset: 0 });
  assert.equal(page.total, 2);
  assert.deepEqual(page.items.map(item => item.id), ['3', '1']);
  assert.equal(await store.getDocument({ id: '2', companyIds: ['a'] }), null);
  assert.equal((await store.getDocument({ id: '2', companyIds: ['b'] })).number, 'NO-2');
  assert.equal(await store.getDocument({ id: '2' }), null);
});

test('搜索匹配单据号、表单名与公司名；状态按文本比较；分页', async () => {
  const store = createMemoryStore({ documents: [doc('1', 'a'), doc('2', 'a', { formName: '常规对公付款' }), doc('3', 'a')], companies });
  assert.deepEqual((await store.listDocuments({ companyIds: ['a'], q: 'no-3' })).items.map(item => item.id), ['3']);
  assert.deepEqual((await store.listDocuments({ companyIds: ['a'], q: '对公' })).items.map(item => item.id), ['2']);
  assert.equal((await store.listDocuments({ companyIds: ['a'], status: '1002' })).total, 0);
  assert.equal((await store.listDocuments({ companyIds: ['a'], status: 1003 })).total, 3);
  assert.deepEqual((await store.listDocuments({ companyIds: ['a'], limit: 1, offset: 1 })).items.map(item => item.id), ['2']);
});

test('不带参数列出全部公司（规则工作区要求每行都有 tenantId）', async () => {
  const store = createMemoryStore({ documents: [doc('1', 'a')], companies });
  assert.deepEqual(await store.listCompanies(), [{ id: 'a', tenantId: 't', name: '甲（虚构）', count: 1 }, { id: 'b', tenantId: 't', name: '乙（虚构）', count: 0 }]);
  assert.deepEqual((await store.listCompanies({ companyIds: ['b'] })).map(company => company.id), ['b']);
});

test('统计按分组汇总金额，没有浮点误差', async () => {
  const store = createMemoryStore({ documents: [doc('1', 'a', { amount: '10.50' }), doc('2', 'a', { amount: '0.20' }), doc('3', 'a', { amount: '0.10' })], companies });
  const analytics = await store.analytics({ companyIds: ['a'] });
  assert.equal(analytics.byType[0].amount, '10.80');
  assert.deepEqual(analytics.byCompany, [{ id: 'a', name: '甲（虚构）', count: 3 }]);
  assert.equal(analytics.amountUnavailable, 0);
  assert.equal((await store.overview({ companyIds: ['a'] })).documentCount, 3);
});

test('compareAndWriteState 按版本号链写入，旧版本号返回 409', async () => {
  const store = createMemoryStore();
  assert.deepEqual(await store.compareAndWriteState('k', { expectedRevision: 0, value: { revision: 1, x: 1 } }), { revision: 1 });
  await assert.rejects(store.compareAndWriteState('k', { expectedRevision: 0, value: { revision: 1, x: 2 } }), { code: 'ANALYSIS_STATE_CONFLICT', status: 409 });
  await assert.rejects(store.compareAndWriteState('k', { expectedRevision: 1, value: { revision: 5 } }), { code: 'ANALYSIS_VALIDATION' });
  assert.deepEqual(await store.readState('k'), { revision: 1, x: 1 });
});

test('同一个键上并发的两次写入只有一次成功', async () => {
  const store = createMemoryStore();
  const results = await Promise.allSettled([
    store.compareAndWriteState('k', { expectedRevision: 0, value: { revision: 1, by: 'first' } }),
    store.compareAndWriteState('k', { expectedRevision: 0, value: { revision: 1, by: 'second' } }),
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'ANALYSIS_STATE_CONFLICT');
});

test('authorize 返回 false 时不写入', async () => {
  const store = createMemoryStore();
  await assert.rejects(store.compareAndWriteState('k', { expectedRevision: 0, value: { revision: 1 }, authorize: async () => false }), { code: 'ANALYSIS_SCOPE_MISMATCH' });
  assert.equal(await store.readState('k'), null);
});

test('readStates 一次最多 50 个且不能重复；返回的是副本', async () => {
  const store = createMemoryStore();
  await store.writeState('a', { list: [1] });
  await assert.rejects(store.readStates(['a', 'a']), { code: 'ANALYSIS_VALIDATION' });
  await assert.rejects(store.readStates(Array.from({ length: 51 }, (_, index) => `k${index}`)), { code: 'ANALYSIS_VALIDATION' });
  const { values } = await store.readStates(['a', 'missing']);
  assert.deepEqual(values, { a: { list: [1] }, missing: null });
  values.a.list.push(2);
  assert.deepEqual(await store.readState('a'), { list: [1] });
});

test('不实现 getPaymentCompanyBinding（九安见到它才会启用付款服务）', () => {
  assert.equal(createMemoryStore().getPaymentCompanyBinding, undefined);
});

test('addDocument（模拟来单用）：新单据排在最前面；编号重复时拒绝', async () => {
  const store = createMemoryStore({ documents: [doc('1', 'a', { collectedAt: '2026-10-15T09:00:00.000Z' })], companies });
  await store.addDocument(doc('2', 'a', { collectedAt: '2026-10-18T03:00:00.000Z' }));
  assert.deepEqual((await store.listDocuments({ companyIds: ['a'] })).items.map(item => item.id), ['2', '1']);
  await assert.rejects(store.addDocument(doc('2', 'a')), { code: 'POC_DOCUMENT_EXISTS' });
});
