/**
 * 同源接口客户端。只走 /api/analysis/v1/...（九安）和 /api/analysis/v1/poc/...（测试台外壳）。
 * - credentials: 'same-origin'；会话 Cookie 是 HttpOnly、Path=/api/analysis/v1，前端看不到它。
 * - 非 GET 自动带 X-CSRF-Token（取自 GET /session 的 data.csrfToken）和 Content-Type: application/json。
 * - 解 {data} / {error:{code,message}} 信封；错误照服务端的中文 message 原样给出。
 * - 401（登录接口本身除外）时调用 onUnauthorized()：由应用清会话缓存、回登录页。
 */
export const API_BASE = '/api/analysis/v1';

export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
export interface ApiInit {
  method?: Method;
  /** JSON 请求体；非 GET 没给就发 {}。 */
  body?: unknown;
  /** 原样发出的请求体（上传文件等）；Content-Type 由 headers 给，默认 application/octet-stream。 */
  raw?: BodyInit;
  headers?: Record<string, string>;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

// 服务端没有给出中文说明时，按状态码说清发生了什么、怎么办。
const FALLBACK: Record<number, string> = {
  400: '请求没有通过校验，请检查填写的内容后再提交。',
  401: '登录已过期，请重新登录。',
  403: '当前账号没有权限做这件事；需要的话请联系管理员开通。',
  404: '没有找到这项内容，可能已被删除或不在你的权限范围内。',
  409: '这项内容刚被别人或系统改过，请刷新后再操作。',
  413: '提交的内容太大，请缩小后再试。',
  429: '操作太频繁，请过一分钟再试。',
};
const fallbackMessage = (status: number) =>
  FALLBACK[status] ?? (status >= 500 ? `服务器出错了（HTTP ${status}），请刷新页面重试；一直这样请联系管理员。` : `请求没有成功（HTTP ${status}），请刷新页面重试。`);
const hasChinese = (text: unknown): text is string => typeof text === 'string' && /[一-龥]/.test(text);

// 这几个接口回 401 说的是「账号口令不对」「票据失效」，不是会话过期。
const SIGN_IN_PATHS = new Set([`${API_BASE}/poc/login`, `${API_BASE}/auth/exchange`, `${API_BASE}/auth/logout`]);

let csrfToken: string | null = null;
let unauthorizedHandler: ((error: ApiError) => void) | null = null;

export function setCsrfToken(token: string | null) { csrfToken = token || null; }
export function getCsrfToken() { return csrfToken; }
export function setUnauthorizedHandler(handler: ((error: ApiError) => void) | null) { unauthorizedHandler = handler; }

function resolvePath(path: string): string {
  const bad = () => new ApiError(0, 'BAD_PATH', '页面要读取的地址不对，请刷新页面重试。');
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('..') || path.includes('\\')) throw bad();
  if (path === API_BASE || path.startsWith(`${API_BASE}/`) || path.startsWith(`${API_BASE}?`)) return path;
  if (path.startsWith('/api/')) throw bad();
  return `${API_BASE}${path}`;
}

export async function api<T = unknown>(path: string, init: ApiInit = {}): Promise<T> {
  const url = resolvePath(path);
  const method = init.method ?? 'GET';
  const headers = new Headers({ Accept: 'application/json' });
  let body: BodyInit | undefined;
  if (method !== 'GET') {
    if (init.raw !== undefined) {
      headers.set('Content-Type', 'application/octet-stream');
      body = init.raw;
    } else {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(init.body ?? {});
    }
    if (csrfToken) headers.set('X-CSRF-Token', csrfToken);
  }
  for (const [name, value] of Object.entries(init.headers ?? {})) headers.set(name, value);

  let response: Response;
  try {
    response = await fetch(url, { method, headers, body, credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer' });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', '连不上服务器，请检查网络后刷新页面重试。');
  }

  let payload: unknown;
  try { payload = await response.json(); } catch { payload = undefined; }
  const envelope = (payload && typeof payload === 'object' ? payload : {}) as { data?: unknown; error?: { code?: unknown; message?: unknown } };

  if (!response.ok) {
    const error = envelope.error && typeof envelope.error === 'object'
      ? new ApiError(response.status, typeof envelope.error.code === 'string' ? envelope.error.code : `HTTP_${response.status}`,
        hasChinese(envelope.error.message) ? envelope.error.message : fallbackMessage(response.status))
      : new ApiError(response.status, 'BAD_RESPONSE', `服务器返回了看不懂的内容（HTTP ${response.status}），请刷新页面重试；一直这样请联系管理员。`);
    if (response.status === 401 && !SIGN_IN_PATHS.has(url.split('?')[0])) unauthorizedHandler?.(error);
    throw error;
  }
  if (!('data' in envelope)) throw new ApiError(response.status, 'BAD_RESPONSE', '服务器返回了看不懂的内容，请刷新页面重试；一直这样请联系管理员。');
  return envelope.data as T;
}
