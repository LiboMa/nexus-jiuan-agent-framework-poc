/**
 * 测试台上九安 v0.7.10 的运行设置：非敏感项来自环境变量（EC2 上是 /etc/andon-finance/jiuan07/env），
 * 口令、数据密钥和虚构的汇联易凭据各在密钥目录里一个文件。jiuanConfig 拼出九安的配置对象，不经九安的配置加载器
 * （它要求钉钉账号，测试台用口令登录换本地票据）。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLISH_ID = /^pub_[A-Za-z0-9_-]{4,80}$/;
const invalid = message => Object.assign(new Error(message), { code: 'POC_CONFIG_INVALID' });

function httpsOrigin(env, name) {
  const value = String(env[name] ?? '').trim();
  let url;
  try { url = new URL(value); } catch { throw invalid(`${name} 应是 https 站点地址`); }
  if (url.protocol !== 'https:' || url.origin !== value) throw invalid(`${name} 应是不带路径和结尾斜杠的 https 站点地址`);
  return value;
}

function absolute(env, name, fallback) {
  const value = String(env[name] || fallback);
  if (!path.isAbsolute(value)) throw invalid(`${name} 应是绝对路径`);
  return value;
}

function portOf(env, name, fallback) {
  const value = Number(env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw invalid(`${name} 应是端口号`);
  return value;
}

export function readSettings(env = process.env) {
  const publishId = String(env.NEXUS_REVIEW_ADVICE_PUBLICATION ?? '').trim();
  if (!PUBLISH_ID.test(publishId)) throw invalid('NEXUS_REVIEW_ADVICE_PUBLICATION 应是发布编号，例如 pub_5c53e70d8dc7ddea');
  return {
    origin: httpsOrigin(env, 'POC07_ORIGIN'), port: portOf(env, 'POC07_PORT', 4181), bindHost: env.POC07_BIND || '0.0.0.0',
    secretsDir: absolute(env, 'POC07_SECRETS_DIR', '/etc/andon-finance/jiuan07'),
    seedPath: absolute(env, 'POC07_SEED', path.join(here, 'seeds/hly-config-seed-poc.json')),
    nexusOrigin: httpsOrigin(env, 'NEXUS_ORIGIN'), publishId,
    database: { host: env.POC07_MYSQL_HOST || '127.0.0.1', port: portOf(env, 'POC07_MYSQL_PORT', 3306),
      database: env.POC07_MYSQL_DATABASE || 'jiuan07', user: env.POC07_MYSQL_USER || 'jiuan07_app' },
  };
}

const deepFreeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
};

/** 九安的配置对象。两个虚构账号沿用 PoC 的（同一份口令），都是本机账号，能看全部虚构公司。 */
export function jiuanConfig(settings, { tenantId, connectionId, companies }) {
  const secret = name => path.join(settings.secretsDir, name);
  const companyIds = companies.map(company => company.id);
  const account = (id, name, role) => ({ id, name, role, mode: 'local_owner', enabled: true, companyIds: [...companyIds],
    providerScopes: { huilianyi: { companyIds: [...companyIds] } } });
  return deepFreeze({
    environment: 'prod', mode: 'read_only_analysis', instance: 'test', deployment: 'ecs-docker',
    connectionId, origin: settings.origin,
    scope: { tenantId, companyId: companyIds[0], allCompaniesInTenant: true },
    source: { kind: 'huilianyi-stage-oauth', appIdFile: secret('hly_app_id'), appSecretFile: secret('hly_app_secret') },
    database: { engine: 'mysql', ...settings.database },
    secretFiles: { databasePassword: secret('mysql_app_password'), dataKey: secret('analysis_data_key') },
    automaticSync: true, syncIntervalMs: 60_000,
    accounts: [account('poc-reviewer', '审核员（虚构）', 'admin'), account('poc-checker', '复核人（虚构）', 'analyst')],
    agents: { nexusOrigin: settings.nexusOrigin, tasks: { review_advice: { enabled: true, version: 1,
      routes: [{ when: { documentType: 'corporate_payment' }, publishId: settings.publishId }] } } },
  });
}
