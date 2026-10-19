import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { a2aKeysFrom, parseSecrets, passwordsFrom, readSecretsFile } from '../../secrets.mjs';

test('parseSecrets 读 KEY=VALUE：忽略注释与空行，去掉成对的引号，兼容 CRLF', () => {
  const secrets = parseSecrets('# 注释\r\nREVIEWER_PASSWORD=abc=def\r\n\r\n  CHECKER_PASSWORD = "quoted value" \nNEXUS_API_KEY=\nnot a line\n');
  assert.deepEqual([...secrets], [['REVIEWER_PASSWORD', 'abc=def'], ['CHECKER_PASSWORD', 'quoted value'], ['NEXUS_API_KEY', '']]);
});

test('readSecretsFile：文件不存在时说明怎么办，报错里不带任何密钥内容', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'poc-secrets-'));
  const file = path.join(dir, 'secrets.env');
  await assert.rejects(readSecretsFile(file), error => error.code === 'POC_SECRETS_UNAVAILABLE' && error.message.includes(file) && /deploy\.sh/.test(error.message));
  await writeFile(file, 'REVIEWER_PASSWORD=reviewer-pass-123\n');
  assert.equal((await readSecretsFile(file)).get('REVIEWER_PASSWORD'), 'reviewer-pass-123');
});

test('passwordsFrom：两个账号的口令都要有，且至少 12 个字符；报错不带口令', () => {
  const ok = parseSecrets('REVIEWER_PASSWORD=reviewer-pass-123\nCHECKER_PASSWORD=checker-pass-123\n');
  assert.deepEqual([...passwordsFrom(ok)], [['poc-reviewer', 'reviewer-pass-123'], ['poc-checker', 'checker-pass-123']]);
  assert.throws(() => passwordsFrom(parseSecrets('REVIEWER_PASSWORD=short\nCHECKER_PASSWORD=checker-pass-123\n')),
    error => /REVIEWER_PASSWORD/.test(error.message) && !/short/.test(error.message));
});

test('a2aKeysFrom 只认 NEXUS_A2A_KEY_<发布编号>，并且值不能为空；E2E_KNOWLEDGE_A2A_KEY 不算系统提供', () => {
  const secrets = parseSecrets('NEXUS_A2A_KEY_pub_5c53e70d8dc7ddea=nxa_1\nNEXUS_A2A_KEY_bad=x\nNEXUS_A2A_KEY_pub_empty=\nE2E_KNOWLEDGE_A2A_KEY=nxa_2\n');
  assert.deepEqual([...a2aKeysFrom(secrets)], [['pub_5c53e70d8dc7ddea', 'nxa_1']]);
});
