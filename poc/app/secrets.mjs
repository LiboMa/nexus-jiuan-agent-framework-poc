/**
 * 密钥配置文件：一份 KEY=VALUE 文本（本机在 audit-nexus/poc/infra/secrets.env，实例上在 /etc/andon-finance/secrets.env）。
 * 填写的项：
 *   REVIEWER_PASSWORD / CHECKER_PASSWORD     两个虚构账号的口令（deploy.sh 首次运行时随机生成）
 *   NEXUS_A2A_KEY_<发布编号>                  系统提供的 A2A 调用密钥（nxa_…，审批流在用的发布）；所有用户可见、不用启用
 *   REGISTRY_KEY                             加密各用户调用密钥的密钥（32 字节 base64，deploy.sh 发现没有时生成）
 *   E2E_KNOWLEDGE_A2A_KEY / E2E_NEXUS_API_KEY  只给端到端测试用，应用不加载
 * 只在内存里使用：不打印，报错时只说缺哪一项、不带任何值。
 */
import { readFile } from 'node:fs/promises';
import { ACCOUNTS } from './accounts.mjs';

const A2A_PREFIX = 'NEXUS_A2A_KEY_';
const PUBLISH_ID = /^pub_[A-Za-z0-9_-]{4,80}$/;

export function parseSecrets(text) {
  const secrets = new Map();
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1);
    secrets.set(match[1], value);
  }
  return secrets;
}

export async function readSecretsFile(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw Object.assign(new Error(`找不到密钥配置文件 ${path}：在本机填好 audit-nexus/poc/infra/secrets.env，再运行 infra/deploy.sh`), { code: 'POC_SECRETS_UNAVAILABLE' });
  }
  return parseSecrets(text);
}

export function passwordsFrom(secrets) {
  const passwords = new Map();
  for (const account of ACCOUNTS) {
    const value = secrets.get(account.passwordKey);
    if (typeof value !== 'string' || value.length < 12) {
      throw new Error(`密钥配置文件里的 ${account.passwordKey} 缺失或太短（至少 12 个字符）：删掉这一行再运行 infra/deploy.sh 会重新生成`);
    }
    passwords.set(account.id, value);
  }
  return passwords;
}

export function a2aKeysFrom(secrets) {
  return new Map([...secrets]
    .filter(([name, value]) => name.startsWith(A2A_PREFIX) && PUBLISH_ID.test(name.slice(A2A_PREFIX.length)) && value)
    .map(([name, value]) => [name.slice(A2A_PREFIX.length), value]));
}

/** REGISTRY_KEY：加密各用户调用密钥用（32 字节，base64）。报错只说缺哪一项、怎么补，不带任何值。 */
export function registryKeyFrom(secrets) {
  const value = secrets.get('REGISTRY_KEY');
  const key = typeof value === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(value) ? Buffer.from(value, 'base64') : null;
  if (!key || key.length !== 32) {
    throw new Error('密钥配置文件里的 REGISTRY_KEY 缺失或格式不对（应是 32 字节的 base64）：运行 infra/deploy.sh 会自动补上');
  }
  return key;
}
