import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

test('macOS 自带的 bash 3.2、set -euo pipefail 下也能用（空数组在 3.2 里算未定义）：给不给 DEPLOY_ENV 都不出错', async () => {
  const strict = `set -euo pipefail; source "${LIB}"; load_deploy_env; deploy_env_overrides; echo done`;
  const none = await run('/bin/bash', ['-c', strict], { env: { PATH: process.env.PATH } });
  assert.equal(none.stdout, 'done\n');
  const some = await run('/bin/bash', ['-c', strict], { env: { PATH: process.env.PATH, DEPLOY_ENV: path.join(FIXTURES, 'basic.env') } });
  assert.deepEqual(some.stdout.trim().split('\n'), [...expected.overrides['basic.env'], 'done']);
  const s3v = await run('/bin/bash', ['-c', strict], { env: { PATH: process.env.PATH, DEPLOY_ENV: path.join(FIXTURES, 's3v.env') } });
  assert.equal(s3v.stdout, 'done\n');
  await assert.rejects(run('/bin/bash', ['-c', strict], { env: { PATH: process.env.PATH, DEPLOY_ENV: path.join(FIXTURES, 's3v-bare.env') } }),
    error => error.code === 2 && error.stderr.includes(expected.errors['s3v-bare.env'].text));
});

test('KB_MODE：只能是 pg 或 s3vectors（别的值报错带行号）；不写或留空读出来没有这个键（调用方当 pg），也不要 S3 Vectors 的几项', async () => {
  for (const name of ['basic.env', 'kb-empty.env']) {
    const result = await bash(DUMP, { DEPLOY_ENV: path.join(FIXTURES, name) });
    assert.equal(result.code, 0, result.stderr);
    assert.equal('KB_MODE' in values(result.stdout), false, name);
  }
  const mongo = await bash(DUMP, { DEPLOY_ENV: path.join(FIXTURES, 'badmode.env') });
  assert.equal(mongo.code, 2);
  assert.ok(mongo.stderr.includes(`${path.join(FIXTURES, 'badmode.env')}:3：KB_MODE 只能是 pg 或 s3vectors：mongo`), mongo.stderr);
});

test('KB_MODE=s3vectors：五项（KB_S3V_BUCKET、KB_S3V_RULES_INDEX、RULES_TOOL_DIR、KB_S3V_KEY_ID、KB_S3V_PUBLICATION_ID）都要写，缺了一次列出缺哪几项、只列缺的', async () => {
  const missing = await bash(DUMP, { DEPLOY_ENV: path.join(FIXTURES, 's3v-missing.env') });
  assert.equal(missing.code, 2);
  assert.ok(missing.stderr.includes('还要写：KB_S3V_KEY_ID（'), missing.stderr);
  for (const present of ['KB_S3V_BUCKET', 'KB_S3V_RULES_INDEX', 'RULES_TOOL_DIR', 'KB_S3V_PUBLICATION_ID']) assert.doesNotMatch(missing.stderr, new RegExp(present));
  // 只看配置文件里写的：shell 里 export 了也不算
  const fromShell = await bash(DUMP, { DEPLOY_ENV: path.join(FIXTURES, 's3v-missing.env'), KB_S3V_KEY_ID: 'key-ffffffffffff' });
  assert.equal(fromShell.code, 2);
  const bare = await bash(DUMP, { DEPLOY_ENV: path.join(FIXTURES, 's3v-bare.env') });
  assert.equal(bare.code, 2);
  assert.ok(bare.stderr.includes('还要写：KB_S3V_BUCKET、KB_S3V_RULES_INDEX、RULES_TOOL_DIR、KB_S3V_KEY_ID、KB_S3V_PUBLICATION_ID（'), bare.stderr);
});

test('KB_PG_PUBLICATION_ID（PG 知识库 Agent 的发布）：只核对格式（pub_ 加 16 位小写十六进制，不对就报错带行号），不强制——pg 方式没写也照常读', async t => {
  const pg = await bash(DUMP, { DEPLOY_ENV: path.join(FIXTURES, 'kb-pg-pub.env') });
  assert.equal(pg.code, 0, pg.stderr);
  assert.equal(values(pg.stdout).KB_PG_PUBLICATION_ID, 'pub_fedcba9876543210');
  for (const name of ['kb-pg.env', 'basic.env', 's3v.env']) {
    const result = await bash(DUMP, { DEPLOY_ENV: path.join(FIXTURES, name) });
    assert.equal(result.code, 0, `${name}：${result.stderr}`);
    assert.equal('KB_PG_PUBLICATION_ID' in values(result.stdout), false, name);
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'deploy-env-pgpub-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const bad of ['pub_0123456789ABCDEF', 'pub_0123456789abcdef0', 'pub_0123456789abcde', 'agent_0123456789abcdef', 'pub_0123456789abcdef x', "pub_0123456789abcdef' && reboot '"]) {
    const file = path.join(dir, 'bad.env');
    await writeFile(file, `STACK=s\nAWS_REGION=us-east-1\nKB_MODE=pg\nKB_PG_PUBLICATION_ID=${bad}\n`);
    const result = await bash(`${DUMP}; echo SHOULD-NOT-REACH`, { DEPLOY_ENV: file });
    assert.equal(result.code, 2, bad);
    assert.doesNotMatch(result.stdout, /SHOULD-NOT-REACH/);
    assert.ok(result.stderr.includes(`${file}:4：KB_PG_PUBLICATION_ID 应是 PG 知识库 Agent 的发布编号`), result.stderr);
  }
});

test('example.env：两个知识库 Agent 的发布、规则工具目录、写入密钥编号都留空，注释写清形状（不放像真值的示例）', async () => {
  const lines = (await readFile(path.join(ROOT, 'poc/infra/env/example.env'), 'utf8')).split('\n');
  const shapes = { KB_PG_PUBLICATION_ID: /pub_ 加 16 位十六进制/, RULES_TOOL_DIR: /kb_s3v_rules_/, KB_S3V_KEY_ID: /key- 加 12 位十六进制/, KB_S3V_PUBLICATION_ID: /pub_ 加 16 位十六进制/ };
  for (const [key, shape] of Object.entries(shapes)) {
    const at = lines.indexOf(`${key}=`);
    assert.ok(at > 0, `example.env 里 ${key} 应留空`);
    assert.match(lines[at - 1], /^# /, `${key} 上面要有注释`);
    assert.match(lines[at - 1], shape, `${key} 的注释要写形状`);
  }
  assert.ok(lines.indexOf('KB_PG_PUBLICATION_ID=') > lines.indexOf('CONNECTOR_ID='), 'PG 方式的几项放在一起');
});
