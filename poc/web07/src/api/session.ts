/**
 * 会话：GET /session（401 = 没登录）；口令登录 POST /poc/login → 票据 → POST /auth/exchange → 会话 Cookie；
 * 旧登录页跳过来的 #access=<票据> 也照样换；退出 POST /auth/logout。
 */
import { useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError, api, setCsrfToken } from './client';
import { queryClient } from './queryClient';

export type Role = 'admin' | 'analyst' | 'policy_reviewer';
export interface SessionUser {
  id: string;
  name: string;
  role: Role;
  companyIds?: string[];
  mode?: string;
  principalId?: string;
}
export interface Session {
  user: SessionUser;
  csrfToken: string;
  capabilities: Record<string, unknown>;
  companies?: Array<{ id: string; name: string }>;
  tenantId?: string;
  version?: string;
  instance?: string;
}

export const SESSION_KEY = ['session'] as const;
export const ROLE_LABELS: Record<Role, string> = { admin: '管理员', analyst: '分析员', policy_reviewer: '规则复核人' };

// 本标签页里登录过的标记（不是凭据）：刷新页面后再遇到 401，也能说「登录已过期」而不是当成第一次来。
const SIGNED_IN_FLAG = 'web07.signedIn';
const markSignedIn = (on: boolean) => {
  try { if (on) window.sessionStorage.setItem(SIGNED_IN_FLAG, '1'); else window.sessionStorage.removeItem(SIGNED_IN_FLAG); } catch { /* 隐私模式下没有 sessionStorage */ }
};
const wasSignedIn = () => { try { return window.sessionStorage.getItem(SIGNED_IN_FLAG) === '1'; } catch { return false; } };

/** 读当前会话；没登录（401）回 null。其他错误照常抛出（由界面说明并给「重新读取」）。 */
export async function fetchSession(): Promise<Session | null> {
  try {
    const session = await api<Session>('/session');
    if (!session?.user || typeof session.csrfToken !== 'string') throw new ApiError(200, 'BAD_RESPONSE', '服务器返回的登录信息不完整，请刷新页面重试。');
    setCsrfToken(session.csrfToken);
    markSignedIn(true);
    return { ...session, capabilities: session.capabilities ?? {} };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export function useSessionQuery() {
  return useQuery({ queryKey: SESSION_KEY, queryFn: fetchSession, retry: false, staleTime: Infinity });
}

/** 当前会话；还没读到或没登录都是 null。 */
export function useSession(): Session | null {
  return useSessionQuery().data ?? null;
}

/** 把会话相关的一切忘掉：CSRF 令牌、会话缓存、其他页面的数据缓存（下一个登录的人不该看到）。返回之前是否登录着。 */
export function forgetSession(): boolean {
  const had = queryClient.getQueryData(SESSION_KEY) != null || wasSignedIn();
  setCsrfToken(null);
  markSignedIn(false);
  queryClient.removeQueries({ predicate: query => query.queryKey[0] !== SESSION_KEY[0] });
  queryClient.setQueryData(SESSION_KEY, null);
  return had;
}

export const EXPIRED_NOTICE = '登录已过期，请重新登录';

// 登录页顶上的提示（会话过期、旧入口的票据失效……）。放在路由之外，谁先跳到登录页都不会丢。
let loginNotice: string | null = null;
const noticeListeners = new Set<() => void>();
export function setLoginNotice(text: string | null) {
  loginNotice = text;
  for (const listener of noticeListeners) listener();
}
export function useLoginNotice(): string | null {
  return useSyncExternalStore(listener => { noticeListeners.add(listener); return () => { noticeListeners.delete(listener); }; }, () => loginNotice);
}

/**
 * 任何接口回 401 时调用（由应用通过 setUnauthorizedHandler 挂上）：清会话缓存；之前登录着就提示「登录已过期」。
 * 会话变成 null 后，外壳自己回登录页并记住原来的位置。
 */
export function handleUnauthorized() {
  // 已经有更具体的说明（例如旧入口的票据失效）就留着它。
  if (forgetSession() && !loginNotice) setLoginNotice(EXPIRED_NOTICE);
}

async function refreshSession(): Promise<Session | null> {
  return queryClient.fetchQuery({ queryKey: SESSION_KEY, queryFn: fetchSession, staleTime: 0 });
}

/** 用票据换会话（九安设 HttpOnly 的会话 Cookie），再重新读会话、拿新的 CSRF 令牌。 */
export async function exchangeTicket(ticket: string): Promise<Session | null> {
  await api('/auth/exchange', { method: 'POST', body: { ticket } });
  return refreshSession();
}

/** 口令登录：POST /poc/login 拿一次性票据，再换成会话。 */
export async function login(account: string, password: string): Promise<Session | null> {
  forgetSession();
  const { ticket } = await api<{ ticket: string }>('/poc/login', { method: 'POST', body: { account, password } });
  if (typeof ticket !== 'string' || !ticket) throw new ApiError(200, 'BAD_RESPONSE', '登录服务没有给出票据，请刷新页面重试。');
  const session = await exchangeTicket(ticket);
  if (!session) throw new ApiError(401, 'SESSION_MISSING', '登录没有生效，请确认浏览器允许本站的 Cookie 后重试。');
  setLoginNotice(null);
  return session;
}

/** 退出：通知九安注销会话；不管成没成功，本地都忘掉。 */
export async function logout(): Promise<void> {
  try { await api('/auth/logout', { method: 'POST' }); } finally { forgetSession(); }
}

const ACCESS_PREFIX = '#access=';
/**
 * 启动时取走旧登录页带来的 #access=<票据>：立刻从地址栏抹掉（不进历史、不留在地址里），返回票据。
 * 没有就回 null。
 */
export function consumeAccessTicket(): string | null {
  const { hash, pathname, search } = window.location;
  if (!hash.startsWith(ACCESS_PREFIX)) return null;
  const ticket = new URLSearchParams(hash.slice(1)).get('access');
  window.history.replaceState(null, '', `${pathname}${search}#/`);
  return ticket || null;
}

// 同一张票据只换一次（React 严格模式下副作用会跑两遍；票据是一次性的）。
const exchanges = new Map<string, Promise<Session | null>>();
export function exchangeTicketOnce(ticket: string): Promise<Session | null> {
  let pending = exchanges.get(ticket);
  if (!pending) {
    pending = exchangeTicket(ticket);
    exchanges.set(ticket, pending);
  }
  return pending;
}
