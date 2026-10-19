import test from 'node:test';
import assert from 'node:assert/strict';
import { createSystemKeyResolver } from '../../nexus/system-key.mjs';

test('审批流的密钥从系统里读：按单据找发起人，用他在页面上启用的那把；401 只把那个账号的那一把标记失效，secrets.env 的不标', async () => {
  const calls = [];
  const me = {
    systemCredential: async (publishId, options) => { calls.push(['lookup', publishId, options]); return { key: 'nxa_page', source: 'user', accountId: 'poc-reviewer' }; },
    markInvalid: async (user, publishId) => { calls.push(['invalid', user.id, publishId]); },
  };
  const workflow = { initiatorOf: documentId => (documentId === 'doc-1' ? 'poc-reviewer' : null) };
  const resolver = createSystemKeyResolver({ me, workflow, publishId: 'pub_x' });
  assert.equal((await resolver.getKey({ documentId: 'doc-1' })).key, 'nxa_page');
  await resolver.getKey({ documentId: 'doc-2' });
  await resolver.getKey({});
  await resolver.onAuthRejected({ key: 'nxa_page', source: 'user', accountId: 'poc-reviewer' });
  await resolver.onAuthRejected({ key: 'nxa_file', source: 'system', accountId: null });
  assert.deepEqual(calls, [
    ['lookup', 'pub_x', { preferAccountId: 'poc-reviewer' }],
    ['lookup', 'pub_x', { preferAccountId: null }],
    ['lookup', 'pub_x', { preferAccountId: null }],
    ['invalid', 'poc-reviewer', 'pub_x'],
  ]);
});
