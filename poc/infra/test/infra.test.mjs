import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DEPLOY_ENV_KEYS, childEnv } from './helpers/child-env.mjs';

// poc/infra 的部署脚本、栈模板、测试台脚本（九安 v0.7.10 测试台：新前端 + 外壳 + 九安副本，一台实例上还有 MySQL 和知识库的 PG）
const execFileAsync = promisify(execFile);
// 子进程不继承部署的环境（DEPLOY_ENV 和环境配置的键，见 helpers/child-env.mjs）；自己给了 env 的调用照它给的
const run = (file, args, options = {}) => execFileAsync(file, args, { env: childEnv(), ...options });
const infra = name => fileURLToPath(new URL(`../${name}`, import.meta.url));
const repo = name => fileURLToPath(new URL(`../../../${name}`, import.meta.url));
const e2eFile = name => fileURLToPath(new URL(`../../app/test/e2e/${name}`, import.meta.url));
const bench = name => infra(`bench/${name}`);
const installBlock = deploy => deploy.slice(deploy.indexOf('# >>> install'), deploy.indexOf('# <<< install'));

test('模板里的 Fn::Sub 只引用模板自己的参数、资源与伪参数（用户数据里没有 Fn::Sub）', async () => {
  const template = await readFile(infra('andon-finance-poc.yaml'), 'utf8');
  const tokens = [...new Set([...template.matchAll(/\$\{([^}]+)\}/g)].map(match => match[1]))].sort();
  // AWS::AccountId：KbBedrockPolicy 里 Cohere v4 推理配置文件的 ARN 带账号；DomainName：输出 SiteUrl
  assert.deepEqual(tokens, ['AWS::AccountId', 'AWS::Partition', 'AWS::Region', 'ArtifactBucket.Arn', 'DomainName']);
});

test('模板的关键约束：只放 CloudFront 回源、22 端口只在经 SSH 管理时开、默认 m7g.xlarge、TLS 1.2、私有构件桶、关缓存并转发观众请求头', async () => {
  const template = await readFile(infra('andon-finance-poc.yaml'), 'utf8');
  assert.match(template, /SourcePrefixListId: !Ref CloudFrontPrefixListId/);
  // 22 端口只在两种条件下开：SshEnabled（有密钥对、给了来源网段）下单独的 SshIngress，来源就是 SshAllowedCidr；
  // UseEice（有密钥对、SshVia=eice）下只对栈自己建的 EC2 Instance Connect 端点的安全组开（端点的安全组也只许出 22 到实例）
  assert.equal(template.match(/FromPort: 22\b/g)?.length, 3);
  assert.match(template, /UseEice: !And \[!Condition HasKeyName, !Equals \[!Ref SshVia, eice\]\]/);
  assert.match(template, /\n  EiceSshIngress:\n    Type: AWS::EC2::SecurityGroupIngress\n    Condition: UseEice\n    Properties:\n      GroupId: !GetAtt AppSecurityGroup\.GroupId\n      IpProtocol: tcp\n      FromPort: 22\n      ToPort: 22\n      SourceSecurityGroupId: !GetAtt EiceSecurityGroup\.GroupId\n/);
  assert.match(template, /\n  EiceSecurityGroup:\n(?:    #[^\n]*\n)?    Type: AWS::EC2::SecurityGroup\n    Condition: UseEice\n[\s\S]*?SecurityGroupEgress:\n        - IpProtocol: tcp\n          FromPort: 22\n          ToPort: 22\n          DestinationSecurityGroupId: !GetAtt AppSecurityGroup\.GroupId\n/);
  assert.match(template, /\n  InstanceConnectEndpoint:\n(?:    #[^\n]*\n)?    Type: AWS::EC2::InstanceConnectEndpoint\n    Condition: UseEice\n/);
  assert.match(template, /\n  SshVia:\n    Type: String\n    Default: direct\n    AllowedValues: \[direct, eice\]\n/);
  assert.match(template, /\n  SshIngress:\n(?:    #[^\n]*\n)?    Type: AWS::EC2::SecurityGroupIngress\n    Condition: SshEnabled\n    Properties:\n      GroupId: !GetAtt AppSecurityGroup\.GroupId\n      IpProtocol: tcp\n      FromPort: 22\n      ToPort: 22\n      CidrIp: !Ref SshAllowedCidr\n/);
  assert.match(template, /SshEnabled: !And \[!Condition HasKeyName, !Not \[!Equals \[!Ref SshAllowedCidr, ''\]\]\]/);
  // 以后都用 m7g.xlarge（arm64），根卷 30 GiB；建栈时 deploy.sh 按类型的架构取 AMI
  assert.match(template, /\n  InstanceType:\n    Type: String\n    Default: m7g\.xlarge\n    AllowedValues: \[t3\.small, t3\.medium, t3\.large, m7g\.large, m7g\.xlarge\]\n/);
  assert.match(template, /\n  RootVolumeSize:\n    Type: Number\n    Default: 30\n/);
  assert.match(template, /MinimumProtocolVersion: TLSv1\.2_2021/);
  assert.match(template, /BlockPublicPolicy: true/);
  assert.match(template, /CachePolicyId: 4135ea2d-6df8-44a3-9df3-4b5a84be39ad/);
  assert.match(template, /OriginRequestPolicyId: 216adef6-5c7f-47e4-b989-5492eafa07d3/);
});

test('模板里只有九安 v0.7.10 测试台：一个 CloudFront 分发（站点 DomainName，回源实例的 AppPort）；v0.5.3 PoC 的站点、参数、服务和 andon 用户都没了', async () => {
  const template = await readFile(infra('andon-finance-poc.yaml'), 'utf8');
  assert.equal(template.match(/Type: AWS::CloudFront::Distribution/g)?.length, 1);
  const distribution = template.slice(template.indexOf('\n  Distribution:\n'), template.indexOf('\n  SiteRecordA:\n'));
  assert.match(distribution, /Aliases: \[!Ref DomainName\]/);
  assert.match(distribution, /DomainName: !Ref OriginDomainName/);
  assert.match(distribution, /HTTPPort: !Ref AppPort/);
  for (const name of ['SiteRecordA', 'SiteRecordAAAA']) assert.match(template, new RegExp(`\\n  ${name}:\\n[\\s\\S]*?Name: !Ref DomainName[\\s\\S]*?Distribution\\.DomainName`));
  assert.match(template, /\n  SiteUrl:\n    Value: !Sub 'https:\/\/\$\{DomainName\}'/);
  for (const gone of [/\n  AdvisoryPublicationId:\n/, /andon-finance-poc\.service/, /useradd/, /POC_BUCKET|POC_PUBLIC_DIR|NEXUS_ADVISORY_PUBLICATION/, /Jiuan07|jiuan07/]) {
    assert.doesNotMatch(template, gone);
  }
  // 用户数据只装 Node 24、Python、tar，建两个目录；构件由 deploy.sh 装（不在开机时取）
  const userData = template.slice(template.indexOf('      UserData:\n'), template.indexOf('\n  ElasticIp:\n'));
  assert.match(userData, /dnf install -y nodejs24 python3 tar gzip/);
  assert.match(userData, /install -d -o root -g root -m 0755 \/opt\/andon-finance \/etc\/andon-finance/);
  assert.doesNotMatch(userData, /systemctl|aws s3/);
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

test('密钥只来自 infra/secrets.env：部署时上传，实例上先装成只有 root 能读的文件，再配置测试台、重启；部署与 E2E 都不用 Parameter Store', async () => {
  const deploy = await readFile(infra('deploy.sh'), 'utf8');
  const install = installBlock(deploy);
  assert.match(deploy, /aws s3 cp --region "\$REGION" --only-show-errors --sse AES256 "\$SECRETS" "s3:\/\/\$BUCKET\/secrets\/secrets\.env"/);
  const at = text => install.indexOf(text);
  assert.ok(at('aws s3 cp s3://$BUCKET/secrets/secrets.env /etc/andon-finance/secrets.env.new') > 0);
  assert.ok(at('chown root:root /etc/andon-finance/secrets.env.new; chmod 0600 /etc/andon-finance/secrets.env.new') > at('aws s3 cp s3://$BUCKET/secrets/secrets.env'));
  const configure = at('bash "\\$work/release/bench/bench-configure.sh"');
  assert.ok(configure > 0 && at('mv /etc/andon-finance/secrets.env.new /etc/andon-finance/secrets.env') < configure, '先装密钥再配置');
  assert.ok(configure < at('systemctl restart andon-jiuan.service'), '先配置再重启');
  const e2e = await readFile(e2eFile('run.sh'), 'utf8');
  for (const text of [deploy, e2e]) assert.doesNotMatch(text, /put-parameter|--with-decryption|\/andon-finance\/poc\/(accounts|nexus)/);
  assert.match(e2e, /secrets\.env/);
});

test('在 macOS 上打包时不带 AppleDouble 与扩展属性（否则实例上解包会多出 ._* 文件和告警）', async () => {
  const deploy = await readFile(infra('deploy.sh'), 'utf8');
  assert.match(deploy, /COPYFILE_DISABLE=1 tar --no-mac-metadata --no-xattrs -czf/);
});

test('shell 脚本里变量名后面不能紧跟中文等非 ASCII 字符（bash 会把它们算进变量名，set -u 下直接报错）；要写成 ${VAR}', async () => {
  for (const file of [infra('deploy.sh'), infra('destroy.sh'), infra('backup.sh'), infra('upgrade-instance.sh'), infra('kb.sh'), infra('migrate-data.sh'),
    infra('lib/remote.sh'), infra('lib/deploy-env.sh'), infra('lib/bench-secrets.sh'), infra('pg-prepare.sh'), infra('remote-jiuan-tests.sh'),
    bench('mysql-install.sh'), bench('pg-install.sh'), bench('test-databases.sh'), bench('bench-configure.sh'), bench('bench-reset.sh'),
    fileURLToPath(new URL('../../bench/build-jiuan.sh', import.meta.url)), e2eFile('run.sh'),
    repo('docs/delivery/make-package.sh'), repo('docs/build-html.sh')]) {
    const offenders = (await readFile(file, 'utf8')).split('\n').map((line, index) => [index + 1, line])
      .filter(([, line]) => /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/.test(line));
    assert.deepEqual(offenders, [], file);
  }
});

test('deploy.sh 默认用仓库里固定版本的 nexus-ai-operator（skills/nexus-ai-operator，1.1.0），可以用 NEXUS_OPERATOR_SCRIPT 换；仓库里这份不带任何密钥', async () => {
  const deploy = await readFile(infra('deploy.sh'), 'utf8');
  assert.match(deploy, /^OPERATOR_SCRIPT="\$\{NEXUS_OPERATOR_SCRIPT:-\$POC_DIR\/\.\.\/skills\/nexus-ai-operator\/scripts\/nexus\.py\}"$/m);
  const skill = fileURLToPath(new URL('../../../skills/nexus-ai-operator/', import.meta.url));
  assert.match(await readFile(path.join(skill, 'SKILL.md'), 'utf8'), /^version: "1\.1\.0"$/m);
  await readFile(path.join(skill, 'scripts/nexus.py'), 'utf8');
  for (const name of ['config/connection.json', 'config/instance.json']) await assert.rejects(readFile(path.join(skill, name)), `${name} 不能进仓库`);
});

test('deploy.sh 开头的变量定义在 set -u 下能跑通（变量要先定义再引用）', async () => {
  const deploy = await readFile(infra('deploy.sh'), 'utf8');
  const prelude = deploy.slice(0, deploy.indexOf('\nsay() '));
  assert.ok(prelude.includes('CODE_ONLY=false'), '变量定义应在 say() 之前');
  await run('bash', ['-c', `cd ${JSON.stringify(fileURLToPath(new URL('../', import.meta.url)))} && ${prelude.replace(/^#!.*\n/, '')}\necho "$SECRETS $OPERATOR_SCRIPT"`]);
});

test('单元测试不继承部署的环境：外面带着找不到的 DEPLOY_ENV（相对路径）和环境配置的键（KB_MODE 还不合格），上面那条测试照样通过', async () => {
  const env = { ...process.env, DEPLOY_ENV: 'poc/infra/env/no-such.env', KB_MODE: 'mongo', STACK: 'not-this-stack' };   // 有意带上
  delete env.NODE_TEST_CONTEXT;   // 不然里面的 node --test 以为自己是被测试运行器拉起来的子进程
  const { stdout } = await run(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern=^deploy\\.sh 开头的变量定义在 set -u 下能跑通',
    fileURLToPath(import.meta.url)], { env });
  assert.match(stdout, /^# pass 1$/m);
  assert.match(stdout, /^# fail 0$/m);
});

test('deploy.sh 跑测试只经 node_tests：DEPLOY_ENV 和 load_deploy_env export 出来的键（shell 里同名的也算）都不传给 node --test', async t => {
  const deploy = await readFile(infra('deploy.sh'), 'utf8');
  const fn = deploy.split('\n').find(line => line.startsWith('node_tests() '));
  assert.ok(fn, 'deploy.sh 里应有一行 node_tests() { … }');
  assert.deepEqual(deploy.split('\n').filter(line => !/^\s*#/.test(line) && line.includes('node --test')), [fn], 'node --test 只在 node_tests 里跑');
  assert.match(deploy, /^node_tests "\$HERE" "test\/\*\*\/\*\.test\.mjs"$/m);
  assert.match(deploy, /^node_tests "\$POC_DIR\/app" "test\/unit\/\*\*\/\*\.test\.mjs"$/m);
  const dir = await mkdtemp(path.join(tmpdir(), 'deploy-unit-tests-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = ['set -euo pipefail', `source ${JSON.stringify(infra('lib/deploy-env.sh'))}`, 'load_deploy_env 2>/dev/null', fn,
    'node() { printf "cwd=%s\\n" "$PWD"; printf "args=%s\\n" "$*"; env; }', 'printf "loaded=%s\\n" "${DEPLOY_ENV_LOADED[*]}"', `node_tests ${JSON.stringify(dir)} "test/unit/**/*.test.mjs"`].join('\n');
  const fixture = fileURLToPath(new URL('./fixtures/deploy-env/s3v.env', import.meta.url));
  const { stdout } = await run('bash', ['-c', script], { env: { PATH: process.env.PATH, HOME: process.env.HOME, DEPLOY_ENV: fixture, KB_ALLOWED_CIDR: '10.9.0.0/16', KEEP_ME: 'yes' } });
  const lines = stdout.split('\n');
  assert.ok(lines.find(line => line.startsWith('loaded=')).split(/[= ]/).includes('KB_MODE'), '先确认读进来了（并 export 了）');
  assert.ok(lines.includes(`cwd=${dir}`));
  assert.ok(lines.includes('args=--test test/unit/**/*.test.mjs'));
  assert.ok(lines.includes('KEEP_ME=yes'), '别的环境变量照常传');
  const leaked = lines.map(line => line.slice(0, line.indexOf('='))).filter(name => name === 'DEPLOY_ENV' || DEPLOY_ENV_KEYS.includes(name));
  assert.deepEqual(leaked, []);
});

test('Agent 的密钥不经过 secrets.env：deploy.sh 新建的 secrets.env 里没有调用密钥那一行，也不提示去填', async () => {
  const deploy = await readFile(new URL('../deploy.sh', import.meta.url), 'utf8');
  const template = deploy.slice(deploy.indexOf('<<SECRETSFILE'), deploy.indexOf('\nSECRETSFILE\n'));
  assert.ok(template.length > 20, '要有新文件模板');
  assert.doesNotMatch(template, /NEXUS_A2A_KEY|NEXUS_API_KEY|nxa_/);
  assert.doesNotMatch(deploy, /调用密钥留空|填好后再运行/);
});

test('测试台的密钥只补不换（ensure_bench_secrets，deploy.sh 和 pg-prepare.sh 共用）：已有的 JIUAN_DATA_KEY 保持原样，缺的补上且格式正确（含 PostgreSQL 的两项）；不再生成 v0.5.3 的几项', async t => {
  const deploy = await readFile(infra('deploy.sh'), 'utf8');
  assert.match(deploy, /^source "\$HERE\/lib\/bench-secrets\.sh"$/m);
  assert.match(deploy, /^ensure_bench_secrets "\$SECRETS"$/m);
  assert.doesNotMatch(deploy, /# >>> bench-secrets/, 'deploy.sh 里不再自己写一份');
  const lib = infra('lib/bench-secrets.sh');
  const block = `source ${JSON.stringify(lib)}\nensure_bench_secrets "$SECRETS"`;
  for (const name of ['REGISTRY_KEY', 'BENCH_DATA_KEY', 'BENCH_MYSQL_APP_PASSWORD']) assert.doesNotMatch(deploy, new RegExp(name), `${name} 是 v0.5.3 的，不再生成`);
  const dir = await mkdtemp(path.join(tmpdir(), 'bench-secrets-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const secrets = path.join(dir, 'secrets.env');
  const existing = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  await writeFile(secrets, `REVIEWER_PASSWORD=x\nJIUAN_DATA_KEY=${existing}\n`);
  for (let round = 0; round < 2; round += 1) await run('bash', ['-c', `set -euo pipefail\nSECRETS=${JSON.stringify(secrets)}\n${block}`]);
  const text = await readFile(secrets, 'utf8');
  const value = name => [...text.matchAll(new RegExp(`^${name}=(.*)$`, 'gm'))].map(match => match[1]);
  assert.deepEqual(value('JIUAN_DATA_KEY'), [existing]);
  for (const name of ['BENCH_MYSQL_ROOT_PASSWORD', 'JIUAN_MYSQL_APP_PASSWORD', 'BENCH_PG_SUPERUSER_PASSWORD', 'JIUAN_PG_APP_PASSWORD']) {
    assert.equal(value(name).length, 1, name);
    assert.match(value(name)[0], /^[0-9a-f]{32}$/, name);
  }
  // 已有的 PG 口令也不换
  const pgBefore = value('JIUAN_PG_APP_PASSWORD')[0];
  await run('bash', ['-c', `set -euo pipefail\nSECRETS=${JSON.stringify(secrets)}\n${block}`]);
  assert.deepEqual([...(await readFile(secrets, 'utf8')).matchAll(/^JIUAN_PG_APP_PASSWORD=(.*)$/gm)].map(match => match[1]), [pgBefore]);
  await writeFile(secrets, 'REVIEWER_PASSWORD=x\n');
  await run('bash', ['-c', `set -euo pipefail\nSECRETS=${JSON.stringify(secrets)}\n${block}`]);
  assert.match((await readFile(secrets, 'utf8')).match(/^JIUAN_DATA_KEY=(.*)$/m)[1], /^[A-Za-z0-9+/]{43}=$/);
  // 2026-11-02 之前的文件里叫 JIUAN07_…：原地改名、值不变，不另生成（换了数据密钥九安的库就打不开）
  await writeFile(secrets, `REVIEWER_PASSWORD=x\nJIUAN07_MYSQL_APP_PASSWORD=0123456789abcdef0123456789abcdef\nJIUAN07_DATA_KEY=${existing}\n`);
  const { stdout } = await run('bash', ['-c', `set -euo pipefail\nSECRETS=${JSON.stringify(secrets)}\n${block}`]);
  const migrated = await readFile(secrets, 'utf8');
  assert.deepEqual([...migrated.matchAll(/^JIUAN_DATA_KEY=(.*)$/gm)].map(match => match[1]), [existing]);
  assert.deepEqual([...migrated.matchAll(/^JIUAN_MYSQL_APP_PASSWORD=(.*)$/gm)].map(match => match[1]), ['0123456789abcdef0123456789abcdef']);
  assert.doesNotMatch(migrated, /^JIUAN07_/m);
  assert.ok(!stdout.includes(existing), '不打印密钥的值');
  assert.equal((await stat(secrets)).mode & 0o777, 0o600);
});

test('构件只有九安 v0.7.10 测试台：外壳（不带测试）、构建出来的九安副本（带 node_modules）、新前端的 dist、测试台脚本、nexus-ai-operator', async () => {
  const deploy = await readFile(infra('deploy.sh'), 'utf8');
  assert.match(deploy, /^"\$POC_DIR\/bench\/build-jiuan\.sh"$/m);
  const copyLine = target => deploy.split('\n').find(line => line.includes(`"$STAGE/release/${target}"`));
  assert.match(copyLine('jiuan/'), /\.build\/jiuan\//);
  assert.doesNotMatch(copyLine('jiuan/'), /--exclude node_modules/);
  assert.match(copyLine('app/'), /--exclude test --exclude scripts --exclude node_modules/);
  assert.match(copyLine('web/dist/'), /"\$POC_DIR\/web\/dist\/"/);
  assert.match(deploy, /"\$HERE\/bench\/" "\$STAGE\/release\/bench\/"/);
  assert.match(deploy, /cp "\$OPERATOR_SCRIPT" "\$STAGE\/release\/operator\/scripts\/nexus\.py"/);
  for (const gone of [/build-public/, /APP_DIR/, /JIUAN_CODE_DIR/, /POC_STORE/, /api\/health/, /app07|web07|jiuan07/]) {
    assert.doesNotMatch(deploy, gone);
  }
});

test('实例上：解开新构件 → 新构件里的 bench-configure.sh → 换上新构件（上一版留在 previous）→ 重启 andon-jiuan；失败就停、不做健康检查', async () => {
  const deploy = await readFile(infra('deploy.sh'), 'utf8');
  const install = installBlock(deploy);
  const order = ['set -euo pipefail', 'aws s3 cp s3://$BUCKET/releases/current.tgz', 'tar -xzf "\\$work/release.tgz" -C "\\$work/release" --no-same-owner',
    'bash "\\$work/release/bench/bench-configure.sh" $SITE_DOMAIN $(param NexusOrigin)', 'rm -rf /opt/andon-finance/previous',
    'mv /opt/andon-finance/current /opt/andon-finance/previous', 'mv "\\$work/release" /opt/andon-finance/current',
    'systemctl restart andon-jiuan.service', 'systemctl is-active andon-jiuan.service'];
  let last = -1;
  for (const step of order) {
    const at = install.indexOf(step);
    assert.ok(at > last, `顺序不对或缺了：${step}`);
    last = at;
  }
  assert.doesNotMatch(install, /andon-finance-poc/);
  assert.match(deploy, /^run_root "\$INSTANCE" "\$INSTALL" 900 \|\| \{ echo "实例上的安装或重启没有成功（见上面的输出），不做健康检查" >&2; exit 1; \}$/m);
  // 只查一个站点：九安 v0.7.10（新前端）的 /poc/healthz
  assert.match(deploy, /^SITE="\$\(output SiteUrl\)"$/m);
  assert.match(deploy, /healthy "\$SITE\/poc\/healthz"/);
});

// ---------- 测试台脚本（poc/infra/bench）
test('测试台脚本语法正确，里面没有写死的密码', async () => {
  for (const name of ['mysql-install.sh', 'pg-install.sh', 'test-databases.sh', 'bench-configure.sh', 'bench-reset.sh']) {
    await run('bash', ['-n', bench(name)]);
    const text = await readFile(bench(name), 'utf8');
    assert.doesNotMatch(text, /PASSWORD=(?!\$|")[^\s"]+/, `${name} 不能有密码字面量`);
    assert.doesNotMatch(text, /-p[A-Za-z0-9]{6,}/, `${name} 不能在命令行上带密码`);
  }
});

test('MySQL 固定用 mysql:8.0，只听本机，参数和九安自己的测试编排一致；只建 root（九安 v0.7.10 的库和账号由 bench-configure.sh 建），root 密码只认原值', async () => {
  const script = await readFile(bench('mysql-install.sh'), 'utf8');
  for (const expected of ['mysql:8.0', '127.0.0.1:3306:3306', '--skip-log-bin', '--character-set-server=utf8mb4', '--collation-server=utf8mb4_unicode_ci', 'TZ=Asia/Shanghai',
    '/var/lib/jiuan-mysql:/var/lib/mysql', 'MYSQL_ROOT_PASSWORD_FILE=/run/bench-secrets/mysql_root_password', '"$DIR":/run/bench-secrets:ro']) {
    assert.ok(script.includes(expected), `mysql-install.sh 应包含 ${expected}`);
  }
  for (const gone of ['-e MYSQL_DATABASE', '-e MYSQL_USER', '-e MYSQL_PASSWORD_FILE', 'jiuan_analysis', 'root:andon', '-g andon']) assert.ok(!script.includes(gone), `不该有 ${gone}`);
  assert.doesNotMatch(script, /0\.0\.0\.0/);
  assert.match(script, /mysqladmin ping/);
  assert.match(script, /拒绝替换/);
  assert.match(script, /chmod 0600 "\$DIR\/mysql_root_password\.new"/);
  // v0.5.3 时建的容器（带 MYSQL_PASSWORD_FILE，那个文件已经没了）：只换容器、数据目录不动，再按现在的参数建
  const replace = script.indexOf("grep -q '^MYSQL_PASSWORD_FILE='");
  assert.ok(replace > 0 && replace < script.indexOf('docker run -d --name jiuan-mysql'), '先换掉旧容器再建');
  assert.match(script, /docker rm -f jiuan-mysql >\/dev\/null\n  echo "BENCH_MYSQL_CONTAINER_REPLACED"/);
  assert.doesNotMatch(script, /rm -rf \/var\/lib\/jiuan-mysql/);
  const configure = await readFile(bench('bench-configure.sh'), 'utf8');
  assert.ok(configure.indexOf('bash "$HERE/mysql-install.sh"') > 0 && configure.indexOf('bash "$HERE/mysql-install.sh"') < configure.indexOf('CREATE DATABASE IF NOT EXISTS'), '先装好 MySQL 再建库');
});

test('PostgreSQL（九安的库）：容器 jiuan-pg 用 postgres:17，只绑 127.0.0.1:5433，上海时区，数据目录 /var/lib/jiuan-pg；超级用户口令只从文件读、只认原值；容器在且参数对就不重建，参数不对只换容器、数据目录不动', async () => {
  const script = await readFile(bench('pg-install.sh'), 'utf8');
  for (const expected of ['postgres:17', '127.0.0.1:5433:5432', 'TZ=Asia/Shanghai', '-c timezone=Asia/Shanghai', '/var/lib/jiuan-pg:/var/lib/postgresql/data',
    'POSTGRES_PASSWORD_FILE=/run/bench-secrets/pg_superuser_password', '"$DIR":/run/bench-secrets:ro', 'BENCH_PG_SUPERUSER_PASSWORD', 'pg_isready', 'BENCH_PG_READY']) {
    assert.ok(script.includes(expected), `pg-install.sh 应包含 ${expected}`);
  }
  assert.doesNotMatch(script, /0\.0\.0\.0|-e POSTGRES_PASSWORD=|POSTGRES_HOST_AUTH_METHOD=trust/);
  assert.match(script, /拒绝替换/);
  assert.match(script, /chmod 0600 "\$DIR\/pg_superuser_password\.new"/);
  assert.match(script, /docker rm -f jiuan-pg >\/dev\/null\n\s+echo "BENCH_PG_CONTAINER_REPLACED"/);
  assert.doesNotMatch(script, /rm -rf \/var\/lib\/jiuan-pg/);
  const replace = script.indexOf('BENCH_PG_CONTAINER_REPLACED');
  assert.ok(replace > 0 && replace < script.indexOf('docker run -d --name jiuan-pg'), '参数不对先换容器再建');
});

test('测试库（test-databases.sh，只给远端测试用）：单独两个用完即删的容器（数据在内存里）——MySQL 在 127.0.0.1:3307（九安测试认的隔离端口）、PG 在 127.0.0.1:5434，各有一个 jiuan_test 和同名账号（PG 那边 UTF8 / C / 上海时区，账号不是超级用户）；口令只在实例上的 root 0600 文件里，经文件进容器；不碰在用的 jiuan-mysql、jiuan-pg', async () => {
  const script = await readFile(bench('test-databases.sh'), 'utf8');
  for (const expected of ['jiuan-test-mysql', 'jiuan-test-pg', '127.0.0.1:3307:3306', '127.0.0.1:5434:5432', '--tmpfs /var/lib/mysql', '--tmpfs /var/lib/postgresql/data',
    'mysql:8.0', 'postgres:17', '-e TZ=Asia/Shanghai', '-c timezone=Asia/Shanghai', 'MYSQL_ROOT_PASSWORD_FILE=', 'MYSQL_PASSWORD_FILE=', 'POSTGRES_PASSWORD_FILE=',
    'MYSQL_DATABASE=jiuan_test', 'MYSQL_USER=jiuan_test', "CREATE ROLE jiuan_test LOGIN", "CREATE DATABASE jiuan_test OWNER jiuan_test ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0",
    "ALTER DATABASE jiuan_test SET timezone = 'Asia/Shanghai'", '/etc/andon-finance/test', 'pg_test_password', 'mysql_test_password', 'umask 077',
    'TEST_DATABASES_READY', 'TEST_DATABASES_DROPPED', 'docker rm -f jiuan-test-mysql jiuan-test-pg']) {
    assert.ok(script.includes(expected), `test-databases.sh 应包含 ${expected}`);
  }
  assert.ok(script.indexOf('docker rm -f jiuan-test-mysql jiuan-test-pg') < script.indexOf('docker run -d --name jiuan-test-mysql'), 'create 先删再建');
  assert.doesNotMatch(script, /docker (exec|rm|stop|restart)[^\n]*\bjiuan-(mysql|pg)\b/, '不碰在用的容器');
  assert.doesNotMatch(script, /--restart/, '测试容器不随机器重启');
  assert.doesNotMatch(script, /-e [A-Z_]*PASSWORD=/, '口令不上命令行');
});

test('远端跑九安测试（remote-jiuan-tests.sh）：本机构建带测试的副本，传到实例上的临时目录（只有自己能读），在实例上用 root 的口令文件拼测试库地址，按文件一个一个跑（junit 报告带文件名），取回结果、删掉远端目录；不碰正在跑的服务', async () => {
  const script = await readFile(infra('remote-jiuan-tests.sh'), 'utf8');
  for (const expected of ['--with-tests', 'ssh_setup', 'remote_root', 'mktemp -d /var/tmp/jiuan-pgtest.XXXXXX', 'chmod 0700', 'test-databases.sh" create',
    '--test-concurrency=1', '--test-timeout=180000', '--test-reporter=junit', 'MYSQL_TEST_URL', 'PG_TEST_URL', 'cat /etc/andon-finance/test/', 'compare-jiuan-results.mjs', 'rm -rf',
    '@127.0.0.1:3307/jiuan_test', '@127.0.0.1:5434/jiuan_test', 'test-databases.sh" drop', 'flock -w 7200 9', '--test-force-exit', 'timeout 3300 node --test',
    '--shell-tests', 'JIUAN_DIR=', 'shell/test/unit/{pg-stores,reviews,kb-cache}.test.mjs']) {
    assert.ok(script.includes(expected), `remote-jiuan-tests.sh 应包含 ${expected}`);
  }
  assert.ok(script.indexOf('flock -w 7200 9') < script.indexOf('test-databases.sh" create'), '两次远端测试不同时跑：先拿实例上的锁再建测试库');
  assert.doesNotMatch(script, /systemctl (stop|restart) andon-jiuan/);
  assert.doesNotMatch(script, /secrets\.env/, '不碰 secrets.env');
});

test('准备 PostgreSQL（pg-prepare.sh）：先补密钥，再和 deploy.sh 一样经构件桶把 secrets.env 装到实例（root 0600），起 jiuan-pg；测试库不在这里建（远端测试每次自己起）；不重启服务、不改外壳的配置', async () => {
  const script = await readFile(infra('pg-prepare.sh'), 'utf8');
  for (const expected of ['ensure_bench_secrets "$SECRETS"', '--sse AES256', 's3://$BUCKET/secrets/secrets.env', 'chmod 0600 /etc/andon-finance/secrets.env.new',
    'pg-install.sh', 'BENCH_PG_READY']) {
    assert.ok(script.includes(expected), `pg-prepare.sh 应包含 ${expected}`);
  }
  assert.doesNotMatch(script, /test-databases\.sh/);
  assert.doesNotMatch(script, /systemctl (stop|restart|start) andon-jiuan|bench-configure\.sh/);
});

test('backup.sh、upgrade-instance.sh 语法正确', async () => {
  for (const name of ['backup.sh', 'upgrade-instance.sh']) await run('bash', ['-n', infra(name)]);
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
  assert.match(script, /m7g\.large\|m7g\.xlarge\|t3\.small\|t3\.medium\|t3\.large/);
  // AMI 不换：新类型和现在的 AMI 不是同一种架构就停
  assert.match(script, /\[\[ "\$IMAGE_ARCH" == "\$TYPE_ARCH" \]\] \|\| \{/);
});

test('备份脚本：只做根卷快照（MySQL、PG 和 /var/lib/jiuan 都在根卷上），不登实例', async () => {
  const script = await readFile(infra('backup.sh'), 'utf8');
  assert.match(script, /create-snapshot/);
  assert.match(script, /snapshot-completed/);
  assert.doesNotMatch(script, /send-command|ssh |\/var\/lib\/andon-finance/);
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
test('各脚本先读环境配置（DEPLOY_ENV）再定栈名和区域：不给就是 andon-finance-poc、us-east-1，栈名不再写死', async () => {
  const scripts = { 'deploy.sh': infra('deploy.sh'), 'destroy.sh': infra('destroy.sh'), 'backup.sh': infra('backup.sh'), 'upgrade-instance.sh': infra('upgrade-instance.sh'),
    'kb.sh': infra('kb.sh'), 'run.sh': e2eFile('run.sh'), 'migrate-data.sh': infra('migrate-data.sh') };
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

test('九安 v0.7.10 的端到端测试不写死区域和 Nexus 地址：run.sh 按配置 / 栈导出 E2E_REGION、E2E_NEXUS_HOST', async () => {
  const spec = await readFile(e2eFile('api.e2e.mjs'), 'utf8');
  assert.doesNotMatch(spec, /'--region', 'us-east-1'/);
  assert.doesNotMatch(spec, /nxs-beine1013/);
  assert.match(spec, /process\.env\.E2E_REGION/);
  assert.match(spec, /process\.env\.E2E_NEXUS_HOST/);
  const runner = await readFile(e2eFile('run.sh'), 'utf8');
  assert.match(runner, /E2E_REGION="\$REGION"/);
  assert.match(runner, /E2E_NEXUS_HOST="\$\(output_param NexusOrigin \| sed -E 's#\^https\?:\/\/##; s#\[\/:\]\.\*\$##'\)"/);
});

test('九安 v0.7.10 的端到端测试按知识库方式走：run.sh 从 DEPLOY_ENV 导出方式（缺省 pg）和这种方式的知识库 Agent 发布，s3vectors 另给桶和规则索引；测试不再调已删掉的直连 PG 接口，自定义规则的日志按带空格的 POC_CUSTOM_RULES 找', async () => {
  const runner = await readFile(e2eFile('run.sh'), 'utf8');
  assert.match(runner, /E2E_KB_MODE="\$\{KB_MODE:-pg\}"/);
  assert.match(runner, /if \[\[ "\$E2E_KB_MODE" == s3vectors \]\]; then\n  E2E_KB_PUBLICATION_ID="\$\{KB_S3V_PUBLICATION_ID:-\}"\n  E2E_KB_S3V_BUCKET="\$\{KB_S3V_BUCKET:-\}"\n  E2E_KB_S3V_RULES_INDEX="\$\{KB_S3V_RULES_INDEX:-\}"\n  export E2E_KB_S3V_BUCKET E2E_KB_S3V_RULES_INDEX\nelse\n  E2E_KB_PUBLICATION_ID="\$\{KB_PG_PUBLICATION_ID:-\}"\nfi\nexport E2E_KB_MODE E2E_KB_PUBLICATION_ID\n/);
  assert.ok(runner.indexOf('export E2E_KB_MODE') < runner.lastIndexOf('node --test --test-concurrency=1'), '先导出再跑测试');
  // 先跑新前端的 web.e2e.mjs，再跑 api.e2e.mjs（检索日志认的是 web 在知识库页上的那次检索），共用一个开始时间
  assert.match(runner, /FILES="\$\{E2E_FILES:-web\.e2e\.mjs api\.e2e\.mjs\}"/);
  assert.ok(runner.indexOf('export E2E_STARTED_AT') > 0 && runner.indexOf('export E2E_STARTED_AT') < runner.lastIndexOf('node --test --test-concurrency=1'), '先给开始时间再跑测试');
  const spec = await readFile(e2eFile('api.e2e.mjs'), 'utf8');
  const web = await readFile(e2eFile('web.e2e.mjs'), 'utf8');
  // 方式和 s3vectors 的桶、索引：jiuan 核对引用的规则编号；知识库 Agent 的发布：web 的「Agent 接入 · 知识库 Agent」和知识库页
  for (const name of ['E2E_KB_MODE', 'E2E_KB_S3V_BUCKET', 'E2E_KB_S3V_RULES_INDEX']) assert.match(spec, new RegExp(`process\\.env\\.${name}\\b`), name);
  for (const name of ['E2E_KB_MODE', 'E2E_KB_PUBLICATION_ID']) assert.match(web, new RegExp(`process\\.env\\.${name}\\b`), name);
  for (const file of [spec, web]) assert.doesNotMatch(file, /\/poc\/kb\/(documents|search-log)/, '0005 之后没有这两个接口');
  assert.match(spec, /journalLines\('POC_CUSTOM_RULES '\)/, '带空格：POC_CUSTOM_RULES_FAILED 不算');
  assert.match(spec, /'s3vectors', 'get-vectors'[\s\S]{0,300}'--return-metadata'/);
  assert.match(spec, /FROM kb_search_log/);
  // 页面那次检索要认得出（md5 取去掉首尾空白的问题，两个文件同一个问题），审核 Agent 的另数
  assert.match(spec, /createHash\('md5'\)\.update\(KB_QUESTION\.trim\(\), 'utf8'\)/);
  assert.match(spec, /count\(\*\) FILTER \(WHERE md5\(question\) = /);
  const question = file => /const KB_QUESTION = process\.env\.KB_E2E_QUESTION \|\| '([^']+)'/.exec(file)?.[1];
  assert.ok(question(spec) && question(spec) === question(web), '检索日志认的问题和 web 在页面上检索的是同一个');
  // 日志里「没有这一行」要有凭据：只有 grep 的退出码 1 算没找到，journalctl 读不出就失败
  const journal = spec.slice(spec.indexOf('async function journalLines'), spec.indexOf('async function knownRuleIds'));
  assert.doesNotMatch(journal, /\|\| true/);
  assert.match(journal, /if \[ "\$rc" -eq 1 \]; then exit 0; fi; exit "\$rc"/);
  assert.match(journal, /\|\| \{ echo "journalctl failed: \$\?" >&2; exit 3; \}/);
  // 知识库页上有真实制度：上传、检索两条不截图；就绪那条只截「上传制度」弹框（选文件之前），不截整页
  const kbCases = web.slice(web.indexOf('test(`知识库（'), web.indexOf("test('分析员"));
  assert.ok(kbCases.length > 100);
  assert.doesNotMatch(kbCases, /page\.screenshot\(/);
  assert.equal((kbCases.match(/\.screenshot\(/g) ?? []).length, 1);
  assert.match(kbCases, /dialog\.screenshot\(/);
  assert.doesNotMatch(spec.slice(spec.indexOf('async function uploadOwnRule'), spec.indexOf("test('登录")), /shot\(/);
});

test('交付包和交接仓库只带 poc/infra/env/example.env（各环境的配置不出去）；打包检查也跑 audit-agent、kb 的单元测试和 poc/infra 的测试', async () => {
  const pack = await readFile(repo('docs/delivery/make-package.sh'), 'utf8');
  assert.match(pack, /copy poc\/infra [^\n]*--include \/infra\/env\/example\.env --exclude '\/infra\/env\/\*\.env'/);
  assert.match(pack, /unittest discover -s audit-agent\/tests/);
  assert.match(pack, /unittest discover -s kb\/tests/);
  assert.match(pack, /cd "\$ROOT\/poc\/infra" && node --test "test\/\*\*\/\*\.test\.mjs"/);
});

test('搬数据（migrate-data.sh）：旧环境只读导出、整包加密、预签名 URL 15 分钟、搬完删掉；新环境先核对密钥配置相同、换完逐表核对；--skip-pg 不动 PG', async () => {
  const script = await readFile(infra('migrate-data.sh'), 'utf8');
  await run('bash', ['-n', infra('migrate-data.sh')]);
  assert.doesNotMatch(script, /set -x|set -euxo/);
  assert.match(script, /mysqldump -uroot --single-transaction/);
  assert.match(script, /pg_dump -U postgres -Fc nexus/);
  assert.match(script, /openssl enc -aes-256-cbc -pbkdf2/);
  assert.match(script, /ExpiresIn=900/);
  assert.match(script, /presign --region "\$REGION" "s3:\/\/\$TGT_BUCKET\/\$OBJECT" --expires-in 900/);
  assert.match(script, /aws s3 rm --region "\$REGION" --only-show-errors "s3:\/\/\$TGT_BUCKET\/\$OBJECT"/);
  assert.match(script, /trap cleanup EXIT/);
  assert.match(script, /secrets\.env 不是同一份/);
  assert.match(script, /--skip-pg\) SKIP_PG=true/);
  assert.match(script, /if ! \$SKIP_PG; then\n  docker exec nexus-pgvector psql[^\n]*DROP DATABASE IF EXISTS nexus/);
  // 拼出来的导出、导入脚本（--print-scripts，不读配置、不连任何东西）语法都对；旧环境上只跑导出（没有 stop / DROP / restore），新环境上才换
  const { stdout } = await run('bash', [infra('migrate-data.sh'), '--print-scripts']);
  const [exportScript, importScript] = stdout.split('# ---- import ----\n');
  assert.ok(exportScript.startsWith('# ---- export ----\n') && importScript, '要打印出导出和导入两段');
  for (const text of [exportScript, importScript]) await run('bash', ['-n', '-c', text]);
  assert.match(exportScript, /\ncounts\(\) \{\n[\s\S]*\n\}\ncounts > "\$w\/counts\.txt"\n/);
  assert.doesNotMatch(exportScript, /systemctl stop|DROP DATABASE|pg_restore|rm -rf \/var\/lib/);
  // 新环境在起服务之前数（服务一起来九安的同步就会写批次表），数完再起、再等健康检查
  assert.match(importScript, /systemctl stop andon-jiuan\.service[\s\S]*\ncounts > "\$w\/counts\.txt"\nsystemctl start [\s\S]*echo IMPORT_OK\ncat "\$w\/counts\.txt"\n/);
  // 密钥只经文件和变量，不 echo
  assert.doesNotMatch(script, /echo[^\n]*\$KEY|echo[^\n]*\$\(cat "\$WORK\/key"\)/);
});
