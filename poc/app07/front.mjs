/**
 * 外壳的前门（九安之前先过这里）：新前端（poc/web07 的构建产物：GET / 给 index.html，/assets/* 给它的脚本、样式和图标）；
 * 口令登录页、模拟来单页和它们的脚本样式；口令登录接口。别的请求交给九安（九安的旧页面 /analysis.html 照旧）。
 * 新前端自己画登录页、自己把 /#access=<票据> 换成会话，所以首页不再跳转。九安 v0.7.10 的登录卡只有钉钉；旧的 /poc/login 照旧：
 * 口令对了就签九安的本地票据，浏览器跳到 /#access=<票据>。登录成功时仍另设一个只作提示的 Cookie（不是凭据，九安的会话 Cookie 只挂在 /api/analysis/v1 下）。
 * 构建产物在创建前门时读一次（index.html 和 assets/ 的文件清单），重新构建后要重启外壳；没有构建产物时首页回 503。
 * HEAD / 和 HEAD /assets/* 照 GET 答（同样的状态和头，Content-Length 是 GET 的长度），只是不带正文；不交给九安的旧页面。
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGE_CSP, clientIp, fail, onlyFields, readJson, sendError, sendJson } from './lib/http.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MARKER_COOKIE = 'poc07_signed_in';
const LOGIN_API = '/api/analysis/v1/poc/login';
const PAGES = Object.freeze({
  '/poc/login': ['login.html', 'text/html; charset=utf-8'], '/poc/intake': ['intake.html', 'text/html; charset=utf-8'],
  '/poc/login.js': ['login.js', 'text/javascript; charset=utf-8'], '/poc/intake.js': ['intake.js', 'text/javascript; charset=utf-8'],
  '/poc/poc.css': ['poc.css', 'text/css; charset=utf-8'],
});
// 新前端 assets/ 里只给这几种（别的扩展名，如 .map、.html，就算在目录里也不给）；文件名带哈希，可以长缓存
const ASSET_TYPES = new Map([['.js', 'text/javascript; charset=utf-8'], ['.css', 'text/css; charset=utf-8'], ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'], ['.woff2', 'font/woff2']]);
const ASSET_CACHE = 'public, max-age=31536000, immutable';

/** 读一次构建产物：index.html 和 assets/ 第一层类型认得的普通文件（文件名 → 类型）。没有 index.html 就当还没构建。 */
async function readBuild(webDir) {
  const index = await readFile(path.join(webDir, 'index.html')).catch(() => null);
  if (!index) return { index: null, assets: new Map() };
  const entries = await readdir(path.join(webDir, 'assets'), { withFileTypes: true }).catch(() => []);
  return { index, assets: new Map(entries.filter(entry => entry.isFile() && ASSET_TYPES.has(path.extname(entry.name)))
    .map(entry => [entry.name, ASSET_TYPES.get(path.extname(entry.name))])) };
}

export function createFrontDoor({ origin, login, publicDir = path.join(here, 'public'), webDir = path.join(here, '../web07/dist') }) {
  const host = new URL(origin).host;
  const build = readBuild(webDir);   // 不会 reject：读不到就当没构建
  function send(req, res, body, type, cache) {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': cache, 'Content-Security-Policy': PAGE_CSP,
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    res.end(req.method === 'HEAD' ? undefined : body);
  }
  return {
    /** 认得的请求处理掉并返回 true；其余返回 false，交给九安。 */
    async serve(req, res, url) {
      // /assets/ 整个归前门：原始路径在 /assets/ 下也算（/assets/../x、/assets/%2e%2e/x 规范化后不在 /assets/ 下，同样 404，不交给九安）
      const asset = url.pathname.startsWith('/assets/') || String(req.url).startsWith('/assets/');
      const read = req.method === 'GET' || req.method === 'HEAD';
      const ours = asset || url.pathname === LOGIN_API || Object.hasOwn(PAGES, url.pathname);
      if (!ours && !(read && url.pathname === '/')) return false;
      try {
        if (req.headers.host !== host) fail('ORIGIN_INVALID', 403);
        if (asset) {
          // 只认清单里的文件名本身（不解码、不拼子目录），清单在创建前门时就定了
          const name = url.pathname.startsWith('/assets/') ? url.pathname.slice('/assets/'.length) : '';
          const type = read ? (await build).assets.get(name) : undefined;
          if (!type) fail('NOT_FOUND', 404);
          let body;
          try { body = await readFile(path.join(webDir, 'assets', name)); } catch { fail('NOT_FOUND', 404); }
          send(req, res, body, type, ASSET_CACHE);
          return true;
        }
        if (url.pathname === '/') {
          const { index } = await build;
          if (!index) fail('WEB_NOT_BUILT', 503);
          send(req, res, index, 'text/html; charset=utf-8', 'no-store');
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
        const [file, type] = PAGES[url.pathname];
        send(req, res, await readFile(path.join(publicDir, file)), type, 'no-store');
      } catch (error) {
        sendError(res, error);
      }
      return true;
    },
  };
}
