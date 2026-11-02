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
  /** 九安按来源分的授权范围：汇联易的公司在 huilianyi.companyIds（有它就按它，没有按 companyIds）。 */
  providerScopes?: { huilianyi?: { companyIds?: string[] } };
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

/**
 * 这个账号在九安里一家公司也没有（照九安的 analysisHuilianyiCompanyIds：有 providerScopes.huilianyi 按它，没有按 companyIds）：
 * 单据池、工作台都是空的。九安不许规则发布复核人有公司（Ruling FR1）。会话里没写范围时不下结论（回 false）。
 */
export function hasNoCompanies(user: SessionUser | null | undefined): boolean {
  const ids = user?.providerScopes?.huilianyi ? user.providerScopes.huilianyi.companyIds : user?.companyIds;
  return Array.isArray(ids) && ids.length === 0;
}
export const ROLE_LABELS: Record<Role, string> = { admin: '管理员', analyst: '分析员', policy_reviewer: '规则发布复核人' };

// 本标签页里登录过的标记（不是凭据）：刷新页面后再遇到 401，也能说「登录已过期」而不是当成第一次来。
const SIGNED_IN_FLAG = 'web.signedIn';
const markSignedIn = (on: boolean) => {
  try { if (on) window.sessionStorage.setItem(SIGNED_IN_FLAG, '1'); else window.sessionStorage.removeItem(SIGNED_IN_FLAG); } catch { /* 隐私模式下没有 sessionStorage */ }
};
const wasSignedIn = () => { try { return window.sessionStorage.getItem(SIGNED_IN_FLAG) === '1'; } catch { return false; } };

/**
 * 读当前会话；没登录（401）回 null。其他错误照常抛出（由界面说明并给「重新读取」）。
 * 读到了就把登录页的提示清掉（例如旧入口的票据失效了、Cookie 却还有效：人已经在里面了，那句话不该留到下一次登录页，T1 M2）。
 */
export async function fetchSession(): Promise<Session | null> {
  try {
    const session = await api<Session>('/session');
    if (!session?.user || typeof session.csrfToken !== 'string') throw new ApiError(200, 'BAD_RESPONSE', '服务器返回的登录信息不完整，请刷新页面重试。');
    setCsrfToken(session.csrfToken);
    markSignedIn(true);
    setLoginNotice(null);
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

/** 任何接口回 403 CSRF_INVALID 时调用（由应用通过 setCsrfInvalidHandler 挂上）：重新读会话，拿新的令牌；会话没了就回登录页。 */
export function handleCsrfInvalid() {
  void queryClient.invalidateQueries({ queryKey: SESSION_KEY });
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

export const LOGOUT_OFFLINE_NOTICE = '退出没有完成：网络断了，服务器上的登录可能还在。请联网后刷新页面，再点一次退出。';
export const LOGOUT_UNCONFIRMED_NOTICE = '退出没有完成：服务器没有确认，服务器上的登录可能还在。请刷新页面后再点一次退出。';

/**
 * 退出：通知九安注销会话；不管成没成功，本地都忘掉。没成功（网络断了、服务器没确认）时在登录页说清楚：
 * 服务器上的会话可能还有效（8 小时），联网后刷新页面会回到里面，再点一次退出（T1 M1）。401 说明服务器上已经没有这个会话了，不用说。
 */
export async function logout(): Promise<void> {
  let notice: string | null = null;
  try {
    await api('/auth/logout', { method: 'POST' });
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 0;
    if (status !== 401) notice = status === 0 ? LOGOUT_OFFLINE_NOTICE : LOGOUT_UNCONFIRMED_NOTICE;
    throw error;
  } finally {
    forgetSession();
    setLoginNotice(notice);
  }
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
