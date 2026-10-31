import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createUserScope, scopedDocument } from '../../user-scope.mjs';
import { analysisHuilianyiCompanyIds, benchScope } from './scope-fixture.mjs';

// 外壳新接口的公司范围（Ruling FR1）：登录的人在九安里能看的汇联易公司（九安自己的 analysisHuilianyiCompanyIds）∩ 测试台的公司。
// 九安不许规则发布复核人有公司（analysis-auth.mjs），所以他的范围是空的。公司、账号全部虚构。
const BENCH = ['co-a', 'co-b'];

test('范围 = 这个人在九安里的汇联易公司 ∩ 测试台的公司；按九安的写法读（providerScopes.huilianyi 优先，没有就用 companyIds）', () => {
  const scopeOf = benchScope(BENCH);
  assert.deepEqual(scopeOf({ id: 'u1', role: 'admin', companyIds: ['co-a', 'co-b'] }), ['co-a', 'co-b']);
  assert.deepEqual(scopeOf({ id: 'u2', role: 'analyst', companyIds: ['co-b', 'co-z'] }), ['co-b'], '测试台以外的公司不算');
  assert.deepEqual(scopeOf({ id: 'u3', role: 'analyst', companyIds: ['co-a', 'co-b'], providerScopes: { huilianyi: { companyIds: ['co-a'] } } }), ['co-a'],
    '九安按汇联易的授权范围读，不按旧的 companyIds');
  assert.deepEqual(scopeOf({ id: 'u4', role: 'analyst', companyIds: ['co-z'] }), []);
});

test('规则发布复核人在九安里没有公司：范围是空的；读不出范围（账号的公司写法不对、没有会话）也当空的，不抛错', () => {
  const scopeOf = benchScope(BENCH);
  assert.deepEqual(scopeOf({ id: 'p1', role: 'policy_reviewer', companyIds: [], providerScopes: { huilianyi: { companyIds: [] } } }), []);
  assert.deepEqual(scopeOf({ id: 'p2', role: 'policy_reviewer', companyIds: [] }), []);
  for (const odd of [{ id: 'x', companyIds: [''] }, { id: 'x', companyIds: ['co-a'], providerScopes: null }]) {
    assert.throws(() => analysisHuilianyiCompanyIds(odd), JSON.stringify(odd) + '：九安自己读到不合格的范围会抛错');
  }
  for (const user of [{ id: 'x', companyIds: [''] }, { id: 'x' }, { id: 'x', companyIds: ['co-a'], providerScopes: null }, null, undefined]) {
    assert.deepEqual(scopeOf(user), [], JSON.stringify(user));
  }
  const odd = createUserScope({ benchCompanyIds: BENCH, sourceCompanyIds: () => 'co-a' });
  assert.deepEqual(odd({ id: 'x' }), [], '九安给的不是数组也当空的');
});

test('scopedDocument：范围是空的就不去读、当不存在；否则按这个人的范围读', async () => {
  const reads = [];
  const read = scopedDocument(benchScope(BENCH), async input => { reads.push(input); return { id: input.id }; });
  assert.equal(await read('d1', { id: 'p1', role: 'policy_reviewer', companyIds: [] }), null);
  assert.deepEqual(reads, [], '范围是空的：不去读');
  assert.deepEqual(await read('d1', { id: 'u2', role: 'analyst', companyIds: ['co-b', 'co-z'] }), { id: 'd1' });
  assert.deepEqual(reads, [{ id: 'd1', companyIds: ['co-b'] }]);
});

test('server_wiring：复核、各轮、原件的文字、工作台都按登录的人的范围读（九安的 analysisHuilianyiCompanyIds ∩ 测试台的公司）', async () => {
  const server = await readFile(fileURLToPath(new URL('../../server.mjs', import.meta.url)), 'utf8');
  assert.match(server, /createUserScope\(\{ benchCompanyIds: companyIds, sourceCompanyIds: J\.auth\.analysisHuilianyiCompanyIds \}\)/);
  assert.match(server, /createReviews\(\{[\s\S]*?readDocument: headInScope \}\)/);
  assert.match(server, /documentRoundsReader\(\{[\s\S]*?readDocument: headInScope \}\)/);
  assert.match(server, /evidencePagesReader\(\{ readDocument: documentInScope, readEvidence \}\)/);
  assert.match(server, /createDashboard\(\{[\s\S]*?scopeOf: userScope,/);
  // 新接口里不再有按整个测试台读单据的地方
  for (const name of ['getDocumentHead', 'getDocument']) {
    const lines = server.split('\n').filter(line => line.includes(`store.${name}(`));
    assert.ok(lines.every(line => !/reviews|adviceRounds|evidencePages|createDashboard/.test(line)), name);
  }
});
