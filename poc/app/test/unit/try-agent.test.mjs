import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs, requestBody } from '../../scripts/try-agent.mjs';
import { parseAnswer, readSecret } from '../../scripts/poc-client.mjs';

test('parseArgs：发布、三种输入方式、可重复的附件与示例附件；缺省站点与密钥文件', () => {
  const options = parseArgs(['--publication', 'pub_2cc24c29d2e5b2c9', '--task', 'select', '--input', '{"document":{"companyId":"poc-company-a"}}',
    '--attach', 'a.png', '--attach', 'b.pdf', '--sample', 'travel-policy-md']);
  assert.equal(options.publication, 'pub_2cc24c29d2e5b2c9');
  assert.equal(options.task, 'select');
  assert.deepEqual(options.attach, ['a.png', 'b.pdf']);
  assert.deepEqual(options.sample, ['travel-policy-md']);
  assert.equal(options.base, 'https://andon-finance.tinyboat.blog');
  assert.equal(options.account, 'poc-reviewer');
  assert.match(options.secrets, /infra\/secrets\.env$/);
  assert.equal(parseArgs(['--list']).list, true);
});

test('parseArgs：不认识的选项、缺值、同时给两种输入方式都报错', () => {
  assert.throws(() => parseArgs(['--shell', 'x']), /不认识的选项/);
  assert.throws(() => parseArgs(['--publication']), /缺少值/);
  assert.throws(() => parseArgs(['--publication', 'pub_x', '--text', 'a', '--task', 'answer']), /只能选一种/);
  assert.throws(() => parseArgs(['--publication', 'pub_x']), /--text、--task 或 --document/);
});

test('requestBody：任务输入组成 {"task", "input"}；单据号换成单据编号；附件放进 attachments', async () => {
  const documents = [{ id: 'doc-001', number: 'FYBX-POC-001' }];
  const files = [{ name: 'a.png', type: 'image/png', data: 'AAAA' }];
  assert.deepEqual(requestBody(parseArgs(['--publication', 'pub_x', '--task', 'answer', '--input', '{"question":"住宿标准？"}']), { documents, files }),
    { publishId: 'pub_x', mode: 'text', text: JSON.stringify({ task: 'answer', input: { question: '住宿标准？' } }), attachments: files });
  assert.deepEqual(requestBody(parseArgs(['--publication', 'pub_x', '--document', 'FYBX-POC-001']), { documents, files: [] }),
    { publishId: 'pub_x', mode: 'advisory', documentId: 'doc-001' });
  assert.throws(() => requestBody(parseArgs(['--publication', 'pub_x', '--document', 'NOPE-1']), { documents, files: [] }), /找不到单据 NOPE-1/);
  assert.throws(() => requestBody(parseArgs(['--publication', 'pub_x', '--task', 'answer', '--input', '[1]']), { documents, files: [] }), /JSON 对象/);
});

test('readSecret 读 KEY=VALUE（去掉成对引号）；parseAnswer 剥一层代码围栏', async () => {
  const file = path.join(await mkdtemp(path.join(tmpdir(), 'poc-secret-')), 'secrets.env');
  await writeFile(file, '# 注释\nREVIEWER_PASSWORD="abc def"\nOTHER=1\n');
  assert.equal(readSecret(file, 'REVIEWER_PASSWORD'), 'abc def');
  assert.equal(readSecret(file, 'MISSING'), null);
  assert.deepEqual(parseAnswer('```json\n{"task":"answer"}\n```'), { task: 'answer' });
  assert.equal(parseAnswer('OK'), null);
});
