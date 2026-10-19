/**
 * 用户调用密钥的加密：AES-256-GCM，每次随机 12 字节 IV；密文格式 v1.<iv>.<tag>.<密文>（base64url）。
 * 加密密钥是启动配置 REGISTRY_KEY（secrets.env）：只拿到 enabled.json 解不出调用密钥。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const invalid = () => Object.assign(new Error('POC_SEALED_INVALID'), { code: 'POC_SEALED_INVALID' });

export function seal(key, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${body.toString('base64url')}`;
}

export function open(key, sealed) {
  const [version, iv, tag, body, extra] = String(sealed ?? '').split('.');
  if (version !== 'v1' || !iv || !tag || !body || extra !== undefined) throw invalid();
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw invalid();
  }
}

export const fingerprint = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 8);
