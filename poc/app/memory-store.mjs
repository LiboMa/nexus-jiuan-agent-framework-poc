/**
 * 九安 store 接口的内存实现（对照九安 src/mysql-analysis-store.mjs 的契约）。只给 PoC 用：单进程、重启清空。
 * 键值状态（AI 建议、原件证据、规则工作区）的乐观锁写入串行执行。
 * 故意不实现 getPaymentCompanyBinding：九安见到它才会启用付款服务，PoC 不提供付款。
 */
const LIST_FIELDS = ['id', 'environment', 'tenantId', 'companyId', 'companyName', 'number', 'formName', 'type', 'status', 'amount', 'currency',
  'modifiedAt', 'collectedAt', 'version', 'historyCount', 'rejectionCount', 'withdrawalCount', 'sourceCompanyId', 'reviewFields', 'evidence',
  'submittedAt', 'detailProjection'];
const clone = value => (value === undefined || value === null ? null : structuredClone(value));
const fail = (code, status) => { throw Object.assign(new Error(code), { code, ...(status ? { status } : {}) }); };
const isDecimal = value => (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value)) || (typeof value === 'number' && Number.isFinite(value));
const cents = value => Math.round(Number(value) * 100);
const amountOf = rows => {
  const priced = rows.filter(row => isDecimal(row.amount));
  return priced.length ? (priced.reduce((sum, row) => sum + cents(row.amount), 0) / 100).toFixed(2) : null;
};
const validKey = key => typeof key === 'string' && key.length > 0 && key.length <= 300;

export function createMemoryStore({ documents = [], companies = [] } = {}) {
  const docs = new Map(documents.map(document => [document.id, clone(document)]));
  const state = new Map();
  let writes = Promise.resolve();
  const visible = companyIds => (Array.isArray(companyIds) ? [...docs.values()].filter(document => companyIds.includes(document.companyId)) : []);
  const series = (rows, keyOf) => {
    const groups = new Map();
    for (const row of rows) { const key = keyOf(row); groups.set(key, [...(groups.get(key) ?? []), row]); }
    return [...groups].map(([name, list]) => ({ name, count: list.length, amount: amountOf(list) }))
      .sort((a, b) => b.count - a.count || String(a.name).localeCompare(String(b.name)));
  };
  return {
    async listCompanies({ companyIds } = {}) {
      return companies.filter(company => !companyIds || companyIds.includes(company.id))
        .map(company => ({ id: company.id, tenantId: company.tenantId, name: company.name, count: [...docs.values()].filter(document => document.companyId === company.id).length }));
    },
    async listDocuments({ companyIds, q = '', status, limit = 25, offset = 0 } = {}) {
      const needle = String(q ?? '').trim().toLowerCase();
      const rows = visible(companyIds)
        .filter(document => !needle || [document.number, document.formName, document.companyName].some(value => String(value ?? '').toLowerCase().includes(needle)))
        .filter(document => status === undefined || status === null || status === '' || String(document.status) === String(status))
        .sort((a, b) => String(b.collectedAt).localeCompare(String(a.collectedAt)) || a.id.localeCompare(b.id));
      return { items: rows.slice(offset, offset + limit).map(document => clone(Object.fromEntries(LIST_FIELDS.map(key => [key, document[key]])))), total: rows.length };
    },
    // 模拟来单（PoC 专用）：九安生产上单据由汇联易同步写进来
    async addDocument(document) {
      if (!document?.id || docs.has(document.id)) fail('POC_DOCUMENT_EXISTS', 409);
      docs.set(document.id, clone(document));
      return clone(document);
    },
    async getDocument({ id, companyIds } = {}) {
      const document = docs.get(id);
      return document && Array.isArray(companyIds) && companyIds.includes(document.companyId) ? clone(document) : null;
    },
    async getDocumentHead({ id, companyIds } = {}) {
      const document = docs.get(id);
      if (!document || !Array.isArray(companyIds) || !companyIds.includes(document.companyId)) return null;
      return { id: document.id, environment: 'prod', tenantId: document.tenantId, companyId: document.companyId, version: document.version,
        type: document.type, detailProjection: clone(document.detailProjection) };
    },
    async overview({ companyIds } = {}) {
      const rows = visible(companyIds), events = rows.flatMap(document => document.history ?? []);
      const count = category => events.filter(event => event.category === category).length;
      return { documentCount: rows.length, companiesCount: new Set(rows.map(document => document.companyId)).size,
        historyReportCount: rows.filter(document => document.historyCount > 0).length, eventCount: events.length,
        rejectionCount: count('rejected'), withdrawalCount: count('withdrawn'), passedEventCount: count('passed'),
        byForm: series(rows, document => document.formName).map(({ name, count: total }) => ({ name, count: total })), historicalVersionsAvailable: false };
    },
    async analytics({ companyIds } = {}) {
      const rows = visible(companyIds);
      const nameOf = id => rows.find(document => document.companyId === id)?.companyName ?? id;
      return {
        byCompany: series(rows, document => document.companyId).map(({ name, count }) => ({ id: name, name: nameOf(name), count })),
        byStatus: series(rows, document => String(document.status ?? '')),
        byType: series(rows, document => document.type),
        byMonth: series(rows.filter(document => document.modifiedAt), document => String(document.modifiedAt).slice(0, 7)).sort((a, b) => a.name.localeCompare(b.name)),
        byCurrency: series(rows, document => document.currency ?? ''),
        byForm: series(rows, document => document.formName),
        aiRecordCount: 0,
        amountUnavailable: rows.filter(document => !isDecimal(document.amount)).length,
        undatedCount: rows.filter(document => !document.modifiedAt).length,
        rejectedDocumentCount: rows.filter(document => document.rejectionCount > 0).length,
        withdrawnDocumentCount: rows.filter(document => document.withdrawalCount > 0).length,
      };
    },
    async listBatches() { return []; },
    async readState(key) { return clone(state.get(key)); },
    async readStates(keys) {
      if (!Array.isArray(keys) || keys.length > 50 || new Set(keys).size !== keys.length || !keys.every(validKey)) fail('ANALYSIS_VALIDATION');
      return { values: Object.fromEntries(keys.map(key => [key, clone(state.get(key))])), errors: {} };
    },
    async writeState(key, value) {
      if (!validKey(key) || value === undefined) fail('ANALYSIS_VALIDATION');
      state.set(key, clone(value));
    },
    compareAndWriteState(key, { expectedRevision, value, authorize = async () => true } = {}) {
      const run = writes.then(async () => {
        if (!validKey(key) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0
          || !value || typeof value !== 'object' || Array.isArray(value) || value.revision !== expectedRevision + 1) fail('ANALYSIS_VALIDATION');
        if (await authorize() === false) fail('ANALYSIS_SCOPE_MISMATCH', 403);
        if ((state.get(key)?.revision ?? 0) !== expectedRevision) fail('ANALYSIS_STATE_CONFLICT', 409);
        if (await authorize() === false) fail('ANALYSIS_SCOPE_MISMATCH', 403);
        state.set(key, clone(value));
        return { revision: value.revision };
      });
      writes = run.catch(() => {});
      return run;
    },
  };
}
