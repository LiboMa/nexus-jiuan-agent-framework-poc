/**
 * 「Agent 接入」页的 Nexus 发布列表（挂在九安的 platformRoutes 钩子上：会话、来源、CSRF 已由九安校验；只给管理员）：
 *   GET  /api/analysis/v1/platform/agent-access/nexus             连接状态
 *   POST /api/analysis/v1/platform/agent-access/nexus {apiKey}    管理员贴一次自己的 Nexus API 密钥连上 Nexus
 *   POST /api/analysis/v1/platform/agent-access/nexus/disconnect   断开（只删本机凭证；网页上那把 API 密钥由本人停用）
 *   GET  /api/analysis/v1/platform/agent-access/publications       Nexus 上开了 A2A 的发布：名称、名片声明的任务、能不能启用（不能的写明原因）
 *        新发布的名片说明里常常没有「契约：jiuan.agent/v1」「任务：…」两行，这不挡启用（九安的启用服务按补丁 0003 同样处理）：
 *        启用后 Agent 就绪，供前端工作流调用；进不进审批流由管理员在卡片上「设为审批 Agent」决定。
 * 启用仍走九安原有的 POST /api/analysis/v1/platform/agent-access（页面从列表带上发布编号，管理员只贴调用密钥）。
 * 连接经 nexus-ai-operator 命令行（和 PoC 的「我的 Nexus 连接」同一做法）：API 密钥只经环境变量交给 login，CLI 自己保存、续期、轮换。
 * 错误码都用 AGENT_ 开头：九安的前端只把这类错误的服务端说明原样显示。
 */
import { publicationView } from '../app/nexus/catalog.mjs';

const BASE = '/api/analysis/v1/platform/agent-access';
const API_KEY = /^nxc_[A-Za-z0-9_-]{16,200}$/;
const MESSAGES = Object.freeze({
  AGENT_NEXUS_KEY_INVALID: 'Nexus API 密钥无效、已经用过（第一次连接后平台会换新），或者不属于这个 Nexus：在 Nexus「个人设置 › API 密钥」新建一把再连接。',
  AGENT_NEXUS_NOT_CONNECTED: '还没有连接 Nexus：先在上面贴一次你的 Nexus API 密钥。',
  AGENT_NEXUS_RECONNECT: 'Nexus 连接已失效（API 密钥被停用或闲置过久）：请重新贴一把 API 密钥连接。',
  AGENT_NEXUS_UNREACHABLE: '暂时连不上 Nexus，稍后再试。',
  AGENT_NEXUS_FORBIDDEN: '只有管理员能连接 Nexus、查看发布列表。',
  AGENT_NEXUS_REQUEST_INVALID: '请求不完整，请刷新页面后重试。',
});

function send(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}
const failWith = (code, status) => { throw Object.assign(new Error(code), { code, status }); };

export function nexusAccessRoutes({ cli, origin, fetchCard, checkCard }) {
  async function status() {
    const who = await cli.whoami();
    if (who.exitCode === 0) return { connected: true, user: who.json?.user?.name ?? who.json?.user?.username ?? null };
    if (who.exitCode === 3 || who.exitCode === 2) return { connected: false, user: null };
    failWith('AGENT_NEXUS_UNREACHABLE', 502);
  }
  async function connect(body) {
    const key = typeof body?.apiKey === 'string' ? body.apiKey.trim() : '';
    if (!body || Object.keys(body).some(name => name !== 'apiKey') || !API_KEY.test(key)) failWith('AGENT_NEXUS_KEY_INVALID', 400);
    const result = await cli.login(key);
    if (result.exitCode === 8) failWith('AGENT_NEXUS_UNREACHABLE', 502);
    if (result.exitCode !== 0) failWith('AGENT_NEXUS_KEY_INVALID', 400);
    const now = await status();
    if (!now.connected) failWith('AGENT_NEXUS_UNREACHABLE', 502);
    return now;
  }
  async function listed() {
    const result = await cli.get('/api/v2/publications');
    if (result.exitCode === 3) failWith((await status()).connected ? 'AGENT_NEXUS_RECONNECT' : 'AGENT_NEXUS_NOT_CONNECTED', 409);
    if (result.exitCode !== 0) failWith('AGENT_NEXUS_UNREACHABLE', 502);
    return (Array.isArray(result.json?.data?.items) ? result.json.data.items : []).filter(item => publicationView(item, origin)?.a2a.enabled);
  }
  async function itemOf(raw) {
    const view = publicationView(raw, origin);
    let card = null;
    try { card = await fetchCard(`${view.a2a.rpcUrl}/.well-known/agent-card.json`); } catch { card = null; }
    const checked = card ? checkCard(card) : { ok: false, problems: [{ message: '读不到名片：发布可能暂停了，或者 A2A 没打开' }], tasks: [] };
    // 名片说明里的契约 / 任务两行不挡启用（补丁 0003）：启用后就绪，进不进审批流由管理员在页面上指定；别的问题照旧挡住
    const blocking = checked.ok ? [] : checked.problems.filter(problem => problem.path !== 'description');
    const usable = Boolean(card) && (checked.ok || (checked.problems.length > 0 && blocking.length === 0));
    return { publishId: view.publishId, name: view.displayName || (typeof card?.name === 'string' && card.name) || view.publishId, description: view.description,
      status: view.status, a2aReady: view.a2a.ready, tasks: checked.tasks, enableable: view.a2a.ready && usable,
      problems: usable ? [] : (blocking.length ? blocking : checked.problems).map(problem => problem.message) };
  }
  const publications = async () => ({ items: await Promise.all((await listed()).map(itemOf)) });
  return {
    async handle({ req, path, session, res, body }) {
      const route = `${req.method} ${path}`;
      const routes = { [`GET ${BASE}/nexus`]: status, [`POST ${BASE}/nexus`]: () => connect(body),
        [`POST ${BASE}/nexus/disconnect`]: async () => { await cli.logout(); return { connected: false, user: null }; },
        [`GET ${BASE}/publications`]: publications };
      if (!Object.hasOwn(routes, route)) return false;
      try {
        if (session?.user?.role !== 'admin') failWith('AGENT_NEXUS_FORBIDDEN', 403);
        send(res, 200, { data: await routes[route]() });
      } catch (error) {
        const code = Object.hasOwn(MESSAGES, error?.code) ? error.code : 'AGENT_NEXUS_UNREACHABLE';
        send(res, Number.isInteger(error?.status) ? error.status : 502, { error: { code, message: MESSAGES[code] } });
      }
      return true;
    },
  };
}
