// 测试里按真实的启动路径打开整个前端：先把地址栏放到给定的哈希，再走 mountApp()。
import { act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Root } from 'react-dom/client';
import { mountApp } from '../App';
import { go } from './fakeApi';

export const mountedRoots: Root[] = [];

export async function startApp(hash = '#/') {
  go(hash);
  const container = document.body.appendChild(document.createElement('div'));
  let root!: Root;
  await act(async () => { root = mountApp(container); });
  mountedRoots.push(root);
  return { container, root, user: userEvent.setup() };
}

export function unmountAll() {
  for (const root of mountedRoots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = '';
}
