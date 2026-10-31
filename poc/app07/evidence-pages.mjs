/**
 * 一张单原件的按页文字（单据抽屉的「原件」页签，Ruling T5g）：九安的 GET /documents/:id/evidence 只给读取状态和页数，不给文字；
 * 文字在九安加密的文字缓存里，只读的 evidenceService.context 会读它（每张单最多 10 个已读出文字的原件，analysis-evidence-service.mjs）。
 *   GET /api/analysis/v1/poc/evidence-pages?documentId= → { documentId, documentVersion, files: [{ id, name, status, totalPages, pages: [{ page, text }] }] }
 * 先按登录的人的范围读单据（store.getDocument，他在九安里的公司 ∩ 测试台的公司，Ruling FR1），读到了才用它的公司和现在的版本调
 * readEvidence（server.mjs 包好的 context）。context 照旧用流水线身份读：九安按人读要求是管理员或分析员（规则发布复核人会被当成登录失效），
 * 所以这一道门是外壳自己的角色检查和这次按人读单据。
 * 原件还没读过（status not_run）回 files: []。给管理员、分析员、规则发布复核人；别的角色 403；单据不在这个人的范围里或不存在 404（同 advice-rounds）。
 * 九安的错误码换成外壳自己的（同 reviews.mjs），日志只记错误码，不记消息和文字。
 */
const PATH = '/api/analysis/v1/poc/evidence-pages';
const ROLES = new Set(['admin', 'analyst', 'policy_reviewer']);
const DOCUMENT_ID = /^[^\u0000-\u001f\u007f]{1,191}$/u;
const CODE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
export const EVIDENCE_PAGES_MESSAGES = Object.freeze({
  EVIDENCE_PAGES_FORBIDDEN: '只有管理员、分析员和规则发布复核人能看原件的文字：请换有权限的账号登录。',
  EVIDENCE_PAGES_INVALID: '请求的参数不对（只要一个单据编号 documentId）：请从单据池重新打开这张单。',
  EVIDENCE_PAGES_NOT_FOUND: '找不到这张单据：刷新单据池后再试。',
  EVIDENCE_PAGES_STALE: '单据刚更新：请刷新这张单后再看原件的文字。',
  EVIDENCE_PAGES_REREAD: '原件的文字和现在的单据对不上了：点「读取原件」重新读取后再看。',
  EVIDENCE_PAGES_UNAVAILABLE: '原件的文字暂时读不到，稍后再试。',
});
// 规则发布复核人没有「读取原件」按钮：换一句叫他找能读的人
const READER_MESSAGES = Object.freeze({ EVIDENCE_PAGES_REREAD: '原件的文字和现在的单据对不上了：要重新读取原件，请找管理员或分析员。' });
const STATUS = Object.freeze({ EVIDENCE_PAGES_FORBIDDEN: 403, EVIDENCE_PAGES_INVALID: 400, EVIDENCE_PAGES_NOT_FOUND: 404, EVIDENCE_PAGES_STALE: 409,
  EVIDENCE_PAGES_REREAD: 409, EVIDENCE_PAGES_UNAVAILABLE: 503 });
// 九安 evidenceService.context 会抛的码 → 外壳的码；别的（含程序错误）都是 UNAVAILABLE
const FROM_JIUAN = Object.freeze({ NOT_FOUND: 'EVIDENCE_PAGES_NOT_FOUND', ANALYSIS_SOURCE_CHANGED: 'EVIDENCE_PAGES_STALE',
  ANALYSIS_EVIDENCE_CACHE_INVALID: 'EVIDENCE_PAGES_REREAD' });
const refuse = code => { throw Object.assign(new Error(code), { code, shell: true }); };
const send = (res, status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(payload)); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** context 的一个原件 → 页面要的样子；不成样子的页、原件丢掉。 */
function fileOf(file) {
  if (!isObject(file) || typeof file.id !== 'string' || !file.id) return null;
  const pages = (Array.isArray(file.pages) ? file.pages : [])
    .filter(page => isObject(page) && Number.isSafeInteger(page.page) && page.page > 0 && typeof page.text === 'string')
    .map(page => ({ page: page.page, text: page.text }));
  return { id: file.id, name: typeof file.name === 'string' && file.name ? file.name : '附件', status: typeof file.status === 'string' ? file.status : null,
    totalPages: Number.isSafeInteger(file.totalPages) ? file.totalPages : null, pages };
}

/**
 * readDocument(id, user) → 登录的人范围里的单据（要 id、companyId、version；user-scope.mjs 的 scopedDocument）或 null；
 * readEvidence({ companyId, documentId, version }) → 九安的 context。
 * 返回的函数：(documentId, user) → null（单据不在这个人的范围里，不去读原件）或 { documentId, documentVersion, files }。
 */
export function evidencePagesReader({ readDocument, readEvidence }) {
  return async (documentId, user) => {
    const document = await readDocument(documentId, user);
    if (!document || document.id !== documentId) return null;
    const context = await readEvidence({ companyId: document.companyId, documentId, version: document.version });
    const files = context?.status === 'not_run' || !Array.isArray(context?.files) ? [] : context.files.map(fileOf).filter(Boolean);
    return { documentId, documentVersion: document.version, files };
  };
}

export function evidencePagesRoutes({ readPages, log = () => {} }) {
  return {
    async handle({ req, url, path: pathname, session, res }) {
      const where = url ?? new URL(pathname, 'http://localhost');
      if (req.method !== 'GET' || where.pathname !== PATH) return false;
      try {
        if (!ROLES.has(session?.user?.role)) refuse('EVIDENCE_PAGES_FORBIDDEN');
        const names = [...where.searchParams.keys()], documentId = where.searchParams.get('documentId');
        if (names.length !== 1 || names[0] !== 'documentId' || !DOCUMENT_ID.test(documentId ?? '') || documentId.trim() !== documentId) refuse('EVIDENCE_PAGES_INVALID');
        const pages = await readPages(documentId, session.user);
        if (!pages) refuse('EVIDENCE_PAGES_NOT_FOUND');
        send(res, 200, { data: pages });
      } catch (error) {
        const own = error?.shell === true && Object.hasOwn(STATUS, error.code);
        // 只记错误码（程序错误没有合格的码时记错误名），不记消息
        if (!own) log(`POC_EVIDENCE_PAGES_FAILED ${[error?.code, error?.name].find(value => typeof value === 'string' && CODE.test(value)) ?? 'UNKNOWN'}`);
        const code = own ? error.code : FROM_JIUAN[error?.code] ?? 'EVIDENCE_PAGES_UNAVAILABLE';
        const message = (session?.user?.role === 'policy_reviewer' && READER_MESSAGES[code]) || EVIDENCE_PAGES_MESSAGES[code];
        send(res, STATUS[code], { error: { code, message } });
      }
      return true;
    },
  };
}
