import { describe, expect, it, vi } from 'vitest';
import { ApiError, api, setCsrfToken, setUnauthorizedHandler } from '../api/client';
import { fakeApi, unauthorized } from './fakeApi';

const rejection = (promise: Promise<unknown>) => promise.then(() => { throw new Error('expected the request to fail'); }, (error: ApiError) => error);

describe('api()', () => {
  it('reads same-origin under /api/analysis/v1 and returns the data of the envelope', async () => {
    const server = fakeApi({ 'GET /api/analysis/v1/documents': { body: { data: { items: [{ id: 'd-1' }] } } } });
    await expect(api('/documents?page=1')).resolves.toEqual({ items: [{ id: 'd-1' }] });
    const [call] = server.calls;
    expect(call.init.credentials).toBe('same-origin');
    expect(call.search).toBe('?page=1');
    expect(call.headers.has('X-CSRF-Token')).toBe(false);
    expect(call.init.body).toBeUndefined();
  });

  it('accepts the full /api/analysis/v1/... path as well', async () => {
    const server = fakeApi({ 'GET /api/analysis/v1/poc/dashboard': { body: { data: { window: '14d' } } } });
    await expect(api('/api/analysis/v1/poc/dashboard?window=14d')).resolves.toEqual({ window: '14d' });
    expect(server.calls[0].path).toBe('/api/analysis/v1/poc/dashboard');
  });

  it('sends X-CSRF-Token and a JSON body on every non-GET request', async () => {
    const server = fakeApi({
      'POST /api/analysis/v1/poc/reviews': { status: 201, body: { data: { review: { id: 'r-1' } } } },
      'PUT /api/analysis/v1/poc/thing': { body: { data: true } },
      'DELETE /api/analysis/v1/poc/thing': { body: { data: true } },
    });
    setCsrfToken('tok-1');
    await expect(api('/poc/reviews', { method: 'POST', body: { documentId: 'd-1', decision: 'adopt' } })).resolves.toEqual({ review: { id: 'r-1' } });
    await api('/poc/thing', { method: 'PUT', body: { a: 1 } });
    await api('/poc/thing', { method: 'DELETE' });
    for (const call of server.calls) {
      expect(call.headers.get('X-CSRF-Token')).toBe('tok-1');
      expect(call.headers.get('Content-Type')).toBe('application/json');
      expect(call.init.credentials).toBe('same-origin');
    }
    expect(server.calls[0].body).toEqual({ documentId: 'd-1', decision: 'adopt' });
    expect(server.calls[2].body).toEqual({});
  });

  it('sends a raw body untouched, with the caller headers and the CSRF token', async () => {
    const server = fakeApi({ 'POST /api/analysis/v1/poc/custom-rules': { status: 201, body: { data: { id: 'f-1' } } } });
    setCsrfToken('tok-2');
    const file = new Blob(['# 规则'], { type: 'text/markdown' });
    await api('/poc/custom-rules', { method: 'POST', raw: file, headers: { 'Content-Type': 'text/markdown', 'X-File-Name': encodeURIComponent('我的规则.md') } });
    const [call] = server.calls;
    expect(call.init.body).toBe(file);
    expect(call.headers.get('Content-Type')).toBe('text/markdown');
    expect(call.headers.get('X-File-Name')).toBe(encodeURIComponent('我的规则.md'));
    expect(call.headers.get('X-CSRF-Token')).toBe('tok-2');
  });

  it('throws ApiError with the status, the code and the Chinese message exactly as the server sent them', async () => {
    fakeApi({ 'POST /api/analysis/v1/poc/reviews': { status: 409, body: { error: { code: 'REVIEW_STALE', message: '这张单的 AI 建议刚更新，请先看新的建议' } } } });
    const error = await rejection(api('/poc/reviews', { method: 'POST', body: {} }));
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: 'REVIEW_STALE', message: '这张单的 AI 建议刚更新，请先看新的建议' });
  });

  it('explains a network failure and an unreadable reply in Chinese, never in English', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const offline = await rejection(api('/session'));
    expect(offline).toBeInstanceOf(ApiError);
    expect(offline.code).toBe('NETWORK_ERROR');
    expect(offline.message).toMatch(/[一-龥]/);
    expect(offline.message).not.toMatch(/fetch|failed/i);

    fakeApi({ 'GET /api/analysis/v1/session': { status: 502, text: '<html>Bad Gateway</html>' } });
    const garbled = await rejection(api('/session'));
    expect(garbled).toMatchObject({ status: 502, code: 'BAD_RESPONSE' });
    expect(garbled.message).toMatch(/[一-龥]/);
    expect(garbled.message).not.toMatch(/Bad Gateway/);

    fakeApi({ 'GET /api/analysis/v1/session': { status: 403, body: { error: { code: 'FORBIDDEN' } } } });
    const bare = await rejection(api('/session'));
    expect(bare).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(bare.message).toMatch(/[一-龥]/);
  });

  it('calls onUnauthorized on a 401 and still rejects', async () => {
    fakeApi({ 'GET /api/analysis/v1/documents': unauthorized });
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    const error = await rejection(api('/documents'));
    expect(error).toMatchObject({ status: 401, code: 'AUTH_REQUIRED' });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('does not treat a wrong password or a dead ticket (401 from the sign-in endpoints) as an expired session', async () => {
    fakeApi({
      'POST /api/analysis/v1/poc/login': { status: 401, body: { error: { code: 'INVALID_CREDENTIALS', message: '账号或口令不正确。' } } },
      'POST /api/analysis/v1/auth/exchange': { status: 401, body: { error: { code: 'TICKET_INVALID', message: '入口已失效，请重新生成本机入口。' } } },
    });
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    await expect(api('/poc/login', { method: 'POST', body: { account: 'a', password: 'b' } })).rejects.toMatchObject({ message: '账号或口令不正确。' });
    await expect(api('/auth/exchange', { method: 'POST', body: { ticket: 't' } })).rejects.toMatchObject({ code: 'TICKET_INVALID' });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('refuses anything that is not a same-origin API path', async () => {
    const server = fakeApi();
    for (const path of ['https://evil.example/api/analysis/v1/session', '//evil.example/x', 'session', '/../poc/login', '/api/other/v1/x']) {
      await expect(api(path)).rejects.toMatchObject({ code: 'BAD_PATH' });
    }
    expect(server.calls).toHaveLength(0);
  });

  it('checks ".." in the path part only: a search for 1..2 goes through, a path with .. (or its %2e form) does not', async () => {
    const server = fakeApi({ 'GET /api/analysis/v1/documents': { body: { data: { items: [] } } } });
    await expect(api('/documents?q=1..2&limit=50')).resolves.toEqual({ items: [] });
    expect(server.calls[0].search).toBe('?q=1..2&limit=50');
    await expect(api(`/documents?q=${encodeURIComponent('a\\b..c')}`)).resolves.toEqual({ items: [] });
    for (const path of ['/documents/../poc/login?q=1', '/documents/%2e%2e/poc/login', '/documents/.%2E/x', '/documents\\x?q=1']) {
      await expect(api(path)).rejects.toMatchObject({ code: 'BAD_PATH' });
    }
    expect(server.calls).toHaveLength(2);
  });
});
