import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup, configure } from '@testing-library/react';
import { queryClient } from '../api/queryClient';
import { setCsrfToken, setUnauthorizedHandler } from '../api/client';
import { unmountAll } from './startApp';
import { setLoginNotice } from '../api/session';

// 每个文件的第一项要先懒加载页面：deploy.sh 里 npm ci 之后缓存是冷的，机器又忙，第一次编译常常超过默认的 1 秒（2026-11-02 部署时五个文件的第一项都卡在这里）。
configure({ asyncUtilTimeout: 3000 });

afterEach(() => {
  cleanup();
  unmountAll();
  queryClient.clear();
  setCsrfToken(null);
  setUnauthorizedHandler(null);
  setLoginNotice(null);
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
});
