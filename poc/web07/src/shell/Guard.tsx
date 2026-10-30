import type { ReactNode } from 'react';
import { useSession } from '../api/session';
import { NoAccess } from '../pages/NoAccess';
import { canSee, type PageKey } from './nav';

/** 角色进不去的页面（例如分析员手动改地址进 #/agents）显示「没有权限」，不渲染页面本身。 */
export function Guard({ page, children }: { page: PageKey; children: ReactNode }) {
  const session = useSession();
  return canSee(page, session?.user.role) ? <>{children}</> : <NoAccess />;
}
