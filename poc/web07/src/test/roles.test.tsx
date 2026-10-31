import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { canSee, type RouteKey } from '../shell/nav';
import type { Role } from '../api/session';
import { fakeApi, sessionBody } from './fakeApi';
import { startApp } from './startApp';

const ROUTES: RouteKey[] = ['dashboard', 'documents', 'knowledge', 'myRules', 'agents', 'settings', 'login'];
const EXPECTED: Record<Role, RouteKey[]> = {
  admin: ['dashboard', 'documents', 'knowledge', 'myRules', 'agents', 'settings', 'login'],
  analyst: ['dashboard', 'documents', 'myRules', 'login'],
  policy_reviewer: ['dashboard', 'documents', 'login'],
};

describe('canSee(route, role)', () => {
  for (const role of Object.keys(EXPECTED) as Role[]) {
    it(`${role} sees exactly ${EXPECTED[role].join(', ')}`, () => {
      expect(ROUTES.filter(route => canSee(route, role))).toEqual(EXPECTED[role]);
    });
  }

  it('takes the hash path as well as the route key', () => {
    expect(canSee('/', 'policy_reviewer')).toBe(true);
    expect(canSee('/documents', 'policy_reviewer')).toBe(true);
    expect(canSee('/my-rules', 'analyst')).toBe(true);
    expect(canSee('/knowledge', 'analyst')).toBe(false);
    expect(canSee('/agents', 'analyst')).toBe(false);
    expect(canSee('/settings', 'admin')).toBe(true);
  });

  it('an unknown role or route sees nothing but the sign-in page', () => {
    expect(canSee('dashboard', 'owner')).toBe(false);
    expect(canSee('dashboard', undefined)).toBe(false);
    expect(canSee('login', undefined)).toBe(true);
    expect(canSee('/nowhere', 'admin')).toBe(false);
  });
});

async function openAs(role: Role, hash: string) {
  const server = fakeApi({ 'GET /api/analysis/v1/session': { body: sessionBody(role) } });
  const app = await startApp(hash);
  await screen.findByRole('navigation', { name: '主导航' });
  return { ...app, calls: server.calls };
}
const navLabels = () => within(screen.getByRole('navigation', { name: '主导航' })).getAllByRole('link').map(link => link.getAttribute('aria-label') || link.textContent);

describe('role guards in the shell (Review Focus 5)', () => {
  it('an analyst who types #/agents sees 「没有权限」, not the page', async () => {
    await openAs('analyst', '#/agents');
    expect(await screen.findByRole('heading', { name: '没有权限' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: 'Agent 接入' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '回到工作台' })).toHaveAttribute('href', '#/');
  });

  it('an analyst who types #/settings sees 「没有权限」 too', async () => {
    await openAs('analyst', '#/settings');
    expect(await screen.findByRole('heading', { name: '没有权限' })).toBeInTheDocument();
  });

  it('an analyst who types #/knowledge sees 「没有权限」: the knowledge base is admin-only for now', async () => {
    const server = await openAs('analyst', '#/knowledge');
    expect(await screen.findByRole('heading', { name: '没有权限' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: '知识库' })).not.toBeInTheDocument();
    expect(server.calls.filter(call => call.path.startsWith('/api/analysis/v1/poc/kb/'))).toEqual([]);
  });

  it('an analyst has no 知识库 and no 平台 group (no Agent 接入, no 设置), and keeps 我的规则', async () => {
    await openAs('analyst', '#/');
    expect(navLabels()).toEqual(['工作台', '单据池', '我的规则']);
    expect(screen.queryByText('平台')).not.toBeInTheDocument();
  });

  it('policy_reviewer has only 工作台 and 单据池; #/knowledge is 没有权限', async () => {
    await openAs('policy_reviewer', '#/knowledge');
    expect(navLabels()).toEqual(['工作台', '单据池']);
    expect(await screen.findByRole('heading', { name: '没有权限' })).toBeInTheDocument();
  });

  it('an admin has all six entries, grouped 审核 and 平台', async () => {
    await openAs('admin', '#/agents');
    expect(navLabels()).toEqual(['工作台', '单据池', '知识库', '我的规则', 'Agent 接入', '设置']);
    expect(screen.getByText('审核')).toBeInTheDocument();
    expect(screen.getByText('平台')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 1, name: 'Agent 接入' })).toBeInTheDocument();
  });
});
