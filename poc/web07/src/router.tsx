/**
 * 哈希路由（不需要服务端回退路由）：
 *   #/            工作台        #/documents   单据池（?doc=<id> 打开抽屉）  #/knowledge  知识库
 *   #/my-rules    我的规则      #/agents      Agent 接入                   #/settings   设置
 *   #/login       登录
 * 每一页都过 Guard（角色进不去就显示「没有权限」）。登录页和外壳在主文件里；各页按路由分开打包（Ruling T6a，React.lazy），
 * 第一次进那一页时才下载，等的时候只有读屏听得到的一句「正在打开」。
 */
import { lazy, type ReactNode } from 'react';
import { Navigate, createHashRouter, type RouteObject } from 'react-router';
import { Guard } from './shell/Guard';
import { LazyPage } from './shell/LazyPage';
import { SessionGate } from './shell/SessionGate';
import { Login } from './pages/Login';
import type { PageKey } from './shell/nav';

const Placeholder = lazy(() => import('./pages/Placeholder').then(module => ({ default: module.Placeholder })));
const Documents = lazy(() => import('./pages/Documents').then(module => ({ default: module.Documents })));
const Knowledge = lazy(() => import('./pages/Knowledge').then(module => ({ default: module.Knowledge })));
const MyRules = lazy(() => import('./pages/MyRules').then(module => ({ default: module.MyRules })));
const Settings = lazy(() => import('./pages/Settings').then(module => ({ default: module.Settings })));

// key：换页时整页（含「没有打开」的状态）换掉，不带到下一页
const page = (key: PageKey, element: ReactNode) => <Guard key={key} page={key}><LazyPage>{element}</LazyPage></Guard>;

export const routes: RouteObject[] = [
  { path: '/login', element: <Login /> },
  {
    path: '/',
    element: <SessionGate />,
    children: [
      { index: true, element: page('dashboard', <Placeholder page="dashboard" />) },
      { path: 'documents', element: page('documents', <Documents />) },
      { path: 'knowledge', element: page('knowledge', <Knowledge />) },
      { path: 'my-rules', element: page('myRules', <MyRules />) },
      { path: 'agents', element: page('agents', <Placeholder page="agents" />) },
      { path: 'settings', element: page('settings', <Settings />) },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
];

export function createAppRouter() {
  return createHashRouter(routes);
}
