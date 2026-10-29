/**
 * 「规则库 › 制度知识库」页的接口（挂在九安的 platformRoutes 钩子上；只给管理员）：
 *   POST /api/analysis/v1/poc/kb/documents                 请求体是 .docx 原文（X-File-Name 为 encodeURIComponent 后的文件名）：
 *                                                         校验 → 存原文件 → 解析 → 记历史 → 入库预览 → 201
 *   POST …/documents/<id>/preview {sourceTag, sourceVersion}   换标签 / 版本后重新预览（入库前要看会新增 / 删除多少）
 *   POST …/documents/<id>/ingest {sourceTag, docTitle, sourceVersion}   确认入库：先回 202，后台跑；同一时间只跑一个。
 *                                                         只认这份文档最近一次预览过的标签和版本，且那次预览没有规则编号冲突
 *   GET  …/documents、…/documents/<id>                     上传历史；一条详情（带这一版解析出的规则）
 *   GET  …/search?q=&k=&segment=                           语义检索（库里的 kb_search，和审核 Agent 用的同一个）
 *   GET  …/search-log                                      检索日志：审核 Agent、页面、verify 查了什么、命中了哪些
 *   GET  …/mode                                            { mode: 'pg', ready: true }：页面据此画「公司制度」块（S3 Vectors 方式见 kb-s3v-routes.mjs）
 * 这些路径不在 /platform 下，九安不替它们读请求体，这里自己读；会话、来源和 CSRF 由九安校验。
 * 原文件存 <uploadsDir>/<sha256>.docx（0600），解析结果存 <id>.rules.json；数据库的读写都经 runner（kb-runner.mjs）。
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const BASE = '/api/analysis/v1/poc/kb';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const TAG = /^[a-z0-9][a-z0-9-]{1,62}$/;
export const KB_MESSAGES = Object.freeze({
  KB_FORBIDDEN: '只有管理员能管理制度知识库。',
  KB_UPLOAD_INVALID: '只收审批矩阵格式的 Word 文档（.docx）：这个文件不是有效的 .docx，或者解压后太大、条目太多。',
  KB_UPLOAD_TOO_LARGE: '文件超过 20 MB。',
  KB_PARSE_FAILED: '这份文档不是审批矩阵格式，解析不出规则。',
  KB_REQUEST_INVALID: '请求不完整：标签只能用小写字母、数字和连字符（2–63 位），文档名和版本说明不超过 200 字。',
  KB_NOT_FOUND: '找不到这条上传记录，刷新后再试。',
  KB_INGEST_BUSY: '已经有一份文档在入库，等它完成再试。',
  KB_PREVIEW_STALE: '标签或版本说明和最近一次预览的不一样：先点「重新预览」，看过预览再入库。',
  KB_RULE_CONFLICT: '有规则编号已属于库里另一份文档，入库会覆盖那份文档的规则，所以不能入库。',
  KB_QUESTION_INVALID: '请写一个问题（不超过 2000 字）。',
  KB_UNAVAILABLE: '知识库暂时连不上，稍后再试。',
});
const fail = (code, status, message) => { throw Object.assign(new Error(code), { code, status, detail: message }); };
const send = (res, status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(payload)); };

async function readBody(req, max, code = 'KB_UPLOAD_TOO_LARGE') {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) { req.destroy?.(); fail(code, 413); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * 请求体里的 .docx（两种知识库方式共用）：Content-Type 是 .docx、X-File-Name（encodeURIComponent 后的文件名）以 .docx 结尾、
 * 不超过 maxBytes、zip 目录合格（checkDocx）；不合格抛 KB_UPLOAD_INVALID（400）/ KB_UPLOAD_TOO_LARGE（413）。
 */
export async function readDocxUpload(req, maxBytes) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  let name = '';
  try { name = path.basename(decodeURIComponent(String(req.headers['x-file-name'] || ''))).slice(0, 200); } catch { name = ''; }
  if (type !== DOCX || !/\.docx$/iu.test(name)) fail('KB_UPLOAD_INVALID', 400);
  const bytes = await readBody(req, maxBytes);
  if (!checkDocx(bytes)) fail('KB_UPLOAD_INVALID', 400);
  return { name, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** 原文件存 <uploadsDir>/<sha256>.docx（目录 0700，文件 0600）。 */
export async function storeDocx(uploadsDir, { sha256, bytes }) {
  await mkdir(uploadsDir, { recursive: true, mode: 0o700 });
  const file = path.join(uploadsDir, `${sha256}.docx`);
  await writeFile(file, bytes, { mode: 0o600 });
  return file;
}

/** 只看 zip 的目录，不解压：本地文件头、中央目录在、条目数和解压后总大小不超限、里面有 word/document.xml。 */
export function checkDocx(buffer, { entries = 2000, uncompressed = 100 * 1024 * 1024 } = {}) {
  if (buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034b50) return false;
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end + 22 > buffer.length) return false;
  const total = buffer.readUInt16LE(end + 10), size = buffer.readUInt32LE(end + 12), offset = buffer.readUInt32LE(end + 16);
  if (total > entries || offset + size > buffer.length) return false;
  let position = offset, sum = 0, document = false;
  for (let index = 0; index < total; index += 1) {
    if (position + 46 > buffer.length || buffer.readUInt32LE(position) !== 0x02014b50) return false;
    const nameLength = buffer.readUInt16LE(position + 28);
    sum += buffer.readUInt32LE(position + 24);
    if (sum > uncompressed) return false;
    if (buffer.toString('utf8', position + 46, position + 46 + nameLength) === 'word/document.xml') document = true;
    position += 46 + nameLength + buffer.readUInt16LE(position + 30) + buffer.readUInt16LE(position + 32);
  }
  return document;
}

export function createKbRoutes({ runner, uploadsDir, maxBytes = 20 * 1024 * 1024, log = () => {} }) {
  let busy = false;
  // 每份上传最近一次预览过的标签、版本和有没有冲突（服务重启后要重新预览）
  const previewed = new Map();
  async function preview(id, meta) {
    const result = await runner.preview(rulesFile(id), meta);
    previewed.set(id, { sourceTag: meta.sourceTag, sourceVersion: meta.sourceVersion ?? '', conflicts: Number(result?.conflicts) || 0 });
    return result;
  }
  const scratch = suffix => path.join(uploadsDir, `.tmp-${randomBytes(6).toString('hex')}${suffix}`);
  const rulesFile = id => path.join(uploadsDir, `${id}.rules.json`);
  async function writeJson(file, value) { await writeFile(file, JSON.stringify(value ?? {}), { mode: 0o600 }); return file; }
  async function json(req) {
    try { return JSON.parse((await readBody(req, 16 * 1024, 'KB_REQUEST_INVALID')).toString('utf8') || '{}'); } catch (error) { if (error?.code) throw error; return fail('KB_REQUEST_INVALID', 400); }
  }
  function meta(body, { needTitle }) {
    const sourceTag = body?.sourceTag, docTitle = body?.docTitle ?? '', sourceVersion = body?.sourceVersion ?? '';
    if (typeof sourceTag !== 'string' || !TAG.test(sourceTag) || typeof docTitle !== 'string' || typeof sourceVersion !== 'string'
      || docTitle.length > 200 || sourceVersion.length > 200 || (needTitle && !docTitle.trim())) fail('KB_REQUEST_INVALID', 400);
    return { sourceTag, docTitle: docTitle.trim(), sourceVersion: sourceVersion.trim() };
  }
  async function existing(id) {
    const { item } = await runner.admin(['show', String(id)]);
    if (!item) fail('KB_NOT_FOUND', 404);
    try { await stat(rulesFile(id)); } catch { fail('KB_NOT_FOUND', 404); }
    return item;
  }

  async function upload(user, req) {
    const { name, bytes, sha256 } = await readDocxUpload(req, maxBytes);
    const file = await storeDocx(uploadsDir, { sha256, bytes });
    const parsedFile = scratch('.rules.json');
    const parsed = await runner.parse(file, parsedFile);
    const reportFile = await writeJson(scratch('.report.json'), parsed.report);
    let id;
    try { ({ id } = await runner.admin(['record', '--name', name, '--sha256', sha256, '--size', String(bytes.length), '--by', String(user.id), '--report', reportFile])); }
    finally { await rm(reportFile, { force: true }); }
    if (parsed.code !== 0) {
      await rm(parsedFile, { force: true });
      await runner.admin(['status', String(id), '--status', 'failed', '--error', parsed.message || KB_MESSAGES.KB_PARSE_FAILED]);
      fail('KB_PARSE_FAILED', 422, parsed.message);
    }
    await rename(parsedFile, rulesFile(id));
    await chmod(rulesFile(id), 0o600);
    // 同一份文件再传：标签和版本说明都取库里现有的（它们也算进规则的哈希），预览才会是「不变」
    const known = ((await runner.admin(['tags'])).items ?? []).find(tag => tag.source_doc === name);
    const suggestedTag = known?.source_tag ?? `doc-${sha256.slice(0, 8)}`, sourceVersion = known?.source_version ?? '';
    const first = await preview(id, { sourceTag: suggestedTag, sourceDoc: name, sourceVersion });
    return { id, fileName: name, sha256, size: bytes.length, report: parsed.report, preview: first, suggestedTag, docTitle: name.replace(/\.docx$/iu, ''), sourceVersion };
  }

  async function startIngest(id, body) {
    const input = meta(body, { needTitle: true });
    const seen = previewed.get(id);
    if (!seen || seen.sourceTag !== input.sourceTag || seen.sourceVersion !== input.sourceVersion) fail('KB_PREVIEW_STALE', 409);
    if (seen.conflicts) fail('KB_RULE_CONFLICT', 409);
    if (busy) fail('KB_INGEST_BUSY', 409);
    busy = true;
    let item;
    try {
      item = await existing(id);
      await runner.admin(['status', String(id), '--status', 'ingesting', '--source-tag', input.sourceTag, '--doc-title', input.docTitle, '--source-version', input.sourceVersion]);
    } catch (error) { busy = false; throw error; }
    void (async () => {
      try {
        const result = await runner.ingest(rulesFile(id), { sourceTag: input.sourceTag, sourceDoc: item.file_name, sourceVersion: input.sourceVersion });
        const resultFile = await writeJson(scratch('.result.json'), result);
        try { await runner.admin(['status', String(id), '--status', 'ingested', '--result', resultFile, '--source-tag', input.sourceTag, '--doc-title', input.docTitle, '--source-version', input.sourceVersion]); }
        finally { await rm(resultFile, { force: true }); }
      } catch (error) {
        log(`POC_KB_INGEST_FAILED ${id}`);
        try { await runner.admin(['status', String(id), '--status', 'failed', '--error', String(error?.message || '入库没有完成').slice(0, 500)]); } catch { /* 下次启动时 recover */ }
      } finally { busy = false; }
    })();
    return { id, status: 'ingesting' };
  }

  async function detail(id) {
    const { item } = await runner.admin(['show', String(id)]);
    if (!item) fail('KB_NOT_FOUND', 404);
    let rules = [];
    try {
      rules = JSON.parse(await readFile(rulesFile(id), 'utf8')).map(rule => ({ rule_id: rule.rule_id, rule_type: rule.rule_type ?? null, chapter: rule.chapter ?? null,
        business_item: rule.business_item ?? '', segment: rule.segment ?? '', amount_tier: rule.amount_tier ?? '' }));
    } catch { rules = []; }
    return { ...item, rules };
  }

  async function route(method, url, req, user) {
    const route = url.pathname.slice(BASE.length);
    if (method === 'POST' && route === '/documents') return [201, await upload(user, req)];
    if (method === 'GET' && route === '/documents') return [200, await runner.admin(['history', '--limit', '50'])];
    const one = /^\/documents\/(\d{1,12})(?:\/(preview|ingest))?$/.exec(route);
    if (one && method === 'GET' && !one[2]) return [200, await detail(Number(one[1]))];
    if (one && method === 'POST' && one[2] === 'preview') {
      const input = meta(await json(req), { needTitle: false });
      const item = await existing(Number(one[1]));
      return [200, { preview: await preview(Number(one[1]), { sourceTag: input.sourceTag, sourceDoc: item.file_name, sourceVersion: input.sourceVersion }) }];
    }
    if (one && method === 'POST' && one[2] === 'ingest') return [202, await startIngest(Number(one[1]), await json(req))];
    if (method === 'GET' && route === '/search') {
      const question = String(url.searchParams.get('q') ?? '').trim(), k = Number(url.searchParams.get('k') || 8), segment = String(url.searchParams.get('segment') ?? '').trim();
      if (!question || [...question].length > 2000 || !Number.isInteger(k) || k < 1 || k > 20 || segment.length > 40) fail('KB_QUESTION_INVALID', 400);
      return [200, await runner.admin(['search', question, '--k', String(k), ...(segment ? ['--segment', segment] : [])])];
    }
    if (method === 'GET' && route === '/search-log') return [200, await runner.admin(['search-log', '--limit', '50'])];
    if (method === 'GET' && route === '/mode') return [200, { mode: 'pg', ready: true }];
    return null;
  }

  return {
    async start() {
      try { const { recovered } = await runner.admin(['recover']); if (recovered) log(`POC_KB_RECOVERED ${recovered}`); }
      catch { log('POC_KB_RECOVER_FAILED'); }
    },
    async handle({ req, url, path: pathname, session, res }) {
      const where = url ?? new URL(pathname, 'http://localhost');
      if (where.pathname !== BASE && !where.pathname.startsWith(`${BASE}/`)) return false;
      try {
        if (session?.user?.role !== 'admin') fail('KB_FORBIDDEN', 403);
        const answer = await route(req.method, where, req, session.user);
        if (!answer) return false;
        send(res, answer[0], { data: answer[1] });
      } catch (error) {
        const known = Object.hasOwn(KB_MESSAGES, error?.code);
        if (!known) log(`POC_KB_FAILED ${error?.code || ''}`);
        const code = known ? error.code : 'KB_UNAVAILABLE';
        send(res, known ? error.status : 503, { error: { code, message: error?.detail || KB_MESSAGES[code] } });
      }
      return true;
    },
  };
}
