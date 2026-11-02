/**
 * PoC 的口令登录：口令对了才签发九安的本地票据，浏览器再用九安原有的 /auth/exchange 把票据换成会话 Cookie。
 * 定长时间比较；按来源 IP 限流（每分钟 10 次，含成功）。口令只在内存里，来自密钥配置文件。
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { fail } from './http.mjs';

const digest = value => createHash('sha256').update(String(value), 'utf8').digest();

export function createPasswordLogin({ passwords, issueTicket, limit = 10, windowMs = 60_000, now = Date.now }) {
  const attempts = new Map();
  function count(ip) {
    const at = now();
    if (attempts.size > 1000) for (const [key, entry] of attempts) if (entry.until <= at) attempts.delete(key);
    const entry = attempts.get(ip);
    const current = entry && entry.until > at ? entry : { until: at + windowMs, count: 0 };
    current.count += 1;
    attempts.set(ip, current);
    if (current.count > limit) fail('POC_LOGIN_RATE_LIMIT', 429);
  }
  return {
    login({ account, password, ip }) {
      count(ip);
      if (typeof account !== 'string' || typeof password !== 'string' || !password || password.length > 200) fail('INVALID_CREDENTIALS', 401);
      const expected = passwords.get(account);
      const same = timingSafeEqual(digest(password), digest(expected ?? `no-such-account:${account}`));
      if (!same || expected === undefined) fail('INVALID_CREDENTIALS', 401);
      return { ticket: issueTicket(account) };
    },
  };
}
