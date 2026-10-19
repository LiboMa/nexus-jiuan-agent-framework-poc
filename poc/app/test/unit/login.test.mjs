import test from 'node:test';
import assert from 'node:assert/strict';
import { createPasswordLogin } from '../../login.mjs';

const passwords = new Map([['poc-reviewer', 'reviewer-pass-1'], ['poc-checker', 'checker-pass-1']]);
function setup() {
  const issued = [];
  let now = 0;
  const login = createPasswordLogin({ passwords, issueTicket: id => { issued.push(id); return `ticket-for-${id}`; }, now: () => now });
  return { login, issued, tick: ms => { now += ms; } };
}

test('口令正确才签发九安票据', () => {
  const { login, issued } = setup();
  assert.deepEqual(login.login({ account: 'poc-checker', password: 'checker-pass-1', ip: '203.0.113.1' }), { ticket: 'ticket-for-poc-checker' });
  for (const attempt of [{ account: 'poc-checker', password: 'reviewer-pass-1' }, { account: 'nobody', password: 'checker-pass-1' },
    { account: 'poc-checker', password: '' }, { account: 'poc-checker', password: 42 }]) {
    assert.throws(() => login.login({ ...attempt, ip: '203.0.113.1' }), { code: 'INVALID_CREDENTIALS', status: 401 });
  }
  assert.deepEqual(issued, ['poc-checker']);
});

test('同一 IP 每分钟最多 10 次（含成功的），一分钟后恢复；不同 IP 互不影响', () => {
  const { login, tick } = setup();
  for (let index = 0; index < 10; index += 1) {
    assert.throws(() => login.login({ account: 'poc-reviewer', password: 'wrong', ip: '203.0.113.2' }), { code: 'INVALID_CREDENTIALS' });
  }
  assert.throws(() => login.login({ account: 'poc-reviewer', password: 'reviewer-pass-1', ip: '203.0.113.2' }), { code: 'POC_LOGIN_RATE_LIMIT', status: 429 });
  assert.ok(login.login({ account: 'poc-reviewer', password: 'reviewer-pass-1', ip: '198.51.100.7' }).ticket);
  tick(60_001);
  assert.ok(login.login({ account: 'poc-reviewer', password: 'reviewer-pass-1', ip: '203.0.113.2' }).ticket);
});
