import { describe, expect, it } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import { api } from '../api/client';
import { fakeApi, sessionBody, unauthorized } from './fakeApi';
import { startApp } from './startApp';

const loginOk = { body: { data: { ticket: 'ticket-1' } } };
const exchangeOk = { body: { data: { authenticated: true } } };

describe('session and sign-in', () => {
  it('opens the shell straight away when the session cookie is still good', async () => {
    fakeApi({ 'GET /api/analysis/v1/session': { body: sessionBody('admin') } });
    await startApp('#/');
    expect(await screen.findByRole('heading', { level: 1, name: '工作台' })).toBeInTheDocument();
    expect(screen.getByText('审核员')).toBeInTheDocument();
  });

  it('a first visit without a session shows the sign-in page, without saying anything expired', async () => {
    fakeApi({ 'GET /api/analysis/v1/session': unauthorized });
    await startApp('#/documents');
    expect(await screen.findByRole('heading', { name: '登录九安审单' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/login');
    expect(screen.queryByText('登录已过期，请重新登录')).not.toBeInTheDocument();
  });

  it('signs in: poc/login gives a ticket, auth/exchange turns it into the session, then 工作台 opens', async () => {
    let signedIn = false;
    const server = fakeApi({
      'GET /api/analysis/v1/session': () => (signedIn ? { body: sessionBody('analyst') } : unauthorized),
      'POST /api/analysis/v1/poc/login': loginOk,
      'POST /api/analysis/v1/auth/exchange': () => { signedIn = true; return exchangeOk; },
    });
    const { user } = await startApp('#/');
    await screen.findByRole('heading', { name: '登录九安审单' });
    await user.selectOptions(screen.getByLabelText('账号'), 'poc-checker');
    await user.type(screen.getByLabelText('口令'), 'secret-pw');
    await user.click(screen.getByRole('button', { name: '登录' }));
    expect(await screen.findByRole('heading', { level: 1, name: '工作台' })).toBeInTheDocument();
    expect(server.find('POST', '/api/analysis/v1/poc/login')[0].body).toEqual({ account: 'poc-checker', password: 'secret-pw' });
    expect(server.find('POST', '/api/analysis/v1/auth/exchange')[0].body).toEqual({ ticket: 'ticket-1' });
    expect(window.location.hash).toBe('#/');
  });

  it('shows the server message as it is when the password is wrong, and lets the user try again', async () => {
    fakeApi({
      'GET /api/analysis/v1/session': unauthorized,
      'POST /api/analysis/v1/poc/login': { status: 401, body: { error: { code: 'INVALID_CREDENTIALS', message: '账号或口令不正确。' } } },
    });
    const { user } = await startApp('#/login');
    await user.type(await screen.findByLabelText('口令'), 'wrong');
    await user.click(screen.getByRole('button', { name: '登录' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('账号或口令不正确。');
    expect(screen.getByRole('button', { name: '登录' })).toBeEnabled();
    expect(window.location.hash).toBe('#/login');
  });

  it('any 401 later on sends the user to the sign-in page with 「登录已过期，请重新登录」; signing in again fetches a new CSRF token (Review Focus 1)', async () => {
    const server = fakeApi({
      'GET /api/analysis/v1/session': { body: sessionBody('admin', 'csrf-old') },
      'GET /api/analysis/v1/documents': unauthorized,
    });
    const { user } = await startApp('#/documents');
    await screen.findByRole('heading', { level: 1, name: '单据池' });

    // 服务重启：会话丢了，下一次接口调用就是 401。
    server.routes['GET /api/analysis/v1/session'] = unauthorized;
    await act(async () => { await api('/documents').catch(() => undefined); });
    expect(await screen.findByText('登录已过期，请重新登录')).toBeInTheDocument();
    expect(window.location.hash).toBe('#/login');
    expect(screen.queryByRole('navigation', { name: '主导航' })).not.toBeInTheDocument();

    server.routes['POST /api/analysis/v1/poc/login'] = loginOk;
    server.routes['POST /api/analysis/v1/auth/exchange'] = () => {
      server.routes['GET /api/analysis/v1/session'] = { body: sessionBody('admin', 'csrf-new') };
      return exchangeOk;
    };
    server.routes['POST /api/analysis/v1/poc/anything'] = { body: { data: { ok: true } } };
    await user.type(screen.getByLabelText('口令'), 'pw');
    await user.click(screen.getByRole('button', { name: '登录' }));
    // 回到过期前所在的页面。
    expect(await screen.findByRole('heading', { level: 1, name: '单据池' })).toBeInTheDocument();
    await act(async () => { await api('/poc/anything', { method: 'POST', body: {} }); });
    expect(server.find('POST', '/api/analysis/v1/poc/anything')[0].headers.get('X-CSRF-Token')).toBe('csrf-new');
  });

  it('takes a #access=<ticket> from the old sign-in page, removes it from the address before exchanging, and opens 工作台', async () => {
    let signedIn = false;
    let addressDuringExchange = '';
    const server = fakeApi({
      'GET /api/analysis/v1/session': () => (signedIn ? { body: sessionBody('admin') } : unauthorized),
      'POST /api/analysis/v1/auth/exchange': call => { addressDuringExchange = call.href; signedIn = true; return exchangeOk; },
    });
    await startApp('#access=old-page-ticket');
    expect(await screen.findByRole('heading', { level: 1, name: '工作台' })).toBeInTheDocument();
    expect(server.find('POST', '/api/analysis/v1/auth/exchange').map(c => c.body)).toEqual([{ ticket: 'old-page-ticket' }]);
    expect(addressDuringExchange).not.toContain('old-page-ticket');
    expect(window.location.href).not.toContain('old-page-ticket');
    expect(window.location.hash).toBe('#/');
  });

  it('a dead #access ticket ends on the sign-in page with the server message', async () => {
    fakeApi({
      'GET /api/analysis/v1/session': unauthorized,
      'POST /api/analysis/v1/auth/exchange': { status: 401, body: { error: { code: 'TICKET_INVALID', message: '入口已失效，请重新生成本机入口。' } } },
    });
    await startApp('#access=used-ticket');
    expect(await screen.findByText('入口已失效，请重新生成本机入口。')).toBeInTheDocument();
    expect(window.location.hash).toBe('#/login');
    expect(window.location.href).not.toContain('used-ticket');
  });

  it('signs out through /auth/logout and comes back to the sign-in page without the expired notice', async () => {
    const server = fakeApi({
      'GET /api/analysis/v1/session': { body: sessionBody('admin', 'csrf-9') },
      'POST /api/analysis/v1/auth/logout': () => {
        server.routes['GET /api/analysis/v1/session'] = unauthorized;
        return { body: { data: { loggedOut: true } } };
      },
    });
    const { user } = await startApp('#/');
    const sidebar = await screen.findByRole('complementary', { name: '侧栏' });
    await user.click(within(sidebar).getByRole('button', { name: '退出登录' }));
    expect(await screen.findByRole('heading', { name: '登录九安审单' })).toBeInTheDocument();
    const [logout] = server.find('POST', '/api/analysis/v1/auth/logout');
    expect(logout.headers.get('X-CSRF-Token')).toBe('csrf-9');
    await waitFor(() => expect(window.location.hash).toBe('#/login'));
    expect(screen.queryByText('登录已过期，请重新登录')).not.toBeInTheDocument();
  });

  it('a session that cannot be read for another reason shows what happened and a way to retry, not a blank page', async () => {
    let up = false;
    fakeApi({
      'GET /api/analysis/v1/session': () => (up ? { body: sessionBody('admin') } : { status: 503, body: { error: { code: 'ANALYSIS_RUNTIME_STOPPING', message: '平台正在重启，请稍候刷新。' } } }),
    });
    const { user } = await startApp('#/');
    expect(await screen.findByText('平台正在重启，请稍候刷新。')).toBeInTheDocument();
    up = true;
    await user.click(screen.getByRole('button', { name: '重新读取' }));
    expect(await screen.findByRole('heading', { level: 1, name: '工作台' })).toBeInTheDocument();
  });
});
