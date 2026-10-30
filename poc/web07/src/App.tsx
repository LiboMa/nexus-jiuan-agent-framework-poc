import { StrictMode, useEffect, useLayoutEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router';
import { ApiError, setUnauthorizedHandler } from './api/client';
import { queryClient } from './api/queryClient';
import { consumeAccessTicket, exchangeTicketOnce, handleUnauthorized, setLoginNotice } from './api/session';
import { createAppRouter } from './router';
import { Splash } from './shell/Splash';
import { TooltipProvider } from './ui/Tooltip';

/**
 * 整个前端。accessTicket 是旧登录页跳过来时地址里的 #access=<票据>（mountApp 启动时已从地址栏抹掉）：
 * 先换成会话再挂路由，免得先读会话读到 401。
 */
export function App({ accessTicket = null }: { accessTicket?: string | null }) {
  const [router] = useState(createAppRouter);
  const [ready, setReady] = useState(!accessTicket);

  useLayoutEffect(() => {
    setUnauthorizedHandler(handleUnauthorized);
    return () => setUnauthorizedHandler(null);
  }, []);

  useEffect(() => {
    if (!accessTicket) return;
    let live = true;
    exchangeTicketOnce(accessTicket)
      .then(session => { if (!session) setLoginNotice('登录没有生效，请确认浏览器允许本站的 Cookie 后重新登录。'); })
      .catch(error => setLoginNotice(error instanceof ApiError ? error.message : '登录入口没有生效，请重新登录。'))
      .finally(() => { if (live) setReady(true); });
    return () => { live = false; };
  }, [accessTicket]);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        {ready ? <RouterProvider router={router} /> : <Splash>正在登录…</Splash>}
      </TooltipProvider>
    </QueryClientProvider>
  );
}

/** 启动：先取走地址里的 #access=<票据>（如有），再渲染。 */
export function mountApp(container: HTMLElement): Root {
  const accessTicket = consumeAccessTicket();
  const root = createRoot(container);
  root.render(<StrictMode><App accessTicket={accessTicket} /></StrictMode>);
  return root;
}
