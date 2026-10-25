/** 运行配置：非敏感项来自环境变量（EC2 上是 /etc/andon-finance/env），口令与密钥来自密钥配置文件（见 secrets.mjs）。 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLISH_ID = /^pub_[A-Za-z0-9_-]{4,80}$/;
const invalid = message => Object.assign(new Error(message), { code: 'POC_CONFIG_INVALID' });

/** 存储：memory（默认，内存存储）或 mysql（测试台：九安的 MySQL 存储，密码和数据密钥各在一个文件里）。 */
function storeConfig(env) {
  const kind = String(env.POC_STORE || 'memory').trim();
  if (kind === 'memory') return { kind };
  if (kind !== 'mysql') throw invalid('POC_STORE 只能是 memory 或 mysql');
  const port = Number(env.BENCH_MYSQL_PORT || 3306);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw invalid('BENCH_MYSQL_PORT 应是端口号');
  const dir = String(env.BENCH_SECRETS_DIR || '/etc/andon-finance/bench');
  if (!path.isAbsolute(dir)) throw invalid('BENCH_SECRETS_DIR 应是绝对路径');
  return {
    kind,
    database: { host: env.BENCH_MYSQL_HOST || '127.0.0.1', port, database: env.BENCH_MYSQL_DATABASE || 'jiuan_analysis', user: env.BENCH_MYSQL_USER || 'jiuan_app' },
    passwordFile: path.join(dir, 'mysql_app_password'), dataKeyFile: path.join(dir, 'analysis_data_key'),
  };
}

/** 按 Host 转发给本机另一个服务（测试台上的九安 v0.7.10，见 host-proxy.mjs）：主机名和端口一起给；都不给就不转发。 */
function forwardConfig(env, origin) {
  const host = String(env.POC_FORWARD_HOST ?? '').trim();
  if (!host && !env.POC_FORWARD_PORT) return null;
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host) || host === new URL(origin).hostname) {
    throw new Error('POC_FORWARD_HOST 应是另一个站点的主机名，例如 jiuan-v0710.tinyboat.blog');
  }
  const port = Number(env.POC_FORWARD_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) throw new Error('POC_FORWARD_PORT 应是本机端口号，例如 4181');
  return { host, port };
}

export function readEnvConfig(env = process.env) {
  const need = name => {
    const value = String(env[name] ?? '').trim();
    if (!value) throw new Error(`缺少环境变量 ${name}`);
    return value;
  };
  const origin = need('POC_ORIGIN');
  if (new URL(origin).origin !== origin) throw new Error('POC_ORIGIN 应是不带路径和结尾斜杠的站点地址，例如 https://andon-finance.tinyboat.blog');
  const advisoryPublishId = need('NEXUS_ADVISORY_PUBLICATION');
  if (!PUBLISH_ID.test(advisoryPublishId)) throw new Error('NEXUS_ADVISORY_PUBLICATION 应是发布编号，例如 pub_5c53e70d8dc7ddea');
  const port = Number(env.POC_PORT ?? 4180);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('POC_PORT 应是端口号');
  return {
    origin, port, bindHost: env.POC_BIND || '0.0.0.0', region: env.AWS_REGION || 'us-east-1', forward: forwardConfig(env, origin),
    secretsFile: env.POC_SECRETS_FILE || '/etc/andon-finance/secrets.env', publicDir: env.POC_PUBLIC_DIR || path.join(here, 'public'),
    // 每个账号的目录（CLI 凭证、启用清单、留痕），见 access/store.mjs。
    usersDir: env.POC_USERS_DIR || '/var/lib/andon-finance/users',
    nexus: { origin: new URL(need('NEXUS_ORIGIN')).origin, advisoryPublishId, operatorScript: need('NEXUS_OPERATOR') },
    store: storeConfig(env),
  };
}

