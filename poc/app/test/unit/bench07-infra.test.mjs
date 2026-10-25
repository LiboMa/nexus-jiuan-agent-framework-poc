import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
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
});
