/**
 * 导航与角色（Spec 第 2、6 节）：工作台；分组「审核」：单据池、知识库、我的规则；分组「平台」：Agent 接入、设置。
 * 管理员看到全部；分析员没有「知识库」「Agent 接入」「设置」（知识库暂时只给管理员：项目负责人 2026-10-31 定的，外壳的 /poc/kb/* 也只认管理员）；
 * policy_reviewer 只有工作台和单据池（只读）。
 * 这里只管「看不看得到入口、进不进得去页面」；接口那头九安和外壳照样按角色拒绝。
 */
import type { IconName } from '../ui/icons';
import type { Role } from '../api/session';

export type PageKey = 'dashboard' | 'documents' | 'knowledge' | 'myRules' | 'agents' | 'settings';
export type RouteKey = PageKey | 'login';

export interface NavItem { key: PageKey; path: string; label: string; icon: IconName }

export const NAV_ITEMS: Record<PageKey, NavItem> = {
  dashboard: { key: 'dashboard', path: '/', label: '工作台', icon: 'dashboard' },
  documents: { key: 'documents', path: '/documents', label: '单据池', icon: 'documents' },
  knowledge: { key: 'knowledge', path: '/knowledge', label: '知识库', icon: 'knowledge' },
  myRules: { key: 'myRules', path: '/my-rules', label: '我的规则', icon: 'myRules' },
  agents: { key: 'agents', path: '/agents', label: 'Agent 接入', icon: 'agent' },
  settings: { key: 'settings', path: '/settings', label: '设置', icon: 'settings' },
};
export const LOGIN_PATH = '/login';

export const NAV_GROUPS: Array<{ label: string | null; items: PageKey[] }> = [
  { label: null, items: ['dashboard'] },
  { label: '审核', items: ['documents', 'knowledge', 'myRules'] },
  { label: '平台', items: ['agents', 'settings'] },
];

const ACCESS: Record<Role, ReadonlySet<PageKey>> = {
  admin: new Set<PageKey>(['dashboard', 'documents', 'knowledge', 'myRules', 'agents', 'settings']),
  analyst: new Set<PageKey>(['dashboard', 'documents', 'myRules']),
  policy_reviewer: new Set<PageKey>(['dashboard', 'documents']),
};

/** 路由键或哈希路径（'/documents'）→ 路由键；认不出回 null。 */
export function routeKeyOf(route: string): RouteKey | null {
  if (route === 'login' || route === LOGIN_PATH) return 'login';
  if (Object.hasOwn(NAV_ITEMS, route)) return route as PageKey;
  const path = route.split('?')[0].replace(/\/+$/, '') || '/';
  const item = Object.values(NAV_ITEMS).find(entry => entry.path === path);
  return item ? item.key : null;
}

/** 这个角色能不能进这一页。登录页谁都能进；认不出的角色或页面一律不能。 */
export function canSee(route: RouteKey | string, role: Role | string | null | undefined): boolean {
  const key = routeKeyOf(route);
  if (key === 'login') return true;
  if (!key || !role || !Object.hasOwn(ACCESS, role)) return false;
  return ACCESS[role as Role].has(key);
}

/** 侧栏要画的分组：只列这个角色进得去的入口，空组不画。 */
export function visibleNav(role: Role | string | null | undefined) {
  return NAV_GROUPS
    .map(group => ({ label: group.label, items: group.items.filter(key => canSee(key, role)).map(key => NAV_ITEMS[key]) }))
    .filter(group => group.items.length > 0);
}
