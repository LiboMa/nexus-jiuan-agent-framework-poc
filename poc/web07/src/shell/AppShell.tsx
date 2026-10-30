/**
 * 外壳（样稿 A 版）：左侧侧栏 220 px（可收起到 72 px，只留图标）——Logo 区、分组导航、底部账号区；右侧内容区。
 * 选中导航：浅蓝底 + 2 px 主蓝左边线 + 主蓝字。侧栏宽度不做动画（动效只给抽屉、弹框）。
 */
import { useState, type AnchorHTMLAttributes, type ReactNode, type Ref } from 'react';
import { NavLink, useNavigate } from 'react-router';
import { Icon } from '../ui/icons';
import { Logo } from '../ui/Logo';
import { Tooltip } from '../ui/Tooltip';
import { cx } from '../ui/cx';
import { ROLE_LABELS, logout, type Session } from '../api/session';
import { visibleNav, type NavItem } from './nav';

export const SIDEBAR_WIDTH = 220;
export const SIDEBAR_COLLAPSED_WIDTH = 72;
const COLLAPSED_KEY = 'web07.sidebarCollapsed';

function readCollapsed() {
  try { return window.localStorage.getItem(COLLAPSED_KEY) === '1'; } catch { return false; }
}
function saveCollapsed(collapsed: boolean) {
  try { window.localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0'); } catch { /* 隐私模式下不记 */ }
}

export function AppShell({ session, children }: { session: Session; children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = () => setCollapsed(current => { saveCollapsed(!current); return !current; });
  return (
    <div className="flex h-screen min-h-0 bg-canvas">
      <Sidebar session={session} collapsed={collapsed} onToggle={toggle} />
      <main className="min-w-0 flex-1 overflow-auto px-[26px] py-[22px]">{children}</main>
    </div>
  );
}

function Sidebar({ session, collapsed, onToggle }: { session: Session; collapsed: boolean; onToggle: () => void }) {
  const groups = visibleNav(session.user.role);
  return (
    <aside
      aria-label="侧栏"
      data-collapsed={collapsed ? 'true' : 'false'}
      style={{ width: collapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_WIDTH }}
      className="flex shrink-0 flex-col border-r border-line bg-surface"
    >
      <div className={cx('pb-[14px] pt-4', collapsed ? 'flex justify-center' : 'px-4')}>
        <Logo wordmark={!collapsed} />
      </div>
      <nav aria-label="主导航" className="flex min-h-0 flex-1 flex-col gap-[2px] overflow-y-auto px-[10px] py-1">
        {groups.map((group, index) => (
          <div key={group.label ?? `group-${index}`} className="flex flex-col gap-[2px]">
            {group.label && (collapsed
              ? <div className="mx-2 my-[10px] h-px bg-line" aria-hidden="true" />
              : <div className="flex items-center gap-2 px-2 pb-[6px] pt-3 text-12 text-faint after:h-px after:flex-1 after:bg-line">{group.label}</div>)}
            {group.items.map(item => (collapsed
              ? <Tooltip key={item.key} content={item.label} side="right"><SideLink item={item} collapsed /></Tooltip>
              : <SideLink key={item.key} item={item} collapsed={false} />))}
          </div>
        ))}
      </nav>
      <button
        type="button"
        onClick={onToggle}
        aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
        aria-expanded={!collapsed}
        className={cx('mx-[10px] mb-2 flex items-center gap-2 py-[6px] text-12 text-steel hover:bg-canvas hover:text-ink', collapsed ? 'justify-center' : 'px-[10px]')}
      >
        <Icon name={collapsed ? 'chevronRight' : 'chevronLeft'} size={16} />
        {!collapsed && <span>收起</span>}
      </button>
      <Account session={session} collapsed={collapsed} />
    </aside>
  );
}

/**
 * 一个导航入口。收起时外面包着 Tooltip（Radix 的 Slot 会把它的事件、data-state、ref 合并进来），
 * 所以这里把多余的属性原样交给 NavLink，className 自己算——Slot 只会把字符串 className 拼起来，函数会被拼坏。
 */
function SideLink({ item, collapsed, ref, ...rest }: { item: NavItem; collapsed: boolean; ref?: Ref<HTMLAnchorElement> } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'className' | 'href'>) {
  return (
    <NavLink
      {...rest}
      ref={ref}
      to={item.path}
      end={item.path === '/'}
      aria-label={collapsed ? item.label : undefined}
      className={({ isActive }) => cx(
        'flex items-center gap-[10px] border-l-2 py-2 text-13',
        collapsed ? 'justify-center px-0' : 'px-[10px]',
        isActive ? 'border-blue bg-blue-50 font-semibold text-blue' : 'border-transparent text-nav hover:bg-canvas hover:text-ink',
      )}
    >
      <Icon name={item.icon} />
      {!collapsed && <span className="truncate">{item.label}</span>}
    </NavLink>
  );
}

function Account({ session, collapsed }: { session: Session; collapsed: boolean }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const { name, role } = session.user;
  const roleLabel = ROLE_LABELS[role] ?? '已登录';
  async function signOut() {
    setBusy(true);
    try { await logout(); } catch { /* 本地已经忘掉会话；服务端的会话 8 小时后自己过期 */ }
    navigate('/login', { replace: true });
  }
  const logoutButton = (
    <button
      type="button" onClick={signOut} disabled={busy} aria-label="退出登录"
      className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-ctl text-steel hover:bg-canvas hover:text-ink disabled:opacity-55"
    >
      <Icon name="logout" size={16} />
    </button>
  );
  return (
    <div className={cx('flex items-center gap-[10px] border-t border-line py-3', collapsed ? 'flex-col px-0' : 'px-4')}>
      <span className="grid h-[26px] w-[26px] shrink-0 place-items-center bg-blue-100 text-12 font-title text-blue" aria-hidden="true">
        {Array.from(name || '人')[0]}
      </span>
      {collapsed
        ? <span className="sr-only">{name} · {roleLabel}</span>
        : (
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold">{name}</div>
            <div className="truncate text-12 text-steel">{roleLabel}</div>
          </div>
        )}
      <Tooltip content="退出登录" side={collapsed ? 'right' : 'top'}>{logoutButton}</Tooltip>
    </div>
  );
}
