import test from 'node:test';
import assert from 'node:assert/strict';
import { readSettings, jiuanConfig } from '../../settings.mjs';
import { guardedFetch } from '../../guard.mjs';

const ENV = { POC_ORIGIN: 'https://jiuan-v0710.tinyboat.blog', NEXUS_ORIGIN: 'https://nxs-beine1013.tinyboat.blog',
  NEXUS_OPERATOR: '/opt/andon-finance/current/operator/scripts/nexus.py' };
const COMPANIES = [{ id: 'co-a', name: '甲（虚构）' }, { id: 'co-b', name: '乙（虚构）' }];

test('设置：默认端口 4181、密钥目录和新库；地址、发布编号、目录都要合规', () => {
  const settings = readSettings(ENV);
  assert.equal(settings.port, 4181);
  assert.equal(settings.secretsDir, '/etc/andon-finance/jiuan');
  assert.deepEqual(settings.database, { host: '127.0.0.1', port: 3306, database: 'jiuan', user: 'jiuan_app' });
  assert.throws(() => readSettings({ ...ENV, POC_ORIGIN: 'http://jiuan-v0710.tinyboat.blog' }), /POC_ORIGIN/);
  assert.equal('publishId' in settings, false, '不写死发布：用哪个发布由「Agent 接入」的启用记录决定');
  assert.throws(() => readSettings({ ...ENV, POC_SECRETS_DIR: 'relative/dir' }), /POC_SECRETS_DIR/);
  // 「Agent 接入」页连 Nexus 用的 Operator 命令行和它自己的凭证目录（和 PoC 的不共用）
  assert.equal(settings.operatorScript, '/opt/andon-finance/current/operator/scripts/nexus.py');
  assert.equal(settings.nexusHome, '/var/lib/jiuan/nexus');
  assert.throws(() => readSettings({ ...ENV, NEXUS_OPERATOR: '' }), /NEXUS_OPERATOR/);
});

test('知识库方式（POC_KB_MODE，不写就是 pg）：两种方式都经知识库 Agent，kb 一个样 { mode, publishId, uploadsDir }；不再有 PG 连库设置；「我的规则」目录单独一项，两种方式都有', () => {
  const PG_LEFTOVERS = { POC_KB_PG_HOST: '10.0.1.10', POC_KB_DIR: '/opt/andon-finance/current/kb', POC_KB_PYTHON: '/opt/x/bin/python', POC_KB_USER: 'nexus', POC_KB_DB: 'nexus' };
  const PG_PUB = 'pub_fedcba9876543210', S3V_PUB = 'pub_0123456789abcdef';
  assert.deepEqual(readSettings(ENV).kb, { mode: 'pg', publishId: null, uploadsDir: '/var/lib/jiuan/kb-uploads' });
  assert.deepEqual(readSettings({ ...ENV, POC_KB_MODE: 'pg' }).kb, { mode: 'pg', publishId: null, uploadsDir: '/var/lib/jiuan/kb-uploads' });
  assert.deepEqual(readSettings({ ...ENV, POC_KB_MODE: '', POC_KB_PUBLICATION_ID: PG_PUB }).kb, { mode: 'pg', publishId: PG_PUB, uploadsDir: '/var/lib/jiuan/kb-uploads' });
  // 旧 env 文件里留下的 PG 连库变量和 S3 Vectors 的旧发布变量一概不认
  assert.deepEqual(readSettings({ ...ENV, ...PG_LEFTOVERS, POC_KB_S3V_PUBLICATION_ID: S3V_PUB }).kb, { mode: 'pg', publishId: null, uploadsDir: '/var/lib/jiuan/kb-uploads' });
  assert.deepEqual(readSettings({ ...ENV, POC_KB_MODE: 's3vectors', POC_KB_PUBLICATION_ID: S3V_PUB }).kb, { mode: 's3vectors', publishId: S3V_PUB, uploadsDir: '/var/lib/jiuan/kb-uploads' });
  assert.deepEqual(readSettings({ ...ENV, ...PG_LEFTOVERS, POC_KB_MODE: 's3vectors', POC_KB_PUBLICATION_ID: S3V_PUB, POC_STATE_DIR: '/srv/j7' }).kb,
    { mode: 's3vectors', publishId: S3V_PUB, uploadsDir: '/srv/j7/kb-uploads' });
  assert.equal(readSettings({ ...ENV, POC_KB_MODE: 's3vectors' }).kb.publishId, null, '没配编号时页面说「知识库 Agent 还没配置」，不是启动失败');
  assert.equal(readSettings(ENV).customRulesDir, '/var/lib/jiuan/custom-rules');
  assert.equal(readSettings({ ...ENV, POC_STATE_DIR: '/srv/j7' }).customRulesDir, '/srv/j7/custom-rules');
  assert.equal('publishId' in readSettings({ ...ENV, POC_KB_PUBLICATION_ID: PG_PUB }), false, '知识库 Agent 的发布只在 kb 里');
  assert.throws(() => readSettings({ ...ENV, POC_KB_MODE: 'mongo' }), error => error.code === 'POC_CONFIG_INVALID' && /POC_KB_MODE/.test(error.message));
});

test('知识库 Agent 的发布编号 POC_KB_PUBLICATION_ID：给了就必须是 pub_ 加 16 位十六进制，否则启动失败（两种方式都是）', () => {
  for (const mode of ['pg', 's3vectors']) {
    for (const id of ['pub_0123', 'pub_0123456789ABCDEF', 'pub_0123456789abcdefa', ' pub_0123456789abcdef', 'pub_0123456789abcdef\n', 'agent_0123456789abcdef', ' ']) {
      assert.throws(() => readSettings({ ...ENV, POC_KB_MODE: mode, POC_KB_PUBLICATION_ID: id }),
        error => error.code === 'POC_CONFIG_INVALID' && /POC_KB_PUBLICATION_ID/.test(error.message), `${mode} ${JSON.stringify(id)}`);
    }
  }
});

test('九安配置：测试实例、测试汇联易、AI 独立建议打开但不写死发布（路由由启用记录现算），没有回写，两个本机账号', () => {
  const settings = readSettings(ENV);
  const config = jiuanConfig(settings, { tenantId: 'poc-tenant', connectionId: 'hly-stage-poc', companies: COMPANIES });
  assert.equal(config.instance, 'test');
  assert.equal(config.environment, 'prod');
  assert.equal(config.deployment, 'ecs-docker');
  assert.equal(config.source.kind, 'huilianyi-stage-oauth');
  assert.equal(config.source.appIdFile, '/etc/andon-finance/jiuan/hly_app_id');
  assert.deepEqual(config.secretFiles, { databasePassword: '/etc/andon-finance/jiuan/mysql_app_password', dataKey: '/etc/andon-finance/jiuan/analysis_data_key' });
  assert.deepEqual(config.scope, { tenantId: 'poc-tenant', companyId: 'co-a', allCompaniesInTenant: true });
  assert.equal(config.approvalWriteback, undefined);
  assert.deepEqual(config.agents, { nexusOrigin: 'https://nxs-beine1013.tinyboat.blog', tasks: { review_advice: { enabled: true, version: 1, routes: [] } } });
  assert.deepEqual(config.accounts.map(account => [account.id, account.role, account.mode, account.companyIds]),
    [['poc-reviewer', 'admin', 'local_owner', ['co-a', 'co-b']], ['poc-checker', 'analyst', 'local_owner', ['co-a', 'co-b']]]);
  assert.ok(Object.isFrozen(config) && Object.isFrozen(config.agents.tasks.review_advice));
  assert.doesNotMatch(JSON.stringify(config), /pub_/);
});

test('出网守卫：只放行名单里的 https 主机，其余一律拒绝并记下', async () => {
  const blocked = [];
  const fetch = guardedFetch({ allowHosts: ['nxs-beine1013.tinyboat.blog'], fetchImpl: async url => `ok ${url}`, onBlocked: host => blocked.push(host) });
  assert.equal(await fetch('https://nxs-beine1013.tinyboat.blog/a2a/pub_x'), 'ok https://nxs-beine1013.tinyboat.blog/a2a/pub_x');
  assert.equal(await fetch(new URL('https://nxs-beine1013.tinyboat.blog/x')), 'ok https://nxs-beine1013.tinyboat.blog/x');
  for (const url of ['https://apistage.huilianyi.com/oauth/token', 'https://oapi.dingtalk.com/gettoken', 'http://nxs-beine1013.tinyboat.blog/', 'http://169.254.169.254/latest/meta-data/']) {
    await assert.rejects(fetch(url), error => error.code === 'POC_EGRESS_BLOCKED');
  }
  await assert.rejects(fetch({ url: 'https://example.invalid/' }), error => error.code === 'POC_EGRESS_BLOCKED');
  assert.deepEqual(blocked, ['apistage.huilianyi.com', 'oapi.dingtalk.com', 'nxs-beine1013.tinyboat.blog', '169.254.169.254', 'example.invalid']);
});
