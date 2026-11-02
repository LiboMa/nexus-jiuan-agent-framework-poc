/**
 * 以子进程调用 nexus-ai-operator（Python 标准库实现）。每个账号一个凭证目录（NEXUS_HOME），由 CLI 自己保存、续期、轮换；这里不读。
 * 连接密钥只经环境变量传给 login（不出现在命令行参数里）；输出一律要求 --json。
 */
import { execFile } from 'node:child_process';

export function execFileJson(file, args, { env, timeoutMs }) {
  return new Promise(resolve => {
    execFile(file, args, { env, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      let json = null;
      try { json = JSON.parse(stdout); } catch { /* 非 JSON 输出按失败处理 */ }
      // 退出码见 nexus.py：3 需要重新连接，4 权限不足，7 限流，8 平台不可用。程序起不来或超时也按 8 处理。
      const exitCode = error ? (Number.isInteger(error.code) ? error.code : 8) : 0;
      resolve({ exitCode, json });
    });
  });
}

export function createOperatorCli({ script, nexusHome, profile, origin, python = 'python3', timeoutMs = 30_000, exec = execFileJson }) {
  const base = ['-I', script, '--profile', profile, '--json'];
  const env = extra => ({ PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', NEXUS_HOME: nexusHome, ...extra });
  return {
    whoami: () => exec(python, [...base, 'whoami'], { env: env(), timeoutMs }),
    login: connectionKey => exec(python, [...base, 'login', '--origin', origin, '--token-env', 'NEXUS_POC_CONNECTION_KEY', '--client', 'other'],
      { env: env({ NEXUS_POC_CONNECTION_KEY: connectionKey }), timeoutMs }),
    // 只删本机凭证（不带 --revoke）：Nexus 上那把 API 密钥由用户自己在网页停用。
    logout: () => exec(python, [...base, 'logout'], { env: env(), timeoutMs }),
    get: (path, query = {}) => exec(python, [...base, 'call', 'GET', path, ...Object.entries(query).flatMap(([key, value]) => ['-q', `${key}=${value}`])],
      { env: env(), timeoutMs }),
  };
}
