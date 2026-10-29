/**
 * S3 Vectors 方式（POC07_KB_MODE=s3vectors）的「规则库 › 制度知识库 › 公司制度」接口；和 PG 方式的 kb-routes.mjs 同一个前缀，两套不同时挂。
 * 只给管理员（KB_FORBIDDEN 403）。规则库由文档管家经 A2A 读写（kb-s3v-client.mjs），这里不连 PG、不解析文档：
 *   GET  /api/analysis/v1/poc/kb/mode                     { mode: 's3vectors', ready }：ready = 「Agent 接入」页里文档管家的发布有可用钥匙
 *   POST …/sources?sourceId=&sourceVersion=&title=        请求体是 .docx 原文（X-File-Name）：校验 → 存 <uploadsDir>/<sha256>.docx（0600）→
 *                                                         记一条上传历史 → 后台 ingest，先回 202 { id, status: 'ingesting' }；同一时间只跑一个
 *   GET  …/uploads、…/uploads/<id>                         上传历史（最近 50 条；<uploadsDir>/history.json，0600），页面轮询到 ingested / skipped / failed
 *   GET  …/sources、…/sources/<id>                         制度清单、一份制度的登记和规则编号
 *   POST …/sources/<id>/(deactivate|restore|delete)       下线、恢复、硬删除
 *   GET  …/search?q=&segment=&amount=&k=                  按问题检索（板块、金额可空，空的不传）
 * 同步的操作各一次 A2A 调用（约 10–20 秒），回 { data: 工具的 JSON }：工具自己失败时也是 200，data.success === false，带 error_type / message / suggestion。
 * 日志只写错误码，不写回复、制度内容和钥匙。
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { KB_MESSAGES, readDocxUpload, storeDocx } from './kb-routes.mjs';

const BASE = '/api/analysis/v1/poc/kb';
// 新上传的制度标识沿用 PG 方式的标签规则；路径里的标识按文档管家工具的规则（别处入库的制度也能管理）
const TAG = /^[a-z0-9][a-z0-9-]{1,62}$/;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const AMOUNT = /^\d{1,13}(?:\.\d{1,2})?$/;
const HISTORY_LIMIT = 200;
const MESSAGES = Object.freeze({
  KB_FORBIDDEN: KB_MESSAGES.KB_FORBIDDEN,
  KB_UPLOAD_INVALID: KB_MESSAGES.KB_UPLOAD_INVALID,
  KB_UPLOAD_TOO_LARGE: KB_MESSAGES.KB_UPLOAD_TOO_LARGE,
  KB_NOT_FOUND: KB_MESSAGES.KB_NOT_FOUND,
  KB_INGEST_BUSY: KB_MESSAGES.KB_INGEST_BUSY,
  KB_RULE_CONFLICT: KB_MESSAGES.KB_RULE_CONFLICT,
  KB_REQUEST_INVALID: '请求不完整：制度标识只能用小写字母、数字和连字符（2–63 位），版本说明不超过 64 字，文档名不超过 200 字。',
  KB_QUESTION_INVALID: '请写一个问题（不超过 2000 字）；板块不超过 40 字，金额写以元为单位的数字，条数 1–20。',
  KB_AGENT_NOT_READY: '先在『Agent 接入』页启用知识库文档管家',
  KB_AGENT_KEY_REJECTED: 'Nexus 不认这把调用密钥，请在『Agent 接入』页换钥匙',
  KB_AGENT_REPLY_INVALID: '文档管家的回复不合格，这次没有完成',
  KB_UNAVAILABLE: '文档管家暂时连不上，或没在限定时间内答完：稍后再试（入库的话先看一下制度清单，可能已经写完）。',
});
const STATUS = Object.freeze({ KB_AGENT_NOT_READY: 409, KB_AGENT_KEY_REJECTED: 409, KB_AGENT_REPLY_INVALID: 502, KB_UNAVAILABLE: 503 });
const INTERRUPTED = Object.freeze({ code: 'KB_INGEST_INTERRUPTED', message: '外壳在入库途中重启了：文档管家那边可能已经写完，先看一下制度清单，没有就重新上传。' });
const fail = (code, status) => { throw Object.assign(new Error(code), { code, status }); };
const send = (res, status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(payload)); };
const chars = text => [...text].length;

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
    } catch (error) { if (error?.code !== 'ENOENT') log('POC_KB_S3V_HISTORY_UNREADABLE'); }
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
  };
}

/** 文档管家对 ingest 的回复 → 历史里这一条的结果。 */
function outcome(result) {
  if (result.success) {
    return { status: result.status, rulesTotal: result.rules_total, written: result.written, removed: result.removed, unchanged: result.unchanged,
      conflicts: result.conflicts, report: result.report ?? null, error: null };
  }
  const report = result.report ?? null;
  if (Array.isArray(result.conflicts) && result.conflicts.length) {
    return { status: 'failed', conflicts: result.conflicts, report, error: { code: 'KB_RULE_CONFLICT', message: MESSAGES.KB_RULE_CONFLICT, type: result.error_type } };
  }
  return { status: 'failed', report, error: { code: 'KB_INGEST_FAILED', type: result.error_type, message: result.message.slice(0, 500),
    ...(typeof result.suggestion === 'string' && result.suggestion ? { suggestion: result.suggestion.slice(0, 500) } : {}) } };
}

export function createKbS3vRoutes({ client, uploadsDir, maxBytes = 20 * 1024 * 1024, log = () => {}, now = Date.now }) {
  const history = createHistory(path.join(uploadsDir, 'history.json'), log);
  let busy = false;
  const iso = ms => new Date(ms).toISOString();

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
      if (patch.error) log(`POC_KB_S3V_INGEST_FAILED ${item.id} ${patch.error.code}`);
    } catch (error) {
      const code = Object.hasOwn(MESSAGES, error?.code) ? error.code : 'KB_UNAVAILABLE';
      log(`POC_KB_S3V_INGEST_FAILED ${item.id} ${code}${error?.reason ? ` ${error.reason}` : ''}`);
      patch = { status: 'failed', error: { code, message: MESSAGES[code] } };
    }
    try {
      const finished = now();
      await history.update(item.id, { ...patch, finishedAt: iso(finished), elapsedMs: finished - started });
    } catch { log(`POC_KB_S3V_HISTORY_WRITE_FAILED ${item.id}`); }
    finally { busy = false; }
  }

  function search(params) {
    const question = String(params.get('q') ?? '').trim(), segment = String(params.get('segment') ?? '').trim(),
      amount = String(params.get('amount') ?? '').trim(), k = Number(params.get('k') || 8);
    if (!question || chars(question) > 2000 || chars(segment) > 40 || (amount && !AMOUNT.test(amount)) || !Number.isInteger(k) || k < 1 || k > 20) {
      fail('KB_QUESTION_INVALID', 400);
    }
    return client.request('search', { question, ...(segment ? { segment } : {}), ...(amount ? { amount: Number(amount) } : {}), top_k: k });
  }

  async function route(method, url, req, user) {
    const route = url.pathname.slice(BASE.length);
    if (method === 'GET' && route === '/mode') return [200, { mode: 's3vectors', ready: await client.ready() }];
    if (method === 'POST' && route === '/sources') return [202, await upload(user, req, url.searchParams)];
    if (method === 'GET' && route === '/uploads') return [200, { items: history.list().slice(0, 50) }];
    const entry = /^\/uploads\/(\d{1,12})$/.exec(route);
    if (entry && method === 'GET') return [200, history.get(Number(entry[1])) ?? fail('KB_NOT_FOUND', 404)];
    if (method === 'GET' && route === '/sources') return [200, await client.request('list', {})];
    const one = /^\/sources\/([^/]+)(?:\/(deactivate|restore|delete))?$/.exec(route);
    if (one && ((method === 'GET' && !one[2]) || (method === 'POST' && one[2]))) {
      let sourceId = '';
      try { sourceId = decodeURIComponent(one[1]); } catch { sourceId = ''; }
      if (!SOURCE_ID.test(sourceId)) fail('KB_REQUEST_INVALID', 400);
      return [200, await client.request(one[2] ?? 'detail', { source_id: sourceId })];
    }
    if (method === 'GET' && route === '/search') return [200, await search(url.searchParams)];
    return null;
  }

  return {
    /** 读上传历史；外壳重启时还在 ingesting 的那几条改成失败（后台的那一轮已经没人等了）。 */
    async start() {
      await history.ready();
      try {
        const stale = history.list().filter(item => item.status === 'ingesting');
        for (const item of stale) await history.update(item.id, { status: 'failed', error: { ...INTERRUPTED } });
        if (stale.length) log(`POC_KB_S3V_RECOVERED ${stale.length}`);
      } catch { log('POC_KB_S3V_RECOVER_FAILED'); }
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
        if (!known || STATUS[code] >= 500) log(`POC_KB_S3V_FAILED ${error?.code || ''}${error?.reason ? ` ${error.reason}` : ''}`.slice(0, 120));
        send(res, known ? (error.status ?? STATUS[code] ?? 503) : 503, { error: { code, message: MESSAGES[code] } });
      }
      return true;
    },
  };
}
