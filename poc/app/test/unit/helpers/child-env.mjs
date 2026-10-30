/** 测试拉起的子进程（deploy.sh、环境配置的读取、bench 脚本……）用的环境：父进程的环境去掉 DEPLOY_ENV 和环境配置能写的键。
 *  deploy.sh 的 load_deploy_env 会把读到的键 export 出来，外面的 shell 里也可能有；单元测试不看部署的环境，哪条测试要用就在 extra 里显式给。 */
import { readFileSync } from 'node:fs';

const LOADER = readFileSync(new URL('../../../../infra/lib/deploy-env.sh', import.meta.url), 'utf8');
export const DEPLOY_ENV_KEYS = /^DEPLOY_ENV_KEYS=\(([^)]*)\)/m.exec(LOADER)[1].split(/\s+/).filter(Boolean);

export function childEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of ['DEPLOY_ENV', ...DEPLOY_ENV_KEYS]) delete env[key];
  return { ...env, ...extra };
}
