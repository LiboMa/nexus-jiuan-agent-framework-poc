/**
 * 工作台统计（测试台外壳）：GET /api/analysis/v1/poc/dashboard?window=today|14d|month → { data: { window, from, to, pendingReview, advice, daily,
 *   topBasis, overrideRate, reviewers, knowledge, topRules, myRules } }。管理员、分析员、规则发布复核人能看，别的角色 403 DASHBOARD_FORBIDDEN；
 * window 只认这三个、别的参数不收（400 DASHBOARD_INVALID）。会话和来源由九安校验。只读；不为看板调 Agent（知识库只看配置、钥匙和上传历史）。
 * 窗口按上海时间（上海没有夏令时，按固定 +08:00 算）：today = 今天 0 点到现在，14d = 今天和前 13 天，month = 本月 1 日 0 点到现在；
 * from / to 是 UTC 的 ISO 时间。daily[]、overrideRate[] 窗口里每个上海日期一项（没有数的日子也给，全 0），从早到晚。
 * 口径（Spec 5.2、第 9 节）：
 *   轮次      照 advice-rounds.mjs 的 walkRounds 从对公付款单反查 review_advice 的轮次（每张单当前一轮 + 5 轮历史，更早的数不到）。
 *             完成 = status completed 且结论是 pass / fail，按 finishedAt 落在窗口里；daily 的 running 是状态为 running 的轮次，按 startedAt。
 *   pendingReview  不按窗口：单据现在的复核状态（reviews.mjs 的 stateOf）是 pending 或 outdated 的单数；failCount 是其中当前一轮结论 fail 的。
 *   advice    completed / pass / fail；passRate = pass / completed，是 0–1 的小数（不取整，页面自己换成百分数），completed 为 0 时 null；
 *             avgDurationMs（四舍五入到毫秒）、maxDurationMs 取完成的轮次的 finishedAt − startedAt，没有时 null；
 *             overrides：窗口里建的复核，每张单每一轮只取最后一次（不管是谁），其中改判的数。
 *   overrideRate[] 同一批复核（每张单每一轮的最后一次），按这次复核的 created_at 落在上海哪一天：{ date, reviews, overrides }。
 *   reviewers[]    每个人每张单每一轮只算自己的最后一次；行 = 设置里的管理员、分析员账号 + 窗口里复核过的人，按复核数从多到少、再按账号；
 *                  name 取设置里的名字，没有就用账号；customRules 是这个账号「我的规则」的份数。分析员只有自己一行，规则发布复核人没有行。
 *   topBasis[]     窗口里完成、结论 fail 的轮次的依据，前 6；topRules[]：窗口里完成的全部轮次引用的公司制度规则编号，前 5（不含我的规则、认不出编号的）。
 *                  一轮里同一项只算一次；同数按标签（码位）从小到大。归并（basisGroup）：
 *                  kind rule、ref 以「自定义：」开头 → custom，标签是前缀后面的标题（去首尾空白；写法见 audit-agent/prompt.yaml 的自定义规则一段）；
 *                  别的 rule 取 ref 开头的规则编号 RULE_ID——知识库生成的编号（kb/lib/parse_rules.py）：C<两位章号>-<序号>（序号是数字和点，例如 C05-2.3、
 *                  C07-7.11）、C<章号>-NOTE（章节说明）、G-<两位序号>（制度说明），编号后面不能紧跟字母、数字、下划线、连字符或「.数字」；
 *                  认不出编号时用整个 ref（去首尾空白，最多 60 字）；field / evidence 取 ref（去首尾空白）。没有 kind、ref 是空的不算。
 *   knowledge      kb.status()（方式、有没有发布编号、「Agent 接入」页有没有钥匙）+ 上传历史：每个制度标识看最近一次上传（编号最大的那条），
 *                  它是 ingested / skipped 且没被删除（removedAt）的算一份，rules 是这些的 rulesTotal 之和；lastIngestAt 是 ingested / skipped 里最晚的 finishedAt。
 *   myRules        自己的「我的规则」{ files, usedChars, limitChars }；规则发布复核人没有「我的规则」，给 0 / 0 / 5000。
 * 结果按（窗口、角色、账号）缓存 60 秒（now 可注入）。算不出来（读轮次、复核、上传历史失败）→ 503 DASHBOARD_UNAVAILABLE，
 * 日志一行 POC_DASHBOARD_FAILED <错误码或错误名>，不记消息；失败不缓存。
 */
import { ADVICE_TASK, adviceOf, basisOf, walkRounds } from './advice-rounds.mjs';
import { CUSTOM_RULES_LIMITS } from './custom-rules.mjs';
import { stateOf } from './reviews.mjs';

const PATH = '/api/analysis/v1/poc/dashboard';
const ROLES = new Set(['admin', 'analyst', 'policy_reviewer']);
/** 能复核、有「我的规则」的角色。 */
const REVIEWER_ROLES = new Set(['admin', 'analyst']);
const WINDOWS = new Set(['today', '14d', 'month']);
const RESULTS = new Set(['pass', 'fail']);
const INGESTED = new Set(['ingested', 'skipped']);
const PENDING = new Set(['pending', 'outdated']);
const TTL_MS = 60_000, DAY_MS = 86_400_000, SHANGHAI_MS = 8 * 3_600_000;
const TOP_BASIS = 6, TOP_RULES = 5, LABEL_MAX = 60;
const CUSTOM = '自定义：';
export const RULE_ID = /^(?:C\d{2,3}-(?:\d+(?:\.\d+)*|NOTE)|G-\d{2,3})(?![A-Za-z0-9_-]|\.\d)/u;
export const DASHBOARD_MESSAGES = Object.freeze({
  DASHBOARD_FORBIDDEN: '只有管理员、分析员和规则发布复核人能看工作台：请换这几种账号登录。',
  DASHBOARD_INVALID: '统计窗口只能是今天（today）、近 14 天（14d）或本月（month）：请刷新页面后重试。',
  DASHBOARD_UNAVAILABLE: '工作台的数暂时算不出来（AI 建议轮次、复核记录或上传历史读不到）：稍后刷新再试。',
});
const STATUS = Object.freeze({ DASHBOARD_FORBIDDEN: 403, DASHBOARD_INVALID: 400, DASHBOARD_UNAVAILABLE: 503 });
const CODE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
const fail = code => { throw Object.assign(new Error(DASHBOARD_MESSAGES[code]), { code }); };
const send = (res, status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(payload)); };
const timeOf = value => { const ms = typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(ms) ? ms : null; };
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** 时刻（毫秒）→ 上海日期 YYYY-MM-DD；上海日期 → 那天 0 点（毫秒）。 */
const dayOf = ms => new Date(ms + SHANGHAI_MS).toISOString().slice(0, 10);
const midnightOf = date => Date.parse(`${date}T00:00:00.000+08:00`);

/** 窗口 → { from, to（毫秒）, days（上海日期，从早到晚） }。 */
export function windowOf(window, nowMs) {
  const today = dayOf(nowMs);
  const first = window === 'today' ? today : window === '14d' ? dayOf(midnightOf(today) - 13 * DAY_MS) : `${today.slice(0, 8)}01`;
  const from = midnightOf(first), days = [];
  for (let at = from; at <= nowMs; at += DAY_MS) days.push(dayOf(at));
  return { from, to: nowMs, days };
}

/** 一条依据 → { kind, label }（规则编号另带 ruleId，topRules 只数这种）；没有 kind、ref 是空的回 null。 */
export function basisGroup({ kind, ref }) {
  const text = String(ref ?? '').trim();
  if (kind === 'rule') {
    if (text.startsWith(CUSTOM)) { const title = text.slice(CUSTOM.length).trim(); return title ? { kind: 'custom', label: title } : null; }
    const id = RULE_ID.exec(text)?.[0];
    if (id) return { kind: 'rule', label: id, ruleId: id };
    return text ? { kind: 'rule', label: [...text].slice(0, LABEL_MAX).join('') } : null;
  }
  return (kind === 'field' || kind === 'evidence') && text ? { kind, label: text } : null;
}

/** 每一轮的条目 [{ key, label, … }] → 一轮里同一 key 只算一次，按次数从多到少、再按标签，前 limit 项。 */
function top(lists, limit) {
  const counts = new Map();
  for (const list of lists) {
    for (const entry of new Map(list.map(item => [item.key, item])).values()) {
      const seen = counts.get(entry.key);
      if (seen) seen.count += 1; else counts.set(entry.key, { ...entry, count: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || compare(a.label, b.label) || compare(a.key, b.key)).slice(0, limit);
}

/** 复核（按时间先后）→ 每个 keyOf 只留最后一次。 */
const lastOf = (reviews, keyOf) => [...new Map(reviews.map(review => [keyOf(review), review])).values()];
const overridesOf = reviews => reviews.filter(review => review.decision === 'override').length;

/**
 * 轮次照 walkRounds 读（tenantId、agentTaskKey、readState、listDocuments 原样传过去；listDocuments 只给对公付款单）；
 * reviews 是 createReviews 的（用 all()），customRules 是 createCustomRules 的（用 list），kb 是 createKbStewardRoutes 的（用 status、historyList）；
 * accounts() → 设置里的账号 [{ id, name, role }]。now() 给毫秒。
 */
export function createDashboard({ tenantId, agentTaskKey, readState, listDocuments, reviews, customRules, kb, accounts = () => [], now = Date.now }) {
  const cache = new Map();

  /** 这个账号「我的规则」的 { files, usedChars, limitChars }；账号编号存不了规则（CUSTOM_RULES_ACCOUNT_INVALID）时算没有。 */
  async function rulesOf(accountId) {
    try {
      const mine = await customRules.list(accountId);
      return { files: mine.items.length, usedChars: mine.usedChars, limitChars: mine.limitChars };
    } catch (error) {
      if (error?.code === 'CUSTOM_RULES_ACCOUNT_INVALID') return { files: 0, usedChars: 0, limitChars: CUSTOM_RULES_LIMITS.chars };
      throw error;
    }
  }

  async function knowledgeOf() {
    const [status, items] = await Promise.all([kb.status(), kb.historyList()]);
    const latest = new Map();
    for (const item of [...items].sort((a, b) => a.id - b.id)) if (typeof item?.sourceId === 'string') latest.set(item.sourceId, item);
    const kept = [...latest.values()].filter(item => INGESTED.has(item.status) && !item.removedAt);
    const finished = items.filter(item => INGESTED.has(item?.status)).map(item => timeOf(item.finishedAt)).filter(ms => ms !== null);
    return { mode: status.mode, configured: status.configured, ready: status.ready, sources: kept.length,
      rules: kept.reduce((sum, item) => sum + (Number.isSafeInteger(item.rulesTotal) && item.rulesTotal > 0 ? item.rulesTotal : 0), 0),
      lastIngestAt: finished.length ? new Date(Math.max(...finished)).toISOString() : null };
  }

  /** 每个人每张单每一轮自己的最后一次；分析员只有自己一行，规则发布复核人没有行。 */
  async function reviewersOf(user, windowed) {
    if (!REVIEWER_ROLES.has(user.role)) return [];
    const self = String(user.id), known = new Map(accounts().map(account => [String(account.id), account]));
    const own = lastOf(windowed, review => JSON.stringify([review.actor, review.documentId, review.adviceRound]));
    const ids = user.role === 'analyst' ? [self]
      : [...new Set([...[...known.values()].filter(account => REVIEWER_ROLES.has(account.role)).map(account => String(account.id)), ...own.map(review => review.actor)])];
    const rows = await Promise.all(ids.map(async account => {
      const mine = own.filter(review => review.actor === account);
      return { account, name: known.get(account)?.name || account, reviews: mine.length, overrides: overridesOf(mine), customRules: (await rulesOf(account)).files };
    }));
    return rows.sort((a, b) => b.reviews - a.reviews || compare(a.account, b.account));
  }

  async function compute(window, user, nowMs) {
    const { from, to, days } = windowOf(window, nowMs);
    const inWindow = ms => ms !== null && ms >= from && ms <= to;
    const [rounds, allReviews, knowledge] = await Promise.all([
      walkRounds({ tenantId, tasks: [ADVICE_TASK], agentTaskKey, listDocuments, readState }), reviews.all(), knowledgeOf()]);

    // 待复核：每张单最后一次复核（不按窗口）对它的当前一轮
    const lastReview = new Map(allReviews.map(review => [review.documentId, review]));
    const pendingReview = { count: 0, failCount: 0 };
    for (const { document, record, current } of rounds) {
      if (!current) continue;
      const advice = adviceOf(document, record);
      if (!PENDING.has(stateOf(advice, lastReview.get(document.id) ?? null))) continue;
      pendingReview.count += 1;
      if (advice.result === 'fail') pendingReview.failCount += 1;
    }

    const daily = new Map(days.map(date => [date, { date, pass: 0, fail: 0, running: 0 }]));
    const completed = [], durations = [];
    for (const { record } of rounds) {
      const started = timeOf(record.startedAt), finished = timeOf(record.finishedAt), result = record.output?.result;
      if (record.status === 'running' && inWindow(started)) daily.get(dayOf(started)).running += 1;
      if (record.status !== 'completed' || !RESULTS.has(result) || !inWindow(finished)) continue;
      daily.get(dayOf(finished))[result] += 1;
      if (started !== null && finished >= started) durations.push(finished - started);
      completed.push({ result, groups: basisOf(record.output).map(basisGroup).filter(Boolean) });
    }
    const pass = completed.filter(item => item.result === 'pass').length;

    // 复核：窗口里建的，每张单每一轮只取最后一次
    const windowed = allReviews.filter(review => inWindow(timeOf(review.createdAt)));
    const last = lastOf(windowed, review => JSON.stringify([review.documentId, review.adviceRound]));
    const overrideRate = new Map(days.map(date => [date, { date, reviews: 0, overrides: 0 }]));
    for (const review of last) {
      const day = overrideRate.get(dayOf(timeOf(review.createdAt)));
      day.reviews += 1;
      if (review.decision === 'override') day.overrides += 1;
    }

    const topBasis = top(completed.filter(item => item.result === 'fail').map(item => item.groups.map(group => ({ key: JSON.stringify([group.kind, group.label]), ...group }))), TOP_BASIS)
      .map(({ kind, label, count }) => ({ kind, label, count }));
    const topRules = top(completed.map(item => item.groups.filter(group => group.ruleId).map(group => ({ key: group.ruleId, label: group.ruleId }))), TOP_RULES)
      .map(({ label, count }) => ({ ruleId: label, count }));
    const myRules = REVIEWER_ROLES.has(user.role) ? await rulesOf(String(user.id)) : { files: 0, usedChars: 0, limitChars: CUSTOM_RULES_LIMITS.chars };

    return {
      window, from: new Date(from).toISOString(), to: new Date(to).toISOString(), pendingReview,
      advice: { completed: completed.length, pass, fail: completed.length - pass, overrides: overridesOf(last),
        passRate: completed.length ? pass / completed.length : null,
        avgDurationMs: durations.length ? Math.round(durations.reduce((sum, ms) => sum + ms, 0) / durations.length) : null,
        maxDurationMs: durations.length ? Math.max(...durations) : null },
      daily: [...daily.values()], topBasis, overrideRate: [...overrideRate.values()], reviewers: await reviewersOf(user, windowed), knowledge, topRules, myRules,
    };
  }

  return {
    /** 这个人这个窗口的统计；60 秒内同一（窗口、角色、账号）给同一份（同时来的几次共用一轮），失败的不留。 */
    read({ window, user }) {
      const at = now(), key = JSON.stringify([window, user.role, String(user.id)]);
      const hit = cache.get(key);
      if (hit && at - hit.at < TTL_MS) return hit.value;
      for (const [name, entry] of cache) if (at - entry.at >= TTL_MS) cache.delete(name);
      const entry = { at, value: compute(window, user, at) };
      cache.set(key, entry);
      entry.value.catch(() => { if (cache.get(key) === entry) cache.delete(key); });
      return entry.value;
    },
  };
}

export function dashboardRoutes({ dashboard, log = () => {} }) {
  return {
    async handle({ req, url, path: pathname, session, res }) {
      const where = url ?? new URL(pathname, 'http://localhost');
      if (req.method !== 'GET' || where.pathname !== PATH) return false;
      try {
        if (!ROLES.has(session?.user?.role)) fail('DASHBOARD_FORBIDDEN');
        const names = [...where.searchParams.keys()], window = where.searchParams.get('window');
        if (names.length !== 1 || names[0] !== 'window' || !WINDOWS.has(window)) fail('DASHBOARD_INVALID');
        send(res, 200, { data: await dashboard.read({ window, user: session.user }) });
      } catch (error) {
        const known = Object.hasOwn(STATUS, error?.code);
        // 只记错误码（没有合格的错误码时记错误名），不记消息
        if (!known) log(`POC_DASHBOARD_FAILED ${[error?.code, error?.name].find(value => typeof value === 'string' && CODE.test(value)) ?? 'UNKNOWN'}`);
        const code = known ? error.code : 'DASHBOARD_UNAVAILABLE';
        send(res, STATUS[code], { error: { code, message: DASHBOARD_MESSAGES[code] } });
      }
      return true;
    },
  };
}
