import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const infra = name => fileURLToPath(new URL(`../../../infra/${name}`, import.meta.url));
const block = (text, name) => {
  const start = text.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `模板里没有 ${name}`);
  const next = text.slice(start + 1).search(/\n  [A-Za-z0-9]+:\n|\nOutputs:\n/);
  return text.slice(start + 1, next < 0 ? undefined : start + 1 + next);
};
// 九安 v0.7.10 代码里写死的外部主机（connectors.mjs、huilianyi-*.mjs、providers/*）
const BLACKHOLE = ['api.huilianyi.com', 'apistage.huilianyi.com', 'huoshantstapi.huilianyi.com', 'helioscloud-uat.huilianyi.com', 'oss-huilianyi.jiuan.com',
  'oapi.dingtalk.com', 'api.openai.com', 'finmcp.jiuan.local', 'sap-mcp.local', 'sub1api.jiuan.com', 'sub1api.theunifiedcare.com'];

test('模板：九安 v0.7.10 只多一个 CloudFront 分发和两条记录，源站还是实例的 4180；实例和安全组一个字不改', async () => {
  const template = await readFile(infra('andon-finance-poc.yaml'), 'utf8');
  const { stdout: committed } = await run('git', ['show', 'b7e710b:poc/infra/andon-finance-poc.yaml'], { cwd: infra('.'), maxBuffer: 8 * 1024 * 1024 });
  for (const name of ['Instance', 'AppSecurityGroup', 'InstanceRole', 'ElasticIp', 'OriginRecord', 'Distribution']) assert.equal(block(template, name), block(committed, name), `${name} 变了`);
  assert.match(block(template, 'Jiuan07DomainName'), /Default: jiuan-v0710\.tinyboat\.blog/);
  const distribution = block(template, 'Jiuan07Distribution');
  assert.match(distribution, /Aliases: \[!Ref Jiuan07DomainName\]/);
  assert.match(distribution, /DomainName: !Ref OriginDomainName/);
  assert.match(distribution, /HTTPPort: !Ref AppPort/);
  assert.match(distribution, /OriginRequestPolicyId: 216adef6-5c7f-47e4-b989-5492eafa07d3/);   // Managed-AllViewer：转发 Host，PoC 才认得出是哪个站
  assert.match(distribution, /AcmCertificateArn: !Ref CertificateArn/);
  for (const name of ['Jiuan07RecordA', 'Jiuan07RecordAAAA']) assert.match(block(template, name), /Name: !Ref Jiuan07DomainName[\s\S]*Jiuan07Distribution\.DomainName/);
  assert.match(template, /Jiuan07Url:\n\s+Value: !Sub 'https:\/\/\$\{Jiuan07DomainName\}'/);
});

test('配置脚本：服务以 jiuan07 用户跑（不进 andon 组，读不到 secrets.env）、只听本机、屏蔽实例元数据；库账号只看 jiuan07 库；堵住写死的外部地址', async () => {
  const script = await readFile(infra('bench/bench07-configure.sh'), 'utf8');
  const unit = await readFile(infra('bench/andon-jiuan07.service'), 'utf8');
  assert.match(unit, /^User=jiuan07$/m);
  assert.doesNotMatch(unit, /SupplementaryGroups|Group=andon/);
  assert.match(unit, /^IPAddressDeny=169\.254\.169\.254 fd00:ec2::254$/m);
  for (const line of ['NoNewPrivileges=true', 'ProtectSystem=strict', 'ProtectHome=true', 'PrivateTmp=true', 'ReadWritePaths=/var/lib/jiuan07', 'CapabilityBoundingSet=']) {
    assert.ok(unit.split('\n').includes(line), `单元里缺 ${line}`);
  }
  assert.match(unit, /^ExecStart=\/usr\/bin\/node-24 \/opt\/andon-finance\/current\/app07\/server\.mjs$/m);
  assert.match(script, /POC07_BIND=127\.0\.0\.1/);
  assert.match(script, /useradd --system [^\n]*jiuan07/);
  assert.doesNotMatch(script, /usermod[^\n]*andon|-G andon/);
  assert.match(script, /GRANT ALL PRIVILEGES ON \\`jiuan07\\`\.\* TO 'jiuan07_app'@'%'/);   // 不加引号的 heredoc 里反引号要转义
  assert.doesNotMatch(script, /ON \*\.\*/);
  for (const host of BLACKHOLE) assert.ok(script.includes(host), `/etc/hosts 没堵 ${host}`);
  assert.match(script, /POC_FORWARD_HOST=\$DOMAIN/);
  assert.match(script, /EnvironmentFile=-\/etc\/andon-finance\/jiuan07-forward\.env/);
  assert.doesNotMatch(script, /echo[^\n]*\$(MYSQL_PASSWORD|DATA_KEY|value)\b/, '不打印密钥');
  // 审核建议发给哪个发布由「Agent 接入」的启用记录决定；S3 Vectors 方式的文档管家发布由 deploy.sh 作为参数传进来，脚本里只核对格式
  assert.doesNotMatch(script, /NEXUS_REVIEW_ADVICE_PUBLICATION|PUBLISH|pub_[0-9a-f]/, '不写死发布');
});

test('配置脚本：实例上已有的库密码和数据密钥只认原值，和 secrets.env 不同就一个文件都不写', async () => {
  const script = await readFile(infra('bench/bench07-configure.sh'), 'utf8');
  assert.match(script, /JIUAN07_MYSQL_APP_PASSWORD:mysql_app_password/);
  assert.match(script, /JIUAN07_DATA_KEY:analysis_data_key/);
  assert.match(script, /拒绝替换/);
  const reset = await readFile(infra('bench/bench07-reset.sh'), 'utf8');
  assert.match(reset, /DROP DATABASE IF EXISTS `jiuan07`/);
  assert.doesNotMatch(reset, /jiuan_analysis/, '重置 v0.7.10 不碰 PoC 的库');
});

test('重置脚本：保留管理员在「Agent 接入」页上的启用记录（先导出、重建库跑完迁移后写回，再正式起服务），不读也不写任何调用密钥文件', async () => {
  const reset = await readFile(infra('bench/bench07-reset.sh'), 'utf8');
  const steps = ["scope_key LIKE 'agent-enablement:%'", 'DROP DATABASE IF EXISTS', 'systemctl start andon-jiuan07.service', 'systemctl stop andon-jiuan07.service',
    'mysql -uroot jiuan07', 'systemctl start andon-jiuan07.service'];
  let at = -1;
  for (const step of steps) {
    const next = reset.indexOf(step, at + 1);
    assert.ok(next > at, `重置顺序不对或缺少：${step}`);
    at = next;
  }
  assert.doesNotMatch(reset, /secrets\.env|NEXUS_A2A_KEY|nxa_/);
});

test('deploy.sh：构建 v0.7.10 副本、把 app07 和副本打进发布包；先配置 v0.7.10 再重启 PoC（它要读转发设置），最后重启 v0.7.10；密钥只补不换', async () => {
  const deploy = await readFile(infra('deploy.sh'), 'utf8');
  assert.match(deploy, /bench\/build-jiuan07\.sh/);
  assert.match(deploy, /rsync -a --exclude test --exclude scripts --exclude node_modules --exclude \.DS_Store "\$POC_DIR\/app07\/" "\$STAGE\/release\/app07\/"/);
  assert.match(deploy, /rsync -a --exclude \.DS_Store "\$POC_DIR\/\.\.\/\.build\/jiuan07\/" "\$STAGE\/release\/jiuan07\/"/);
  assert.match(deploy, /for name in BENCH_MYSQL_ROOT_PASSWORD BENCH_MYSQL_APP_PASSWORD BENCH_DATA_KEY JIUAN07_MYSQL_APP_PASSWORD JIUAN07_DATA_KEY; do/);
  const install = deploy.slice(deploy.indexOf('INSTALL="'), deploy.indexOf('\n', deploy.indexOf('INSTALL="')));
  const order = ['bench-configure.sh', 'bench07-configure.sh', 'systemctl restart andon-finance-poc.service', 'systemctl restart andon-jiuan07.service'].map(text => install.indexOf(text));
  assert.ok(order.every(index => index > 0) && order.every((index, i) => i === 0 || index > order[i - 1]), `安装顺序不对：${order}`);
  assert.match(deploy, /\/poc\/healthz/);
  assert.doesNotMatch(install.slice(install.indexOf('bench07-configure.sh'), install.indexOf('systemctl restart andon-finance-poc')), /AdvisoryPublicationId/, 'v0.7.10 不接收发布编号');
});

// ---- 知识库两种方式（KB_MODE=pg|s3vectors，不写就是 pg）：deploy.sh 把方式和文档管家的发布交给 bench07-configure.sh ----
const KB_PUB = 'pub_0123456789abcdef';
const SITE = ['jiuan.example.com', 'https://nexus.example.com'];

// 照 deploy.sh 拼 SSM 命令（栈参数换成假的），再看 bench07-configure.sh 实际收到哪几个参数
async function configureArgs(env) {
  const deploy = await readFile(infra('deploy.sh'), 'utf8');
  const line = prefix => deploy.split('\n').find(text => text.startsWith(prefix));
  const script = ['set -euo pipefail', 'param() { echo https://nexus.example.com; }', 'BUCKET=b REGION=us-east-1 ENV_B64=e30= POC_STORE=mysql J07_DOMAIN=jiuan.example.com',
    line('INSTALL='), line('COMMANDS='), 'printf "%s" "$COMMANDS"'].join('\n');
  const { stdout } = await run('bash', ['-c', script], { env: { PATH: process.env.PATH, ...env } });
  const [install] = JSON.parse(stdout).commands;
  const start = install.indexOf('bench07-configure.sh ') + 'bench07-configure.sh '.length;
  const call = install.slice(start, install.indexOf(' && systemctl restart andon-finance-poc', start));
  return (await run('bash', ['-c', `printf '[%s]' ${call}`])).stdout;
}

test('deploy.sh：KB_MODE（缺省 pg）和 KB_S3V_PUBLICATION_ID 是 bench07-configure.sh 的第 3、4 个参数；SSM 命令仍是合法 JSON', async () => {
  const deploy = await readFile(infra('deploy.sh'), 'utf8');
  assert.match(deploy.split('\n').find(text => text.startsWith('INSTALL=')),
    /\/bench\/bench07-configure\.sh \$J07_DOMAIN \$\(param NexusOrigin\) '\$\{KB_MODE:-pg\}' '\$\{KB_S3V_PUBLICATION_ID:-\}' && /);
  assert.equal(await configureArgs({}), '[jiuan.example.com][https://nexus.example.com][pg][]');
  assert.equal(await configureArgs({ KB_MODE: 's3vectors', KB_S3V_PUBLICATION_ID: KB_PUB }), `[jiuan.example.com][https://nexus.example.com][s3vectors][${KB_PUB}]`);
});

test('deploy.sh：KB_MODE 只能是 pg 或 s3vectors，s3vectors 时要有 KB_S3V_PUBLICATION_ID，发布编号格式不对也不行——在动任何 AWS 资源之前就停（exit 2）', async () => {
  const deploy = await readFile(infra('deploy.sh'), 'utf8');
  const prelude = deploy.slice(0, deploy.indexOf('\nsay() ')).replace(/^#!.*\n/, '');
  const runPrelude = env => run('bash', ['-c', `${prelude}\necho PRELUDE_OK`], { cwd: infra('.'), env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } });
  for (const env of [{}, { KB_MODE: 'pg' }, { KB_MODE: 's3vectors', KB_S3V_PUBLICATION_ID: KB_PUB }]) assert.equal((await runPrelude(env)).stdout, 'PRELUDE_OK\n', JSON.stringify(env));
  for (const env of [{ KB_MODE: 'mongo' }, { KB_MODE: 's3vectors' }, { KB_MODE: 's3vectors', KB_S3V_PUBLICATION_ID: 'pub_0123' },
    { KB_MODE: 's3vectors', KB_S3V_PUBLICATION_ID: `${KB_PUB}' && reboot '` }, { KB_S3V_PUBLICATION_ID: "pub_x'" }]) {
    await assert.rejects(runPrelude(env), error => error.code === 2 && !error.stdout.includes('PRELUDE_OK') && /KB_MODE|KB_S3V_PUBLICATION_ID/.test(error.stderr), JSON.stringify(env));
  }
});

// 跑 bench07-configure.sh 的参数检查 + jiuan07-kb 段 + 写 env 那段：install / write_secret / sed / curl 换成只记账的桩，
// PG 主机的 .env 和 kb-venv 指到临时目录（其余一字不改）
async function configureKb(t, args, { pgEnv = null } = {}) {
  const script = await readFile(infra('bench/bench07-configure.sh'), 'utf8');
  const dir = await mkdtemp(path.join(tmpdir(), 'bench07-kb-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const kbEnv = path.join(dir, 'nexus-pgvector.env'), venv = path.join(dir, 'kb-venv'), log = path.join(dir, 'calls.log');
  if (pgEnv) await writeFile(kbEnv, pgEnv);
  await mkdir(path.join(venv, 'bin'), { recursive: true });
  await writeFile(path.join(venv, 'bin/python'), '#!/bin/sh\nexit 0\n');
  await chmod(path.join(venv, 'bin/python'), 0o755);
  const between = (start, end) => {
    const from = script.indexOf(start), to = script.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `bench07-configure.sh 里没有 ${start}`);
    return script.slice(from, to + end.length);
  };
  const prelude = script.slice(0, script.indexOf('\nHERE=')).replace(/^#!.*\n/, '');
  const kb = between('# >>> jiuan07-kb', '# <<< jiuan07-kb').replace('KB_ENV=/opt/nexus-pgvector/.env', `KB_ENV=${JSON.stringify(kbEnv)}`).replaceAll('/opt/andon-finance/kb-venv', venv);
  const stubs = [`LOG=${JSON.stringify(log)}; DIR=${JSON.stringify(dir)}; : > "$LOG"`,
    `install() { printf 'install %s\\n' "$*" >> "$LOG"; }`, `write_secret() { printf 'write_secret %s\\n' "$1" >> "$LOG"; }`,
    `sed() { printf 'sed %s\\n' "$*" >> "$LOG"; command sed "$@"; }`, `curl() { printf 'curl\\n' >> "$LOG"; echo 10.0.0.5; }`,
    `python3() { printf 'python3 %s\\n' "$*" >> "$LOG"; }`].join('\n');
  try {
    await run('bash', ['-c', [prelude, stubs, kb, between('cat > "$DIR/env.new" <<ENV', '\nENV\n')].join('\n'), 'bench07-configure.sh', ...args]);
  } catch (error) { return { code: error.code, stderr: error.stderr, wrote: await readFile(path.join(dir, 'env.new'), 'utf8').then(() => true, () => false) }; }
  return { code: 0, env: await readFile(path.join(dir, 'env.new'), 'utf8'), calls: (await readFile(log, 'utf8')).split('\n').filter(Boolean) };
}
const PG_ENV = 'NEXUS_DB_USER=kbuser\nNEXUS_DB_PASSWORD=not-a-real-password\nNEXUS_DB_NAME=kbdb\n';

test('bench07-configure.sh s3vectors：写 POC07_KB_MODE=s3vectors 和文档管家的发布，建上传目录；不读 PG 主机的 .env、不写 kb_pg_password（也不写别的密钥文件），不碰 IMDS', async t => {
  const result = await configureKb(t, [...SITE, 's3vectors', KB_PUB], { pgEnv: PG_ENV });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.env, /^POC07_KB_MODE=s3vectors$/m);
  assert.match(result.env, new RegExp(`^POC07_KB_S3V_PUBLICATION_ID=${KB_PUB}$`, 'm'));
  assert.doesNotMatch(result.env, /POC07_KB_PG_HOST|POC07_KB_PYTHON|not-a-real-password/);
  assert.deepEqual(result.calls, ['install -d -o jiuan07 -g jiuan07 -m 0700 /var/lib/jiuan07/kb-uploads']);
});

test('bench07-configure.sh pg：写 POC07_KB_MODE=pg，知识库的设置照旧（PG 主机的 .env 在才写 kb_pg_password 和 POC07_KB_*）；pg 时给了发布编号也不写', async t => {
  const deployed = await configureKb(t, [...SITE, 'pg', KB_PUB], { pgEnv: PG_ENV });
  assert.equal(deployed.code, 0, deployed.stderr);
  assert.match(deployed.env, /^POC07_KB_MODE=pg\nPOC07_KB_PG_HOST=10\.0\.0\.5\nPOC07_KB_USER=kbuser\nPOC07_KB_DB=kbdb\nPOC07_KB_DIR=\/opt\/andon-finance\/current\/kb\nPOC07_KB_PYTHON=/m);
  assert.doesNotMatch(deployed.env, /POC07_KB_S3V_PUBLICATION_ID|pub_/);
  assert.ok(deployed.calls.includes('write_secret kb_pg_password'), deployed.calls.join('\n'));
  assert.ok(deployed.calls.includes('install -d -o jiuan07 -g jiuan07 -m 0700 /var/lib/jiuan07/kb-uploads'));
  // 不给第 3 个参数（旧的调用方式）就是 pg；PG 主机的 .env 不在就不开知识库
  const plain = await configureKb(t, SITE);
  assert.equal(plain.code, 0, plain.stderr);
  assert.match(plain.env, /^POC07_KB_MODE=pg$/m);
  assert.doesNotMatch(plain.env, /POC07_KB_PG_HOST|POC07_KB_S3V/);
  assert.deepEqual(plain.calls, []);
});

test('bench07-configure.sh：kb 方式只能是 pg 或 s3vectors，s3vectors 的发布编号要是 pub_ 加 16 位十六进制；不合格就退出（2），env 一个字不写', async t => {
  for (const args of [[...SITE, 'mongo'], [...SITE, 's3vectors'], [...SITE, 's3vectors', ''], [...SITE, 's3vectors', 'pub_0123'], [...SITE, 's3vectors', KB_PUB.toUpperCase()],
    [...SITE, 's3vectors', `${KB_PUB}x`], [...SITE, 's3vectors', `${KB_PUB}\nPOC07_KB_PG_HOST=evil`]]) {
    const result = await configureKb(t, args);
    assert.equal(result.code, 2, JSON.stringify(args));
    assert.match(result.stderr, /pg 或 s3vectors|发布编号/, JSON.stringify(args));
    assert.equal(result.wrote, false);
  }
});

test('bench07-configure.sh：pg 方式知识库那段一字不改（和改动前的提交比）；两种方式都建 /var/lib/jiuan07/custom-rules（jiuan07 0700，不在任何分支里）', async () => {
  const script = await readFile(infra('bench/bench07-configure.sh'), 'utf8');
  const { stdout: before } = await run('git', ['show', '50b5470:poc/infra/bench/bench07-configure.sh'], { cwd: infra('.') });
  const pgBody = text => {
    const head = 'if [[ -s "$KB_ENV" ]]; then\n';
    return text.slice(text.indexOf(head) + head.length, text.indexOf('\nfi\n# <<< jiuan07-kb'));
  };
  assert.ok(pgBody(before).length > 500);
  assert.equal(pgBody(script), pgBody(before));
  const dirs = script.indexOf('\ninstall -d -o jiuan07 -g jiuan07 -m 0700 /var/lib/jiuan07 /var/lib/jiuan07/nexus /var/lib/jiuan07/custom-rules\n');
  assert.ok(dirs > 0 && dirs < script.indexOf('# >>> jiuan07-kb'), '数据目录在一开始就建好，和 kb 方式无关');
  assert.match(script, /^# 用法：bench07-configure\.sh <站点主机名> <Nexus 地址> \[<kb 方式> \[<文档管家发布编号>\]\]/m);
});
