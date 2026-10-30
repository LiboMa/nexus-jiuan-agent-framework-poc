import { Navigate, Outlet, useLocation } from 'react-router';
import { ApiError } from '../api/client';
import { useSessionQuery } from '../api/session';
import { Button } from '../ui/Button';
import { AppShell } from './AppShell';
import { Splash } from './Splash';

/** 登录后的所有页面都挂在这里：先读会话；没登录回登录页（记住原来的位置）；读不到就说明原因并给「重新读取」。 */
export function SessionGate() {
  const query = useSessionQuery();
  const location = useLocation();
  if (query.isPending) return <Splash>正在确认登录状态…</Splash>;
  if (query.isError && !query.data) {
    const message = query.error instanceof ApiError ? query.error.message : '读取登录状态没有成功，请刷新页面重试。';
    return (
      <Splash action={<Button variant="primary" icon="refresh" busy={query.isFetching} onClick={() => query.refetch()}>重新读取</Button>}>
        <p role="alert" className="m-0 text-14 text-ink">{message}</p>
      </Splash>
    );
  }
  if (!query.data) return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
  return <AppShell session={query.data}><Outlet /></AppShell>;
}
