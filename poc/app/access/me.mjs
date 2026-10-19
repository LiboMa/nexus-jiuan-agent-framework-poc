/**
 * 「我的 Nexus」（接口约定 agent-access-v1）：每个应用账号用自己的 API 密钥连接 Nexus，列出自己的发布与还没发布的 Agent，
 * 自己粘贴调用密钥启用要用的 Agent。
 * - 列表经 operator CLI 读 REST（每个账号一个 CLI 凭证目录）；列表超过 staleMs 先刷新，读出错的只留 errorTtlMs。名片经 A2A 公开读取，缓存 cardTtlMs，所有账号共用。
 * - 启用：发布在我的列表里 → 同源 → 名片读得到 → tasks/get 证明密钥有效（不花钱）→ 加密保存 → 默认读能力清单。
 * - 系统提供的 Agent：secrets.env 里 NEXUS_A2A_KEY_<发布编号> 对应的发布（审批流在用的那个），所有人可见、不用启用。
 * - 系统功能（审批流、九安自己的 AI 建议）的调用密钥从页面上的启用记录里读（systemCredential），secrets.env 那一把只是兜底。
 * 返回里一律不含密钥；密钥只以指纹（sha256 前 8 位）出现。
 */
import { fail } from '../http.mjs';
import { cardView, publicationView } from '../nexus/catalog.mjs';
import { fingerprint, open, seal } from './crypto.mjs';

export const INTERFACE_VERSION = 'agent-access-v1';
const PUBLISH_ID = /^pub_[A-Za-z0-9_-]{4,80}$/;
const API_KEY = /^nxc_[A-Za-z0-9_-]{16,200}$/;
const CALL_KEY = /^nxa_[A-Za-z0-9_-]{16,200}$/;
const CLIENTS = new Set(['web', 'claude_code', 'codex', 'kiro', 'cli', 'other']);
const clientOf = client => (CLIENTS.has(client) ? client : 'web');
const codeOf = (error, fallback) => (typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,60}$/.test(error.code) ? error.code : fallback);
const sameOrigin = (url, origin) => { try { return new URL(url).origin === origin; } catch { return false; } };
const unpublishedView = agent => ({ agentId: agent.agent_id, name: agent.agent_name_cn || agent.agent_name || agent.agent_id, status: agent.status ?? null,
  version: agent.version ?? null, createdAt: agent.created_at ?? null });

export function createMeService({ store, cliFor, registryKey, keyStore, fetchCard, verifyKey, loadManifest, nexusOrigin, advisoryPublishId,
  staleMs = 60_000, errorTtlMs = 5_000, cardTtlMs = 60_000, perMinute = 5, clock = Date.now, now = () => new Date().toISOString() }) {
  const origin = new URL(nexusOrigin).origin;
  const snapshots = new Map(), pending = new Map(), cards = new Map(), windows = new Map();
  const rpcUrlOf = publishId => `${origin}/a2a/${publishId}`;
  const readable = item => { try { return open(registryKey, item?.credential?.cipher); } catch { return null; } };

  function limit(accountId) {
    const at = clock(), entry = windows.get(accountId);
    const current = entry && entry.until > at ? entry : { until: at + 60_000, count: 0 };
    if (current.count >= perMinute) fail('POC_ME_RATE_LIMIT', 429);
    current.count += 1;
    windows.set(accountId, current);
  }

  async function cardFor(publishId, rpcUrl, { fresh = false } = {}) {
    const hit = cards.get(publishId);
    if (!fresh && hit && clock() - hit.at < cardTtlMs) return hit.card;
    let card;
    try { card = { ...cardView(await fetchCard(`${rpcUrl}/.well-known/agent-card.json`)), error: null }; }
    catch (error) { card = { ...cardView(null), error: codeOf(error, 'POC_CARD_UNAVAILABLE') }; }
    cards.set(publishId, { card, at: clock() });
    return card;
  }

  const empty = (status, error = null, extra = {}) => ({ status, nexusUser: null, preset: null, refreshedAt: clock(), error, publications: [], unpublished: [], ...extra });
  async function load(accountId) {
    const cli = await cliFor(accountId);
    const who = await cli.whoami();
    if (who.exitCode === 3) return empty('not_connected');
    if (who.exitCode !== 0) return empty('error', who.json?.error?.code ?? 'POC_NEXUS_UNREACHABLE');
    const nexusUser = { id: who.json?.user?.user_id ?? null, name: who.json?.user?.name ?? null, role: who.json?.user?.role ?? null };
    const preset = who.json?.connection?.preset ?? null;
    const [publications, agents] = await Promise.all([cli.get('/api/v2/publications'), cli.get('/api/v2/agents', { limit: 100 })]);
    if (publications.exitCode !== 0) return empty('error', publications.json?.error?.code ?? 'POC_NEXUS_UNREACHABLE', { nexusUser, preset });
    const views = (Array.isArray(publications.json?.data?.items) ? publications.json.data.items : []).map(item => publicationView(item, origin)).filter(Boolean);
    await Promise.all(views.map(async view => { view.card = await cardFor(view.publishId, view.a2a.rpcUrl); }));
    const rows = agents.exitCode === 0 && Array.isArray(agents.json?.data)
      ? agents.json.data.filter(agent => agent && typeof agent === 'object' && typeof agent.agent_id === 'string') : [];
    const published = new Set(views.flatMap(view => [view.agentId, view.effectiveAgentId]).filter(Boolean));
    const unpublished = rows.filter(agent => nexusUser.id && agent.creator_user_id === nexusUser.id && !published.has(agent.agent_id)).map(unpublishedView);
    return { status: 'connected', nexusUser, preset, refreshedAt: clock(), error: null, publications: views, unpublished };
  }
  function refreshSnapshot(accountId) {
    if (!pending.has(accountId)) {
      pending.set(accountId, load(accountId)
        .catch(() => empty('error', 'POC_NEXUS_UNREACHABLE'))
        .then(next => { snapshots.set(accountId, next); return next; })
        .finally(() => pending.delete(accountId)));
    }
    return pending.get(accountId);
  }
  async function snapshot(accountId, mode = 'auto') {
    const current = snapshots.get(accountId);
    const ttl = current?.status === 'error' ? errorTtlMs : staleMs;
    if (mode === 'force' || !current || (mode === 'auto' && clock() - current.refreshedAt > ttl)) return refreshSnapshot(accountId);
    return current;
  }

  function enablementView(item, publication) {
    if (!item) return null;
    return { status: readable(item) ? item.status : 'key_invalid', fingerprint: item.credential?.fingerprint ?? null, verifiedAt: item.credential?.verifiedAt ?? null,
      capabilitiesVersion: item.capabilities?.version ?? null, enabledAt: item.enabledAt ?? null,
      versionChanged: publication?.version != null && item.publicationVersion != null && publication.version !== item.publicationVersion };
  }
  async function systemView() {
    return Promise.all(keyStore.ids().map(async publishId => {
      const card = await cardFor(publishId, rpcUrlOf(publishId));
      return { publishId, displayName: card.name || publishId, description: card.description || '', purpose: publishId === advisoryPublishId ? 'advisory' : 'general',
        a2a: { rpcUrl: rpcUrlOf(publishId) }, card };
    }));
  }

  async function view(user, mode = 'auto') {
    const accountId = user.id;
    const [snap, items, connection, system] = await Promise.all([snapshot(accountId, mode), store.list(accountId), store.readConnection(accountId), systemView()]);
    const byId = new Map(items.map(item => [item.publishId, item]));
    const publications = snap.publications.map(publication => ({ ...publication, listed: true, enablement: enablementView(byId.get(publication.publishId), publication),
      capabilities: byId.get(publication.publishId)?.capabilities?.manifest ?? null }));
    for (const item of items) {
      if (publications.some(publication => publication.publishId === item.publishId)) continue;
      publications.push({ publishId: item.publishId, displayName: item.displayName, description: '', status: 'unverified', version: null, followUpdates: null, model: null,
        a2a: { enabled: null, ready: null, status: null, rpcUrl: rpcUrlOf(item.publishId) }, card: null, listed: false,
        enablement: enablementView(item, null), capabilities: item.capabilities?.manifest ?? null });
    }
    return { interfaceVersion: INTERFACE_VERSION,
      connection: { status: snap.status, nexusUser: snap.nexusUser, preset: snap.preset, connectedAt: snap.status === 'connected' ? connection?.connectedAt ?? null : null,
        refreshedAt: new Date(snap.refreshedAt).toISOString(), error: snap.error },
      publications, unpublished: snap.unpublished, system };
  }

  async function connect(user, apiKey, { client } = {}) {
    limit(user.id);
    const key = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (!API_KEY.test(key)) fail('POC_NEXUS_API_KEY_INVALID', 400);
    const result = await (await cliFor(user.id)).login(key);
    if (result.exitCode === 8) fail('POC_NEXUS_UNREACHABLE', 502);
    if (result.exitCode !== 0) fail('POC_NEXUS_API_KEY_INVALID', 400);
    const snap = await snapshot(user.id, 'force');
    if (snap.status !== 'connected') fail('POC_NEXUS_UNREACHABLE', 502);
    await store.saveConnection(user.id, { connectedAt: now(), nexusUser: snap.nexusUser });
    await store.audit(user.id, { action: 'connect', client: clientOf(client), nexusUser: snap.nexusUser?.name ?? null });
    return view(user, 'never');
  }

  async function disconnect(user, { client } = {}) {
    await (await cliFor(user.id)).logout().catch(() => null);
    snapshots.delete(user.id);
    await store.clearConnection(user.id);
    await store.audit(user.id, { action: 'disconnect', client: clientOf(client) });
    return view(user, 'auto');
  }

  async function refresh(user) {
    const snap = await snapshot(user.id, 'force');
    if (snap.status === 'not_connected') fail('POC_NEXUS_NOT_CONNECTED', 409);
    if (snap.status === 'error') fail('POC_NEXUS_UNREACHABLE', 502);
    return view(user, 'never');
  }

  async function enable(user, publishId, { token, loadCapabilities = true, issue, client } = {}) {
    if (typeof publishId !== 'string' || !PUBLISH_ID.test(publishId)) fail('NOT_FOUND', 404);
    if (issue !== undefined && issue !== false) fail('POC_ISSUE_NOT_ALLOWED', 403);
    if ((token !== undefined && typeof token !== 'string') || typeof loadCapabilities !== 'boolean') fail('INVALID_REQUEST', 400);
    limit(user.id);
    const snap = await snapshot(user.id, 'auto');
    if (snap.status === 'error') fail('POC_NEXUS_UNREACHABLE', 502);   // 暂时读不到列表，不是「没连接」：别让人去换新的 API 密钥
    if (snap.status !== 'connected') fail('POC_NEXUS_NOT_CONNECTED', 409);
    const publication = snap.publications.find(item => item.publishId === publishId);
    if (!publication) fail('POC_PUBLICATION_NOT_MINE', 404);
    const existing = await store.get(user.id, publishId);
    let key;
    if (token === undefined) {
      if (!existing) fail('POC_AGENT_NOT_ENABLED', 409);
      key = readable(existing);
      if (!key) fail('POC_CALL_KEY_INVALID', 400);
    } else {
      key = token.trim();
      if (!CALL_KEY.test(key)) fail('POC_CALL_KEY_INVALID', 400);
    }
    if (!sameOrigin(publication.a2a.rpcUrl, origin)) fail('POC_CARD_UNAVAILABLE', 409);
    const card = await cardFor(publishId, publication.a2a.rpcUrl, { fresh: true });
    if (card.error) fail('POC_CARD_UNAVAILABLE', 409);
    if (await verifyKey({ url: publication.a2a.rpcUrl, key }) !== 'valid') {
      if (token === undefined) await store.update(user.id, publishId, { status: 'key_invalid', updatedAt: now() });
      fail('POC_CALL_KEY_INVALID', 400);
    }
    const capabilities = loadCapabilities ? { ...(await loadManifest({ url: publication.a2a.rpcUrl, key })), fetchedAt: now() } : existing?.capabilities ?? null;
    const stamp = now();
    const item = { publishId, displayName: publication.displayName, credential: { cipher: seal(registryKey, key), fingerprint: fingerprint(key), verifiedAt: stamp },
      capabilities, publicationVersion: publication.version ?? null, status: 'active', enabledAt: existing?.enabledAt ?? stamp, updatedAt: stamp };
    // 验证和读能力清单要一会儿；这期间这一项若被停用或换了密钥，就不写回去（停用不能被撤销）。
    const unchanged = current => (current?.credential?.fingerprint ?? null) === (existing?.credential?.fingerprint ?? null);
    if (!await store.putIf(user.id, item, unchanged)) {
      if (!await store.get(user.id, publishId)) fail('POC_AGENT_NOT_ENABLED', 409);
      return (await view(user, 'never')).publications.find(entry => entry.publishId === publishId);
    }
    await store.audit(user.id, { action: !existing ? 'enable' : token === undefined || fingerprint(key) === existing.credential?.fingerprint ? 'reverify' : 'replace_key',
      publishId, fingerprint: item.credential.fingerprint, client: clientOf(client) });
    return (await view(user, 'never')).publications.find(entry => entry.publishId === publishId);
  }

  async function disable(user, publishId, { client } = {}) {
    if (typeof publishId !== 'string' || !PUBLISH_ID.test(publishId)) fail('NOT_FOUND', 404);
    if (await store.remove(user.id, publishId)) await store.audit(user.id, { action: 'disable', publishId, client: clientOf(client) });
    return view(user, 'never');
  }

  async function credentialFor(user, publishId) {
    const item = await store.get(user.id, publishId);
    const key = item?.status === 'active' ? readable(item) : null;
    if (key) return { key, rpcUrl: rpcUrlOf(publishId), source: 'user' };
    if (keyStore.has(publishId)) return { key: keyStore.get(publishId), rpcUrl: rpcUrlOf(publishId), source: 'system' };
    return null;
  }

  // 先用发起人自己启用的；没有再用别的账号启用的、最近验证的那把；最后才是 secrets.env。失效的、解不开的都跳过。
  async function systemCredential(publishId, { preferAccountId = null } = {}) {
    const usable = async accountId => {
      const item = await store.get(accountId, publishId).catch(() => null);
      const key = item?.status === 'active' ? readable(item) : null;
      return key ? { key, accountId, verifiedAt: String(item.credential?.verifiedAt ?? '') } : null;
    };
    const own = preferAccountId ? await usable(preferAccountId) : null;
    if (own) return { key: own.key, source: 'user', accountId: own.accountId };
    const others = (await Promise.all((await store.accounts()).filter(id => id !== preferAccountId).map(usable))).filter(Boolean);
    others.sort((a, b) => b.verifiedAt.localeCompare(a.verifiedAt));
    if (others[0]) return { key: others[0].key, source: 'user', accountId: others[0].accountId };
    if (keyStore.has(publishId)) return { key: keyStore.get(publishId), source: 'system', accountId: null };
    return null;
  }

  async function markInvalid(user, publishId) {
    if (await store.update(user.id, publishId, { status: 'key_invalid', updatedAt: now() })) await store.audit(user.id, { action: 'key_invalid', publishId });
  }

  return { view, connect, disconnect, refresh, enable, disable, credentialFor, systemCredential, markInvalid };
}
