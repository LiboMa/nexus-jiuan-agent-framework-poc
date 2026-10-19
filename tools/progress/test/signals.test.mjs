import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkHealth, docsFreshness, parsePythonUnittest, readE2eSummary, runNodeTests } from '../signals.mjs';

test('runNodeTests：用自带的报告器跑 node --test，按文件数通过和失败（只数顶层用例，跳过的单独数）', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'progress-signals-'));
  const dir = path.join(root, 'app', 'test');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'a.test.mjs'), "import test from 'node:test';\ntest('一', () => {});\ntest('二', async t => { await t.test('子', () => {}); });\ntest('跳过', { skip: true }, () => {});\n");
  await writeFile(path.join(dir, 'b.test.mjs'), "import test from 'node:test';\ntest('好', () => {});\ntest('坏', () => { throw new Error('x'); });\n");
  const result = await runNodeTests({ root, cwd: path.join(root, 'app'), patterns: ['test/*.test.mjs'] });
  assert.deepEqual(result.files, { 'app/test/a.test.mjs': { pass: 2, fail: 0, skip: 1 }, 'app/test/b.test.mjs': { pass: 1, fail: 1, skip: 0 } });
  assert.deepEqual([result.pass, result.fail, result.skip], [3, 1, 1]);
});

test('parsePythonUnittest：按模块名换成测试文件，数通过和失败', () => {
  const output = [
    'test_exit_codes (test_agent_access.PureTests.test_exit_codes) ... ok',
    'test_redact (test_agent_access.PureTests.test_redact) ... FAIL',
    'test_store (test_agent_access.PureTests.test_store) ... ERROR',
    'test_slow (test_agent_access.PureTests.test_slow) ... skipped \'later\'',
    'Ran 4 tests in 0.010s',
  ].join('\n');
  assert.deepEqual(parsePythonUnittest(output, 'skills/agent-access/tests'),
    { files: { 'skills/agent-access/tests/test_agent_access.py': { pass: 1, fail: 2, skip: 1 } }, pass: 1, fail: 2, skip: 1 });
});

test('docsFreshness：Markdown 比同名 HTML 新就算过期；没有 HTML 的不管', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'progress-docs-'));
  await mkdir(path.join(root, 'docs', 'delivery'), { recursive: true });
  const at = (file, seconds) => utimes(path.join(root, file), seconds, seconds);
  for (const file of ['docs/a.md', 'docs/a.html', 'docs/delivery/b.md', 'docs/delivery/b.html', 'docs/c.md']) await writeFile(path.join(root, file), 'x');
  await at('docs/a.md', 1000); await at('docs/a.html', 2000);
  await at('docs/delivery/b.md', 3000); await at('docs/delivery/b.html', 2000);
  assert.deepEqual(await docsFreshness({ root }), { checked: 2, stale: ['docs/delivery/b.md'] });
});

test('checkHealth：200 是 ok；别的状态码或请求失败都不是 ok，并带原因', async () => {
  assert.equal((await checkHealth({ url: 'https://x/api/health', fetchImpl: async () => ({ status: 200 }) })).ok, true);
  assert.deepEqual((await checkHealth({ url: 'https://x/api/health', fetchImpl: async () => ({ status: 503 }) })).reason, 'HTTP 503');
  assert.equal((await checkHealth({ url: 'https://x/api/health', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } })).ok, false);
});

test('readE2eSummary：读 run.sh 写的结果（每行一条用例），没有文件时是 null', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'progress-e2e-'));
  const file = path.join(root, 'last-run.jsonl');
  assert.equal(await readE2eSummary(file), null);
  await writeFile(file, [{ file: 'poc.e2e.mjs', name: '1. 登录', status: 'pass' }, { file: 'access.e2e.mjs', name: '停用', status: 'skip' },
    { file: 'access.e2e.mjs', name: '启用', status: 'fail' }].map(line => JSON.stringify(line)).join('\n') + '\n');
  const summary = await readE2eSummary(file);
  assert.deepEqual([summary.pass, summary.fail, summary.skip], [1, 1, 1]);
  assert.deepEqual(summary.failures, ['access.e2e.mjs：启用']);
  assert.match(summary.at, /^\d{4}-\d{2}-\d{2}T/);
});
