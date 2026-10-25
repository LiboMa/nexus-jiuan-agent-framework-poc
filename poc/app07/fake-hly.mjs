/**
 * 进程内的假汇联易：九安 v0.7.10 自己的测试环境客户端（providers/huilianyi-stage-oauth.mjs）照常运行，只把它的 fetchImpl 和
 * 连接器的 downloadFetchImpl 换成这里的两个函数（transports['hly-prod']），所以同步、详情、明细整理、原件读取、AI 独立建议
 * 走的都是九安原来的代码。不做任何真实网络 I/O；只认九安写死的两个测试环境域名，别的域名一律抛错。
 *
 * 九安测试实例正常运行时调哪些汇联易接口、先后顺序（读 src/platform/scheduler.mjs、platform/adapters/*、analysis-sync.mjs、
 * report-detail-queue.mjs、analysis-evidence-service.mjs、company-directory.mjs、department-directory.mjs 得出）：
 *  0. POST /oauth/token  client_credentials + Basic；客户端缓存令牌到过期前 60 秒，之后每次请求带 Bearer。
 *  1. hly.list-sync（定时或手动，corporate、employee 两个通道）：GET /gateway/api/open/expenseReport
 *     参数 startDate、endDate（北京时间墙钟 YYYY-MM-DD HH:mm:ss）、corporateFlag、status=1001,…,1008、page（从 1）、size=50、
 *     dateSearchField=lastModifyDate、withApprovalHistory=true、withPaymentSchedule=false、queryIncludeArchived=true，
 *     单主体配置时另带 docCompanyOID。按窗口翻页，用 X-Total-Count 核对每个窗口的条数；每行的 tenantId、docCompanyOID 须在授权范围内。
 *     增量同步只读到「现在减 5 分钟」，首轮从昨天 0 点（上海）起；更早的单据要用「历史回填」。
 *  2. hly.report-detail（列表同步之后串联）：GET /gateway/api/open/expenseReport/detail?businessCode&companyOID&corporateFlag
 *     （companyOID 是原文的 companyOID，corporateFlag 按表单名推）。返回的原文规整后须与列表那一行一致（bindAnalysisDetail）。
 *  3. hly.detail-projection、audit.ai-advice（review_advice@1）、audit.element-check（详情读取之后并行串联）：不调汇联易。
 *  4. 原件只在「单据原件在线读取」（analysis-evidence-service.mjs，单据页手动，或测试台在 AI 独立建议前代为发起）时读：
 *     详情缓存超过 15 分钟先重读 detail，再经连接器 attachment.download 逐个 GET https://helioscloud-uat.huilianyi.com/…（downloadFetchImpl）。
 *  5. 开启自动同步后（启动 5 分钟后，此后每天一次）：GET /gateway/api/open/company/tenant/all?page&size=100（公司目录）；
 *     GET /gateway/api/open/department/{departmentOID} 与 GET /gateway/api/open/user/{userOID}（部门负责人目录）。
 *  只有手动才调：POST /gateway/api/open/payment/detail/query（付款流水采集）。没有调用方、照常应答空结果：approvalHistory/query、
 *  expenseReport/auto/audit/result/list|detail、contract/batch/detail/query、travelApplication/detail、/gateway/budget-service/…、
 *  GET /gateway/api/open/user/detail/{工号}。
 *  审批写入与待办（含已办）：POST /gateway/api/open/approvals/*、POST /gateway/api/open/batch/approval —— 一律 403，calls 里记 blocked。
 *  其他路径 404。calls 只记 { method, path, status, blocked? }，不记正文、查询串和令牌。
 */
import { createHash, randomBytes } from 'node:crypto';
import { yesterdayNoon } from './seed-anchor.mjs';
import { DEPARTMENTS, EMPLOYEES, COMPANIES, FILES, FILE_HOST, REPORTS } from './fixtures.mjs';

export const API_HOST = 'apistage.huilianyi.com';
// 九安增量同步读到「现在减 5 分钟」：模拟来单的时间往前挪 6 分钟，下一轮同步就读得到
export const ARRIVAL_LAG_MS = 6 * 60_000;

const json = (status, value, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json;charset=UTF-8', ...headers } });
const OK = Object.freeze({ errorCode: '0000', message: '成功' });
const fault = (errorCode, message) => ({ errorCode, message: `${message}（假汇联易）` });
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const clone = value => structuredClone(value);
const parseUrl = input => new URL(input instanceof URL ? input.href : typeof input === 'string' ? input : input?.url);
const refuse = url => { throw Object.assign(new Error(`FAKE_HLY_HOST_REFUSED ${url.protocol}//${url.host}`), { code: 'FAKE_HLY_HOST_REFUSED' }); };
// 汇联易时间（带时区的 ISO，或不带时区的北京时间）→ 北京时间墙钟文本，跟列表查询的 startDate/endDate 同一坐标
function beijing(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  if (!/(?:[zZ]|[+-]\d{2}:?\d{2})$/u.test(text)) return text.replace('T', ' ').slice(0, 19);
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ') : null;
}
const isoSecond = date => date.toISOString().replace(/\.\d{3}Z$/u, 'Z');
const derivedOid = seed => {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
async function bodyJson(options) {
  try { return typeof options?.body === 'string' ? JSON.parse(options.body) : {}; } catch { return {}; }
}

const TIME_KEYS = ['createdDate', 'lastSubmittedDate', 'lastModifyDate', 'activatedDate'];
const DAY_MS = 24 * 3600_000, SHANGHAI_MS = 8 * 3600_000;
/** 昨天中午（北京时间）：九安首轮增量同步从昨天 0 点读起，落在这里的种子首轮就读得到；同一天里算出来都一样。 */

/** 按 lastModifyDate 的先后逐张落位：最晚一张在 anchor，往前每张早 10 分钟；每张单内部的时间差（创建、提交、审批）照原样。 */
function restamp(raws, anchor) {
  const order = raws.map((raw, index) => [index, Date.parse(raw.lastModifyDate)]).sort((left, right) => right[1] - left[1]);
  order.forEach(([index, modified], rank) => {
    const shift = anchor - rank * 10 * 60_000 - modified;
    const walk = value => {
      if (Array.isArray(value)) { value.forEach(walk); return; }
      if (!value || typeof value !== 'object') return;
      for (const key of TIME_KEYS) if (typeof value[key] === 'string' && Number.isFinite(Date.parse(value[key]))) value[key] = isoSecond(new Date(Date.parse(value[key]) + shift));
      Object.values(value).forEach(walk);
    };
    walk(raws[index]);
  });
  return raws;
}

/**
 * restampSeeds：测试台上传锚点（seed-anchor.mjs 存下的那个时间，毫秒）；传 true 就按 now 现算昨天中午（只给单元测试用）。
 * 种子单据的日期是写死的，九安首轮增量同步只读昨天 0 点以后的，所以创建时把它们落到锚点前后；
 * 同一天里重启，时间和版本都不变（不会重复发起 AI 初审），换了天重启会变成新版本、重新初审一次。单元测试默认关闭，用写死的日期。
 */
export function createFakeHuilianyi({ reports = REPORTS, files = FILES, now = () => new Date(), onCall = () => {}, arrivalLagMs = ARRIVAL_LAG_MS,
  restampSeeds = false } = {}) {
  const anchor = Number.isFinite(restampSeeds) ? restampSeeds : restampSeeds === true ? yesterdayNoon(new Date(now()).getTime()) : null;
  const seeds = anchor === null ? reports.map(clone) : restamp(reports.map(clone), anchor);
  const live = seeds.map(clone);           // 种子单据 + 模拟来单
  const tokens = new Set(), calls = [];
  let sequence = 0;
  const record = (method, path, status, blocked = false) => {
    const entry = { method, path, status, ...(blocked ? { blocked: true } : {}) };
    calls.push(entry);
    try { onCall({ ...entry }); } catch { /* 观察回调出错不影响应答 */ }
  };
  const find = code => live.find(raw => raw.businessCode === code);

  function list(q) {
    const page = Number(q.get('page') ?? 1), size = Number(q.get('size') ?? 20), start = q.get('startDate'), end = q.get('endDate');
    if (!start || !end || !Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(size) || size < 1 || size > 100) return [400, fault('120003', '缺少必填项或分页无效')];
    const flag = q.get('corporateFlag'), statuses = q.get('status')?.split(','), dateField = q.get('dateSearchField') || 'lastModifyDate';
    const filters = ['docCompanyOID', 'companyOID', 'docCompanyCode'].filter(key => q.get(key));
    const rows = live.filter(raw => (flag === null || String(raw.corporateFlag === true) === flag)
      && (!statuses || statuses.includes(String(raw.status))) && filters.every(key => raw[key] === q.get(key))
      && (at => at !== null && at >= start && at <= end)(beijing(raw[dateField])))
      .sort((a, b) => beijing(a[dateField]).localeCompare(beijing(b[dateField])) || a.businessCode.localeCompare(b.businessCode));
    return [200, rows.slice((page - 1) * size, page * size).map(clone), { 'X-Total-Count': String(rows.length) }];
  }
  function detail(q) {
    const raw = find(q.get('businessCode') ?? ''), company = q.get('companyOID');
    if (!raw || company && company !== raw.companyOID && company !== raw.docCompanyOID) return [404, fault('120401', '单据不存在')];
    return [200, clone(raw)];
  }
  function directory(q) {
    const page = Number(q.get('page') ?? 1), size = Number(q.get('size') ?? 100);
    const rows = COMPANIES.map(company => ({ companyOID: company.id, code: company.code, name: company.name, tenantId: company.tenantId, enabled: true }));
    return [200, { ...OK, data: rows.slice((page - 1) * size, page * size) }];
  }
  const ROUTES = [
    ['GET', /^\/api\/open\/expenseReport$/u, list],
    ['GET', /^\/api\/open\/expenseReport\/detail$/u, detail],
    ['GET', /^\/api\/open\/company\/tenant\/all$/u, directory],
    ['GET', new RegExp(`^/api/open/department/(${UUID})$`, 'u'), (q, [, id]) => {
      const row = DEPARTMENTS.find(item => item.departmentOID === id);
      return row ? [200, clone(row)] : [404, fault('120103', '部门不存在')];
    }],
    ['GET', /^\/api\/open\/user\/detail\/([A-Za-z0-9_-]{1,64})$/u, (q, [, id]) => {
      const row = EMPLOYEES.find(item => item.employeeID === id);
      return row ? [200, clone(row)] : [404, fault('120207', '员工不存在')];
    }],
    ['GET', new RegExp(`^/api/open/user/(${UUID})$`, 'u'), (q, [, id]) => {
      const row = EMPLOYEES.find(item => item.userOID === id);
      return row ? [200, clone(row)] : [404, fault('120207', '员工不存在')];
    }],
    ['POST', /^\/api\/open\/approvalHistory\/query$/u, (q, m, body) => [200, { ...OK, data: clone(find(body.businessCode)?.approvalHistoryDTOs ?? []) }]],
    ['GET', /^\/api\/open\/expenseReport\/auto\/audit\/result\/list$/u, () => [200, { ...OK, data: [] }]],
    ['GET', /^\/api\/open\/expenseReport\/auto\/audit\/result\/detail$/u, () => [200, { ...OK, data: null }]],
    ['POST', /^\/api\/open\/payment\/detail\/query$/u, () => [200, { ...OK, data: [] }, { 'X-Total-Count': '0' }]],
    ['POST', /^\/api\/open\/contract\/batch\/detail\/query$/u, () => [200, { ...OK, data: [] }]],
    ['GET', /^\/api\/open\/travelApplication\/detail$/u, () => [200, { ...OK, data: null }]],
    ['GET', /^\/budget-service\/api\/open\/budget\/explain\/query\/v2$/u, () => [200, { ...OK, data: [] }]],
    ['POST', /^\/budget-service\/api\/open\/budget\/query\/reserve$/u, () => [200, { ...OK, data: [] }]],
    ['POST', /^\/budget-service\/api\/open\/budget\/balance\/code$/u, () => [200, { ...OK, data: { queryResultList: [], queryResultCurrencyList: [] } }]],
  ];

  async function fetchImpl(input, options = {}) {
    const url = parseUrl(input);
    if (url.protocol !== 'https:' || url.hostname !== API_HOST || url.port || url.username || url.password) refuse(url);
    options?.signal?.throwIfAborted?.();
    const method = String(options?.method || 'GET').toUpperCase(), path = url.pathname, headers = new Headers(options?.headers ?? {});
    const reply = (status, body, extra = {}, blocked = false) => { record(method, path, status, blocked); return json(status, body, extra); };
    if (path === '/oauth/token') {
      const grant = new URLSearchParams(String(options?.body ?? '')).get('grant_type');
      if (method !== 'POST' || !/^Basic \S+$/u.test(headers.get('authorization') ?? '') || grant !== 'client_credentials') return reply(401, { error: 'invalid_client' });
      const token = `fake-stage-token-${randomBytes(12).toString('hex')}`;
      tokens.add(token);
      return reply(200, { access_token: token, token_type: 'bearer', expires_in: 7199, scope: 'write' });
    }
    if (!path.startsWith('/gateway/')) return reply(404, fault('FAKE_HLY_NOT_FOUND', '没有这个接口'));
    const route = path.slice('/gateway'.length);
    // 审批写入与待办：测试台只读，一律拒绝并记下
    if (/^\/api\/open\/approvals(?:\/|$)/u.test(route) || route === '/api/open/batch/approval') {
      return reply(403, fault('FAKE_HLY_WRITE_BLOCKED', '测试台只读，不接受审批写入或待办查询'), {}, true);
    }
    const bearer = /^Bearer (\S+)$/u.exec(headers.get('authorization') ?? '')?.[1];
    if (!bearer || !tokens.has(bearer)) return reply(401, fault('401', '令牌无效'));
    for (const [verb, pattern, handle] of ROUTES) {
      const match = pattern.exec(route);
      if (verb !== method || !match) continue;
      const [status, body, extra] = handle(url.searchParams, match, method === 'POST' ? await bodyJson(options) : {});
      return reply(status, body, extra);
    }
    return reply(404, fault('FAKE_HLY_NOT_FOUND', '没有这个接口'));
  }

  async function downloadFetchImpl(input, options = {}) {
    const url = parseUrl(input);
    if (url.protocol !== 'https:' || url.hostname !== FILE_HOST || url.port || url.username || url.password) refuse(url);
    options?.signal?.throwIfAborted?.();
    const method = String(options?.method || 'GET').toUpperCase();
    const file = method === 'GET' ? files.get(url.href) ?? files.get(url.origin + url.pathname) : null;
    record(method, url.pathname, file ? 200 : 404);
    if (!file) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    return new Response(new Uint8Array(file.bytes), { status: 200, headers: { 'content-type': 'application/pdf', 'content-length': String(file.bytes.length) } });
  }

  /**
   * 模拟来单：照模板复制一张新单据（新单号 <前缀>-SIM-<序号>、新的单据/发票/附件 OID 与审批记录编号、提交与修改时间取现在），
   * 下一轮列表同步就读得到。附件还是指向同一批虚构文件，原件照样能读。
   */
  function arrive({ template } = {}) {
    const source = reports.find(raw => raw.businessCode === template);
    if (!source) throw Object.assign(new Error('FAKE_HLY_TEMPLATE_UNKNOWN'), { code: 'FAKE_HLY_TEMPLATE_UNKNOWN', status: 400 });
    sequence += 1;
    const raw = clone(source), suffix = String(sequence).padStart(3, '0');
    const fresh = new Map(), renew = old => { if (!fresh.has(old)) fresh.set(old, derivedOid(`${old}|sim|${sequence}`)); return fresh.get(old); };
    const at = isoSecond(new Date(new Date(now()).getTime() - arrivalLagMs));
    const walk = value => {
      if (Array.isArray(value)) { value.forEach(walk); return; }
      if (!value || typeof value !== 'object') return;
      for (const key of ['expenseReportOID', 'invoiceOID', 'attachmentOID']) if (typeof value[key] === 'string') value[key] = renew(value[key]);
      Object.values(value).forEach(walk);
    };
    walk(raw);
    for (const entry of [...raw.approvalHistoryDTOs, ...(raw.approvalChains ?? [])]) {
      if (Number.isSafeInteger(entry.id)) entry.id += sequence * 100_000_000;
      if ('createdDate' in entry) entry.createdDate = at;
      if ('activatedDate' in entry) entry.activatedDate = at;
    }
    raw.businessCode = `${template.split('-')[0]}-SIM-${suffix}`;
    raw.createdDate = raw.lastSubmittedDate = raw.lastModifyDate = at;
    live.push(raw);
    return { businessCode: raw.businessCode };
  }

  const templates = () => reports.map(raw => ({ businessCode: raw.businessCode, formName: raw.formName, companyName: raw.docCompanyName, title: raw.title }));
  return Object.freeze({ fetchImpl, downloadFetchImpl, arrive, templates, calls });
}
