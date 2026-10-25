import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../../../bench/build-jiuan07.sh', import.meta.url));
const SOURCE = fileURLToPath(new URL('../../../../source/九安自助审核平台-测试环境开发包-v0.7.10', import.meta.url));
// 开发包里这两个目录含真实数据：测试只核对它们没进构件，不读内容
const SENSITIVE = new Set(['seeds', 'database']);

async function build(out) {
  const { stdout } = await run('bash', [SCRIPT, '--out', out], { maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim().split('\n').at(-1);
}

async function files(dir, skip = new Set()) {
  const found = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const relative = path.relative(dir, full);
      if (skip.has(relative)) continue;
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) found.push(relative);
    }
  }
  await walk(dir);
  return found.sort();
}

async function digestTree(dir) {
  const lines = [];
  for (const file of await files(dir, SENSITIVE)) lines.push(`${file} ${createHash('sha256').update(await readFile(path.join(dir, file))).digest('hex')}`);
  return lines.join('\n');
}

const exists = file => stat(file).then(() => true, () => false);

test('九安 v0.7.10 构件：只带运行时要的文件和锁定版本的 mysql2', async t => {
  const out = path.join(await mkdtemp(path.join(tmpdir(), 'jiuan07-')), 'jiuan07');
  t.after(() => rm(path.dirname(out), { recursive: true, force: true }));
  assert.equal(await build(out), `JIUAN07_BUILD_OK ${out}`);
  for (const file of ['analysis-server.mjs', 'package.json', 'providers/nexus-a2a.mjs', 'public/analysis.js',
    'src/agent-contract/tasks/review_advice/v1/task.json', 'src/agent-contract/envelope/v1/card-requirements.json']) {
    assert.ok(await exists(path.join(out, file)), `缺 ${file}`);
  }
  const mysql2 = JSON.parse(await readFile(path.join(out, 'node_modules/mysql2/package.json'), 'utf8'));
  assert.equal(mysql2.version, '3.14.3');
});

test('构件里没有种子、数据库、测试、部署、脚本和旧版入口', async t => {
  const out = path.join(await mkdtemp(path.join(tmpdir(), 'jiuan07-')), 'jiuan07');
  t.after(() => rm(path.dirname(out), { recursive: true, force: true }));
  await build(out);
  for (const name of ['seeds', 'database', 'tests', 'deploy', '.gitea', 'scripts', 'server.mjs', 'stage-server.mjs', 'README.md',
    'compose.yaml', 'Dockerfile', 'public/index.html', 'public/app.js', 'public/stage.html', 'public/attachment-viewer.html']) {
    assert.equal(await exists(path.join(out, name)), false, `不该有 ${name}`);
  }
  const shipped = (await files(out)).filter(file => !file.startsWith('node_modules/'));
  assert.deepEqual(shipped.filter(file => /hly-config-seed|\.sql(\.gz)?$|tenant-companies|\.env(\.|$)|\.(pem|key|pfx|dpapi)$/.test(file)), []);
  assert.ok(shipped.every(file => /^(analysis-server\.mjs|package\.json|src\/|providers\/|public\/)/.test(file)), '构件里只能有清单里的文件');
});

test('构建不改 source/ 下的开发包', async t => {
  const out = path.join(await mkdtemp(path.join(tmpdir(), 'jiuan07-')), 'jiuan07');
  t.after(() => rm(path.dirname(out), { recursive: true, force: true }));
  const before = await digestTree(SOURCE);
  await build(out);
  assert.equal(await digestTree(SOURCE), before);
});
