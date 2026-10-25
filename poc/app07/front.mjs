/**
 * 外壳的前门（九安之前先过这里）：口令登录页、模拟来单页和它们的脚本样式；口令登录接口；首页跳转。
 * 九安 v0.7.10 的登录卡只有钉钉。口令对了就签九安的本地票据，浏览器跳到 /#access=<票据>，由九安自己的前端换成会话。
 * 九安的会话 Cookie 只挂在 /api/analysis/v1 下，首页看不到它，所以登录成功时另设一个只作提示的 Cookie（不是凭据），
 * 首页没有它就跳到登录页；有它但会话已过期，九安会显示自己的登录卡，再到 /poc/login 登录即可。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGE_CSP, clientIp, fail, onlyFields, readJson, sendError, sendJson } from '../app/http.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MARKER_COOKIE = 'poc07_signed_in';
const LOGIN_API = '/api/analysis/v1/poc/login';
const PAGES = Object.freeze({
  '/poc/login': ['login.html', 'text/html; charset=utf-8'], '/poc/intake': ['intake.html', 'text/html; charset=utf-8'],
  '/poc/login.js': ['login.js', 'text/javascript; charset=utf-8'], '/poc/intake.js': ['intake.js', 'text/javascript; charset=utf-8'],
  '/poc/poc.css': ['poc.css', 'text/css; charset=utf-8'],
});

export function createFrontDoor({ origin, login, publicDir = path.join(here, 'public') }) {
  const host = new URL(origin).host;
  const signedIn = req => (req.headers.cookie || '').split(';').some(part => part.trim() === `${MARKER_COOKIE}=1`);
  async function page(res, [file, type]) {
    const body = await readFile(path.join(publicDir, file));
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-store', 'Content-Security-Policy': PAGE_CSP,
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    res.end(body);
  }
  return {
    /** 认得的请求处理掉并返回 true；其余返回 false，交给九安。 */
    async serve(req, res, url) {
      const ours = url.pathname === LOGIN_API || Object.hasOwn(PAGES, url.pathname);
      if (!ours && !(req.method === 'GET' && url.pathname === '/')) return false;
      try {
        if (req.headers.host !== host) fail('ORIGIN_INVALID', 403);
        if (url.pathname === '/') {
          if (signedIn(req)) return false;
          res.writeHead(302, { Location: '/poc/login', 'Cache-Control': 'no-store' });
          res.end();
          return true;
        }
        if (url.pathname === LOGIN_API) {
          if (req.method !== 'POST') fail('NOT_FOUND', 404);
          if (req.headers.origin !== origin) fail('ORIGIN_INVALID', 403);
          const body = await readJson(req, { maximum: 2000 });
          onlyFields(body, ['account', 'password']);
          const result = login.login({ account: body.account, password: body.password, ip: clientIp(req) });
          res.setHeader('Set-Cookie', `${MARKER_COOKIE}=1; Path=/; Max-Age=28800; SameSite=Strict; Secure`);
          sendJson(res, 200, { data: result });
          return true;
        }
        if (req.method !== 'GET') fail('NOT_FOUND', 404);
        await page(res, PAGES[url.pathname]);
      } catch (error) {
        sendError(res, error);
      }
      return true;
    },
  };
}
