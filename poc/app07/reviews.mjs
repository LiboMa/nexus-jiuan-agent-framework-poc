/**
 * 复核记录：审核员对一张单当前那一轮 AI 独立建议「采纳」或「改判」，绑定这一轮（advice_round）。按单据：谁复核都算，以最后一次为准，旧的留着。
 * 不回写汇联易，不碰九安的审批写回。
 *   POST /api/analysis/v1/poc/reviews {documentId, sourceVersion, round, decision, reason?, note?}  → 201 { review }（管理员、分析员）
 *   GET  …/reviews?documentId=                 这张单的复核历史，新的在前 → { items }
 *   GET  …/reviews/latest?ids=a,b,…             单据池一页（1–50 张）的复核状态 → { items: { [documentId]: { state, current, review } } }
 *   current 是当前一轮 { round, result, status, startedAt, finishedAt }（时间是 ISO 或 null；单据池的「最近审核」用）；每条复核（提交的回答、历史、latest）
 *   带 actorName：测试台账号的名字（config.accounts），没有这个账号或名字是空的就用账号（actor）。
 * 两个 GET 给管理员、分析员和规则发布复核人（policy_reviewer 的单据池只读，也要看复核状态）；别的角色一律 403。
 * 会话、来源和 CSRF 由九安校验；这些路径不在 /platform 下，九安不替它们读请求体，这里自己读。
 * 单据按登录的人的范围读（他在九安里的公司 ∩ 测试台的公司，Ruling FR1）：范围外的单据和不存在的一样——复核、历史 404，latest 里是 no_advice（别人的复核也不给）。
 * 只能复核「当前那一轮已完成、审的是单据现在的版本、结论是 pass / fail」的建议。单据不在这个人的范围里或不存在 → 404；然后按顺序查：
 *   ① 提交的版本不是单据现在的版本 → 409 REVIEW_STALE；② 有当前一轮、提交的轮次不是它 → 409 REVIEW_STALE；
 *   ③ 没有轮次，或当前一轮不能复核（在跑、失败、declined、给旧版本做的…）→ 409 REVIEW_ADVICE_NOT_READY。
 *   只有真有更新的东西（单据新版本、新一轮）时才说「刚更新」。两人同时复核同一轮都成功，后一次为准。
 * 查当前一轮和写入之间不加锁：这中间刚好又跑完一轮的话，记下的仍是提交时那一轮，latest 里这张单显示 outdated，回到待复核。
 * 改判原因按方向（Spec 第 9 节）：AI 不建议通过 → 改判为通过、AI 建议通过 → 改判为不通过各一组；other 必须写备注；备注去掉首尾空白，最多 200 字。
 * 表 poc_review_decisions 在九安的 jiuan07 库里（端到端测试的重置删库重建，随之清空），start() 时建；created_at 存 UTC 的 DATETIME(3)。
 * 每次复核成功后调 onReviewed(review)（外壳用它清工作台的缓存，F3）；它出错只记日志，不影响这次复核。
 */
import { readJson } from './lib/http.mjs';

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
  REVIEW_FORBIDDEN: '只有管理员和分析员能复核 AI 建议（规则发布复核人只能查看）：要复核请换管理员或分析员账号登录。',
  REVIEW_INVALID: '复核内容不对（要有单据、版本、轮次和结论，不带别的字段）：请刷新页面后重新提交。',
  REVIEW_NOT_FOUND: '找不到这张单据：刷新单据池后再试。',
  REVIEW_ADVICE_NOT_READY: '这张单还没有完成的 AI 建议，等建议出来再复核。',
  REVIEW_STALE: '这张单的 AI 建议刚更新，请先看新的建议。',
  REVIEW_UNAVAILABLE: '复核记录暂时读写不了，稍后再试。',
  INVALID_CONTENT_TYPE: '复核请求不是 JSON：请刷新页面后重新提交。',
  INVALID_JSON: '复核请求不是有效的 JSON：请刷新页面后重新提交。',
  BODY_LIMIT: `复核请求太大：请把备注缩短到 ${NOTE_MAX} 字以内再提交。`,
});
const INVALID = Object.freeze({
  adoptReason: '采纳 AI 建议不用选改判原因：请去掉改判原因再提交。',
  reason: '改判还没选原因：请选一个改判原因再提交。',
  fail: '这个原因不能用来改判为通过：请从合同或补充协议已涵盖、原件齐全 AI 没识别、金额核对无误、适用规则不对、其他里选一个。',
  pass: '这个原因不能用来改判为不通过：请从原件缺失或不符、金额不符、收款方不符、适用规则不对、其他里选一个。',
  otherNote: '改判原因选了「其他」：请写上备注再提交。',
  note: `备注超过 ${NOTE_MAX} 字：请缩短后再提交。`,
  documentId: '缺少单据编号（documentId）：请从单据池重新打开这张单。',
  ids: `复核状态一次查 1 到 ${LATEST_MAX} 张单据（ids 用逗号分开）：请减少单据数后重试。`,
  query: '请求里有不认识的参数：请刷新页面后重试。',
  since: '统计起点不是有效的时间：请刷新页面后重试。',
});
const STATUS = Object.freeze({ REVIEW_FORBIDDEN: 403, REVIEW_INVALID: 400, REVIEW_NOT_FOUND: 404, REVIEW_ADVICE_NOT_READY: 409, REVIEW_STALE: 409,
  REVIEW_UNAVAILABLE: 503, INVALID_CONTENT_TYPE: 415, INVALID_JSON: 400, BODY_LIMIT: 413 });
const fail = (code, message = REVIEW_MESSAGES[code]) => { throw Object.assign(new Error(message), { code, shown: message }); };
const send = (res, status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(payload)); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && TEXT.test(value) && value.trim() === value;
const absent = value => value === undefined || value === null;
const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:Z|([+-])(\d{2}):(\d{2}))$/u;
const CODE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;

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
/**
 * 带时差的 ISO 时间 → Date；日历上没有的（2026-02-30、24:00、:60 秒、时差 +24:00 …）回 null，不像 new Date() 那样滚到下一天：
 * 按写的时刻（不算时差）拼一个 UTC 时间，toISOString() 回来的年月日时分秒毫秒要和写的一样，再减时差。
 */
function isoDate(text) {
  const parts = ISO_TIME.exec(text);
  if (!parts) return null;
  const [, year, month, day, hour, minute, second = '00', fraction = '', sign, offsetHours = '00', offsetMinutes = '00'] = parts;
  if (Number(offsetHours) > 23 || Number(offsetMinutes) > 59) return null;
  const wall = `${year}-${month}-${day}T${hour}:${minute}:${second}.${fraction.padEnd(3, '0')}Z`;
  const ms = Date.parse(wall);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== wall) return null;
  const offset = (sign === '-' ? -1 : 1) * (Number(offsetHours) * 60 + Number(offsetMinutes)) * 60_000;
  return new Date(ms - offset);
}
/** 统计起点：Date，或带时差（Z / ±hh:mm）、日历上有的 ISO 时间；DATETIME 只到 1000–9999 年。别的一律 REVIEW_INVALID。 */
function sinceOf(since) {
  if (absent(since)) return new Date(0);
  const at = since instanceof Date ? since : typeof since === 'string' ? isoDate(since) : null;
  const year = at ? at.getUTCFullYear() : NaN;
  if (!(year >= 1000 && year <= 9999)) fail('REVIEW_INVALID', INVALID.since);
  return at;
}
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
export const reviewable = advice => advice?.status === 'completed' && advice.adviceVersion === advice.documentVersion && RESULTS.has(advice.result);
/** 一张单的复核状态（advice 是 currentAdviceReader / adviceOf 的样子，review 是这张单最后一次复核或 null）；工作台的「待复核」也按它数（dashboard.mjs）。 */
export function stateOf(advice, review) {
  if (advice?.round == null) return 'no_advice';
  if (advice.status === 'running') return 'running';
  if (!reviewable(advice)) return 'no_advice';
  if (!review) return 'pending';
  return review.adviceRound === advice.round && review.documentVersion === advice.documentVersion ? 'reviewed' : 'outdated';
}

/**
 * readCurrentAdvice(documentId, user) → null（单据不在这个人的范围里）或 { documentVersion（单据现在的版本）, round, status, result, adviceVersion（这一轮审的版本）,
 * startedAt, finishedAt }（advice-rounds.mjs 的 currentAdviceReader）。user 是登录的人（会话里的 user）。
 * accounts() → 测试台的账号 [{ id, name, role }]（config.accounts，每次读当时的设置），给复核人的名字。now() 给毫秒。
 */
export function createReviews({ pool, readCurrentAdvice, accounts = () => [], now = Date.now }) {
  async function select(where, params, order = 'created_at, id') {
    const [rows] = await pool.query(`SELECT ${COLUMNS} FROM poc_review_decisions WHERE ${where} ORDER BY ${order}`, params);
    return rows.map(reviewOf);
  }
  /** 复核加上 actorName（放在 actor 后面）：账号的名字，没有就用账号。 */
  function named(reviews) {
    const names = new Map((accounts() ?? []).map(account => [String(account?.id), account?.name]));
    return reviews.map(({ createdAt, ...review }) => {
      const name = names.get(review.actor);
      return { ...review, actorName: typeof name === 'string' && name.trim() ? name : review.actor, createdAt };
    });
  }
  async function adviceOf(documentId, user) {
    const advice = await readCurrentAdvice(documentId, user);
    if (!advice) fail('REVIEW_NOT_FOUND');
    return advice;
  }
  return {
    async start() { await pool.query(SCHEMA); },

    /** user 是登录的人：actor 记他的账号，单据按他的范围读。 */
    async add(user, input) {
      const review = parse(input);
      const advice = await adviceOf(review.documentId, user);
      const actor = user?.id;
      if (review.sourceVersion !== advice.documentVersion) fail('REVIEW_STALE');
      if (advice.round != null && review.round !== advice.round) fail('REVIEW_STALE');
      if (advice.round == null || !reviewable(advice)) fail('REVIEW_ADVICE_NOT_READY');
      const aiResult = advice.result;
      if (review.decision === 'override' && !OVERRIDE_REASONS[aiResult].includes(review.reason)) fail('REVIEW_INVALID', INVALID[aiResult]);
      const finalResult = review.decision === 'adopt' ? aiResult : aiResult === 'pass' ? 'fail' : 'pass';
      const createdAt = new Date(now()).toISOString();
      const [result] = await pool.query('INSERT INTO poc_review_decisions (document_id, document_version, advice_round, ai_result, decision, final_result, reason, note, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [review.documentId, review.sourceVersion, review.round, aiResult, review.decision, finalResult, review.reason, review.note, String(actor), sqlTime(createdAt)]);
      return named([{ id: Number(result.insertId), documentId: review.documentId, documentVersion: review.sourceVersion, adviceRound: review.round, aiResult,
        decision: review.decision, finalResult, reason: review.reason, note: review.note, actor: String(actor), createdAt }])[0];
    },

    /** 这张单的全部复核，新的在前。 */
    async history(documentId, user) {
      if (!isText(documentId)) fail('REVIEW_INVALID', INVALID.documentId);
      await adviceOf(documentId, user);
      return named(await select('document_id = ?', [documentId], 'created_at DESC, id DESC'));
    },

    /** 每张单：state、当前一轮 { round, result, status, startedAt, finishedAt }（没有轮次时 null）、最后一次复核（不在这个人范围里的单据什么都不给）。 */
    async latest(documentIds, user) {
      if (!Array.isArray(documentIds) || !documentIds.length || documentIds.length > LATEST_MAX || !documentIds.every(isText)) fail('REVIEW_INVALID', INVALID.ids);
      const ids = [...new Set(documentIds)];
      const advice = await Promise.all(ids.map(id => readCurrentAdvice(id, user)));
      const last = new Map();
      for (const review of named(await select(`document_id IN (${ids.map(() => '?').join(', ')})`, ids))) last.set(review.documentId, review);
      return Object.fromEntries(ids.map((id, index) => {
        const current = advice[index], review = current ? last.get(id) ?? null : null;
        return [id, { state: stateOf(current, review), current: current?.round == null ? null
          : { round: current.round, result: current.result, status: current.status, startedAt: current.startedAt ?? null, finishedAt: current.finishedAt ?? null }, review }];
      }));
    },

    /** since（Date 或带时差的 ISO 时间）以来的全部复核，按时间先后；不给就是全部。 */
    async all({ since = null } = {}) {
      return select('created_at >= ?', [sqlTime(sinceOf(since))]);
    },
  };
}

/** 查询参数只认 names 里的、每个最多一次。 */
function onlyQuery(url, names) {
  for (const key of url.searchParams.keys()) if (!names.includes(key) || url.searchParams.getAll(key).length !== 1) fail('REVIEW_INVALID', INVALID.query);
}

export function reviewsRoutes({ reviews, log = () => {}, onReviewed = () => {} }) {
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
          const review = await reviews.add(session.user, input);
          try { onReviewed(review); } catch (error) { log(`POC_REVIEWS_ON_REVIEWED_FAILED ${[error?.code, error?.name].find(value => typeof value === 'string' && CODE.test(value)) ?? 'UNKNOWN'}`); }
          send(res, 201, { data: { review } });
        } else if (route === 'history') {
          onlyQuery(where, ['documentId']);
          send(res, 200, { data: { items: await reviews.history(where.searchParams.get('documentId'), session.user) } });
        } else {
          onlyQuery(where, ['ids']);
          const ids = where.searchParams.get('ids');
          send(res, 200, { data: { items: await reviews.latest(ids === null ? [] : ids.split(','), session.user) } });
        }
      } catch (error) {
        const known = Object.hasOwn(STATUS, error?.code);
        // 只记错误码（程序错误没有 code 时记错误名），不记消息
        if (!known) log(`POC_REVIEWS_FAILED ${[error?.code, error?.name].find(value => typeof value === 'string' && CODE.test(value)) ?? 'UNKNOWN'}`);
        const code = known ? error.code : 'REVIEW_UNAVAILABLE';
        send(res, STATUS[code], { error: { code, message: (known && error.shown) || REVIEW_MESSAGES[code] } });
      }
      return true;
    },
  };
}
