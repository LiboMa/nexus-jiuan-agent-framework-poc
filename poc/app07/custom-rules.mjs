/**
 * 「我的规则」：审核员（管理员、分析员）自己上传的规则，Markdown（.md）或 Word（.docx），存在测试台本机，两种知识库方式都有。
 *   GET  /api/analysis/v1/poc/custom-rules            自己的规则 { items: [{ id, title, format, chars, uploadedAt }], usedChars, limitChars, limitFiles }
 *   POST …/custom-rules                               请求体是文件原文（X-File-Name 为 encodeURIComponent 后的文件名）：
 *                                                     转成纯文本 → 核对限额 → 存 → 201 { id, title, format, chars, uploadedAt, text }（页面给审核员核对转出来的文字）
 *   GET  …/custom-rules/<id>                          一份规则，带全文
 *   POST …/custom-rules/<id>/delete                   删掉一份（和 /poc/kb、/poc/intake 一样走 POST）→ { id, deleted: true }
 * 只操作 session.user.id 自己的；会话、来源和 CSRF 由九安校验。这些路径不在 /platform 下，九安不替它们读请求体，这里自己读。
 * 存 <dir>/<账号>/<id>.json（文件 0600、目录 0700）：{ id, title（文件名）, format, chars, sha256, uploadedAt, text }。
 * 上限：每人 10 份、单个文件 2 MB、合计 20,000 字（按 Unicode 字符数，和九安量请求大小的办法一样）；超了在上传时就拒绝并说明。
 * .md 按 UTF-8 读（去 BOM、换行统一成 \n）；.docx 由 docx_text.py 在隔离的子进程里抽正文段落与表格行（python3 -I，只用标准库）。
 * forRequest(账号) 给人手动发起 AI 独立建议时附进请求的那一份。日志只写错误码，不写规则内容。
 */
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = '/api/analysis/v1/poc/custom-rules';
const ROLES = new Set(['admin', 'analyst']);
const ACCOUNT = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const ONE = /^\/([a-z0-9][a-z0-9-]{0,63})(\/delete)?$/u;
const FORMATS = Object.freeze({ '.md': 'md', '.docx': 'docx' });
const DOCX_TEXT = fileURLToPath(new URL('./docx_text.py', import.meta.url));
export const CUSTOM_RULES_LIMITS = Object.freeze({ files: 10, chars: 20_000, bytes: 2 * 1024 * 1024 });
export const CUSTOM_RULES_MESSAGES = Object.freeze({
  CUSTOM_RULES_FORBIDDEN: '只有管理员和分析员能用「我的规则」。',
  CUSTOM_RULES_ACCOUNT_INVALID: '这个账号的编号不能用来存「我的规则」（只认小写字母、数字和连字符）。',
  CUSTOM_RULES_TYPE: '只收 Markdown（.md）或 Word（.docx）文件。',
  CUSTOM_RULES_TOO_LARGE: '文件超过 2 MB。',
  CUSTOM_RULES_EMPTY: '这个文件里没有抽出文字（空文件，或 Word 里只有图片）。',
  CUSTOM_RULES_UNREADABLE: '读不出这个文件：.docx 不是有效的 Word 文件，或 .md 不是 UTF-8 编码。',
  CUSTOM_RULES_FILE_LIMIT: '每人最多 10 份规则：先删掉一份再上传。',
  CUSTOM_RULES_CHAR_LIMIT: '每人的规则合计不超过 20,000 字。',
  CUSTOM_RULES_NOT_FOUND: '找不到这份规则，刷新后再试。',
  CUSTOM_RULES_UNAVAILABLE: '「我的规则」暂时用不了，稍后再试。',
});
const UNREADABLE_DOCX = '这个 .docx 不是有效的 Word 文件，读不出文字。';
const UNREADABLE_MD = '这个 .md 不是 UTF-8 编码的文本：请另存为 UTF-8 再上传。';
const STATUS = Object.freeze({ CUSTOM_RULES_FORBIDDEN: 403, CUSTOM_RULES_ACCOUNT_INVALID: 403, CUSTOM_RULES_TYPE: 400, CUSTOM_RULES_TOO_LARGE: 413,
  CUSTOM_RULES_EMPTY: 422, CUSTOM_RULES_UNREADABLE: 422, CUSTOM_RULES_FILE_LIMIT: 409, CUSTOM_RULES_CHAR_LIMIT: 409, CUSTOM_RULES_NOT_FOUND: 404,
  CUSTOM_RULES_UNAVAILABLE: 503 });
const fail = (code, message = CUSTOM_RULES_MESSAGES[code]) => { throw Object.assign(new Error(message), { code }); };
const send = (res, status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(payload)); };
const chars = text => [...text].length;
const thousands = number => number.toLocaleString('en-US');
const normalize = text => text.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n').trim();

/**
 * .docx → 纯文本：python3 -I docx_text.py <file>，60 秒时限，环境变量只给 PATH 和 LANG。
 * 文件读不出（退出码非 0、超时、输出过大）→ CUSTOM_RULES_UNREADABLE；子进程起不来（没装 python3）是测试台的问题，原样抛。
 */
export function docxToText(file, { python = 'python3', timeout = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(python, ['-I', DOCX_TEXT, file], { timeout, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer',
      env: { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C.UTF-8' } }, (error, stdout) => {
      if (!error) resolve(stdout.toString('utf8'));
      else if (String(error.syscall ?? '').startsWith('spawn')) reject(error);
      else reject(Object.assign(new Error(UNREADABLE_DOCX), { code: 'CUSTOM_RULES_UNREADABLE' }));
    });
  });
}

/** 文件名 → { title, format }：只取最后一段、去掉控制字符，最长 200 字（截主名、留扩展名）；不是 .md / .docx 抛 CUSTOM_RULES_TYPE。 */
function ruleFile(fileName) {
  const base = path.basename(String(fileName ?? '')).replace(/[\u0000-\u001f\u007f]/gu, '').trim();
  const ext = path.extname(base), format = FORMATS[ext.toLowerCase()];
  if (!format) fail('CUSTOM_RULES_TYPE');
  const stem = [...base.slice(0, -ext.length)];
  return { title: stem.length + ext.length > 200 ? `${stem.slice(0, 200 - ext.length).join('')}${ext}` : base, format };
}

export function createCustomRules({ dir, docxToText: toText = docxToText, now = Date.now, newId = randomUUID }) {
  // 同一账号的增删排队（单进程）：两份同时上传时限额按顺序核对
  const queues = new Map();
  function serial(accountId, work) {
    const run = (queues.get(accountId) ?? Promise.resolve()).then(work);
    const tail = run.catch(() => {});
    queues.set(accountId, tail);
    void tail.then(() => { if (queues.get(accountId) === tail) queues.delete(accountId); });
    return run;
  }
  function folderOf(accountId) {
    if (typeof accountId !== 'string' || !ACCOUNT.test(accountId)) fail('CUSTOM_RULES_ACCOUNT_INVALID');
    return path.join(dir, accountId);
  }
  /** 这个账号的全部规则，按上传先后。 */
  async function load(accountId) {
    const folder = folderOf(accountId);
    let names;
    try { names = await readdir(folder); } catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
    const rules = [];
    for (const name of names) {
      if (!name.endsWith('.json') || !ID.test(name.slice(0, -'.json'.length))) continue;
      try { rules.push(JSON.parse(await readFile(path.join(folder, name), 'utf8'))); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
    return rules.sort((a, b) => String(a.uploadedAt).localeCompare(String(b.uploadedAt)) || String(a.id).localeCompare(String(b.id)));
  }
  const summary = rule => ({ id: rule.id, title: rule.title, format: rule.format, chars: rule.chars, uploadedAt: rule.uploadedAt });
  const used = rules => rules.reduce((sum, rule) => sum + rule.chars, 0);

  async function extract(folder, format, bytes) {
    if (format === 'md') {
      try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return fail('CUSTOM_RULES_UNREADABLE', UNREADABLE_MD); }
    }
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const scratch = path.join(folder, `.tmp-${randomBytes(6).toString('hex')}.docx`);
    try {
      await writeFile(scratch, bytes, { mode: 0o600 });
      return await toText(scratch);
    } catch (error) {
      if (error?.code === 'CUSTOM_RULES_UNREADABLE') fail('CUSTOM_RULES_UNREADABLE', UNREADABLE_DOCX);
      throw error;
    } finally { await rm(scratch, { force: true }); }
  }

  async function save(folder, rule) {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const scratch = path.join(folder, `.tmp-${randomBytes(6).toString('hex')}.json`);
    try { await writeFile(scratch, JSON.stringify(rule), { mode: 0o600 }); await rename(scratch, path.join(folder, `${rule.id}.json`)); }
    catch (error) { await rm(scratch, { force: true }); throw error; }
  }

  return {
    async list(accountId) {
      const rules = await load(accountId);
      return { items: rules.map(summary), usedChars: used(rules), limitChars: CUSTOM_RULES_LIMITS.chars, limitFiles: CUSTOM_RULES_LIMITS.files };
    },

    async add(accountId, { fileName, bytes } = {}) {
      const folder = folderOf(accountId);
      const { title, format } = ruleFile(fileName);
      const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
      if (content.length > CUSTOM_RULES_LIMITS.bytes) fail('CUSTOM_RULES_TOO_LARGE');
      // 已满就不转了；转完在队里再核对一次（转 .docx 要几秒，不占着队）
      if ((await load(accountId)).length >= CUSTOM_RULES_LIMITS.files) fail('CUSTOM_RULES_FILE_LIMIT');
      const text = normalize(await extract(folder, format, content));
      if (!text) fail('CUSTOM_RULES_EMPTY');
      const size = chars(text);
      return serial(accountId, async () => {
        const rules = await load(accountId);
        if (rules.length >= CUSTOM_RULES_LIMITS.files) fail('CUSTOM_RULES_FILE_LIMIT');
        const left = Math.max(CUSTOM_RULES_LIMITS.chars - used(rules), 0);
        if (size > left) {
          fail('CUSTOM_RULES_CHAR_LIMIT', `每人的规则合计不超过 ${thousands(CUSTOM_RULES_LIMITS.chars)} 字：这份有 ${thousands(size)} 字，现在还剩 ${thousands(left)} 字。`);
        }
        const id = String(newId());
        if (!ID.test(id)) throw new Error('custom rule id is malformed');
        const rule = { id, title, format, chars: size, sha256: createHash('sha256').update(content).digest('hex'), uploadedAt: new Date(now()).toISOString(), text };
        await save(folder, rule);
        return { ...summary(rule), text };
      });
    },

    async get(accountId, id) {
      const folder = folderOf(accountId);
      if (typeof id !== 'string' || !ID.test(id)) fail('CUSTOM_RULES_NOT_FOUND');
      let rule;
      try { rule = JSON.parse(await readFile(path.join(folder, `${id}.json`), 'utf8')); }
      catch (error) { if (error?.code === 'ENOENT') fail('CUSTOM_RULES_NOT_FOUND'); throw error; }
      return { ...summary(rule), text: rule.text };
    },

    async remove(accountId, id) {
      const folder = folderOf(accountId);
      if (typeof id !== 'string' || !ID.test(id)) fail('CUSTOM_RULES_NOT_FOUND');
      return serial(accountId, async () => {
        try { await unlink(path.join(folder, `${id}.json`)); }
        catch (error) { if (error?.code === 'ENOENT') fail('CUSTOM_RULES_NOT_FOUND'); throw error; }
        return { id, deleted: true };
      });
    },

    /** 这个账号当前的全部规则 { owner, items: [{ title, text }] }（按上传先后）；没有规则（或编号不合格、不可能有规则）时 null。 */
    async forRequest(accountId) {
      if (typeof accountId !== 'string' || !ACCOUNT.test(accountId)) return null;
      const rules = await load(accountId);
      return rules.length ? { owner: accountId, items: rules.map(rule => ({ title: rule.title, text: rule.text })) } : null;
    },
  };
}

/** 请求体：先看 Content-Length，超了不读；没声明的读到超过为止。 */
async function readBody(req, max) {
  const declared = Number(req.headers?.['content-length']);
  if (Number.isFinite(declared) && declared > max) fail('CUSTOM_RULES_TOO_LARGE');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) fail('CUSTOM_RULES_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function customRulesRoutes({ rules, log = () => {} }) {
  async function upload(req, user) {
    let name = '';
    try { name = decodeURIComponent(String(req.headers?.['x-file-name'] ?? '')); } catch { name = ''; }
    ruleFile(name); // 扩展名不对就不读请求体
    return rules.add(user.id, { fileName: name, bytes: await readBody(req, CUSTOM_RULES_LIMITS.bytes) });
  }

  async function route(method, rest, req, user) {
    if (rest === '' || rest === '/') {
      if (method === 'GET') return [200, await rules.list(user.id)];
      if (method === 'POST') return [201, await upload(req, user)];
      return null;
    }
    const one = ONE.exec(rest);
    if (one && method === 'GET' && !one[2]) return [200, await rules.get(user.id, one[1])];
    if (one && method === 'POST' && one[2]) return [200, await rules.remove(user.id, one[1])];
    return null;
  }

  return {
    async handle({ req, url, path: pathname, session, res }) {
      const where = (url ?? new URL(pathname, 'http://localhost')).pathname;
      if (where !== BASE && !where.startsWith(`${BASE}/`)) return false;
      try {
        if (!ROLES.has(session?.user?.role)) fail('CUSTOM_RULES_FORBIDDEN');
        const answer = await route(req.method, where.slice(BASE.length), req, session.user);
        if (!answer) return false;
        send(res, answer[0], { data: answer[1] });
      } catch (error) {
        const known = Object.hasOwn(STATUS, error?.code);
        if (!known) log(`POC_CUSTOM_RULES_FAILED ${String(error?.code ?? '')}`.trim().slice(0, 120));
        const code = known ? error.code : 'CUSTOM_RULES_UNAVAILABLE';
        send(res, STATUS[code], { error: { code, message: known ? error.message : CUSTOM_RULES_MESSAGES[code] } });
      }
      return true;
    },
  };
}
