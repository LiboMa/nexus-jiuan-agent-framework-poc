import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { childEnv } from './helpers/child-env.mjs';

const execFileAsync = promisify(execFile);
// 子进程不继承部署的环境（DEPLOY_ENV 和环境配置的键，见 helpers/child-env.mjs）；自己给了 env 的调用照它给的
const run = (file, args, options = {}) => execFileAsync(file, args, { env: childEnv(), ...options });
const SCRIPT = fileURLToPath(new URL('../../../bench/build-jiuan.sh', import.meta.url));
const SOURCE = fileURLToPath(new URL('../../../../source/审核平台-测试环境开发包-v0.5.3/code', import.meta.url));

async function build(args) {
  const { stdout } = await run('bash', [SCRIPT, ...args], { maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim().split('\n').at(-1);
}

async function digestTree(dir) {
  const lines = [];
  async function walk(current) {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) lines.push(`${path.relative(dir, full)} ${createHash('sha256').update(await readFile(full)).digest('hex')}`);
    }
  }
  await walk(dir);
  return lines.join('\n');
}

const exists = file => stat(file).then(() => true, () => false);

test('构建九安副本：带上锁定版本的 mysql2 3.14.3，不带测试目录', async t => {
  const out = await mkdtemp(path.join(tmpdir(), 'jiuan-copy-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  const last = await build(['--out', out, '--patches', path.join(out, 'no-patches')]);
  assert.equal(last, `JIUAN_BUILD_OK ${out}`);
  assert.ok(await exists(path.join(out, 'analysis-server.mjs')));
  const mysql2 = JSON.parse(await readFile(path.join(out, 'node_modules/mysql2/package.json'), 'utf8'));
  assert.equal(mysql2.version, '3.14.3');
  assert.equal(await exists(path.join(out, 'tests')), false);
  assert.equal(await exists(path.join(out, 'deploy')), false);
});

test('构建副本不改 source/ 下的开发包', async t => {
  const out = await mkdtemp(path.join(tmpdir(), 'jiuan-copy-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  const before = await digestTree(SOURCE);
  await build(['--out', out, '--patches', path.join(out, 'no-patches')]);
  assert.equal(await digestTree(SOURCE), before);
});

test('补丁按文件名顺序打进副本', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'jiuan-patch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const patches = path.join(root, 'patches');
  const out = path.join(root, 'out');
  await mkdir(patches);
  await writeFile(path.join(patches, '0001-a.patch'), '--- /dev/null\n+++ b/hello.txt\n@@ -0,0 +1 @@\n+1\n');
  await writeFile(path.join(patches, '0002-b.patch'), '--- a/hello.txt\n+++ b/hello.txt\n@@ -1 +1 @@\n-1\n+2\n');
  await build(['--out', out, '--patches', patches]);
  assert.equal(await readFile(path.join(out, 'hello.txt'), 'utf8'), '2\n');
});

test('补丁打不上就失败，不留半成品', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'jiuan-patch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const patches = path.join(root, 'patches');
  await mkdir(patches);
  await writeFile(path.join(patches, '0001-bad.patch'), '--- a/does-not-exist.txt\n+++ b/does-not-exist.txt\n@@ -1 +1 @@\n-x\n+y\n');
  await assert.rejects(build(['--out', path.join(root, 'out'), '--patches', patches]));
  assert.equal(await exists(path.join(root, 'out', 'analysis-server.mjs')), false);
});
