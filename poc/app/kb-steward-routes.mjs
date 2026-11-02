/**
 * 「规则库 › 制度知识库 › 公司制度」的接口，两种知识库方式（POC_KB_MODE=pg|s3vectors）共用这一套：测试台不连 PG、不解析文档，
 * 规则库由 Nexus 上的知识库 Agent 经 A2A 读写（kb-steward-client.mjs）——pg 方式是 PG 知识库 Agent，s3vectors 方式是知识库文档管家。
 * 只给管理员（KB_FORBIDDEN 403）。部署配置里没有发布编号时只有 /mode 回答，别的都回 409 KB_AGENT_NOT_CONFIGURED。
 *   GET  /api/analysis/v1/poc/kb/mode                     { mode, configured, ready, ops }：configured = 有发布编号，ready = 「Agent 接入」页里这个发布有可用钥匙，
 *                                                         ops = 这个 Agent 的 describe 回的操作（没就绪时 []；页面按它显示按钮）
 *   POST …/sources?sourceId=&sourceVersion=&title=        请求体是 .docx 原文（X-File-Name）：校验 → 存 <uploadsDir>/<sha256>.docx（0600）→
 *                                                         记一条上传历史 → 后台 ingest，先回 202 { id, status: 'ingesting' }；同一时间只跑一个
 *   GET  …/uploads、…/uploads/<id>                         上传历史（最近 50 条；<uploadsDir>/history.json，0600），页面轮询到 ingested / skipped / failed
 *   GET  …/sources、…/sources/<id>[?refresh=1]             制度清单、一份制度的登记和规则编号（回复多一个 fetched_at：外壳从 Agent 读到它的时间）
 *   POST …/sources/<id>/(deactivate|restore|delete)       下线、恢复、硬删除；下线、恢复不在 describe 的 ops 里时回 409 KB_OP_UNSUPPORTED，不调 Agent。
 *                                                         删除成功（Agent 回 success:true）后，这个制度标识已入完（有 finishedAt）的每一条上传历史
 *                                                         记上 removedAt（工作台不再算它；还在入库的那条和之后再传的不带）；下线、恢复不记
 *   GET  …/search?q=&segment=&amount=&k=                  按问题检索（板块、金额可空，空的不传）
 * 同步的操作各一次 A2A 调用（约 10–20 秒），回 { data: 工具的 JSON }：工具自己失败时也是 200，data.success === false，带 error_type / message / suggestion。
 * 缓存（给了 cache 时，kb-cache.mjs，九安 jiuan 库的 poc_kb_cache）：规则入库之后很少再改，所以 describe、制度清单、每份制度的详情问到一次就存进库，
 *   之后打开页面直接从库里给，外壳重启也不丢。只有这几种时候才再问 Agent：库里没有；?refresh=1（页面上的「刷新清单」，同时清掉存着的详情）；
 *   在这里入库、下线、恢复、删除之后（不管结果，清单和这份制度的详情作废）；钥匙被拒、回复不合格（Agent 那边换了钥匙或版本，操作清单作废）。
 *   只存成功的回复；没启用时不给库里的；同时来的几次共用一次调用；库读写出错就照常问 Agent，记一行 POC_KB_CACHE_UNAVAILABLE。检索不存（每次现问）。
 * 给工作台（dashboard.mjs）的两个函数，都不调 Agent：status() → { mode, configured, ready }（同 /mode，不带 ops），historyList() → 全部上传历史，新的在前。
 * 错误文案里的 Agent 名字按方式。日志只写错误码，不写回复、制度内容和钥匙。
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DOCX_MESSAGES, readDocxUpload, storeDocx } from './kb-docx.mjs';

const BASE = '/api/analysis/v1/poc/kb';
// 新上传的制度标识（PG 知识库 Agent 约定的 source_id，也是 PG 方式原来的标签规则）；路径里的标识按文档管家工具的规则（别处入库的制度也能管理）
const TAG = /^[a-z0-9][a-z0-9-]{1,62}$/;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const AMOUNT = /^\d{1,13}(?:\.\d{1,2})?$/;
const HISTORY_LIMIT = 200;
/** 这两个操作 Agent 可以不支持（describe 的 ops 里没有就不调）。 */
const OPTIONAL_OPS = new Set(['deactivate', 'restore']);
/** 这两种失败说明 Agent 那边变了（换了钥匙、换了版本）：库里存的操作清单作废（同 kb-steward-client.mjs 的 STALE）。 */
const STALE = new Set(['KB_AGENT_KEY_REJECTED', 'KB_AGENT_REPLY_INVALID']);
const DETAIL = 'detail:';
/** 文案里的 Agent 名字按方式；lead 是放在句首、后面直接接汉字时的写法（「知识库 Agent」后空一格）。 */
const AGENTS = Object.freeze({
  pg: Object.freeze({ name: '知识库 Agent', lead: '知识库 Agent ' }),
  s3vectors: Object.freeze({ name: '知识库文档管家', lead: '知识库文档管家' }),
});
const COMMON_MESSAGES = Object.freeze({
  KB_FORBIDDEN: '只有管理员能管理制度知识库。',
  ...DOCX_MESSAGES,
  KB_NOT_FOUND: '找不到这条上传记录，刷新后再试。',
  KB_INGEST_BUSY: '已经有一份文档在入库，等它完成再试。',
  KB_RULE_CONFLICT: '有规则编号已属于库里另一份文档，入库会覆盖那份文档的规则，所以不能入库。',
  KB_REQUEST_INVALID: '请求不完整：制度标识只能用小写字母、数字和连字符（2–63 位），版本说明不超过 64 字，文档名不超过 200 字。',
  KB_QUESTION_INVALID: '请写一个问题（不超过 2000 字）；板块不超过 40 字，金额写以元为单位的数字，条数 1–20。',
  KB_AGENT_KEY_REJECTED: 'Nexus 不认这把调用密钥，请在『Agent 接入』页换钥匙',
  KB_AGENT_NOT_CONFIGURED: '知识库 Agent 还没配置：部署配置里缺发布编号',
  KB_OP_UNSUPPORTED: '这个知识库 Agent 不支持这个操作',
});
const STATUS = Object.freeze({ KB_AGENT_NOT_READY: 409, KB_AGENT_KEY_REJECTED: 409, KB_AGENT_NOT_CONFIGURED: 409, KB_OP_UNSUPPORTED: 409,
  KB_AGENT_REPLY_INVALID: 502, KB_UNAVAILABLE: 503 });
const fail = (code, status) => { throw Object.assign(new Error(code), { code, status }); };
const send = (res, status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(payload)); };
const chars = text => [...text].length;

/** 这种方式下接口的错误文案：通用的加上带 Agent 名字的几条。 */
function messagesFor({ name, lead }) {
  return Object.freeze({ ...COMMON_MESSAGES,
    KB_AGENT_NOT_READY: `先在『Agent 接入』页启用${name}`,
    KB_AGENT_REPLY_INVALID: `${lead}的回复不合格，这次没有完成`,
    KB_UNAVAILABLE: `${lead}暂时连不上，或没在限定时间内答完：稍后再试（入库的话先看一下制度清单，可能已经写完）。`,
  });
}

/**
 * 上传历史（单进程，内存里一份）：改动按顺序排队，整份先写临时文件再改名成 history.json（0600），写成了才换进内存，
 * 所以页面看到的就是盘上的。入库结果写盘失败时仍换进内存（页面不至于一直「入库中」），重启后按盘上的算中断。
 */
function createHistory(file, log) {
  let state = { nextId: 1, items: [] }, loading = null, queue = Promise.resolve();
  async function load() {
    try {
      const saved = JSON.parse(await readFile(file, 'utf8'));
      if (Number.isInteger(saved?.nextId) && Array.isArray(saved?.items)) state = saved;
    } catch (error) { if (error?.code !== 'ENOENT') log('POC_KB_HISTORY_UNREADABLE'); }
  }
  async function persist(next) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const scratch = `${file}.tmp-${randomBytes(6).toString('hex')}`;
    try { await writeFile(scratch, JSON.stringify(next), { mode: 0o600 }); await rename(scratch, file); }
    catch (error) { await rm(scratch, { force: true }); throw error; }
  }
  /** change(state) → { next, value }；keep = 写盘失败时也换进内存。 */
  function commit(change, { keep = false } = {}) {
    const run = queue.then(async () => {
      const { next, value } = change(state);
      try { await persist(next); } catch (error) { if (keep) state = next; throw error; }
      state = next;
      return value;
    });
    queue = run.catch(() => {});
    return run;
  }
  return {
    ready: () => (loading ??= load()),
    list: () => [...state.items].reverse(),
    get: id => state.items.find(item => item.id === id) ?? null,
    add: fields => commit(current => {
      const item = { id: current.nextId, ...fields };
      return { next: { nextId: current.nextId + 1, items: [...current.items, item].slice(-HISTORY_LIMIT) }, value: item };
    }),
    update: (id, patch) => commit(current => ({ next: { ...current, items: current.items.map(item => (item.id === id ? { ...item, ...patch } : item)) } }), { keep: true }),
    /** 这个制度标识已入完（有 finishedAt）的每一条记上删除时间；还在入库的不记（它入完时库里就有它），已经记过的不动。 */
    removed: (sourceId, at) => commit(current => ({ next: { ...current, items: current.items.map(item => (item.sourceId === sourceId && item.finishedAt && !item.removedAt
      ? { ...item, removedAt: at } : item)) } }), { keep: true }),
  };
}

/** Agent 对 ingest 的回复 → 历史里这一条的结果。 */
function outcome(result) {
  if (result.success) {
    return { status: result.status, rulesTotal: result.rules_total, written: result.written, removed: result.removed, unchanged: result.unchanged,
      conflicts: result.conflicts, report: result.report ?? null, error: null };
  }
  const report = result.report ?? null;
  if (Array.isArray(result.conflicts) && result.conflicts.length) {
    return { status: 'failed', conflicts: result.conflicts, report, error: { code: 'KB_RULE_CONFLICT', message: COMMON_MESSAGES.KB_RULE_CONFLICT, type: result.error_type } };
  }
  return { status: 'failed', report, error: { code: 'KB_INGEST_FAILED', type: result.error_type, message: result.message.slice(0, 500),
    ...(typeof result.suggestion === 'string' && result.suggestion ? { suggestion: result.suggestion.slice(0, 500) } : {}) } };
}

export function createKbStewardRoutes({ mode, client, uploadsDir, cache = null, maxBytes = 20 * 1024 * 1024, log = () => {}, now = Date.now }) {
  if (!Object.hasOwn(AGENTS, mode)) throw new TypeError(`kb mode must be pg or s3vectors: ${mode}`);
  const MESSAGES = messagesFor(AGENTS[mode]);
  const INTERRUPTED = Object.freeze({ code: 'KB_INGEST_INTERRUPTED',
    message: `外壳在入库途中重启了：${AGENTS[mode].lead}那边可能已经写完，先看一下制度清单，没有就重新上传。` });
  const history = createHistory(path.join(uploadsDir, 'history.json'), log);
  let busy = false;
  const iso = ms => new Date(ms).toISOString();
  const inflight = new Map();   // 缓存的键 → 进行中的那次 Agent 调用

  /** 库读写出错不挡路：记一行，当没有。 */
  async function quietly(work) {
    try { return await work(); } catch { log('POC_KB_CACHE_UNAVAILABLE'); return null; }
  }
  const forget = (...keys) => (cache ? quietly(() => cache.drop(...keys)) : null);
  /** 同一个键同时只问 Agent 一次，后来的等它。 */
  function once(key, work) {
    if (inflight.has(key)) return inflight.get(key);
    const run = work().finally(() => inflight.delete(key));
    inflight.set(key, run);
    return run;
  }
  /** 清单、详情：先看库里（refresh 时不看），没有就问 Agent，成功的存进库；回复带 fetched_at。没启用时不给库里的。 */
  async function stored(key, load, { refresh = false } = {}) {
    if (!cache) return load();
    if (!(await client.ready())) fail('KB_AGENT_NOT_READY', 409);
    if (!refresh) {
      const hit = await quietly(() => cache.get(key));
      if (hit) return { ...hit.body, fetched_at: hit.fetchedAt };
    }
    return once(key, async () => {
      const value = await load();
      if (value?.success !== true) return value;
      const at = (await quietly(() => cache.put(key, value))) ?? iso(now());
      return { ...value, fetched_at: at };
    });
  }
  /** 这个 Agent 支持的操作（describe）：库里有就用库里的。 */
  async function opsOf() {
    if (!cache) return (await client.describe()).ops;
    const hit = await quietly(() => cache.get('describe'));
    if (Array.isArray(hit?.body?.ops)) return hit.body.ops;
    return once('describe', async () => {
      const { protocol, backend, ops } = await client.describe();
      await quietly(() => cache.put('describe', { protocol, backend, ops: [...ops] }));
      return ops;
    });
  }

  async function describeMode() {
    if (!client.configured) return { mode, configured: false, ready: false, ops: [] };
    if (!(await client.ready())) return { mode, configured: true, ready: false, ops: [] };
    return { mode, configured: true, ready: true, ops: [...(await opsOf())] };
  }

  async function sources(params) {
    const refresh = params.get('refresh') === '1';
    if (refresh && cache) await quietly(() => cache.dropPrefix(DETAIL));   // 「刷新清单」：存着的详情也作废，下次看详情再问
    return stored('list', () => client.request('list', {}), { refresh });
  }

  function meta(params) {
    const sourceId = String(params.get('sourceId') ?? '').trim(), sourceVersion = String(params.get('sourceVersion') ?? '').trim(),
      title = String(params.get('title') ?? '').trim();
    if (!TAG.test(sourceId) || chars(sourceVersion) > 64 || chars(title) > 200) fail('KB_REQUEST_INVALID', 400);
    return { sourceId, sourceVersion, title };
  }

  async function upload(user, req, params) {
    const input = meta(params);
    if (busy) fail('KB_INGEST_BUSY', 409);
    busy = true;
    let item, file;
    const started = now();
    try {
      // 没启用就不收文件、不留记录（页面直接说先去「Agent 接入」页启用）
      if (!(await client.ready())) fail('KB_AGENT_NOT_READY', 409);
      file = await readDocxUpload(req, maxBytes);
      await storeDocx(uploadsDir, file);
      item = await history.add({ at: iso(started), fileName: file.name, size: file.bytes.length, sha256: file.sha256, by: String(user.id),
        sourceId: input.sourceId, sourceVersion: input.sourceVersion, title: input.title, status: 'ingesting',
        rulesTotal: null, written: null, removed: null, unchanged: null, conflicts: [], report: null, finishedAt: null, elapsedMs: null, error: null });
    } catch (error) { busy = false; throw error; }
    void ingest(item, file, input, started);
    return { id: item.id, status: 'ingesting' };
  }

  async function ingest(item, file, input, started) {
    let patch;
    try {
      const result = await client.request('ingest', { source_id: input.sourceId, source_version: input.sourceVersion, title: input.title },
        { name: file.name, bytes: file.bytes });
      patch = outcome(result);
      if (patch.error) log(`POC_KB_INGEST_FAILED ${item.id} ${patch.error.code}`);
    } catch (error) {
      const code = Object.hasOwn(MESSAGES, error?.code) ? error.code : 'KB_UNAVAILABLE';
      log(`POC_KB_INGEST_FAILED ${item.id} ${code}${error?.reason ? ` ${error.reason}` : ''}`);
      if (STALE.has(code)) await forget('describe');
      patch = { status: 'failed', error: { code, message: MESSAGES[code] } };
    }
    // 不管结果：库里可能改了（超时的那一轮也可能已经写完），清单和这份制度的详情以 Agent 那边为准
    await forget('list', `${DETAIL}${input.sourceId}`);
    try {
      const finished = now();
      await history.update(item.id, { ...patch, finishedAt: iso(finished), elapsedMs: finished - started });
    } catch { log(`POC_KB_HISTORY_WRITE_FAILED ${item.id}`); }
    finally { busy = false; }
  }

  /**
   * 一份制度的详情、下线、恢复、删除；下线、恢复先看 describe 的 ops，不支持就不调。详情存进库（refresh 时重问）；
   * 下线、恢复、删除之后（不管结果）清单和这份制度的详情作废。删除成功后在上传历史里记上（写盘失败只记日志，照样回 Agent 的结果）。
   */
  async function manage(op, sourceId, params) {
    if (op === 'detail') return stored(`${DETAIL}${sourceId}`, () => client.request('detail', { source_id: sourceId }), { refresh: params.get('refresh') === '1' });
    if (OPTIONAL_OPS.has(op) && !(await opsOf()).includes(op)) fail('KB_OP_UNSUPPORTED', 409);
    let result;
    try { result = await client.request(op, { source_id: sourceId }); }
    finally { await forget('list', `${DETAIL}${sourceId}`); }
    if (op === 'delete' && result.success === true) {
      try { await history.removed(sourceId, iso(now())); } catch { log('POC_KB_HISTORY_WRITE_FAILED delete'); }
    }
    return result;
  }

  function search(params) {
    const question = String(params.get('q') ?? '').trim(), segment = String(params.get('segment') ?? '').trim(),
      amount = String(params.get('amount') ?? '').trim(), k = Number(params.get('k') || 8);
    if (!question || chars(question) > 2000 || chars(segment) > 40 || (amount && !AMOUNT.test(amount)) || !Number.isInteger(k) || k < 1 || k > 20) {
      fail('KB_QUESTION_INVALID', 400);
    }
    return client.request('search', { question, ...(segment ? { segment } : {}), ...(amount ? { amount: Number(amount) } : {}), top_k: k });
  }

  /** 除 /mode 以外的路径 → 处理函数；不认识的路径回 null（交还九安）。 */
  function pick(method, url, req, user) {
    const route = url.pathname.slice(BASE.length);
    if (method === 'POST' && route === '/sources') return async () => [202, await upload(user, req, url.searchParams)];
    if (method === 'GET' && route === '/uploads') return async () => [200, { items: history.list().slice(0, 50) }];
    const entry = /^\/uploads\/(\d{1,12})$/.exec(route);
    if (entry && method === 'GET') return async () => [200, history.get(Number(entry[1])) ?? fail('KB_NOT_FOUND', 404)];
    if (method === 'GET' && route === '/sources') return async () => [200, await sources(url.searchParams)];
    const one = /^\/sources\/([^/]+)(?:\/(deactivate|restore|delete))?$/.exec(route);
    if (one && ((method === 'GET' && !one[2]) || (method === 'POST' && one[2]))) {
      return async () => {
        let sourceId = '';
        try { sourceId = decodeURIComponent(one[1]); } catch { sourceId = ''; }
        if (!SOURCE_ID.test(sourceId)) fail('KB_REQUEST_INVALID', 400);
        return [200, await manage(one[2] ?? 'detail', sourceId, url.searchParams)];
      };
    }
    if (method === 'GET' && route === '/search') return async () => [200, await search(url.searchParams)];
    return null;
  }

  async function route(method, url, req, user) {
    if (method === 'GET' && url.pathname === `${BASE}/mode`) return [200, await describeMode()];
    const run = pick(method, url, req, user);
    if (!run) return null;
    if (!client.configured) fail('KB_AGENT_NOT_CONFIGURED', 409);
    return run();
  }

  return {
    /** 工作台用：方式、有没有发布编号、「Agent 接入」页里有没有可用的钥匙——只看配置和钥匙，不调 Agent（不问 describe）。 */
    async status() { return { mode, configured: client.configured, ready: client.configured ? await client.ready() : false }; },
    /** 工作台用：全部上传历史（最多 200 条），新的在前。 */
    async historyList() { await history.ready(); return history.list(); },
    /** 读上传历史；外壳重启时还在 ingesting 的那几条改成失败（后台的那一轮已经没人等了）。 */
    async start() {
      await history.ready();
      try {
        const stale = history.list().filter(item => item.status === 'ingesting');
        for (const item of stale) await history.update(item.id, { status: 'failed', error: { ...INTERRUPTED } });
        if (stale.length) log(`POC_KB_RECOVERED ${stale.length}`);
      } catch { log('POC_KB_RECOVER_FAILED'); }
    },
    async handle({ req, url, path: pathname, session, res }) {
      const where = url ?? new URL(pathname, 'http://localhost');
      if (where.pathname !== BASE && !where.pathname.startsWith(`${BASE}/`)) return false;
      try {
        if (session?.user?.role !== 'admin') fail('KB_FORBIDDEN', 403);
        await history.ready();
        const answer = await route(req.method, where, req, session.user);
        if (!answer) return false;
        send(res, answer[0], { data: answer[1] });
      } catch (error) {
        const known = Object.hasOwn(MESSAGES, error?.code);
        const code = known ? error.code : 'KB_UNAVAILABLE';
        if (STALE.has(code)) await forget('describe');
        if (!known || STATUS[code] >= 500) log(`POC_KB_FAILED ${error?.code || ''}${error?.reason ? ` ${error.reason}` : ''}`.slice(0, 120));
        send(res, known ? (error.status ?? STATUS[code] ?? 503) : 503, { error: { code, message: MESSAGES[code] } });
      }
      return true;
    },
  };
}
