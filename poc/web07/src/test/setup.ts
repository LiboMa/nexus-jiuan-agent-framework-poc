import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { queryClient } from '../api/queryClient';
import { setCsrfToken, setUnauthorizedHandler } from '../api/client';
import { unmountAll } from './startApp';
import { setLoginNotice } from '../api/session';

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
