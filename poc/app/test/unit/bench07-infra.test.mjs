import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DEPLOY_ENV_KEYS, childEnv } from './helpers/child-env.mjs';
import { asBefore } from './helpers/template-as-before.mjs';

const execFileAsync = promisify(execFile);
// 子进程不继承部署的环境（DEPLOY_ENV 和环境配置的键，见 helpers/child-env.mjs）；自己给了 env 的调用照它给的
const run = (file, args, options = {}) => execFileAsync(file, args, { env: childEnv(), ...options });
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

test('模板：九安 v0.7.10 只多一个 CloudFront 分发和两条记录，源站还是实例的 4180；实例和安全组一个字不改（经 SSH 管理的几处按默认值还原后）', async () => {
  const template = asBefore(await readFile(infra('andon-finance-poc.yaml'), 'utf8'));
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

// ---- 新前端（poc/web07，React）：部署时按锁文件装依赖、跑测试、构建；dist/ 进构件的 web07/dist，外壳的前门默认找 app07/../web07/dist ----
const WEB_BUILD = 'web_build() { (unset -v DEPLOY_ENV "${DEPLOY_ENV_KEYS[@]}"; cd "$1" && npm ci && npm test && npm run build); }';
const WEB_RSYNC = 'rsync -a --exclude .DS_Store "$POC_DIR/web07/dist/" "$STAGE/release/web07/dist/"';

test('deploy.sh：动 AWS 资源之前先构建新前端（npm ci → npm test → npm run build），再跑外壳的单元测试（前门对真实 dist 的那条测的就是要发的这份）；dist/ 打进构件的 web07/dist；外壳默认就找这里', async () => {
  const deploy = await readFile(infra('deploy.sh'), 'utf8');
  const lines = deploy.split('\n');
  assert.ok(lines.find(line => line.startsWith('for tool in ')).split(' ').includes('npm'), '检查工具时要有 npm');
  assert.equal(lines.find(line => line.startsWith('web_build() ')), WEB_BUILD);
  const at = text => { const index = lines.indexOf(text); assert.ok(index > 0, `deploy.sh 里没有这一行：${text}`); return index; };
  const build = at('web_build "$POC_DIR/web07"');
  const shellTests = at('unit_tests "$POC_DIR/app07"');
  assert.ok(at('"$POC_DIR/bench/build-jiuan07.sh"') < build, '先构建九安 v0.7.10 副本');
  assert.ok(build < shellTests, '先构建新前端，再跑外壳的单元测试：前门对 poc/web07/dist 的那条测试测的是这次构建、要发出去的那份');
  assert.ok(shellTests < lines.findIndex(line => line.includes('aws cloudformation deploy')), '外壳的单元测试不过就不建栈、不更新栈');
  assert.ok(build < lines.findIndex(line => line.includes('aws cloudformation deploy')), '新前端构建不过就不建栈、不更新栈');
  const mkdir = lines.find(line => line.startsWith('mkdir -p "$STAGE/release/app"'));
  assert.ok(mkdir.includes('"$STAGE/release/web07/dist"'), '构件里先建好 web07/dist');
  assert.ok(build < at(WEB_RSYNC) && at(WEB_RSYNC) < lines.findIndex(line => line.includes('tar --no-mac-metadata')), '构建在前，复制进构件、再打包');
  const front = await readFile(fileURLToPath(new URL('../../../app07/front.mjs', import.meta.url)), 'utf8');
  assert.match(front, /webDir = path\.join\(here, '\.\.\/web07\/dist'\)/, '实例上外壳是 current/app07/server.mjs，构件里是 current/web07/dist');
});

test('deploy.sh 的 web_build：在 poc/web07 里依次 npm ci、npm test、npm run build，DEPLOY_ENV 和环境配置的键都不传给 npm；哪一步失败部署就停', async t => {
  const fn = (await readFile(infra('deploy.sh'), 'utf8')).split('\n').find(line => line.startsWith('web_build() '));
  assert.ok(fn, 'deploy.sh 里应有一行 web_build() { … }');
  const fixture = fileURLToPath(new URL('../fixtures/deploy-env/s3v.env', import.meta.url));
  const dir = await mkdtemp(path.join(tmpdir(), 'deploy-web-build-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = npm => ['set -euo pipefail', `source ${JSON.stringify(infra('lib/deploy-env.sh'))}`, 'load_deploy_env 2>/dev/null', fn, npm,
    'printf "loaded=%s\\n" "${DEPLOY_ENV_LOADED[*]}"', `web_build ${JSON.stringify(dir)}`, 'echo AFTER_BUILD'].join('\n');
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, DEPLOY_ENV: fixture, KB_ALLOWED_CIDR: '10.9.0.0/16', KEEP_ME: 'yes' };
  const { stdout } = await run('bash', ['-c', script('npm() { printf "npm=%s cwd=%s\\n" "$*" "$PWD"; [[ "$1" != ci ]] || env; }')], { env });
  const lines = stdout.split('\n');
  assert.ok(lines.find(line => line.startsWith('loaded=')).split(/[= ]/).includes('KB_MODE'), '先确认读进来了（并 export 了）');
  assert.deepEqual(lines.filter(line => line.startsWith('npm=')), [`npm=ci cwd=${dir}`, `npm=test cwd=${dir}`, `npm=run build cwd=${dir}`]);
  assert.ok(lines.includes('KEEP_ME=yes'), '别的环境变量照常传');
  assert.deepEqual(lines.map(line => line.slice(0, line.indexOf('='))).filter(name => name === 'DEPLOY_ENV' || DEPLOY_ENV_KEYS.includes(name)), []);
  assert.ok(lines.includes('AFTER_BUILD'));
  for (const step of ['ci', 'test', 'run']) {
    const failed = await run('bash', ['-c', script(`npm() { printf "npm=%s\\n" "$*"; [[ "$1" != ${step} ]]; }`)], { env }).then(() => null, error => error);
    assert.ok(failed && failed.code !== 0, `npm ${step} 失败时部署要停`);
    assert.doesNotMatch(failed.stdout, /AFTER_BUILD/, step);
    const ran = failed.stdout.split('\n').filter(line => line.startsWith('npm=')).map(line => line.slice(4).split(' ')[0]);
    assert.deepEqual(ran, ['ci', 'test', 'run'].slice(0, ['ci', 'test', 'run'].indexOf(step) + 1), step);
  }
});

// ---- 知识库两种方式（KB_MODE=pg|s3vectors，不写就是 pg）：「制度知识库」页都经 Nexus 上的知识库 Agent（A2A），测试台不直连 PG。
// deploy.sh 把方式和当前方式的知识库 Agent 发布（pg：KB_PG_PUBLICATION_ID；s3vectors：KB_S3V_PUBLICATION_ID）交给 bench07-configure.sh ----
const KB_PUB = 'pub_0123456789abcdef';
const PG_PUB = 'pub_fedcba9876543210';
const SITE = ['jiuan.example.com', 'https://nexus.example.com'];
const deployPrelude = deploy => deploy.slice(0, deploy.indexOf('\nsay() ')).replace(/^#!.*\n/, '');

// 照 deploy.sh 拼 SSM 命令（先跑它开头的检查，栈参数换成假的），再看 bench07-configure.sh 实际收到哪几个参数
async function configureArgs(env) {
  const deploy = await readFile(infra('deploy.sh'), 'utf8');
  const line = prefix => deploy.split('\n').find(text => text.startsWith(prefix));
  const script = [deployPrelude(deploy), 'param() { echo https://nexus.example.com; }', 'BUCKET=b REGION=us-east-1 ENV_B64=e30= POC_STORE=mysql J07_DOMAIN=jiuan.example.com',
    line('INSTALL='), line('COMMANDS='), 'printf "%s" "$COMMANDS"'].join('\n');
  const { stdout } = await run('bash', ['-c', script], { cwd: infra('.'), env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } });
  const [install] = JSON.parse(stdout).commands;
  const start = install.indexOf('bench07-configure.sh ') + 'bench07-configure.sh '.length;
  const call = install.slice(start, install.indexOf(' && systemctl restart andon-finance-poc', start));
  return (await run('bash', ['-c', `printf '[%s]' ${call}`])).stdout;
}

test('deploy.sh：KB_MODE（缺省 pg）和当前方式的知识库 Agent 发布是 bench07-configure.sh 的第 3、4 个参数（pg 用 KB_PG_PUBLICATION_ID，s3vectors 用 KB_S3V_PUBLICATION_ID）；SSM 命令仍是合法 JSON', async () => {
  const deploy = await readFile(infra('deploy.sh'), 'utf8');
  assert.match(deploy.split('\n').find(text => text.startsWith('INSTALL=')),
    /\/bench\/bench07-configure\.sh \$J07_DOMAIN \$\(param NexusOrigin\) '\$\{KB_MODE:-pg\}' '\$KB_PUBLICATION' && /);
  assert.equal(await configureArgs({}), '[jiuan.example.com][https://nexus.example.com][pg][]');
  assert.equal(await configureArgs({ KB_PG_PUBLICATION_ID: PG_PUB }), `[jiuan.example.com][https://nexus.example.com][pg][${PG_PUB}]`);
  assert.equal(await configureArgs({ KB_MODE: 'pg', KB_PG_PUBLICATION_ID: PG_PUB, KB_S3V_PUBLICATION_ID: KB_PUB }), `[jiuan.example.com][https://nexus.example.com][pg][${PG_PUB}]`);
  assert.equal(await configureArgs({ KB_MODE: 'pg', KB_S3V_PUBLICATION_ID: KB_PUB }), '[jiuan.example.com][https://nexus.example.com][pg][]', 'pg 方式不拿文档管家的发布');
  assert.equal(await configureArgs({ KB_MODE: 's3vectors', KB_S3V_PUBLICATION_ID: KB_PUB }), `[jiuan.example.com][https://nexus.example.com][s3vectors][${KB_PUB}]`);
  assert.equal(await configureArgs({ KB_MODE: 's3vectors', KB_S3V_PUBLICATION_ID: KB_PUB, KB_PG_PUBLICATION_ID: PG_PUB }), `[jiuan.example.com][https://nexus.example.com][s3vectors][${KB_PUB}]`);
});

test('deploy.sh：KB_MODE 只能是 pg 或 s3vectors，s3vectors 时要有 KB_S3V_PUBLICATION_ID，两个发布编号给了就要合格式（pg 的不强制）——在动任何 AWS 资源之前就停（exit 2）', async () => {
  const deploy = await readFile(infra('deploy.sh'), 'utf8');
  const prelude = deployPrelude(deploy);
  const runPrelude = env => run('bash', ['-c', `${prelude}\necho PRELUDE_OK`], { cwd: infra('.'), env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } });
  for (const env of [{}, { KB_MODE: 'pg' }, { KB_PG_PUBLICATION_ID: PG_PUB }, { KB_MODE: 'pg', KB_PG_PUBLICATION_ID: PG_PUB },
    { KB_MODE: 's3vectors', KB_S3V_PUBLICATION_ID: KB_PUB }]) assert.equal((await runPrelude(env)).stdout, 'PRELUDE_OK\n', JSON.stringify(env));
  for (const env of [{ KB_MODE: 'mongo' }, { KB_MODE: 's3vectors' }, { KB_MODE: 's3vectors', KB_S3V_PUBLICATION_ID: 'pub_0123' },
    { KB_MODE: 's3vectors', KB_S3V_PUBLICATION_ID: `${KB_PUB}' && reboot '` }, { KB_S3V_PUBLICATION_ID: "pub_x'" }]) {
    await assert.rejects(runPrelude(env), error => error.code === 2 && !error.stdout.includes('PRELUDE_OK') && /KB_MODE|KB_S3V_PUBLICATION_ID/.test(error.stderr), JSON.stringify(env));
  }
  for (const env of [{ KB_PG_PUBLICATION_ID: 'pub_0123' }, { KB_MODE: 'pg', KB_PG_PUBLICATION_ID: PG_PUB.toUpperCase() }, { KB_PG_PUBLICATION_ID: `${PG_PUB}' && reboot '` },
    { KB_MODE: 's3vectors', KB_S3V_PUBLICATION_ID: KB_PUB, KB_PG_PUBLICATION_ID: "pub_x'" }]) {
    await assert.rejects(runPrelude(env), error => error.code === 2 && !error.stdout.includes('PRELUDE_OK') && /KB_PG_PUBLICATION_ID/.test(error.stderr), JSON.stringify(env));
  }
});

// 跑 bench07-configure.sh 的参数检查 + jiuan07-kb 段 + 写 env 那段：install / write_secret / sed / curl / python3 换成只记账的桩，
// DIR 指到临时目录（里面放一份旧的 kb_pg_password）；上传目录 /var/lib/jiuan07/kb-uploads 换成临时目录，里面放上 PG 直连时留下的
// <id>.rules.json（和别的文件，看它们碰不碰）；调用记录里再换回原路径
const KB_UPLOADS = '/var/lib/jiuan07/kb-uploads';
const UPLOAD_LEFTOVERS = ['1.rules.json', '12.rules.json', '.tmp-0a1b2c3d4e5f.rules.json'];
const UPLOAD_KEEP = ['0123abcd.docx', '1.rules.json.bak', 'history.json', 'keep.rules.json'];
async function configureKb(t, args, { oldPassword = true } = {}) {
  const script = await readFile(infra('bench/bench07-configure.sh'), 'utf8');
  const dir = await mkdtemp(path.join(tmpdir(), 'bench07-kb-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'calls.log');
  if (oldPassword) await writeFile(path.join(dir, 'kb_pg_password'), 'not-a-real-password');
  const uploads = path.join(dir, 'kb-uploads');
  await mkdir(path.join(uploads, 'keep.rules.json'), { recursive: true });   // 同名的目录不删
  for (const name of [...UPLOAD_LEFTOVERS, ...UPLOAD_KEEP.filter(name => name !== 'keep.rules.json')]) await writeFile(path.join(uploads, name), 'x');
  const between = (start, end) => {
    const from = script.indexOf(start), to = script.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `bench07-configure.sh 里没有 ${start}`);
    return script.slice(from, to + end.length);
  };
  const prelude = script.slice(0, script.indexOf('\nHERE=')).replace(/^#!.*\n/, '');
  const stubs = [`LOG=${JSON.stringify(log)}; DIR=${JSON.stringify(dir)}; : > "$LOG"`,
    `install() { printf 'install %s\\n' "$*" >> "$LOG"; }`, `write_secret() { printf 'write_secret %s\\n' "$1" >> "$LOG"; }`,
    `sed() { printf 'sed %s\\n' "$*" >> "$LOG"; command sed "$@"; }`, `curl() { printf 'curl\\n' >> "$LOG"; echo 10.0.0.5; }`,
    `python3() { printf 'python3 %s\\n' "$*" >> "$LOG"; }`].join('\n');
  const leftover = () => readFile(path.join(dir, 'kb_pg_password'), 'utf8').then(() => true, () => false);
  try {
    const kb = between('# >>> jiuan07-kb', '# <<< jiuan07-kb').replaceAll(KB_UPLOADS, uploads);
    await run('bash', ['-c', [prelude, stubs, kb, between('cat > "$DIR/env.new" <<ENV', '\nENV\n')].join('\n'), 'bench07-configure.sh', ...args]);
  } catch (error) { return { code: error.code, stderr: error.stderr, wrote: await readFile(path.join(dir, 'env.new'), 'utf8').then(() => true, () => false), leftover: await leftover() }; }
  return { code: 0, env: await readFile(path.join(dir, 'env.new'), 'utf8'), leftover: await leftover(), uploads: (await readdir(uploads)).sort(),
    calls: (await readFile(log, 'utf8')).split('\n').filter(Boolean).map(line => line.replaceAll(uploads, KB_UPLOADS)) };
}
const UPLOADS = 'install -d -o jiuan07 -g jiuan07 -m 0700 /var/lib/jiuan07/kb-uploads';
const NO_PG = /POC07_KB_PG_HOST|POC07_KB_USER|POC07_KB_DB|POC07_KB_DIR|POC07_KB_PYTHON|POC07_KB_S3V_PUBLICATION_ID|not-a-real-password/;

test('bench07-configure.sh 两种方式一个样：写 POC07_KB_MODE 和知识库 Agent 的发布 POC07_KB_PUBLICATION_ID，只建上传目录；不读 PG 主机的 .env、不写任何密钥文件、不建 venv、不碰 IMDS，旧的 kb_pg_password 删掉', async t => {
  for (const [mode, id] of [['s3vectors', KB_PUB], ['pg', PG_PUB]]) {
    const result = await configureKb(t, [...SITE, mode, id]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.env, new RegExp(`^POC07_KB_MODE=${mode}\\nPOC07_KB_PUBLICATION_ID=${id}$`, 'm'), mode);
    assert.doesNotMatch(result.env, NO_PG, mode);
    assert.deepEqual(result.calls, [UPLOADS], mode);
    assert.equal(result.leftover, false, `${mode}：实例上留下的连库密码文件要删掉`);
    assert.deepEqual(result.uploads, [...UPLOAD_KEEP].sort(), `${mode}：PG 直连时留下的 <id>.rules.json（从制度派生的规则）删掉，别的文件和同名目录不动`);
  }
});

test('bench07-configure.sh：没给发布编号（或不给第 3 个参数，旧的调用方式就是 pg）也照常配置，env 里不写 POC07_KB_PUBLICATION_ID（页面说「知识库 Agent 还没配置」）；没有旧密码文件也不出错', async t => {
  for (const args of [SITE, [...SITE, 'pg'], [...SITE, 'pg', ''], [...SITE, 's3vectors', '']]) {
    const result = await configureKb(t, args, { oldPassword: args.length === 2 });
    assert.equal(result.code, 0, `${JSON.stringify(args)}：${result.stderr}`);
    assert.match(result.env, new RegExp(`^POC07_KB_MODE=${args[2] || 'pg'}$`, 'm'));
    assert.doesNotMatch(result.env, /POC07_KB_PUBLICATION_ID/);
    assert.doesNotMatch(result.env, NO_PG);
    assert.deepEqual(result.calls, [UPLOADS]);
    assert.equal(result.leftover, false);
    assert.deepEqual(result.uploads, [...UPLOAD_KEEP].sort());
  }
});

test('bench07-configure.sh：kb 方式只能是 pg 或 s3vectors，发布编号给了就要是 pub_ 加 16 位十六进制（两种方式都是）；不合格就退出（2），env 一个字不写', async t => {
  const bad = ['pub_0123', KB_PUB.toUpperCase(), `${KB_PUB}x`, `${KB_PUB}\nPOC07_KB_PG_HOST=evil`, ' ', `${KB_PUB}' && reboot '`];
  for (const args of [[...SITE, 'mongo'], ...bad.flatMap(id => [[...SITE, 's3vectors', id], [...SITE, 'pg', id]])]) {
    const result = await configureKb(t, args);
    assert.equal(result.code, 2, JSON.stringify(args));
    assert.match(result.stderr, /pg 或 s3vectors|发布编号/, JSON.stringify(args));
    assert.equal(result.wrote, false);
  }
});

test('bench07-configure.sh：测试台不直连 PG——整份脚本不读 PG 主机的 .env、不写 kb_pg_password、不建 kb-venv、不取私网 IP；两种方式都建 /var/lib/jiuan07/custom-rules（jiuan07 0700，不在任何分支里）', async () => {
  const script = await readFile(infra('bench/bench07-configure.sh'), 'utf8');
  for (const gone of ['/opt/nexus-pgvector', 'NEXUS_DB_PASSWORD', 'write_secret kb_pg_password', 'kb-venv', 'psycopg', '169.254.169.254', 'local-ipv4',
    'POC07_KB_PG_HOST', 'POC07_KB_USER', 'POC07_KB_DB', 'POC07_KB_DIR', 'POC07_KB_PYTHON', 'POC07_KB_S3V_PUBLICATION_ID']) assert.ok(!script.includes(gone), `还有 ${gone}`);
  const kb = script.slice(script.indexOf('# >>> jiuan07-kb'), script.indexOf('# <<< jiuan07-kb'));
  assert.match(kb, /^rm -f "\$DIR\/kb_pg_password"$/m);
  assert.match(kb, /^find "\/var\/lib\/jiuan07\/kb-uploads" -maxdepth 1 -type f -name '\*\.rules\.json' -delete$/m, '只删上传目录第一层的 *.rules.json 文件');
  assert.match(kb, /^install -d -o jiuan07 -g jiuan07 -m 0700 \/var\/lib\/jiuan07\/kb-uploads$/m, '上传目录不在任何分支里');
  assert.doesNotMatch(kb, /^(if|elif) /m, 'kb 段不再按方式分支');
  const dirs = script.indexOf('\ninstall -d -o jiuan07 -g jiuan07 -m 0700 /var/lib/jiuan07 /var/lib/jiuan07/nexus /var/lib/jiuan07/custom-rules\n');
  assert.ok(dirs > 0 && dirs < script.indexOf('# >>> jiuan07-kb'), '数据目录在一开始就建好，和 kb 方式无关');
  assert.match(script, /^# 用法：bench07-configure\.sh <站点主机名> <Nexus 地址> \[<kb 方式> \[<知识库 Agent 发布编号>\]\]/m);
});
