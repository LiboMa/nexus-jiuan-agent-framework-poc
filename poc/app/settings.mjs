/**
 * 测试台上九安 v0.7.10 的运行设置：非敏感项来自环境变量（EC2 上是 /etc/andon-finance/jiuan/env），
 * 口令、数据密钥和虚构的汇联易凭据各在密钥目录里一个文件。jiuanConfig 拼出九安的配置对象，不经九安的配置加载器
 * （它要求钉钉账号，测试台用口令登录换本地票据）。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const invalid = message => Object.assign(new Error(message), { code: 'POC_CONFIG_INVALID' });

function httpsOrigin(env, name) {
  const value = String(env[name] ?? '').trim();
  let url;
  try { url = new URL(value); } catch { throw invalid(`${name} 应是 https 站点地址`); }
  if (url.protocol !== 'https:' || url.origin !== value) throw invalid(`${name} 应是不带路径和结尾斜杠的 https 站点地址`);
  return value;
}

function absolute(env, name, fallback) {
  const value = String(env[name] || fallback || '');
  if (!path.isAbsolute(value)) throw invalid(`${name} 应是绝对路径`);
  return value;
}

function portOf(env, name, fallback) {
  const value = Number(env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw invalid(`${name} 应是端口号`);
  return value;
}

export function readSettings(env = process.env) {
  const stateDir = absolute(env, 'POC_STATE_DIR', '/var/lib/jiuan');
  return {
    origin: httpsOrigin(env, 'POC_ORIGIN'), port: portOf(env, 'POC_PORT', 4181), bindHost: env.POC_BIND || '0.0.0.0',
    secretsDir: absolute(env, 'POC_SECRETS_DIR', '/etc/andon-finance/jiuan'),
    seedPath: absolute(env, 'POC_SEED', path.join(here, 'seeds/hly-config-seed-poc.json')),
    nexusOrigin: httpsOrigin(env, 'NEXUS_ORIGIN'),
    // 「Agent 接入」页连 Nexus（列出已发布的 Agent）用的 Operator 命令行；凭证目录是 v0.7.10 自己的，不和 PoC 共用
    operatorScript: absolute(env, 'NEXUS_OPERATOR'), nexusHome: absolute(env, 'POC_NEXUS_HOME', '/var/lib/jiuan/nexus'),
    // 服务自己的数据目录：种子时间锚点（seed-anchor.json）等
    stateDir,
    database: { host: env.POC_MYSQL_HOST || '127.0.0.1', port: portOf(env, 'POC_MYSQL_PORT', 3306),
      database: env.POC_MYSQL_DATABASE || 'jiuan', user: env.POC_MYSQL_USER || 'jiuan_app' },
    kb: kbSettings(env, stateDir),
    // 「我的规则」：每人上传的自定义规则，两种知识库方式都有
    customRulesDir: path.join(stateDir, 'custom-rules'),
  };
}

const PUBLICATION_ID = /^pub_[0-9a-f]{16}$/;

/**
 * 「规则库 › 制度知识库」按 POC_KB_MODE（不写就是 pg）；两种方式都经 Nexus 上的知识库 Agent（A2A），测试台不直连 PG：
 * - pg：PG 知识库 Agent；s3vectors：知识库文档管家（读写 S3 Vectors）。
 * - 发布编号 POC_KB_PUBLICATION_ID 可以不配（publishId 为 null，页面说「知识库 Agent 还没配置」）；配了就必须是 pub_ 加 16 位十六进制，否则启动失败。
 * 调用密钥由「Agent 接入」页启用，不在设置里。
 */
function kbSettings(env, stateDir) {
  const mode = env.POC_KB_MODE || 'pg';
  if (mode !== 'pg' && mode !== 's3vectors') throw invalid('POC_KB_MODE 只能是 pg 或 s3vectors');
  const publishId = env.POC_KB_PUBLICATION_ID ? String(env.POC_KB_PUBLICATION_ID) : null;
  if (publishId !== null && !PUBLICATION_ID.test(publishId)) throw invalid('POC_KB_PUBLICATION_ID 应是知识库 Agent 的发布编号（pub_ 加 16 位十六进制）');
  return { mode, publishId, uploadsDir: path.join(stateDir, 'kb-uploads') };
}

const deepFreeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
};

/**
 * 九安的配置对象。两个虚构账号沿用 PoC 的（同一份口令），都是本机账号，能看全部虚构公司。
 * AI 独立建议打开，但不写死发给哪个发布：routes 先为空，由 agent-routes.mjs 按「Agent 接入」的启用记录现算。
 */
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
    agents: { nexusOrigin: settings.nexusOrigin, tasks: { review_advice: { enabled: true, version: 1, routes: [] } } },
  });
}
