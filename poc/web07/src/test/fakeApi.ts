// 测试用的假后端：把 fetch 换成按「方法 路径」查表的假实现，记下每一次请求。
import { vi } from 'vitest';
import type { Role } from '../api/session';

export interface FakeCall {
  method: string;
  path: string;
  search: string;
  headers: Headers;
  body: unknown;
  init: RequestInit;
  href: string;
}
export interface FakeReply { status?: number; body?: unknown; text?: string }
export type FakeRoute = FakeReply | ((call: FakeCall) => FakeReply | Promise<FakeReply>);

export function fakeApi(routes: Record<string, FakeRoute> = {}) {
  const calls: FakeCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), window.location.href);
    const method = (init.method || 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    let body: unknown = init.body;
    if (typeof body === 'string' && (headers.get('Content-Type') || '').startsWith('application/json')) body = JSON.parse(body);
    const call: FakeCall = { method, path: url.pathname, search: url.search, headers, body, init, href: window.location.href };
    calls.push(call);
    const route = routes[`${method} ${url.pathname}`];
    if (!route) return reply({ status: 404, body: { error: { code: 'NOT_FOUND', message: '未找到可访问的记录。' } } });
    return reply(typeof route === 'function' ? await route(call) : route);
  });
  vi.stubGlobal('fetch', fetchMock);
  const find = (method: string, path: string) => calls.filter(c => c.method === method && c.path === path);
  return { calls, routes, fetchMock, find };
}

function reply({ status = 200, body, text }: FakeReply): Response {
  if (text !== undefined) return new Response(text, { status, headers: { 'Content-Type': 'text/html' } });
  return new Response(JSON.stringify(body ?? { data: null }), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

export const NAMES: Record<Role, string> = { admin: '审核员', analyst: '复核人', policy_reviewer: '规则复核' };

export function sessionBody(role: Role = 'admin', csrfToken = 'csrf-1') {
  return {
    data: {
      tenantId: 'jiuan07', version: '0.7.10', instance: 'test',
      user: { id: `u-${role}`, name: NAMES[role], role, companyIds: role === 'policy_reviewer' ? [] : ['c-1'], mode: 'local' },
      csrfToken,
      companies: [{ id: 'c-1', name: '九安' }],
      capabilities: { platformView: true, platformAdmin: role === 'admin', agentAccess: role === 'admin' },
    },
  };
}

export const unauthorized = { status: 401, body: { error: { code: 'AUTH_REQUIRED', message: '请通过本机入口或已绑定的钉钉身份登录。' } } };

/** 把地址栏放到给定的哈希上（测试之间互不影响）。 */
export function go(hash: string) {
  window.history.replaceState(null, '', `/${hash}`);
}
