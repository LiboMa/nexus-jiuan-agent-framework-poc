/**
 * 哈希路由（不需要服务端回退路由）：
 *   #/            工作台        #/documents   单据池（?doc=<id> 打开抽屉）  #/knowledge  知识库
 *   #/my-rules    我的规则      #/agents      Agent 接入                   #/settings   设置
 *   #/login       登录
 * 页面先挂占位，后面的任务逐个换成真的（单据池已换）；每一页都过 Guard（角色进不去就显示「没有权限」）。
 */
import { Navigate, createHashRouter, type RouteObject } from 'react-router';
import { Guard } from './shell/Guard';
import { SessionGate } from './shell/SessionGate';
import { Documents } from './pages/Documents';
import { Login } from './pages/Login';
import { Placeholder } from './pages/Placeholder';
import { Settings } from './pages/Settings';

export const routes: RouteObject[] = [
  { path: '/login', element: <Login /> },
  {
    path: '/',
    element: <SessionGate />,
    children: [
      { index: true, element: <Guard page="dashboard"><Placeholder page="dashboard" /></Guard> },
      { path: 'documents', element: <Guard page="documents"><Documents /></Guard> },
      { path: 'knowledge', element: <Guard page="knowledge"><Placeholder page="knowledge" /></Guard> },
      { path: 'my-rules', element: <Guard page="myRules"><Placeholder page="myRules" /></Guard> },
      { path: 'agents', element: <Guard page="agents"><Placeholder page="agents" /></Guard> },
      { path: 'settings', element: <Guard page="settings"><Settings /></Guard> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
];

export function createAppRouter() {
  return createHashRouter(routes);
}
