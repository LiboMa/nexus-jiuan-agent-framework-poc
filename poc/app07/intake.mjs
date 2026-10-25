/**
 * 模拟来单（挂在九安的 platformRoutes 钩子上：会话、来源、CSRF 已由九安校验）：
 *   GET  /api/analysis/v1/poc/intake/templates  登录后可看模板；
 *   POST /api/analysis/v1/poc/intake {template}  管理员才能来单：假汇联易里多一张新单，九安下一轮同步（约 1 分钟）拉进单据池，
 *                                                读完详情后自动发起 AI 独立建议。每个账号每分钟最多 5 次。
 * 九安只替 /platform 下的写请求读请求体（analysis-server.mjs 的 requestBody），这里的请求体自己读。
 */
import { fail, onlyFields, readJson, sendError, sendJson } from '../app/http.mjs';

const BASE = '/api/analysis/v1/poc/intake';

export function intakeRoutes({ fake, perMinute = 5, now = Date.now }) {
  const windows = new Map();
  function limit(userId) {
    const at = now(), entry = windows.get(userId);
    const current = entry && entry.until > at ? entry : { until: at + 60_000, count: 0 };
    if (current.count >= perMinute) fail('POC_INTAKE_RATE_LIMIT', 429);
    current.count += 1;
    windows.set(userId, current);
  }
  return {
    async handle({ req, path, session, res, body }) {
      if (path !== BASE && path !== `${BASE}/templates`) return false;
      try {
        if (!session?.user) fail('AUTH_REQUIRED', 401);
        if (path === `${BASE}/templates`) {
          if (req.method !== 'GET') fail('NOT_FOUND', 404);
          sendJson(res, 200, { data: { items: fake.templates() } });
          return true;
        }
        if (req.method !== 'POST') fail('NOT_FOUND', 404);
        if (session.user.role !== 'admin') fail('POC_INTAKE_FORBIDDEN', 403);
        if (body === undefined) body = await readJson(req, { maximum: 2_000 });
        if (!body || typeof body !== 'object' || Array.isArray(body)) fail('INVALID_REQUEST', 400);
        onlyFields(body, ['template']);
        if (typeof body.template !== 'string') fail('INVALID_REQUEST', 400);
        limit(session.user.id);
        const { businessCode } = fake.arrive({ template: body.template });
        sendJson(res, 201, { data: { businessCode, note: '下一轮同步（约 1 分钟）后出现在单据池，读完详情后自动发起 AI 独立建议。' } });
      } catch (error) {
        sendError(res, error);
      }
      return true;
    },
  };
}
