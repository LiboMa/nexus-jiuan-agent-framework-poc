import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fingerprint, open, seal } from '../../access/crypto.mjs';
import { parseSecrets, registryKeyFrom } from '../../secrets.mjs';

const KEY = randomBytes(32);

test('seal / open 往返；每次密文不同；密文里看不出原文；指纹是 sha256 前 8 位', () => {
  const a = seal(KEY, 'nxa_example_token_value'), b = seal(KEY, 'nxa_example_token_value');
  assert.notEqual(a, b);
  assert.match(a, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(a.includes('nxa_example'), false);
  assert.equal(open(KEY, a), 'nxa_example_token_value');
  assert.equal(fingerprint('abc'), 'ba7816bf');
});

test('换了加密密钥、密文被改过或格式不对：一律 POC_SEALED_INVALID', () => {
  const sealed = seal(KEY, 'secret-value');
  assert.throws(() => open(randomBytes(32), sealed), { code: 'POC_SEALED_INVALID' });
  const parts = sealed.split('.');
  parts[3] = `${parts[3].slice(0, -2)}${parts[3].endsWith('AA') ? 'BB' : 'AA'}`;
  assert.throws(() => open(KEY, parts.join('.')), { code: 'POC_SEALED_INVALID' });
  for (const bad of ['', 'v0.a.b.c', 'v1.only', null]) assert.throws(() => open(KEY, bad), { code: 'POC_SEALED_INVALID' });
});

test('registryKeyFrom：32 字节 base64；缺失或格式不对时说明怎么补，且不带值', () => {
  const value = randomBytes(32).toString('base64');
  assert.equal(registryKeyFrom(parseSecrets(`REGISTRY_KEY=${value}\n`)).length, 32);
  for (const text of ['', 'REGISTRY_KEY=\n', 'REGISTRY_KEY=abc\n', `REGISTRY_KEY=${randomBytes(16).toString('base64')}\n`]) {
    assert.throws(() => registryKeyFrom(parseSecrets(text)), error => /REGISTRY_KEY/.test(error.message) && /deploy\.sh/.test(error.message) && !error.message.includes('abc'));
  }
});
