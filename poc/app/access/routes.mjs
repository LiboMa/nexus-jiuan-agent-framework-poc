/**
 * 「我的 Nexus」接口（接口约定 agent-access-v1，前缀 /api/analysis/v1/poc/nexus/me），挂在九安的 platformRoutes 钩子上：会话、来源与 CSRF 已由九安校验。
 * 只作用于当前会话的账号；返回里不含任何密钥。页面、命令行 agent_access.py 与以后的编码工具共用这一套。
 */
import { onlyFields, onlyQuery, readJson, sendJson } from '../http.mjs';

const BASE = '/api/analysis/v1/poc/nexus/me';
const AGENT = /^\/agents\/([^/]+)\/(enable|disable)$/;

export function meRoutes({ me }) {
  return () => ({
    async handle({ req, url, path, session, res }) {
      if (path !== BASE && !path.startsWith(`${BASE}/`)) return false;
      const route = path.slice(BASE.length);
      const user = session.user;
      const send = data => { sendJson(res, 200, { data }); return true; };
      if (route === '' && req.method === 'GET') { onlyQuery(url, []); return send(await me.view(user)); }
      const agent = AGENT.exec(route);
      if (req.method !== 'POST' || !(['/connect', '/disconnect', '/refresh'].includes(route) || agent)) return false;
      onlyQuery(url, []);
      const body = await readJson(req, { maximum: 4000 });
      if (route === '/connect') { onlyFields(body, ['apiKey', 'client']); return send(await me.connect(user, body.apiKey, { client: body.client })); }
      if (route === '/disconnect') { onlyFields(body, ['client']); return send(await me.disconnect(user, { client: body.client })); }
      if (route === '/refresh') { onlyFields(body, []); return send(await me.refresh(user)); }
      if (agent[2] === 'enable') { onlyFields(body, ['token', 'loadCapabilities', 'issue', 'client']); return send(await me.enable(user, agent[1], body)); }
      onlyFields(body, ['client']);
      return send(await me.disable(user, agent[1], { client: body.client }));
    },
  });
}
