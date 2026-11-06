import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../../../docs/delivery/make-package.sh', import.meta.url));
const exists = file => stat(file).then(() => true, () => false);

test('make-package.sh --export：交接仓库只放交接内容（九安 v0.7.10 测试台、知识库、Agent、nexus-ai-operator），不放设计、过程、证据、密钥和已经拿掉的 v0.5.3 PoC；目标目录里多余的旧文件删掉，.git 保留', async t => {
  const out = await mkdtemp(path.join(tmpdir(), 'guide-repo-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  await mkdir(path.join(out, '.git'));
  await writeFile(path.join(out, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(path.join(out, 'stale.md'), 'old');
  const { stdout } = await run('bash', [SCRIPT, '--skip-checks', '--export', out], { maxBuffer: 16 * 1024 * 1024 });
  assert.match(stdout, /已导出到/);
  for (const keep of ['README.md', 'VERSION', 'CHANGELOG.md', '.gitignore', 'docs/delivery/README.md', 'docs/delivery/handover.md', 'docs/delivery/customer-rollout.md',
    'docs/delivery/deploy-iteration.md', 'docs/build-html.sh', 'skills/nexus-ai-operator/SKILL.md', 'skills/nexus-ai-operator/scripts/nexus.py',
    'poc/app/server.mjs', 'poc/app/lib/a2a-client.mjs', 'poc/web/package.json', 'poc/infra/deploy.sh', 'poc/infra/test/infra.test.mjs', 'poc/bench/build-jiuan.sh',
    'patches/jiuan-v0.7.10', 'audit-agent/prompt.yaml', 'kb/deploy.sh', 'knowledgebase-writer-agent-pg/README.md', 'customer-deploy/README.md']) {
    assert.ok(await exists(path.join(out, keep)), `应该有 ${keep}`);
  }
  for (const drop of ['docs/specs', 'docs/plans', 'docs/progress.html', 'progress.json', 'tools', 'RULES_PLAN.md', 'docs/delivery/code-review-2026-10-17.md',
    'docs/assessment.md', 'docs/feasibility-round2.md', 'docs/compromise-round3.md', 'docs/poc-a2a-round4.md', 'docs/replication-feasibility.md',
    'docs/agent-discovery-registration.html', 'docs/assets/diagrams/review-quadrant.svg', 'evidence', 'archive', 'poc/infra/secrets.env', 'poc/a2a-entry',
    'get_passwd.sh', 'poc/bench/node_modules', 'poc/app/test/e2e/node_modules', 'poc/infra/.state', 'stale.md', 'MANIFEST.txt', 'PACKAGE-INFO.txt',
    'poc/tools', 'skills/agent-access', 'knowledge-agent', 'contract', 'docs/delivery/patches', 'poc/app07', 'poc/web07']) {
    assert.equal(await exists(path.join(out, drop)), false, `不应该有 ${drop}`);
  }
  assert.ok(await exists(path.join(out, '.git', 'HEAD')), '.git 要保留');
  assert.match(await readFile(path.join(out, '.gitignore'), 'utf8'), /^poc\/infra\/secrets\.env$/m);
});

// 在仓库里的文档管家包中临时放一个探针文件；已有的同名文件（真实的部署设置、状态）不碰。测试结束删掉探针和为它新建的目录
async function plant(t, file) {
  if (await exists(file)) return;
  let top = file;
  while (!(await exists(path.dirname(top)))) top = path.dirname(top);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '# package.test.mjs 临时放的探针，测试结束就删\n');
  t.after(() => rm(top, { recursive: true, force: true }));
}

// 探针都没提交进 git，所以 tests/fixtures 里的那个也不带（只带提交过的文件）；这里核对的是白名单的排除规则
test('make-package.sh --export：带上文档管家（knowbase-s3vectors-agent），不带它的 deploy.env、.state、.build、build/out、__pycache__ 和 .docx（tests/fixtures 的仿真文档除外）', async t => {
  const pkg = fileURLToPath(new URL('../../../knowbase-s3vectors-agent/', import.meta.url));
  for (const probe of ['deploy.env', '.state/package-test-probe', '.build/package-test-probe', 'build/out/package-test-probe',
    'tools/__pycache__/package-test-probe.pyc', 'package-test-probe.docx', 'tests/fixtures/package-test-probe.docx']) {
    await plant(t, path.join(pkg, probe));
  }
  const out = await exportTo(t);
  const dir = path.join(out, 'knowbase-s3vectors-agent');
  for (const keep of ['GUIDE.zh.md', 'deploy.env.example', '.gitignore', 'tools/s3vectors_kb_tools.py', 'tests/local_test.py']) {
    assert.ok(await exists(path.join(dir, keep)), `应该有 knowbase-s3vectors-agent/${keep}`);
  }
  for (const drop of ['deploy.env', '.state', '.build', 'build/out', 'tests/fixtures/package-test-probe.docx']) {
    assert.equal(await exists(path.join(dir, drop)), false, `不应该有 knowbase-s3vectors-agent/${drop}`);
  }
  const { stdout } = await run('find', [dir, '(', '-name', '__pycache__', '-o', '-name', '*.docx', ')', '!', '-path', path.join(dir, 'tests/fixtures/*.docx')]);
  assert.equal(stdout, '', '只有 tests/fixtures 里能有 .docx，哪里都不能有 __pycache__');
  const ignore = await readFile(path.join(out, '.gitignore'), 'utf8');
  for (const line of ['knowbase-s3vectors-agent/deploy.env', 'knowbase-s3vectors-agent/.state/']) assert.ok(ignore.split('\n').includes(line), `.gitignore 要挡住 ${line}`);
});

test('make-package.sh --export：只带提交进 git 的文件：白名单目录里没提交的（草稿、本机的笔记）不带，并列出名字', async t => {
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  const drafts = ['docs/package-test-draft.md', 'kb/package-test-draft.txt', 'poc/infra/package-test-草稿.md'];
  for (const draft of drafts) await plant(t, path.join(repo, draft));
  // 一整个没进 git 的目录（例如别人放的大目录）：拷的时候就跳过，只报一次目录，不逐个文件列
  for (const name of ['a.txt', 'deep/b.txt']) await plant(t, path.join(repo, 'docs/package-test-dir', name));
  const out = await mkdtemp(path.join(tmpdir(), 'guide-repo-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  const { stdout } = await run('bash', [SCRIPT, '--skip-checks', '--export', out], { maxBuffer: 16 * 1024 * 1024 });
  for (const draft of drafts) {
    assert.equal(await exists(path.join(out, draft)), false, `没提交的 ${draft} 不该带上`);
    assert.ok(stdout.includes(draft), `要列出没带上的 ${draft}`);
  }
  for (const keep of ['docs/delivery/delivery-guide.md', 'kb/deploy.sh', 'poc/infra/deploy.sh']) assert.ok(await exists(path.join(out, keep)), `应该有 ${keep}`);
  assert.equal(await exists(path.join(out, 'docs/package-test-dir')), false);
  assert.ok(stdout.includes('docs/package-test-dir/'), '要列出没带上的目录');
  assert.ok(!stdout.includes('docs/package-test-dir/deep/b.txt'), '目录只报一次，不逐个文件列');
  const script = await readFile(SCRIPT, 'utf8');
  assert.match(script, /ls-files -z --others --directory/, '拷之前就按 git 收好的目录跳过');
});

test('make-package.sh 的检查：哪一项没过就停下、不出包（不能写成「… && echo 通过」，那样没过也接着出包）；知识库工具的单元测试装上依赖再跑；PACKAGE-INFO 只写真跑了的检查', async () => {
  const script = await readFile(SCRIPT, 'utf8');
  const checks = script.slice(script.indexOf('if $CHECKS; then'), script.indexOf('say "按白名单暂存"'));
  assert.ok(checks.length > 200, '要有检查段');
  assert.doesNotMatch(checks, /&&\s*echo\b/, '「… && echo」在 set -e 下失败了也不停');
  assert.match(checks, /uv run [\s\S]*?--with openpyxl[\s\S]*?--with pdfplumber[\s\S]*?unittest discover -s kb\/tests/);
  for (const label of ['部署脚本和栈模板的测试', '九安 v0.7.10 外壳的单元测试', '知识库工具的单元测试', '审核 Agent 下发脚本的单元测试']) assert.ok(checks.includes(label), `要检查：${label}`);
  const info = script.split('\n').find(line => line.includes('echo "检查：'));
  assert.doesNotMatch(info, /参考补丁|命令行测试/, 'v0.5.3 的检查已经没有了');
});

const EXAMPLES = { i: 'i-0123456789abcdef0', vpc: 'vpc-0123456789abcdef0', snap: 'snap-0123456789abcdef0', vol: 'vol-0123456789abcdef0', sg: 'sg-0123456789abcdef0' };

async function exportTo(t) {
  const out = await mkdtemp(path.join(tmpdir(), 'guide-repo-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  await run('bash', [SCRIPT, '--skip-checks', '--export', out], { maxBuffer: 16 * 1024 * 1024 });
  return out;
}

async function textFiles(dir) {
  const { stdout } = await run('find', [dir, '-type', 'f', '!', '-path', '*/.git/*'], { maxBuffer: 16 * 1024 * 1024 });
  const files = [];
  for (const file of stdout.trim().split('\n')) {
    const text = await readFile(file, 'utf8').catch(() => null);
    if (text !== null && !text.includes('\u0000')) files.push([path.relative(dir, file), text]);
  }
  return files;
}

test('导出时把 AWS 账户和 EC2 的标识换成 AWS 文档的示例值；对照表本身不导出，对照表里的真实值一个都不留', async t => {
  const out = await exportTo(t);
  assert.equal(await exists(path.join(out, 'docs/delivery/sanitize.conf')), false, '对照表不能导出');
  const files = await textFiles(out);
  for (const [name, text] of files) {
    for (const [kind, pattern] of [['i', /\bi-[0-9a-f]{17}\b/g], ['vpc', /\bvpc-[0-9a-f]{17}\b/g], ['snap', /\bsnap-[0-9a-f]{17}\b/g], ['vol', /\bvol-[0-9a-f]{17}\b/g], ['sg', /\bsg-[0-9a-f]{17}\b/g]]) {
      for (const match of text.match(pattern) ?? []) assert.equal(match, EXAMPLES[kind], `${name} 里还有 ${kind} 标识`);
    }
    for (const match of text.match(/\bsubnet-[0-9a-f]{17}\b/g) ?? []) assert.match(match, /^subnet-0123456789abcdef[01]$/, `${name} 里还有 subnet`);
    for (const match of text.match(/arn:aws:[a-z0-9-]+:[a-z0-9-]*:\d{12}/g) ?? []) assert.match(match, /:123456789012$/, `${name} 里的 ARN 带着真实账号`);
    for (const match of text.match(/artifactbucket-[a-z0-9]+/g) ?? []) assert.equal(match, 'artifactbucket-example', `${name} 里还有构件桶名`);
  }
  const conf = await readFile(fileURLToPath(new URL('../../../docs/delivery/sanitize.conf', import.meta.url)), 'utf8').catch(() => null);
  if (conf) {
    const reals = conf.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#')).map(line => line.split(/\s+=>\s+/)[0]);
    assert.ok(reals.length >= 5, '对照表至少要有账号、实例、IP、构件桶、CloudFront');
    for (const [name, text] of files) for (const real of reals) assert.equal(text.includes(real), false, `${name} 里还留着一个真实值`);
  }
});

test('secrets.env.example 随交接内容走：键都在、值都是假的；.gitignore 挡住 secrets.env，但不挡样例', async t => {
  const out = await exportTo(t);
  const example = await readFile(path.join(out, 'poc/infra/secrets.env.example'), 'utf8');
  const keys = [...example.matchAll(/^(# )?([A-Z][A-Za-z0-9_]*)=(.*)$/gm)];
  for (const name of ['REVIEWER_PASSWORD', 'CHECKER_PASSWORD', 'BENCH_PG_SUPERUSER_PASSWORD', 'JIUAN_PG_APP_PASSWORD', 'BENCH_MYSQL_ROOT_PASSWORD', 'JIUAN_MYSQL_APP_PASSWORD', 'JIUAN_DATA_KEY']) {
    assert.ok(keys.some(([, , key]) => key === name), `样例里要有 ${name}`);
  }
  // 照抄样例不能上线一套公开的口令：没注释掉的值一律留空；要 deploy.sh 自动生成的几项保持注释
  for (const [, commented, key, value] of keys) assert.equal(value, '', `${key}${commented ? '（注释里）' : ''} 不能带值`);
  for (const name of ['BENCH_PG_SUPERUSER_PASSWORD', 'JIUAN_PG_APP_PASSWORD', 'BENCH_MYSQL_ROOT_PASSWORD', 'JIUAN_MYSQL_APP_PASSWORD', 'JIUAN_DATA_KEY']) {
    assert.match(example, new RegExp(`^# ${name}=$`, 'm'), `${name} 要保持注释，让 deploy.sh 自动生成`);
  }
  assert.match(example, /\/etc\/andon-finance\/secrets\.env/);
  assert.match(example, /\/etc\/andon-finance\/bench\//);
  const ignore = await readFile(path.join(out, '.gitignore'), 'utf8');
  assert.match(ignore, /^poc\/infra\/secrets\.env$/m);
  assert.match(ignore, /^!poc\/infra\/secrets\.env\.example$/m);
});
