import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// 知识库（kb/，PostgreSQL + pgvector → Nexus 数据连接器 → 审核 Agent）和测试台共用一套 IaC：
// PG 跑在测试台实例上（kb 的 existing 模式），PG 端口的入站规则由测试台的栈管（KbAllowedCidr / KbIngress），
// infra/kb.sh 从栈里取实例、网段、Nexus 地址生成 kb 的配置，再调用 kb/deploy.sh。
const run = promisify(execFile);
const infra = name => fileURLToPath(new URL(`../../../infra/${name}`, import.meta.url));
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const KB_SH = infra('kb.sh');
const block = (text, name) => { const start = text.indexOf(`\n  ${name}:\n`); assert.ok(start >= 0, `模板里缺 ${name}`); const rest = text.slice(start + 1); const next = rest.slice(3).search(/\n  [A-Za-z]/); return next < 0 ? rest : rest.slice(0, next + 3); };

test('模板：PG 端口的入站规则归测试台的栈管——KbAllowedCidr 为空就不建，只接受私网段，规则加在应用的安全组上', async () => {
  const template = await readFile(infra('andon-finance-poc.yaml'), 'utf8');
  const cidr = block(template, 'KbAllowedCidr');
  assert.match(cidr, /Type: String\n\s+Default: ''/);
  const pattern = new RegExp(/AllowedPattern: '([^']+)'/.exec(cidr)[1]);
  for (const ok of ['', '10.0.0.0/8', '10.0.1.10/32', '172.16.0.0/12', '192.168.1.0/24']) assert.ok(pattern.test(ok), `应接受 ${JSON.stringify(ok)}`);
  for (const bad of ['0.0.0.0/0', '8.8.8.0/24', '172.32.0.0/16', '10.0.0.0', '10.0.0.0/33']) assert.ok(!pattern.test(bad), `应拒绝 ${bad}`);
  assert.match(block(template, 'KbPort'), /Type: Number\n\s+Default: 5432/);
  assert.match(template, /KbEnabled: !Not \[!Equals \[!Ref KbAllowedCidr, ''\]\]/);
  const ingress = block(template, 'KbIngress');
  for (const line of [/Type: AWS::EC2::SecurityGroupIngress/, /Condition: KbEnabled/, /GroupId: !GetAtt AppSecurityGroup\.GroupId/, /IpProtocol: tcp/,
    /FromPort: !Ref KbPort/, /ToPort: !Ref KbPort/, /CidrIp: !Ref KbAllowedCidr/]) assert.match(ingress, line);
});

/** 假的 aws 命令：按参数回栈的输出 / 参数，记下每次调用；FAKE_* 环境变量控制现场状态。 */
async function harness({ settings = 'RULES_DOCX=/local/rules.docx\nNEXUS_ADMIN_PASSWORD_FILE=/local/nexus-admin\n', fakeKb = false } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'kb-infra-'));
  const bin = path.join(dir, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'aws'), `#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
case "$*" in
  *"describe-stack-resource"*"KbIngress"*) [[ "\${FAKE_MANAGED:-0}" == 1 ]] && echo sgr-managed || exit 254 ;;
  *"describe-stack-resource"*"AppSecurityGroup"*) echo sg-0123456789abcdef0 ;;
  *"describe-security-group-rules"*) [[ "\${FAKE_MANUAL:-0}" == 1 ]] && echo sgr-0manual0000000001 ;;
  *"revoke-security-group-ingress"*|*"authorize-security-group-ingress"*) echo '{"Return": true}' ;;
  *"cloudformation deploy"*) [[ "\${FAKE_DEPLOY_FAIL:-0}" == 1 ]] && exit 255 || echo deployed ;;
  *"OutputKey=='InstanceId'"*) echo i-0123456789abcdef0 ;;
  *"ParameterKey=='KbAllowedCidr'"*) echo "\${FAKE_KB_CIDR-10.0.0.0/8}" ;;
  *"ParameterKey=='KbPort'"*) echo 5432 ;;
  *"ParameterKey=='NexusOrigin'"*) echo https://nexus.example ;;
  *) echo "unexpected aws $*" >&2; exit 9 ;;
esac
`);
  await chmod(path.join(bin, 'aws'), 0o755);
  let kbDir = path.join(ROOT, 'kb');
  if (fakeKb) {
    kbDir = path.join(dir, 'kb');
    await mkdir(kbDir);
    await copyFile(path.join(ROOT, 'kb/deploy.env.example'), path.join(kbDir, 'deploy.env.example'));
    await writeFile(path.join(kbDir, 'deploy.sh'), '#!/usr/bin/env bash\necho "KB_DEPLOY $*"\n');
    await chmod(path.join(kbDir, 'deploy.sh'), 0o755);
  }
  await writeFile(path.join(dir, 'kb.env'), settings);
  const config = path.join(dir, 'state', 'infra.env');
  const log = path.join(dir, 'aws.log');
  await writeFile(log, '');
  const kb = async (args, env = {}) => {
    try {
      const { stdout, stderr } = await run('bash', [KB_SH, ...args], { env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, KB_DIR: kbDir, KB_SETTINGS: path.join(dir, 'kb.env'),
        KB_CONFIG: config, FAKE_LOG: log, ...env } });
      return { code: 0, stdout, stderr };
    } catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  };
  const resolved = async () => (await run('bash', ['-c', `set -a; source "${config}"; for k in AWS_REGION PG_HOST_MODE PG_HOST_INSTANCE_ID PG_ALLOWED_CIDR PG_PORT NEXUS_URL RULES_DOCX NEXUS_ADMIN_PASSWORD_FILE; do echo "$k=\${!k}"; done`])).stdout;
  return { dir, kb, config, resolved, calls: async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean), done: () => rm(dir, { recursive: true, force: true }) };
}

test('kb.sh config：由栈的输出和参数（实例、网段、端口、Nexus 地址）加上 infra/kb.env 生成知识库工具的配置，0600；栈的值优先', async t => {
  const h = await harness({ settings: 'RULES_DOCX=/local/rules.docx\nNEXUS_ADMIN_PASSWORD_FILE=/local/nexus-admin\nPG_HOST_INSTANCE_ID=i-0fedcba9876543210\n' });
  t.after(h.done);
  const result = await h.kb(['config']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await stat(h.config)).mode & 0o777, 0o600);
  assert.equal(await h.resolved(), ['AWS_REGION=us-east-1', 'PG_HOST_MODE=existing', 'PG_HOST_INSTANCE_ID=i-0123456789abcdef0', 'PG_ALLOWED_CIDR=10.0.0.0/8',
    'PG_PORT=5432', 'NEXUS_URL=https://nexus.example', 'RULES_DOCX=/local/rules.docx', 'NEXUS_ADMIN_PASSWORD_FILE=/local/nexus-admin', ''].join('\n'));
  assert.match(result.stderr, /PG_HOST_INSTANCE_ID.*以栈为准/);
  assert.ok((await h.calls()).every(call => /describe-stacks/.test(call)), '生成配置只读栈');
});

test('kb.sh config：kb.env 里写了明文的 Nexus 管理员密码就拒绝；栈还没开 PG 端口（KbAllowedCidr 为空）就先让人跑 kb.sh sg', async t => {
  const plain = await harness({ settings: 'NEXUS_ADMIN_PASSWORD=hunter2hunter2\n' });
  t.after(plain.done);
  const refused = await plain.kb(['config']);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /NEXUS_ADMIN_PASSWORD/);
  assert.doesNotMatch(refused.stderr + refused.stdout, /hunter2/);
  await assert.rejects(stat(plain.config));
  const closed = await harness();
  t.after(closed.done);
  const result = await closed.kb(['config'], { FAKE_KB_CIDR: '' });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /kb\.sh sg/);
});

test('kb.sh <阶段>：生成配置后原样交给 kb/deploy.sh --config', async t => {
  const h = await harness({ fakeKb: true });
  t.after(h.done);
  const result = await h.kb(['verify', '--e2e']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`KB_DEPLOY --config ${h.config.replaceAll('/', '\\/')} verify --e2e`));
});

test('kb.sh sg：把 PG 端口的入站规则交给栈；现场有手工加的同样规则时先列出，--yes 才撤掉再由栈建，栈更新失败就把手工规则加回去', async t => {
  const h = await harness();
  t.after(h.done);
  const listed = await h.kb(['sg', '--cidr', '10.0.0.0/8'], { FAKE_MANUAL: '1' });
  assert.equal(listed.code, 3, listed.stderr);
  assert.match(listed.stderr, /sgr-0manual0000000001/);
  assert.ok(!(await h.calls()).some(call => /revoke|cloudformation deploy/.test(call)), '没加 --yes：不撤、不改栈');
  const bad = await h.kb(['sg', '--cidr', '8.8.8.0/24']);
  assert.equal(bad.code, 2);

  const moved = await harness();
  t.after(moved.done);
  const result = await moved.kb(['sg', '--cidr', '10.0.0.0/8', '--yes'], { FAKE_MANUAL: '1' });
  assert.equal(result.code, 0, result.stderr);
  const calls = await moved.calls();
  const revoke = calls.findIndex(call => /revoke-security-group-ingress.*sg-0123456789abcdef0.*sgr-0manual0000000001/.test(call));
  const deploy = calls.findIndex(call => /cloudformation deploy.*KbAllowedCidr=10\.0\.0\.0\/8/.test(call));
  assert.ok(revoke >= 0 && deploy > revoke, calls.join('\n'));
  assert.match(calls[deploy], /--tags project=andon-finance-poc/);

  const failed = await harness();
  t.after(failed.done);
  const rolled = await failed.kb(['sg', '--cidr', '10.0.0.0/8', '--yes'], { FAKE_MANUAL: '1', FAKE_DEPLOY_FAIL: '1' });
  assert.notEqual(rolled.code, 0);
  assert.ok((await failed.calls()).some(call => /authorize-security-group-ingress.*sg-0123456789abcdef0.*10\.0\.0\.0\/8/.test(call)), '栈没建成：手工规则加回去');

  const managed = await harness();
  t.after(managed.done);
  const again = await managed.kb(['sg', '--cidr', '10.0.0.0/8'], { FAKE_MANAGED: '1' });
  assert.equal(again.code, 0, again.stderr);
  assert.ok(!(await managed.calls()).some(call => /revoke/.test(call)), '已经归栈管：不撤规则');
});

test('deploy.sh 建栈 / 更新栈时可以带上 KB_ALLOWED_CIDR；导出交接内容时带上 kb/，不带它的配置、状态、生成物和制度原文', async () => {
  const deploy = await readFile(infra('deploy.sh'), 'utf8');
  assert.match(deploy, /KbAllowedCidr=\$KB_ALLOWED_CIDR/);
  const pack = await readFile(path.join(ROOT, 'docs/delivery/make-package.sh'), 'utf8');
  // 仿真文档（单元测试用，虚构内容）要带上：rsync 先匹配的规则生效，所以 include 写在 '*.docx' 之前
  assert.match(pack, /copy kb --exclude \/kb\/\.state --exclude \/kb\/\.build --exclude \/kb\/deploy\.env --include \/kb\/tests\/fixtures\/sample-matrix\.docx --exclude '\*\.docx' --exclude '\*\.doc'/);
  assert.match(pack, /--exclude kb\.env/);
  await run('bash', ['-n', KB_SH]);
});

test('模板：知识库在库里生成向量（PG 容器经实例角色调 Bedrock）——KbEnabled 时实例角色多一条策略，只许调 Titan v2 这一个嵌入模型', async () => {
  const template = await readFile(infra('andon-finance-poc.yaml'), 'utf8');
  const policy = block(template, 'KbBedrockPolicy');
  for (const line of [/Type: AWS::IAM::Policy/, /Condition: KbEnabled/, /Roles: \[!Ref InstanceRole\]/, /Action: bedrock:InvokeModel/,
    /Resource: !Sub 'arn:\$\{AWS::Partition\}:bedrock:\$\{AWS::Region\}::foundation-model\/amazon\.titan-embed-text-v2:0'/]) assert.match(policy, line);
  assert.equal((policy.match(/Effect:/g) || []).length, 1, '只有一条声明');
  assert.doesNotMatch(policy, /bedrock:\*|Resource: '\*'/);
});

test('测试台配置：「制度知识库」页经知识库 Agent，不直连 PG——jiuan07-kb 段不读 PG 主机的 .env、不写连库密码、不建 venv、不取私网 IP；先算出知识库的设置再写 env', async () => {
  const configure = await readFile(infra('bench/bench07-configure.sh'), 'utf8');
  const kb = configure.slice(configure.indexOf('# >>> jiuan07-kb'), configure.indexOf('# <<< jiuan07-kb'));
  assert.ok(kb.length > 100, 'bench07-configure.sh 里要有 jiuan07-kb 段');
  assert.doesNotMatch(kb, /nexus-pgvector|NEXUS_DB_|write_secret|kb-venv|psycopg|meta-data|POC07_KB_PG_HOST/);
  assert.match(kb, /install -d -o jiuan07 -g jiuan07 -m 0700 \/var\/lib\/jiuan07\/kb-uploads/);
  assert.ok(configure.indexOf('# <<< jiuan07-kb') < configure.indexOf('cat > "$DIR/env.new" <<ENV'), '先算出知识库的设置再写 env');
  assert.match(configure.slice(configure.indexOf('cat > "$DIR/env.new" <<ENV')), /\$\{KB_LINES\}\nENV/);
});

test('部署：构件里带上知识库的入库代码与 SQL（kb/lib、kb/sql），不带状态、生成物和文档原文', async () => {
  const deploy = await readFile(infra('deploy.sh'), 'utf8');
  assert.match(deploy, /rsync -a --exclude __pycache__ --exclude \.DS_Store "\$POC_DIR\/\.\.\/kb\/lib" "\$POC_DIR\/\.\.\/kb\/sql" "\$STAGE\/release\/kb\/"/);
  assert.match(deploy, /mkdir -p [^\n]*"\$STAGE\/release\/kb"/);
});

test('kb/deploy.sh ingest --dry-run：规则编号已属于库里另一份文档时先警告（实跑时 ingest_rules.py 拒绝入库，一条不写）', async () => {
  const deploy = await readFile(path.join(ROOT, 'kb/deploy.sh'), 'utf8');
  const dry = deploy.slice(deploy.indexOf('if $DRY_RUN; then\n    plan "新增 $ins'), deploy.indexOf('if [ "$ins$upd$ret$prn" = "0000" ]'));
  assert.match(dry, /jget conflicts/);
  assert.match(dry, /已属于库里另一份文档/);
});

test('kb 的 create 模式：新建的 PG 主机也能做库内语义检索——实例角色只许调配置的嵌入模型，IMDS 跳数 2（PG 容器经 Docker 网桥取实例角色凭证）', async () => {
  const host = await readFile(path.join(ROOT, 'kb/cfn/pgvector-host.yaml'), 'utf8');
  assert.match(block(host, 'EmbedModelId'), /Type: String\n\s+Default: amazon\.titan-embed-text-v2:0/);
  const role = block(host, 'HostRole');
  for (const line of [/Action: bedrock:InvokeModel/, /Resource: !Sub 'arn:\$\{AWS::Partition\}:bedrock:\$\{AWS::Region\}::foundation-model\/\$\{EmbedModelId\}'/]) assert.match(role, line);
  assert.equal((role.match(/Effect: Allow/g) || []).length, 2, '信任策略一条 + 调模型一条');
  assert.match(block(host, 'Host'), /HttpPutResponseHopLimit: 2/);
  const deploy = await readFile(path.join(ROOT, 'kb/deploy.sh'), 'utf8');
  assert.match(deploy, /"ImageId=\$ami" "EmbedModelId=\$EMBED_MODEL_ID"/);
});

test('仿真文档进仓库：kb/.gitignore 忽略所有 .docx（制度原文），只把单元测试用的仿真文档放出来', async () => {
  const ignore = (await readFile(path.join(ROOT, 'kb/.gitignore'), 'utf8')).split('\n').map(line => line.trim());
  const docx = ignore.indexOf('*.docx'), fixture = ignore.indexOf('!tests/fixtures/sample-matrix.docx');
  assert.ok(docx >= 0 && fixture > docx, 'git 按顺序看规则：放行要写在 *.docx 之后');
  const { stdout } = await run('git', ['-C', ROOT, 'check-ignore', '-v', '--no-index', 'kb/tests/fixtures/sample-matrix.docx']).catch(error => ({ stdout: error.stdout }));
  assert.match(stdout, /!tests\/fixtures\/sample-matrix\.docx/, '仿真文档不被忽略');
});

test('kb.sh 读环境配置（DEPLOY_ENV）：栈名、区域、kb 的个人设置文件都从它来；配置里写了 AGENT_NAME 就以它为准写进 kb 的配置', async t => {
  const h = await harness({ settings: 'RULES_DOCX=/local/rules.docx\nNEXUS_ADMIN_PASSWORD_FILE=/local/nexus-admin\nAGENT_NAME=jiuan_audit_ai_poc\n' });
  t.after(h.done);
  const env = path.join(h.dir, 'rehearsal.env');
  await writeFile(env, `STACK=andon-finance-rehearsal\nAWS_REGION=us-east-1\nKB_SETTINGS=${path.join(h.dir, 'kb.env')}\nAGENT_NAME=jiuan_audit_ai_rehearsal\n`);
  const result = await h.kb(['config'], { DEPLOY_ENV: env, KB_SETTINGS: path.join(h.dir, 'no-such-kb.env'), STACK: 'other-stack' });
  assert.equal(result.code, 0, result.stderr);
  const calls = await h.calls();
  assert.ok(calls.length && calls.every(call => call.includes('--stack-name andon-finance-rehearsal') && call.includes('--region us-east-1')), calls.join('\n'));
  const agent = (await run('bash', ['-c', `set -a; source "${h.config}"; echo "$AGENT_NAME"`])).stdout.trim();
  assert.equal(agent, 'jiuan_audit_ai_rehearsal');
  assert.match(result.stderr, /AGENT_NAME.*以环境配置为准/);
});
