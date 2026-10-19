/** PoC 包装层的 HTTP 小工具：与九安服务端相同的 JSON 外壳、请求体限制与安全响应头。 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const MIME = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml' };
const MESSAGES = { ORIGIN_INVALID: '请从 PoC 站点地址访问。', INVALID_CREDENTIALS: '账号或口令不正确。', POC_LOGIN_RATE_LIMIT: '登录尝试过多，请一分钟后再试。',
  NOT_FOUND: '未找到可访问的记录。' };

export function fail(code, status = 400) { throw Object.assign(new Error(code), { code, status }); }

export function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(payload));
}

export function sendError(res, error) {
  const code = /^[A-Z][A-Z0-9_]{1,60}$/.test(error?.code || '') ? error.code : 'INTERNAL_ERROR';
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
  if (res.headersSent) { res.end(); return; }
  sendJson(res, status, { error: { code, message: MESSAGES[code] || (status === 500 ? '当前操作未完成，请稍后重试。' : '请求未通过校验。') } });
}

/**
 * 超出上限不多（不到一倍）时把请求体读完、丢掉，再报 413：立即断开的话，经 CloudFront 的浏览器只会看到 502，看不到「请求太大」。
 * 超出一倍以上才立即中断连接。
 */
export async function readJson(req, { maximum = 16_000 } = {}) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) fail('INVALID_CONTENT_TYPE', 415);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximum * 2) { req.destroy?.(); fail('BODY_LIMIT', 413); }
    if (size <= maximum) chunks.push(chunk);
  }
  if (size > maximum) fail('BODY_LIMIT', 413);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return fail('INVALID_JSON', 400); }
}

export function onlyFields(body, names) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !names.includes(key))) fail('INVALID_REQUEST', 400);
}

export function onlyQuery(url, names) {
  for (const key of url.searchParams.keys()) if (!names.includes(key) || url.searchParams.getAll(key).length !== 1) fail('INVALID_QUERY', 400);
}

/** CloudFront 把观众的 IP 追加在 X-Forwarded-For 的最后；前面的部分是观众自己填的，不可信。 */
export function clientIp(req) {
  const parts = String(req.headers['x-forwarded-for'] || '').split(',').map(part => part.trim()).filter(Boolean);
  return parts.at(-1) || req.socket?.remoteAddress || 'unknown';
}

/** 托管前端副本（app/public）：只认白名单里的路径，响应头与九安托管它自己的前端时相同。 */
export function createStaticFiles({ dir, files, entryPages = ['/', '/analysis.html'] }) {
  const entries = new Set(entryPages);
  return {
    async serve(res, url) {
      if (!Object.hasOwn(files, url.pathname)) return false;
      if (url.search && !entries.has(url.pathname)) fail('NOT_FOUND', 404);
      const file = files[url.pathname];
      let content;
      try { content = await readFile(path.join(dir, file)); } catch { fail('NOT_FOUND', 404); }
      res.writeHead(200, { 'Content-Type': MIME[file.split('.').at(-1)] || 'application/octet-stream', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': PAGE_CSP, 'Referrer-Policy': 'no-referrer' });
      res.end(content);
      return true;
    },
  };
}
