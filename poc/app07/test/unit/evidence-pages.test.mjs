import test from 'node:test';
import assert from 'node:assert/strict';
import { evidencePagesReader, evidencePagesRoutes } from '../../evidence-pages.mjs';

// 单据抽屉「原件」页签按页看抽取的文字（Ruling T5g）：读单据（store.getDocument），再用它的公司和现在的版本调九安只读的
// evidenceService.context（server.mjs 的 readEvidence）；只回 { id, name, status, totalPages, pages: [{ page, text }] }。全部虚构。
const PATH = '/api/analysis/v1/poc/evidence-pages';
const DOCS = new Map([
  ['d1', { id: 'd1', companyId: 'co-a', version: 'v2', number: 'DGZF-X-001' }],
  ['d2', { id: 'd2', companyId: 'co-a', version: 'v1' }],
]);
const CONTEXT = {
  environment: 'prod', tenantId: 't1', companyId: 'co-a', documentId: 'd1', sourceVersion: 'v2', detailVersion: 'dv1', status: 'pending_read', completeness: 'partial',
  observedScopeComplete: false, observedFileCount: 3, omittedCount: 0, returnedCount: 2, truncated: false, fingerprint: 'fp',
  files: [
    { id: 'a-1', name: '虚构合同.pdf', sha256: 'h1', pageTextHash: 'p1', status: 'ready', totalPages: 2, pages: [{ page: 1, text: '虚构合同第一页' }, { page: 2, text: '合同金额 110,000 元（虚构）' }] },
    { id: 'a-2', name: '虚构发票.pdf', sha256: 'h2', pageTextHash: 'p2', status: 'extraction_partial', totalPages: 2, pages: [{ page: 1, text: '' }, { page: 2, text: '虚构发票' }] },
  ],
};

function harness({ readEvidence } = {}) {
  const reads = [], calls = [], logs = [];
  const readPages = evidencePagesReader({
    readDocument: async id => { reads.push(id); return DOCS.get(id) ?? null; },
    readEvidence: readEvidence ?? (async input => { calls.push(input); return input.documentId === 'd1' ? CONTEXT : { ...CONTEXT, documentId: input.documentId, status: 'not_run', files: [] }; }),
  });
  const routes = evidencePagesRoutes({ readPages, log: line => logs.push(line) });
  const ask = async (search = '', { user = { id: 'poc-reviewer', role: 'admin' }, method = 'GET', path = PATH } = {}) => {
    let status = null, payload = null;
    const res = { writeHead(code) { status = code; return this; }, setHeader() {}, end(text) { payload = text ? JSON.parse(text) : null; } };
    const url = new URL(`${path}${search}`, 'http://localhost');
    const handled = await routes.handle({ req: { method, headers: {} }, url, path: url.pathname, session: user ? { user } : null, res, body: undefined });
    return { handled, status, payload };
  };
  return { reads, calls, logs, readPages, ask };
}
const refusedWith = (answer, status, code) => {
  assert.equal(answer.handled, true);
  assert.equal(answer.status, status, JSON.stringify(answer.payload));
  assert.equal(answer.payload.error.code, code);
  assert.match(answer.payload.error.message, /[一-鿿]/u, '错误说明是中文');
};

test('reads the document, then the evidence context with its company and current version; returns only id, name, status, totalPages and pages', async () => {
  const h = harness();
  const answer = await h.readPages('d1');
  assert.deepEqual(h.reads, ['d1']);
  assert.deepEqual(h.calls, [{ companyId: 'co-a', documentId: 'd1', version: 'v2' }]);
  assert.deepEqual(answer, { documentId: 'd1', documentVersion: 'v2', files: [
    { id: 'a-1', name: '虚构合同.pdf', status: 'ready', totalPages: 2, pages: [{ page: 1, text: '虚构合同第一页' }, { page: 2, text: '合同金额 110,000 元（虚构）' }] },
    { id: 'a-2', name: '虚构发票.pdf', status: 'extraction_partial', totalPages: 2, pages: [{ page: 1, text: '' }, { page: 2, text: '虚构发票' }] },
  ] });
});

test('originals not read yet (status not_run) → files: []; a document outside the bench → null', async () => {
  const h = harness();
  assert.deepEqual(await h.readPages('d2'), { documentId: 'd2', documentVersion: 'v1', files: [] });
  assert.equal(await h.readPages('nope'), null);
  assert.deepEqual(h.calls.map(call => call.documentId), ['d2'], '范围外的单据不去读原件');
});

test('GET evidence-pages?documentId=: admin, analyst and policy_reviewer may read it', async () => {
  for (const role of ['admin', 'analyst', 'policy_reviewer']) {
    const answer = await harness().ask('?documentId=d1', { user: { id: `u-${role}`, role } });
    assert.equal(answer.status, 200, JSON.stringify(answer.payload));
    assert.deepEqual(answer.payload.data.files.map(file => [file.name, file.pages.length]), [['虚构合同.pdf', 2], ['虚构发票.pdf', 2]]);
    assert.equal(Object.hasOwn(answer.payload.data.files[0], 'sha256'), false);
  }
});

test('other roles and no session → 403; unknown document → 404; bad query → 400', async () => {
  const h = harness();
  refusedWith(await h.ask('?documentId=d1', { user: { id: 'x', role: 'owner' } }), 403, 'EVIDENCE_PAGES_FORBIDDEN');
  refusedWith(await h.ask('?documentId=d1', { user: null }), 403, 'EVIDENCE_PAGES_FORBIDDEN');
  refusedWith(await h.ask('?documentId=nope'), 404, 'EVIDENCE_PAGES_NOT_FOUND');
  for (const search of ['', '?documentId=', '?documentId=d1&documentId=d2', '?documentId=d1&x=1', '?documentId=d%01', `?documentId=${'a'.repeat(192)}`, '?documentId=%20d1']) {
    refusedWith(await h.ask(search), 400, 'EVIDENCE_PAGES_INVALID');
  }
  assert.deepEqual(h.calls, []);
});

test('Jiuan\'s codes map to the shell\'s own, with Chinese messages; unknown errors are 503 and only the code is logged', async () => {
  const cases = [
    ['NOT_FOUND', 404, 'EVIDENCE_PAGES_NOT_FOUND'],
    ['ANALYSIS_SOURCE_CHANGED', 409, 'EVIDENCE_PAGES_STALE'],
    ['ANALYSIS_EVIDENCE_CACHE_INVALID', 409, 'EVIDENCE_PAGES_REREAD'],
    ['ANALYSIS_EVIDENCE_UNAVAILABLE', 503, 'EVIDENCE_PAGES_UNAVAILABLE'],
  ];
  for (const [jiuan, status, code] of cases) {
    const h = harness({ readEvidence: async () => { throw Object.assign(new Error('里面有 秘密 文字'), { code: jiuan }); } });
    refusedWith(await h.ask('?documentId=d1'), status, code);
    assert.deepEqual(h.logs, [`POC_EVIDENCE_PAGES_FAILED ${jiuan}`]);
  }
  const h = harness({ readEvidence: async () => { throw new TypeError('boom 秘密'); } });
  refusedWith(await h.ask('?documentId=d1'), 503, 'EVIDENCE_PAGES_UNAVAILABLE');
  assert.deepEqual(h.logs, ['POC_EVIDENCE_PAGES_FAILED TypeError']);
});

test('only GET on this path; anything else goes to the next route', async () => {
  const h = harness();
  assert.equal((await h.ask('?documentId=d1', { method: 'POST' })).handled, false);
  assert.equal((await h.ask('?documentId=d1', { path: `${PATH}/x` })).handled, false);
});

test('drops malformed pages and files instead of passing them through', async () => {
  const h = harness({ readEvidence: async () => ({ ...CONTEXT, files: [
    { id: 'a-1', name: '虚构合同.pdf', status: 'ready', totalPages: 2, pages: [{ page: 1, text: '好的' }, { page: 'x', text: 1 }, null] },
    null, { name: '没有编号' },
  ] }) });
  assert.deepEqual((await h.readPages('d1')).files, [{ id: 'a-1', name: '虚构合同.pdf', status: 'ready', totalPages: 2, pages: [{ page: 1, text: '好的' }] }]);
});
