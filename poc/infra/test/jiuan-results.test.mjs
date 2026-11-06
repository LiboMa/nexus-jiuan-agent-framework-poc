import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { compareResults, parseJunit } from './compare-jiuan-results.mjs';

// 远端跑九安的测试后，junit 报告 → { "tests/x.test.mjs": { "<测试名>": "pass"|"fail"|"skip" } }，再和基线比
const run = promisify(execFile);
const CLI = fileURLToPath(new URL('./compare-jiuan-results.mjs', import.meta.url));
const ROOT = '/var/tmp/jiuan-pgtest.abc123';
const JUNIT = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
	<testcase name="alpha ok" time="0.1" classname="test" file="${ROOT}/tests/a.test.mjs"/>
	<testcase name="alpha &amp; skipped" time="0" classname="test" file="${ROOT}/tests/a.test.mjs">
		<skipped type="skipped" message="no db"/>
	</testcase>
	<testsuite name="alpha nested" time="0.2" disabled="0" errors="0" tests="1" failures="0" skipped="0" hostname="h">
		<testcase name="inner" time="0.1" classname="test" file="${ROOT}/tests/a.test.mjs"/>
	</testsuite>
	<testcase name="beta fails" time="0.1" classname="test" file="${ROOT}/tests/b.test.mjs" failure="1 == 2">
		<failure type="testCodeFailure" message="1 == 2">boom</failure>
	</testcase>
	<testcase name="todo one" time="0" classname="test" file="${ROOT}/tests/b.test.mjs">
		<skipped type="todo" message="later"/>
	</testcase>
</testsuites>`;

test('parseJunit：按文件（去掉远端目录前缀）分组，pass / fail / skip（todo 算 skip），名字里的实体还原；嵌套的测试名带上外层', () => {
  assert.deepEqual(parseJunit(JUNIT, ROOT), {
    'tests/a.test.mjs': { 'alpha ok': 'pass', 'alpha & skipped': 'skip', 'alpha nested > inner': 'pass' },
    'tests/b.test.mjs': { 'beta fails': 'fail', 'todo one': 'skip' },
  });
});

test('parseJunit：同一个文件里重名的测试各记一条（第二个起加 #2、#3）', () => {
  const twice = `<testsuites><testcase name="same" file="${ROOT}/tests/c.test.mjs"/><testcase name="same" file="${ROOT}/tests/c.test.mjs"><failure message="x"/></testcase></testsuites>`;
  assert.deepEqual(parseJunit(twice, ROOT), { 'tests/c.test.mjs': { same: 'pass', 'same #2': 'fail' } });
});

test('compareResults：基线里 pass 的这次不是 pass（fail、skip、不见了）都算回退；基线里不是 pass 的随便；removed 里列的不比', () => {
  const baseline = { 'tests/a.test.mjs': { x: 'pass', y: 'fail', z: 'pass', w: 'pass' }, 'tests/gone.test.mjs': { g: 'pass' } };
  const current = { 'tests/a.test.mjs': { x: 'pass', y: 'pass', z: 'skip' } };
  assert.deepEqual(compareResults(baseline, current, { removed: ['tests/gone.test.mjs'] }),
    [{ file: 'tests/a.test.mjs', test: 'z', was: 'pass', now: 'skip' }, { file: 'tests/a.test.mjs', test: 'w', was: 'pass', now: 'missing' }]);
  assert.deepEqual(compareResults(baseline, current, { removed: ['tests/gone.test.mjs', 'tests/a.test.mjs#z', 'tests/a.test.mjs#w'] }), []);
});

test('命令行：--from-junit 转成 JSON；比较时有回退就列出来、退出 1，没有就退出 0 并报个数', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'jiuan-results-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'junit.xml'), JUNIT);
  const { stdout } = await run('node', [CLI, '--from-junit', path.join(dir, 'junit.xml'), '--root', ROOT]);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed['tests/b.test.mjs']['beta fails'], 'fail');
  await writeFile(path.join(dir, 'base.json'), JSON.stringify({ 'tests/a.test.mjs': { 'alpha ok': 'pass' }, 'tests/b.test.mjs': { 'beta fails': 'pass' } }));
  await writeFile(path.join(dir, 'now.json'), stdout);
  await assert.rejects(run('node', [CLI, path.join(dir, 'base.json'), path.join(dir, 'now.json')]), error => error.code === 1 && /tests\/b\.test\.mjs.*beta fails.*pass → fail/.test(error.stdout));
  await writeFile(path.join(dir, 'base.json'), JSON.stringify({ 'tests/a.test.mjs': { 'alpha ok': 'pass' } }));
  const ok = await run('node', [CLI, path.join(dir, 'base.json'), path.join(dir, 'now.json')]);
  assert.match(ok.stdout, /没有回退/);
});
