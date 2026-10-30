import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const infra = name => fileURLToPath(new URL(`../../../infra/${name}`, import.meta.url));

test('模板里的 Fn::Sub 只引用模板自己的参数、资源与伪参数（用户数据里的 shell 变量一律不带花括号）', async () => {
  const template = await readFile(infra('andon-finance-poc.yaml'), 'utf8');
  const tokens = [...new Set([...template.matchAll(/\$\{([^}]+)\}/g)].map(match => match[1]))].sort();
  assert.deepEqual(tokens, ['AWS::Partition', 'AWS::Region', 'AdvisoryPublicationId', 'AppPort', 'ArtifactBucket', 'ArtifactBucket.Arn',
    'DomainName', 'Jiuan07DomainName', 'NexusOrigin']);
});

test('模板的关键约束：只放 CloudFront 回源、不开 22 端口、固定 node-24、TLS 1.2、私有构件桶、关缓存并转发观众请求头', async () => {
  const template = await readFile(infra('andon-finance-poc.yaml'), 'utf8');
  assert.match(template, /SourcePrefixListId: !Ref CloudFrontPrefixListId/);
  assert.doesNotMatch(template, /FromPort: 22\b/);
  assert.match(template, /ExecStart=\/usr\/bin\/node-24 \/opt\/andon-finance\/current\/app\/server\.mjs/);
  assert.match(template, /MinimumProtocolVersion: TLSv1\.2_2021/);
  assert.match(template, /BlockPublicPolicy: true/);
  assert.match(template, /CachePolicyId: 4135ea2d-6df8-44a3-9df3-4b5a84be39ad/);
  assert.match(template, /OriginRequestPolicyId: 216adef6-5c7f-47e4-b989-5492eafa07d3/);
});

test('部署与清理脚本的 bash 语法正确，清理前要求输入栈名确认', async () => {
  for (const script of ['deploy.sh', 'destroy.sh']) await run('bash', ['-n', infra(script)]);
  assert.match(await readFile(infra('destroy.sh'), 'utf8'), /输入栈名确认/);
});

test('实例角色读不了任何 SSM 参数（应用不用 Parameter Store；显式 Deny 覆盖 AmazonSSMManagedInstanceCore 的 *），只能读构件与密钥配置文件', async () => {
  const template = await readFile(infra('andon-finance-poc.yaml'), 'utf8');
  assert.match(template, /Effect: Deny\s+Action: \[ssm:GetParameter, ssm:GetParameters, ssm:GetParametersByPath, ssm:GetParameterHistory\]\s+Resource: '\*'/);
  assert.doesNotMatch(template, /parameter\/andon-finance/);
  assert.match(template, /Resource:\s+- !Sub '\$\{ArtifactBucket\.Arn\}\/releases\/\*'\s+- !Sub '\$\{ArtifactBucket\.Arn\}\/secrets\/secrets\.env'/);
});

test('密钥只来自 infra/secrets.env：部署时上传、在重启前装到实例上；部署与 E2E 都不用 Parameter Store 存取口令或密钥', async () => {
  const template = await readFile(infra('andon-finance-poc.yaml'), 'utf8');
  const deploy = await readFile(infra('deploy.sh'), 'utf8');
  const e2e = await readFile(fileURLToPath(new URL('../e2e/run.sh', import.meta.url)), 'utf8');
  assert.match(deploy, /s3:\/\/\$BUCKET\/secrets\/secrets\.env/);
  assert.match(deploy, /aws s3 cp s3:\/\/\$\{?BUCKET\}?\/secrets\/secrets\.env \/etc\/andon-finance\/secrets\.env[^\n]*systemctl restart andon-finance-poc\.service/);
  assert.match(template, /aws s3 cp "s3:\/\/\$POC_BUCKET\/secrets\/secrets\.env" \/etc\/andon-finance\/secrets\.env/);
  for (const text of [deploy, e2e]) {
    assert.doesNotMatch(text, /put-parameter|--with-decryption|\/andon-finance\/poc\/(accounts|nexus)/);
  }
  assert.match(e2e, /secrets\.env/);
});

test('每次部署都按栈参数重写实例的 /etc/andon-finance/env：与用户数据写的是同一组变量，且在重启之前写', async () => {
  const template = await readFile(infra('andon-finance-poc.yaml'), 'utf8');
  const deploy = await readFile(infra('deploy.sh'), 'utf8');
  const keysOf = (text, start, end) => {
    const body = text.slice(text.indexOf(start) + start.length, text.indexOf(end, text.indexOf(start) + start.length));
    return body.split('\n').map(line => line.trim()).filter(line => /^[A-Z_]+=/.test(line)).map(line => line.split('=')[0]).sort();
  };
  const fromUserData = keysOf(template, "cat > /etc/andon-finance/env <<'ENV'", '\n          ENV');
  const fromDeploy = keysOf(deploy, '<<ENVFILE', '\nENVFILE');
  assert.ok(fromUserData.length >= 10);
  assert.deepEqual(fromDeploy, fromUserData);
  assert.match(deploy, /base64 -d > \/etc\/andon-finance\/env[^\n]*systemctl restart andon-finance-poc\.service/);
  assert.doesNotMatch(template, /Changing this text replaces the instance/);
});

test('在 macOS 上打包时不带 AppleDouble 与扩展属性（否则实例上解包会多出 ._* 文件和告警）', async () => {
  const deploy = await readFile(infra('deploy.sh'), 'utf8');
  assert.match(deploy, /COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs -czf/);
});

test('shell 脚本里变量名后面不能紧跟中文等非 ASCII 字符（bash 会把它们算进变量名，set -u 下直接报错）；要写成 ${VAR}', async () => {
  for (const file of [infra('deploy.sh'), infra('destroy.sh'), infra('backup.sh'), infra('upgrade-instance.sh'), infra('bench-test.sh'), infra('bench/mysql-install.sh'),
    infra('bench/bench-reset.sh'), infra('bench/bench-configure.sh'), infra('bench/bench07-configure.sh'), infra('bench/bench07-reset.sh'),
    fileURLToPath(new URL('../../../bench/build-jiuan07.sh', import.meta.url)),
    fileURLToPath(new URL('../e2e/run.sh', import.meta.url)),
    fileURLToPath(new URL('../../../../docs/delivery/make-package.sh', import.meta.url)), fileURLToPath(new URL('../../../../docs/build-html.sh', import.meta.url)),
    fileURLToPath(new URL('../../../../docs/delivery/patches/make-reference-patch.sh', import.meta.url)), fileURLToPath(new URL('../../../bench/build-jiuan.sh', import.meta.url))]) {
    const offenders = (await readFile(file, 'utf8')).split('\n').map((line, index) => [index + 1, line])
      .filter(([, line]) => /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/.test(line));
    assert.deepEqual(offenders, [], file);
  }
});

test('deploy.sh 默认用仓库里固定版本的 nexus-ai-operator（skills/nexus-ai-operator，1.1.0），可以用 NEXUS_OPERATOR_SCRIPT 换；仓库里这份不带任何密钥', async () => {
  const deploy = await readFile(infra('deploy.sh'), 'utf8');
  assert.match(deploy, /^OPERATOR_SCRIPT="\$\{NEXUS_OPERATOR_SCRIPT:-\$POC_DIR\/\.\.\/skills\/nexus-ai-operator\/scripts\/nexus\.py\}"$/m);
  const skill = fileURLToPath(new URL('../../../../skills/nexus-ai-operator/', import.meta.url));
  assert.match(await readFile(path.join(skill, 'SKILL.md'), 'utf8'), /^version: "1\.1\.0"$/m);
  await readFile(path.join(skill, 'scripts/nexus.py'), 'utf8');
  for (const name of ['config/connection.json', 'config/instance.json']) await assert.rejects(readFile(path.join(skill, name)), `${name} 不能进仓库`);
});

test('deploy.sh 开头的变量定义在 set -u 下能跑通（变量要先定义再引用）', async () => {
  const deploy = await readFile(infra('deploy.sh'), 'utf8');
  const prelude = deploy.slice(0, deploy.indexOf('\nsay() '));
  assert.ok(prelude.includes('CODE_ONLY=false'), '变量定义应在 say() 之前');
  await run('bash', ['-c', `cd ${JSON.stringify(fileURLToPath(new URL('../../../infra/', import.meta.url)))} && ${prelude.replace(/^#!.*\n/, '')}\necho "$SECRETS $APP_DIR"`]);
});

test('deploy.sh：secrets.env 没有 REGISTRY_KEY 时追加一条（openssl 32 字节）；新文件模板不再写 NEXUS_API_KEY', async () => {
  const deploy = await readFile(new URL('../../../infra/deploy.sh', import.meta.url), 'utf8');
  assert.match(deploy, /grep -q '\^REGISTRY_KEY=' "\$SECRETS"/);
  assert.match(deploy, /REGISTRY_KEY=\$\(openssl rand -base64 32\)/);
  assert.equal(/^NEXUS_API_KEY=/m.test(deploy), false);
});

test('Agent 的密钥不经过 secrets.env：deploy.sh 新建的 secrets.env 里没有调用密钥那一行，也不提示去填', async () => {
  const deploy = await readFile(new URL('../../../infra/deploy.sh', import.meta.url), 'utf8');
  const template = deploy.slice(deploy.indexOf('<<SECRETSFILE'), deploy.indexOf('\nSECRETSFILE\n'));
  assert.ok(template.length > 20, '要有新文件模板');
  assert.doesNotMatch(template, /NEXUS_A2A_KEY|NEXUS_API_KEY|nxa_/);
  assert.doesNotMatch(deploy, /调用密钥留空|填好后再运行/);
});

test('端到端测试不读 secrets.env 里的 Agent 密钥：用审核员本人在前端的连接和启用；也不依赖「系统提供」那一项', async () => {
  const e2e = await readFile(fileURLToPath(new URL('../e2e/run.sh', import.meta.url)), 'utf8');
  assert.doesNotMatch(e2e, /E2E_KNOWLEDGE_A2A_KEY|E2E_NEXUS_API_KEY/);
  for (const name of ['access.e2e.mjs', 'attachments.e2e.mjs', 'poc.e2e.mjs']) {
    const text = await readFile(fileURLToPath(new URL(`../e2e/${name}`, import.meta.url)), 'utf8');
    assert.doesNotMatch(text, /E2E_KNOWLEDGE_A2A_KEY|E2E_NEXUS_API_KEY|\.system\b|系统提供/, name);
  }
});

test('交接仓库里没有进度看板（tools/），run.sh 照样能跑：报告器存在才多记一份结果', async () => {
  const e2e = await readFile(fileURLToPath(new URL('../e2e/run.sh', import.meta.url)), 'utf8');
  assert.match(e2e, /\[\[ -f "\$ROOT\/tools\/progress\/reporter\.mjs" \]\]/);
});

test('端到端测试另记一份结果给进度看板：用 tools/progress/reporter.mjs 写到 evidence/e2e/last-run.jsonl，终端照样是 spec 输出', async () => {
  const e2e = await readFile(fileURLToPath(new URL('../e2e/run.sh', import.meta.url)), 'utf8');
  assert.match(e2e, /tools\/progress\/reporter\.mjs/);
  assert.match(e2e, /evidence\/e2e\/last-run\.jsonl/);
  assert.match(e2e, /--test-reporter=spec --test-reporter-destination=stdout/);
});

// ---------- 测试台（计划 2026-10-19-bench-upgrade 任务 5）
const bench = name => infra(`bench/${name}`);

test('测试台脚本语法正确', async () => {
  for (const name of ['mysql-install.sh', 'bench-reset.sh']) await run('bash', ['-n', bench(name)]);
});

test('MySQL 固定用 mysql:8.0，只听本机，参数和九安自己的测试编排一致', async () => {
  const script = await readFile(bench('mysql-install.sh'), 'utf8');
  for (const expected of ['mysql:8.0', '127.0.0.1:3306:3306', '--skip-log-bin', '--character-set-server=utf8mb4', '--collation-server=utf8mb4_unicode_ci', 'TZ=Asia/Shanghai',
    '/var/lib/jiuan-mysql:/var/lib/mysql', 'MYSQL_ROOT_PASSWORD_FILE', 'MYSQL_PASSWORD_FILE', 'MYSQL_DATABASE=jiuan_analysis', 'MYSQL_USER=jiuan_app', ':ro']) {
    assert.ok(script.includes(expected), `mysql-install.sh 应包含 ${expected}`);
  }
  assert.doesNotMatch(script, /0\.0\.0\.0/);
  assert.match(script, /mysqladmin ping/);
});

test('重置只动 jiuan_analysis 这个库，不碰账号数据', async () => {
  const script = await readFile(bench('bench-reset.sh'), 'utf8');
  assert.match(script, /DROP DATABASE IF EXISTS jiuan_analysis/);
  assert.match(script, /CREATE DATABASE jiuan_analysis CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci/);
  assert.match(script, /GRANT ALL ON jiuan_analysis\.\* TO 'jiuan_app'@'%'/);
  assert.doesNotMatch(script, /\/var\/lib\/andon-finance/);
  assert.doesNotMatch(script, /rm -rf/);
});

test('服务的 systemd 补充配置：等 Docker，读测试台的环境文件', async () => {
  const conf = await readFile(bench('andon-finance-bench.conf'), 'utf8');
  assert.match(conf, /^\[Unit\]$/m);
  assert.match(conf, /^After=docker\.service$/m);
  assert.match(conf, /^Wants=docker\.service$/m);
  assert.match(conf, /^\[Service\]$/m);
  assert.match(conf, /^EnvironmentFile=-\/etc\/andon-finance\/bench\.env$/m);
});

test('测试台脚本里没有写死的密码', async () => {
  for (const name of ['mysql-install.sh', 'bench-reset.sh', 'andon-finance-bench.conf']) {
    const text = await readFile(bench(name), 'utf8');
    assert.doesNotMatch(text, /PASSWORD=(?!\$|")[^\s"]+/, `${name} 不能有密码字面量`);
    assert.doesNotMatch(text, /-p[A-Za-z0-9]{6,}/, `${name} 不能在命令行上带密码`);
  }
});

// ---------- 测试台（任务 6）：模板、部署、备份、换型、在测试台上跑测试
test('模板允许 t3.large；Resources 除了九安 v0.7.10 新增的分发、记录和输出、知识库的入站规则 KbIngress 和 Bedrock 策略 KbBedrockPolicy，一字不改（不会替换实例）', async () => {
  const template = await readFile(infra('andon-finance-poc.yaml'), 'utf8');
  assert.match(template, /InstanceType:\n\s+Type: String\n\s+Default: t3\.small\n\s+AllowedValues: \[t3\.small, t3\.medium, t3\.large\]/);
  const resources = template.slice(template.indexOf('\nResources:')).replace(/\n  Jiuan07Distribution:\n[\s\S]*?\n(?=\nOutputs:)/, '')
    .replace("\n  Jiuan07Url:\n    Value: !Sub 'https://${Jiuan07DomainName}'", '')
    .replace(['\n\n  KbIngress:', "    # The knowledge base's PostgreSQL (kb/, container nexus-pgvector on this instance) from the Nexus VPC only.", '    Type: AWS::EC2::SecurityGroupIngress',
      '    Condition: KbEnabled', '    Properties:', '      GroupId: !GetAtt AppSecurityGroup.GroupId', '      IpProtocol: tcp', '      FromPort: !Ref KbPort', '      ToPort: !Ref KbPort',
      '      CidrIp: !Ref KbAllowedCidr', "      Description: 'nexus-pgvector: Nexus server + sandbox VMs (private only)'"].join('\n'), '')
    .replace(/\n\n  KbBedrockPolicy:\n[\s\S]*?(?=\n\n  Instance:)/, '');
  assert.equal(createHash('sha256').update(resources).digest('hex'), '517e951151bb07d472fdba0263ece054bb3982fe85f619a1f8dc409b96053b1f');
});

test('测试台的三项密钥只补不换：已有的 BENCH_DATA_KEY 保持原样，缺的补上且格式正确', async t => {
  const deploy = await readFile(infra('deploy.sh'), 'utf8');
  const block = deploy.slice(deploy.indexOf('# >>> bench-secrets'), deploy.indexOf('# <<< bench-secrets'));
  assert.ok(block.length > 40, 'deploy.sh 里要有 bench-secrets 段');
  const dir = await mkdtemp(path.join(tmpdir(), 'bench-secrets-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const secrets = path.join(dir, 'secrets.env');
  const existing = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  await writeFile(secrets, `REVIEWER_PASSWORD=x\nBENCH_DATA_KEY=${existing}\n`);
  for (let round = 0; round < 2; round += 1) await run('bash', ['-c', `set -euo pipefail\nSECRETS=${JSON.stringify(secrets)}\n${block}`]);
  const text = await readFile(secrets, 'utf8');
  const value = name => [...text.matchAll(new RegExp(`^${name}=(.*)$`, 'gm'))].map(match => match[1]);
  assert.deepEqual(value('BENCH_DATA_KEY'), [existing]);
  assert.equal(value('BENCH_MYSQL_ROOT_PASSWORD').length, 1);
  assert.equal(value('BENCH_MYSQL_APP_PASSWORD').length, 1);
  assert.match(value('BENCH_MYSQL_ROOT_PASSWORD')[0], /^[A-Za-z0-9]{32}$/);
  assert.match(value('BENCH_MYSQL_APP_PASSWORD')[0], /^[A-Za-z0-9]{32}$/);
  await writeFile(secrets, 'REVIEWER_PASSWORD=x\n');
  await run('bash', ['-c', `set -euo pipefail\nSECRETS=${JSON.stringify(secrets)}\n${block}`]);
  assert.match((await readFile(secrets, 'utf8')).match(/^BENCH_DATA_KEY=(.*)$/m)[1], /^[A-Za-z0-9+/]{43}=$/);
});

test('构件里的九安是构建出来的副本，并且带着 node_modules；还带上测试台脚本', async () => {
  const deploy = await readFile(infra('deploy.sh'), 'utf8');
  assert.match(deploy, /bench\/build-jiuan\.sh/);
  const jiuanLine = deploy.split('\n').find(line => line.includes('"$STAGE/release/jiuan/"'));
  assert.ok(jiuanLine, '要有复制九安到构件的那一行');
  assert.match(jiuanLine, /\.build\/jiuan/);
  assert.doesNotMatch(jiuanLine, /--exclude node_modules/);
  assert.match(deploy, /"\$HERE\/bench\/" "\$STAGE\/release\/bench\/"/);
});

test('部署时在重启之前配置测试台（取新构件里的 bench-configure.sh），并检查 SSM 的执行结果', async () => {
  const deploy = await readFile(infra('deploy.sh'), 'utf8');
  const install = deploy.split('\n').find(line => line.startsWith('INSTALL='));
  assert.ok(install);
  const configure = install.indexOf('bench/bench-configure.sh');
  assert.ok(configure > 0 && configure < install.indexOf('systemctl restart andon-finance-poc.service'), 'bench-configure.sh 要在重启之前');
  assert.match(install, /\/var\/tmp\/andon-bench-config/);
  assert.match(install, /bench-configure\.sh \$POC_STORE/);
  assert.match(deploy, /^POC_STORE="\$\{POC_STORE:-[a-z]+\}"$/m);
  assert.doesNotMatch(deploy, /--instance-id "\$INSTANCE" \|\| true\naws ssm get-command-invocation[^\n]*--output text\n\nsay "健康检查/);
  assert.match(deploy, /--query Status --output text\)" == "Success" \]\]/);
});

test('bench-configure.sh：密钥写成 root:andon 0640 的文件，bench.env 只接受 memory 或 mysql，最后装 MySQL', async () => {
  const script = await readFile(infra('bench/bench-configure.sh'), 'utf8');
  await run('bash', ['-n', infra('bench/bench-configure.sh')]);
  for (const name of ['mysql_root_password', 'mysql_app_password', 'analysis_data_key']) assert.ok(script.includes(name), name);
  for (const key of ['BENCH_MYSQL_ROOT_PASSWORD', 'BENCH_MYSQL_APP_PASSWORD', 'BENCH_DATA_KEY']) assert.ok(script.includes(key), key);
  assert.match(script, /chown root:andon/);
  assert.match(script, /chmod 0640/);
  assert.match(script, /umask 077/);
  assert.match(script, /-o root -g andon -m 0750/);
  assert.match(script, /memory\|mysql/);
  assert.match(script, /POC_STORE=/);
  assert.match(script, /mysql-install\.sh/);
  assert.doesNotMatch(script, /echo[^\n]*\$value/);
});

const scriptBlock = async (file, name) => {
  const text = await readFile(file, 'utf8');
  const start = text.indexOf(`# >>> ${name}`);
  const end = text.indexOf(`# <<< ${name}`);
  assert.ok(start >= 0 && end > start, `${path.basename(file)} 里要有 ${name} 段`);
  return text.slice(start, end);
};

test('bench-configure.sh：实例上已有的测试台密钥只认原值；secrets.env 里的值变了就拒绝替换，三个文件都不动，也不打印值', async t => {
  const code = await scriptBlock(infra('bench/bench-configure.sh'), 'bench-secret-files');
  const dir = await mkdtemp(path.join(tmpdir(), 'bench-configure-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const secrets = path.join(dir, 'secrets.env');
  const files = path.join(dir, 'bench');
  const [key1, key2] = [randomBytes(32).toString('base64'), randomBytes(32).toString('base64')];
  const configure = () => run('bash', ['-c', `set -euo pipefail\nchown() { :; }\nSECRETS=${JSON.stringify(secrets)}\nDIR=${JSON.stringify(files)}\nmkdir -p "$DIR"\n${code}`]);
  const read = name => readFile(path.join(files, name), 'utf8');
  await writeFile(secrets, `BENCH_MYSQL_ROOT_PASSWORD=${'a'.repeat(32)}\nBENCH_MYSQL_APP_PASSWORD=${'b'.repeat(32)}\nBENCH_DATA_KEY=${key1}\n`);
  await configure();
  await configure();
  assert.equal(await read('analysis_data_key'), key1);
  // secrets.env 被重新生成了：数据密钥和 root 密码都换了
  await writeFile(secrets, `BENCH_MYSQL_ROOT_PASSWORD=${'c'.repeat(32)}\nBENCH_MYSQL_APP_PASSWORD=${'b'.repeat(32)}\nBENCH_DATA_KEY=${key2}\n`);
  await assert.rejects(configure(), error => /拒绝替换/.test(error.stderr) && !error.stderr.includes(key2) && !error.stderr.includes('c'.repeat(32)));
  assert.equal(await read('mysql_root_password'), 'a'.repeat(32));
  assert.equal(await read('mysql_app_password'), 'b'.repeat(32));
  assert.equal(await read('analysis_data_key'), key1);
});

test('bench-configure.sh：BENCH_DATA_KEY 不是 32 字节的 base64 就不写', async t => {
  const code = await scriptBlock(infra('bench/bench-configure.sh'), 'bench-secret-files');
  const dir = await mkdtemp(path.join(tmpdir(), 'bench-configure-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const secrets = path.join(dir, 'secrets.env');
  const files = path.join(dir, 'bench');
  await writeFile(secrets, `BENCH_MYSQL_ROOT_PASSWORD=${'a'.repeat(32)}\nBENCH_MYSQL_APP_PASSWORD=${'b'.repeat(32)}\nBENCH_DATA_KEY=not-a-key\n`);
  await assert.rejects(run('bash', ['-c', `set -euo pipefail\nchown() { :; }\nSECRETS=${JSON.stringify(secrets)}\nDIR=${JSON.stringify(files)}\nmkdir -p "$DIR"\n${code}`]),
    error => /BENCH_DATA_KEY/.test(error.stderr));
  await assert.rejects(readFile(path.join(files, 'analysis_data_key')));
});

test('bench-configure.sh：回到内存存储不依赖 MySQL（MySQL 坏了也能退回）；mysql 模式下 MySQL 没就绪就失败；两种都装上 systemd 补充配置', async t => {
  const code = await scriptBlock(infra('bench/bench-configure.sh'), 'store-setup');
  const dir = await mkdtemp(path.join(tmpdir(), 'bench-store-setup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = path.join(dir, 'calls.txt');
  await writeFile(path.join(dir, 'mysql-install.sh'), 'echo mysql-install >> "$CALLS"; exit 1\n');
  await writeFile(path.join(dir, 'andon-finance-bench.conf'), '[Service]\n');
  const setup = store => run('bash', ['-c', `set -euo pipefail\nexport CALLS=${JSON.stringify(calls)}\ninstall() { echo "install $*" >> "$CALLS"; }\nsystemctl() { echo "systemctl $*" >> "$CALLS"; }\nSTORE=${store}\nHERE=${JSON.stringify(dir)}\n${code}`]);
  await setup('memory');
  const memory = await readFile(calls, 'utf8');
  assert.match(memory, /^install -m 0644 \S*andon-finance-bench\.conf \/etc\/systemd\/system\/andon-finance-poc\.service\.d\/andon-finance-bench\.conf$/m);
  assert.match(memory, /^systemctl daemon-reload$/m);
  assert.doesNotMatch(memory, /^mysql-install$/m);
  await rm(calls);
  await assert.rejects(setup('mysql'));
  assert.match(await readFile(calls, 'utf8'), /^mysql-install$/m);
});

test('backup.sh、upgrade-instance.sh、bench-test.sh 语法正确', async () => {
  for (const name of ['backup.sh', 'upgrade-instance.sh', 'bench-test.sh']) await run('bash', ['-n', infra(name)]);
});

test('换型脚本只做「停机再开」：变更集里实例要被替换就删掉变更集并退出；执行前要输入栈名确认', async () => {
  const script = await readFile(infra('upgrade-instance.sh'), 'utf8');
  assert.match(script, /create-change-set/);
  assert.match(script, /ParameterKey=InstanceType,ParameterValue=/);
  assert.match(script, /UsePreviousValue=true/);
  assert.match(script, /Replacement/);
  assert.match(script, /delete-change-set/);
  assert.match(script, /read -r/);
  assert.match(script, /execute-change-set/);
  assert.match(script, /t3\.small\|t3\.medium\|t3\.large/);
});

test('备份脚本：根卷快照 + 实例上打包账号目录，并检查 SSM 结果', async () => {
  const script = await readFile(infra('backup.sh'), 'utf8');
  assert.match(script, /create-snapshot/);
  assert.match(script, /snapshot-completed/);
  assert.match(script, /tar -czf \/root\/andon-backup-/);
  assert.match(script, /users nexus/);
  assert.match(script, /--query Status --output text\)" == "Success" \]\]/);
});

test('在测试台上跑要 MySQL 的测试：只用 _test 结尾的库，密码在实例上读文件，不出现在命令里', async () => {
  const script = await readFile(infra('bench-test.sh'), 'utf8');
  assert.match(script, /jiuan_bench_test/);
  assert.match(script, /\\\$\(cat \/etc\/andon-finance\/bench\/mysql_root_password\)/);
  assert.match(script, /releases\/bench-tests\.tgz/);
  assert.match(script, /JIUAN_CODE_DIR=\/opt\/andon-finance\/current\/jiuan/);
  assert.doesNotMatch(script, /BENCH_MYSQL_ROOT_PASSWORD/);
});

// ---------- 测试台（任务 7）：端到端测试的重置
test('端到端测试先重置测试台的库（bench-reset.sh）；实例上还没有这个脚本时退回到重启服务', async () => {
  const e2e = await readFile(fileURLToPath(new URL('../e2e/run.sh', import.meta.url)), 'utf8');
  assert.match(e2e, /\/opt\/andon-finance\/current\/bench\/bench-reset\.sh/);
  assert.match(e2e, /if \[ -x \/opt\/andon-finance\/current\/bench\/bench-reset\.sh \]; then[^"]*else systemctl restart andon-finance-poc\.service; fi/);
  const poc = await readFile(fileURLToPath(new URL('../e2e/poc.e2e.mjs', import.meta.url)), 'utf8');
  assert.match(poc, /test\('0\. 平台中心能打开（九安真实运行时）'/);
  assert.match(poc, /#platformAgents/);
  assert.match(poc, /汇联易单据同步/);
});

test('换型脚本：InstanceType 变化在 CloudFormation 里永远是 Conditional；只有「唯一的变化是 InstanceType、根卷是 EBS」才放行，其余一律不执行', async () => {
  const script = await readFile(infra('upgrade-instance.sh'), 'utf8');
  assert.match(script, /Details\[\]\.Target\.Name/);
  assert.match(script, /RootDeviceType/);
  assert.match(script, /"\$REPLACEMENT" == "Conditional"/);
  assert.match(script, /\[\[ "\$ROOT_DEVICE" == "ebs" \]\]/);
  assert.match(script, /\[\[ "\$CAUSES" == "InstanceType" \]\]/);
});

// 一个环境一份配置文件（poc/infra/env/<环境名>.env，poc/infra/lib/deploy-env.sh 读）：不给 DEPLOY_ENV 就是现有环境
const e2e07 = name => fileURLToPath(new URL(`../e2e/${name}`, import.meta.url));
test('各脚本先读环境配置（DEPLOY_ENV）再定栈名和区域：不给就是现有环境（andon-finance-poc、us-east-1），栈名不再写死', async () => {
  const scripts = { 'deploy.sh': infra('deploy.sh'), 'destroy.sh': infra('destroy.sh'), 'backup.sh': infra('backup.sh'), 'upgrade-instance.sh': infra('upgrade-instance.sh'),
    'bench-test.sh': infra('bench-test.sh'), 'kb.sh': infra('kb.sh'), 'run07.sh': e2e07('run07.sh') };
  for (const [name, file] of Object.entries(scripts)) {
    const text = await readFile(file, 'utf8');
    assert.match(text, /source "[^"\n]*\/lib\/deploy-env\.sh"\nload_deploy_env\n/, `${name} 先 source deploy-env.sh 再 load_deploy_env`);
    const loadAt = text.indexOf('\nload_deploy_env\n');
    assert.ok(text.indexOf('STACK="${STACK:-andon-finance-poc}"') > loadAt, `${name} 的栈名在读完配置之后定`);
    assert.ok(text.indexOf('REGION="${AWS_REGION:-us-east-1}"') > loadAt, `${name} 的区域在读完配置之后定`);
    assert.doesNotMatch(text, /^STACK="andon-finance-poc"$/m, name);
    await run('bash', ['-n', file]);
  }
});

test('deploy.sh：配置文件里写了值的栈参数都传给 CloudFormation；给了配置文件时 KbAllowedCidr 以文件为准（不再另加环境变量那一条）', async () => {
  const deploy = await readFile(infra('deploy.sh'), 'utf8');
  assert.match(deploy, /while IFS= read -r override; do overrides\+=\("\$override"\); done < <\(deploy_env_overrides\)/);
  assert.match(deploy, /\[\[ -z "\$\{DEPLOY_ENV:-\}" && -n "\$\{KB_ALLOWED_CIDR:-\}" \]\] && overrides\+=\("KbAllowedCidr=\$KB_ALLOWED_CIDR"\)/);
});

test('九安 v0.7.10 的端到端测试不写死区域和 Nexus 地址：run07.sh 按配置 / 栈导出 E2E07_REGION、E2E07_NEXUS_HOST', async () => {
  const spec = await readFile(e2e07('jiuan07.e2e.mjs'), 'utf8');
  assert.doesNotMatch(spec, /'--region', 'us-east-1'/);
  assert.doesNotMatch(spec, /nxs-beine1013/);
  assert.match(spec, /process\.env\.E2E07_REGION/);
  assert.match(spec, /process\.env\.E2E07_NEXUS_HOST/);
  const runner = await readFile(e2e07('run07.sh'), 'utf8');
  assert.match(runner, /E2E07_REGION="\$REGION"/);
  assert.match(runner, /E2E07_NEXUS_HOST="\$\(output_param NexusOrigin \| sed -E 's#\^https\?:\/\/##; s#\[\/:\]\.\*\$##'\)"/);
});

test('九安 v0.7.10 的端到端测试按知识库方式走：run07.sh 从 DEPLOY_ENV 导出方式（缺省 pg）和这种方式的知识库 Agent 发布，s3vectors 另给桶和规则索引；测试不再调已删掉的直连 PG 接口，自定义规则的日志按带空格的 POC_CUSTOM_RULES 找', async () => {
  const runner = await readFile(e2e07('run07.sh'), 'utf8');
  assert.match(runner, /E2E07_KB_MODE="\$\{KB_MODE:-pg\}"/);
  assert.match(runner, /if \[\[ "\$E2E07_KB_MODE" == s3vectors \]\]; then\n  E2E07_KB_PUBLICATION_ID="\$\{KB_S3V_PUBLICATION_ID:-\}"\n  E2E07_KB_S3V_BUCKET="\$\{KB_S3V_BUCKET:-\}"\n  E2E07_KB_S3V_RULES_INDEX="\$\{KB_S3V_RULES_INDEX:-\}"\n  export E2E07_KB_S3V_BUCKET E2E07_KB_S3V_RULES_INDEX\nelse\n  E2E07_KB_PUBLICATION_ID="\$\{KB_PG_PUBLICATION_ID:-\}"\nfi\nexport E2E07_KB_MODE E2E07_KB_PUBLICATION_ID\n/);
  assert.ok(runner.indexOf('export E2E07_KB_MODE') < runner.lastIndexOf('node --test --test-concurrency=1'), '先导出再跑测试');
  const spec = await readFile(e2e07('jiuan07.e2e.mjs'), 'utf8');
  for (const name of ['E2E07_KB_MODE', 'E2E07_KB_PUBLICATION_ID', 'E2E07_KB_S3V_BUCKET', 'E2E07_KB_S3V_RULES_INDEX']) assert.match(spec, new RegExp(`process\\.env\\.${name}\\b`), name);
  assert.doesNotMatch(spec, /\/poc\/kb\/(documents|search-log)/, '0005 之后没有这两个接口');
  assert.match(spec, /journalLines\('POC_CUSTOM_RULES '\)/, '带空格：POC_CUSTOM_RULES_FAILED 不算');
  assert.match(spec, /'s3vectors', 'get-vectors'[\s\S]{0,300}'--return-metadata'/);
  assert.match(spec, /FROM kb_search_log/);
  // 截图只拍单据、Agent 接入、模拟来单：「规则库 › 制度知识库」页上有真实制度，不截图
  const kbCase = spec.slice(spec.indexOf('test(`制度知识库'), spec.indexOf("test('清场"));
  assert.ok(kbCase.length > 100);
  assert.doesNotMatch(kbCase, /shot\(/);
  assert.doesNotMatch(spec.slice(spec.indexOf('async function uploadOwnRule'), spec.indexOf("test('登录")), /shot\(/);
});

test('交付包和交接仓库只带 poc/infra/env/example.env（各环境的配置不出去）；打包检查也跑 audit-agent、kb 的单元测试', async () => {
  const pack = await readFile(fileURLToPath(new URL('../../../../docs/delivery/make-package.sh', import.meta.url)), 'utf8');
  assert.match(pack, /copy poc\/infra [^\n]*--include \/infra\/env\/example\.env --exclude '\/infra\/env\/\*\.env'/);
  assert.match(pack, /unittest discover -s audit-agent\/tests/);
  assert.match(pack, /unittest discover -s kb\/tests/);
});
