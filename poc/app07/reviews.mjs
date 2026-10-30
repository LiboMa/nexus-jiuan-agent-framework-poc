/**
 * 复核记录：审核员对一张单当前那一轮 AI 独立建议「采纳」或「改判」，绑定这一轮（advice_round）。按单据：谁复核都算，以最后一次为准，旧的留着。
 * 不回写汇联易，不碰九安的审批写回。
 *   POST /api/analysis/v1/poc/reviews {documentId, sourceVersion, round, decision, reason?, note?}  → 201 { review }（管理员、分析员）
 *   GET  …/reviews?documentId=                 这张单的复核历史，新的在前 → { items }
 *   GET  …/reviews/latest?ids=a,b,…             单据池一页（1–50 张）的复核状态 → { items: { [documentId]: { state, current, review } } }
 * 两个 GET 给管理员、分析员和规则发布复核人（policy_reviewer 的单据池只读，也要看复核状态）；别的角色一律 403。
 * 会话、来源和 CSRF 由九安校验；这些路径不在 /platform 下，九安不替它们读请求体，这里自己读。
 * 只能复核「当前那一轮已完成、审的是单据现在的版本、结论是 pass / fail」的建议：提交的轮次或版本不是当前的 → 409 REVIEW_STALE（先查这个），
 * 同一轮但还没完成（在跑、失败、declined…）→ 409 REVIEW_ADVICE_NOT_READY；单据不在测试台的公司里或不存在 → 404。两人同时复核同一轮都成功，后一次为准。
 * 查当前一轮和写入之间不加锁：这中间刚好又跑完一轮的话，记下的仍是提交时那一轮，latest 里这张单显示 outdated，回到待复核。
 * 改判原因按方向（Spec 第 9 节）：AI 不建议通过 → 改判为通过、AI 建议通过 → 改判为不通过各一组；other 必须写备注；备注去掉首尾空白，最多 200 字。
 * 表 poc_review_decisions 在九安的 jiuan07 库里（端到端测试的重置删库重建，随之清空），start() 时建；created_at 存 UTC 的 DATETIME(3)。
 */
import { readJson } from '../app/http.mjs';

const BASE = '/api/analysis/v1/poc/reviews';
const LATEST = `${BASE}/latest`;
const READ_ROLES = new Set(['admin', 'analyst', 'policy_reviewer']);
const WRITE_ROLES = new Set(['admin', 'analyst']);
const FIELDS = ['documentId', 'sourceVersion', 'round', 'decision', 'reason', 'note'];
const RESULTS = new Set(['pass', 'fail']);
const TEXT = /^[^\u0000-\u001f\u007f]{1,191}$/u;
const NOTE_MAX = 200, LATEST_MAX = 50;
/** 按 AI 的结论分：fail（AI 不建议通过）→ 改判为通过的原因；pass（AI 建议通过）→ 改判为不通过的原因。 */
export const OVERRIDE_REASONS = Object.freeze({
  fail: Object.freeze(['contract_covers', 'evidence_complete', 'amount_ok', 'rule_not_applicable', 'other']),
  pass: Object.freeze(['evidence_missing', 'amount_mismatch', 'payee_mismatch', 'rule_not_applicable', 'other']),
});
const ALL_REASONS = new Set([...OVERRIDE_REASONS.fail, ...OVERRIDE_REASONS.pass]);
export const REVIEW_MESSAGES = Object.freeze({
  REVIEW_FORBIDDEN: '只有管理员和分析员能复核 AI 建议；规则发布复核人只能查看复核记录。',
  REVIEW_INVALID: '复核内容不对：要有单据、版本、轮次和结论（采纳或改判），不带别的字段。',
  REVIEW_NOT_FOUND: '找不到这张单据：刷新单据池后再试。',
  REVIEW_ADVICE_NOT_READY: '这张单还没有完成的 AI 建议，等建议出来再复核。',
  REVIEW_STALE: '这张单的 AI 建议刚更新，请先看新的建议。',
  REVIEW_UNAVAILABLE: '复核记录暂时读写不了，稍后再试。',
  INVALID_CONTENT_TYPE: '复核请求要用 JSON 发送。',
  INVALID_JSON: '复核请求不是有效的 JSON。',
  BODY_LIMIT: '复核请求太大：备注最多 200 字。',
});
const INVALID = Object.freeze({
  adoptReason: '采纳 AI 建议时不用选改判原因。',
  reason: '改判要选一个改判原因。',
  fail: '改判为通过要从这些原因里选一个：合同或补充协议已涵盖、原件齐全 AI 没识别、金额核对无误、适用规则不对、其他。',
  pass: '改判为不通过要从这些原因里选一个：原件缺失或不符、金额不符、收款方不符、适用规则不对、其他。',
  otherNote: '改判原因选「其他」时要写备注。',
  note: `备注最多 ${NOTE_MAX} 字。`,
  documentId: '要给出单据编号（documentId）。',
  ids: `复核状态一次查 1 到 ${LATEST_MAX} 张单据（ids 用逗号分开）。`,
  query: '请求里有不认识的参数。',
});
const STATUS = Object.freeze({ REVIEW_FORBIDDEN: 403, REVIEW_INVALID: 400, REVIEW_NOT_FOUND: 404, REVIEW_ADVICE_NOT_READY: 409, REVIEW_STALE: 409,
  REVIEW_UNAVAILABLE: 503, INVALID_CONTENT_TYPE: 415, INVALID_JSON: 400, BODY_LIMIT: 413 });
const fail = (code, message = REVIEW_MESSAGES[code]) => { throw Object.assign(new Error(message), { code, shown: message }); };
const send = (res, status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(payload)); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && TEXT.test(value) && value.trim() === value;
const absent = value => value === undefined || value === null;

const COLUMNS = 'id, document_id, document_version, advice_round, ai_result, decision, final_result, reason, note, actor, created_at';
const SCHEMA = `CREATE TABLE IF NOT EXISTS poc_review_decisions (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  document_id VARCHAR(191) NOT NULL,
  document_version VARCHAR(191) NOT NULL,
  advice_round INT UNSIGNED NOT NULL,
  ai_result VARCHAR(8) NOT NULL,
  decision VARCHAR(16) NOT NULL,
  final_result VARCHAR(8) NOT NULL,
  reason VARCHAR(32) NULL,
  note VARCHAR(200) NULL,
  actor VARCHAR(191) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY poc_review_decisions_document (document_id, created_at, id),
  KEY poc_review_decisions_created (created_at, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`;
/** ISO 时间 ↔ UTC 的 DATETIME(3) 文字（'2026-10-30 08:00:01.000'），不经 pool 的时区换算。 */
const sqlTime = at => new Date(at).toISOString().slice(0, 23).replace('T', ' ');
const isoOf = value => (value instanceof Date ? value : new Date(`${String(value).replace(' ', 'T')}Z`)).toISOString();
const reviewOf = row => ({ id: Number(row.id), documentId: row.document_id, documentVersion: row.document_version, adviceRound: Number(row.advice_round),
  aiResult: row.ai_result, decision: row.decision, finalResult: row.final_result, reason: row.reason ?? null, note: row.note ?? null, actor: row.actor,
  createdAt: isoOf(row.created_at) });

/** 请求体 → { documentId, sourceVersion, round, decision, reason, note }；和方向无关的都在这里查（方向要等读到 AI 的结论）。 */
function parse(input) {
  if (!isObject(input) || Object.keys(input).some(name => !FIELDS.includes(name))) fail('REVIEW_INVALID');
  const { documentId, sourceVersion, round, decision, reason = null, note = null } = input;
  if (!isText(documentId) || !isText(sourceVersion) || !Number.isSafeInteger(round) || round < 1 || !['adopt', 'override'].includes(decision)) fail('REVIEW_INVALID');
  if (!absent(note) && typeof note !== 'string') fail('REVIEW_INVALID');
  const text = typeof note === 'string' ? note.trim() : '';
  if ([...text].length > NOTE_MAX) fail('REVIEW_INVALID', INVALID.note);
  if (decision === 'adopt' && !absent(reason)) fail('REVIEW_INVALID', INVALID.adoptReason);
  if (decision === 'override' && !ALL_REASONS.has(reason)) fail('REVIEW_INVALID', INVALID.reason);
  if (reason === 'other' && !text) fail('REVIEW_INVALID', INVALID.otherNote);
  return { documentId, sourceVersion, round, decision, reason: decision === 'override' ? reason : null, note: text || null };
}

/** 当前一轮能复核：已完成、审的是单据现在的版本、结论是 pass / fail。 */
const reviewable = advice => advice?.status === 'completed' && advice.adviceVersion === advice.documentVersion && RESULTS.has(advice.result);
function stateOf(advice, review) {
  if (advice?.round == null) return 'no_advice';
  if (advice.status === 'running') return 'running';
  if (!reviewable(advice)) return 'no_advice';
  if (!review) return 'pending';
  return review.adviceRound === advice.round && review.documentVersion === advice.documentVersion ? 'reviewed' : 'outdated';
}

/**
 * readCurrentAdvice(documentId) → null（单据不在范围里）或 { documentVersion（单据现在的版本）, round, status, result, adviceVersion（这一轮审的版本） }
 * （advice-rounds.mjs 的 currentAdviceReader）。now() 给毫秒。
 */
export function createReviews({ pool, readCurrentAdvice, now = Date.now }) {
  async function select(where, params, order = 'created_at, id') {
    const [rows] = await pool.query(`SELECT ${COLUMNS} FROM poc_review_decisions WHERE ${where} ORDER BY ${order}`, params);
    return rows.map(reviewOf);
  }
  async function adviceOf(documentId) {
    const advice = await readCurrentAdvice(documentId);
    if (!advice) fail('REVIEW_NOT_FOUND');
    return advice;
  }
  return {
    async start() { await pool.query(SCHEMA); },

    async add(actor, input) {
      const review = parse(input);
      const advice = await adviceOf(review.documentId);
      if (review.round !== advice.round || review.sourceVersion !== advice.documentVersion || review.sourceVersion !== advice.adviceVersion) fail('REVIEW_STALE');
      if (!reviewable(advice)) fail('REVIEW_ADVICE_NOT_READY');
      const aiResult = advice.result;
      if (review.decision === 'override' && !OVERRIDE_REASONS[aiResult].includes(review.reason)) fail('REVIEW_INVALID', INVALID[aiResult]);
      const finalResult = review.decision === 'adopt' ? aiResult : aiResult === 'pass' ? 'fail' : 'pass';
      const createdAt = new Date(now()).toISOString();
      const [result] = await pool.query('INSERT INTO poc_review_decisions (document_id, document_version, advice_round, ai_result, decision, final_result, reason, note, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [review.documentId, review.sourceVersion, review.round, aiResult, review.decision, finalResult, review.reason, review.note, String(actor), sqlTime(createdAt)]);
      return { id: Number(result.insertId), documentId: review.documentId, documentVersion: review.sourceVersion, adviceRound: review.round, aiResult,
        decision: review.decision, finalResult, reason: review.reason, note: review.note, actor: String(actor), createdAt };
    },

    /** 这张单的全部复核，新的在前。 */
    async history(documentId) {
      if (!isText(documentId)) fail('REVIEW_INVALID', INVALID.documentId);
      await adviceOf(documentId);
      return select('document_id = ?', [documentId], 'created_at DESC, id DESC');
    },

    /** 每张单：state、当前一轮 { round, result, status }（没有轮次时 null）、最后一次复核（不在范围里的单据什么都不给）。 */
    async latest(documentIds) {
      if (!Array.isArray(documentIds) || !documentIds.length || documentIds.length > LATEST_MAX || !documentIds.every(isText)) fail('REVIEW_INVALID', INVALID.ids);
      const ids = [...new Set(documentIds)];
      const advice = await Promise.all(ids.map(id => readCurrentAdvice(id)));
      const last = new Map();
      for (const review of await select(`document_id IN (${ids.map(() => '?').join(', ')})`, ids)) last.set(review.documentId, review);
      return Object.fromEntries(ids.map((id, index) => {
        const current = advice[index], review = current ? last.get(id) ?? null : null;
        return [id, { state: stateOf(current, review), current: current?.round == null ? null : { round: current.round, result: current.result, status: current.status }, review }];
      }));
    },

    /** since（ISO 时间、Date 或毫秒）以来的全部复核，按时间先后；不给就是全部。 */
    async all({ since = null } = {}) {
      return select('created_at >= ?', [sqlTime(since ?? 0)]);
    },
  };
}

/** 查询参数只认 names 里的、每个最多一次。 */
function onlyQuery(url, names) {
  for (const key of url.searchParams.keys()) if (!names.includes(key) || url.searchParams.getAll(key).length !== 1) fail('REVIEW_INVALID', INVALID.query);
}

export function reviewsRoutes({ reviews, log = () => {} }) {
  return {
    async handle({ req, url, path: pathname, session, res, body }) {
      const where = url ?? new URL(pathname, 'http://localhost');
      const route = where.pathname === BASE ? (req.method === 'POST' ? 'add' : req.method === 'GET' ? 'history' : null)
        : where.pathname === LATEST && req.method === 'GET' ? 'latest' : null;
      if (!route) return false;
      try {
        if (!(route === 'add' ? WRITE_ROLES : READ_ROLES).has(session?.user?.role)) fail('REVIEW_FORBIDDEN');
        if (route === 'add') {
          onlyQuery(where, []);
          const input = body === undefined ? await readJson(req, { maximum: 4_000 }) : body;
          send(res, 201, { data: { review: await reviews.add(session.user.id, input) } });
        } else if (route === 'history') {
          onlyQuery(where, ['documentId']);
          send(res, 200, { data: { items: await reviews.history(where.searchParams.get('documentId')) } });
        } else {
          onlyQuery(where, ['ids']);
          const ids = where.searchParams.get('ids');
          send(res, 200, { data: { items: await reviews.latest(ids === null ? [] : ids.split(',')) } });
        }
      } catch (error) {
        const known = Object.hasOwn(STATUS, error?.code);
        if (!known) log(`POC_REVIEWS_FAILED ${String(error?.code ?? '')}`.trim().slice(0, 120));
        const code = known ? error.code : 'REVIEW_UNAVAILABLE';
        send(res, STATUS[code], { error: { code, message: (known && error.shown) || REVIEW_MESSAGES[code] } });
      }
      return true;
    },
  };
}
