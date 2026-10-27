import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// 一个环境一份配置文件（poc/infra/env/<环境名>.env），脚本经 DEPLOY_ENV 读：逐行 KEY=VALUE，不 source、不 eval。
// fixtures 和 expected.json 和 audit-agent/tests/test_deploy_env.py 共用，两边读出来的必须一样。
const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const FIXTURES = path.join(ROOT, 'poc/app/test/fixtures/deploy-env');
const LIB = path.join(ROOT, 'poc/infra/lib/deploy-env.sh');
const expected = JSON.parse(await readFile(path.join(FIXTURES, 'expected.json'), 'utf8'));
const DUMP = `source "${LIB}"; load_deploy_env; for k in "\${DEPLOY_ENV_KEYS[@]}"; do [[ -n "\${!k+x}" ]] && printf '%s=%s\\n' "$k" "\${!k}"; done; true`;

async function bash(script, env = {}) {
  try {
    const { stdout, stderr } = await run('bash', ['-c', script], { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } });
    return { code: 0, stdout, stderr };
  } catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
}
const values = stdout => Object.fromEntries(stdout.trim().split('\n').filter(Boolean).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));

test('读出来的值：注释和空行跳过，引号去掉一层，空值等于没写；$(…)、反引号、${…} 原样当字符串，不执行', async () => {
  await rm('/tmp/deploy-env-pwned', { force: true });
  for (const [name, want] of Object.entries(expected.values)) {
    const result = await bash(DUMP, { DEPLOY_ENV: path.join(FIXTURES, name) });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(values(result.stdout), want, name);
  }
  assert.equal(existsSync('/tmp/deploy-env-pwned'), false, '配置里的命令不能被执行');
});

test('写错了就报错退出（2），说清哪一行、哪个键：不认识的键、重复的键、export、没有等号、没写 STACK / AWS_REGION；文件不存在也报错，不退回现有环境', async () => {
  for (const [name, want] of Object.entries(expected.errors)) {
    const result = await bash(`${DUMP}; echo SHOULD-NOT-REACH`, { DEPLOY_ENV: path.join(FIXTURES, name) });
    assert.equal(result.code, 2, `${name}：${result.stdout}`);
    assert.doesNotMatch(result.stdout, /SHOULD-NOT-REACH/);
    if (want.line) assert.match(result.stderr, new RegExp(`${name}:${want.line}`));
    assert.ok(result.stderr.includes(want.text), `${name}：${result.stderr}`);
  }
  const missing = await bash(DUMP, { DEPLOY_ENV: path.join(FIXTURES, 'no-such.env') });
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /no-such\.env/);
});

test('不给 DEPLOY_ENV：什么都不读、不打印，现有环境照旧', async () => {
  const result = await bash(DUMP);
  assert.deepEqual([result.code, result.stdout, result.stderr], [0, '', '']);
});

test('shell 里已经 export 了别的栈和区域：以配置文件为准，并打印要动的是哪个栈、哪个区域', async () => {
  const file = path.join(FIXTURES, 'basic.env');
  const result = await bash(`${DUMP}; echo "STACK_NOW=$STACK REGION_NOW=$AWS_REGION"`, { DEPLOY_ENV: file, STACK: 'other-stack', AWS_REGION: 'eu-west-1' });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /STACK_NOW=andon-finance-rehearsal REGION_NOW=us-east-1/);
  assert.ok(result.stderr.includes(`环境：${file}（栈 andon-finance-rehearsal，区域 us-east-1）`), result.stderr);
});

test('deploy_env_overrides：只列出写了值的栈参数，按对照表的顺序', async () => {
  for (const [name, want] of Object.entries(expected.overrides)) {
    const result = await bash(`source "${LIB}"; load_deploy_env 2>/dev/null; deploy_env_overrides`, { DEPLOY_ENV: path.join(FIXTURES, name) });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split('\n'), want);
  }
});

test('example.env 列的键就是脚本认的键；只有 example.env 进仓库', async () => {
  const example = await readFile(path.join(ROOT, 'poc/infra/env/example.env'), 'utf8');
  const keys = example.split('\n').map(line => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1]).filter(Boolean);
  const known = (await bash(`source "${LIB}"; printf '%s\\n' "\${DEPLOY_ENV_KEYS[@]}"`)).stdout.trim().split('\n');
  assert.deepEqual(keys, known);
  const ignored = await bash(`cd "${ROOT}" && git check-ignore --no-index poc/infra/env/somewhere.env`);
  assert.equal(ignored.code, 0, '各环境的配置文件不进仓库');
  const example2 = await bash(`cd "${ROOT}" && git check-ignore --no-index poc/infra/env/example.env`);
  assert.equal(example2.code, 1, 'example.env 进仓库');
});
