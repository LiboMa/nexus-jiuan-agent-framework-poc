// 「Agent 接入」测试用的假测试台：九安的 /platform/agent-access（启用服务，补丁 0003 的 view）和外壳挂在上面的 nexus / publications / test / tests / calls。
// 有状态：启用、换钥匙、停用、复核、设为 / 取消审批 Agent 改记录；连接 / 断开改 Nexus 状态；测试记一条「进行中」，由测试 finish() 收尾。
// 名称、单据、密钥全部虚构（密钥形如 nxa_FAKE…，不是真的）；知识库 Agent 的发布编号照项目里写明的那个（不是秘密）。
import type { Role } from '../api/session';
import { fakeApi, sessionBody, type FakeCall, type FakeReply, type FakeRoute } from './fakeApi';

const BASE = '/api/analysis/v1/platform/agent-access';
export const KB_PUB = 'pub_6ea5f0855dff6c1b';
export const AUDIT_PUB = 'pub_audit0001aaaa';
export const DRAFT_PUB = 'pub_draft0003cccc';
export const BROKEN_PUB = 'pub_broken004dddd';
export const MANUAL_PUB = 'pub_manual005eeee';
export const FAKE_KEY = 'nxa_FAKEKEY_only_for_tests_0123456789';
export const FAKE_NEXUS_KEY = 'nxc_FAKENEXUS_only_for_tests_0123456789';

export interface FakeRecord {
  publishId: string; status: string; fingerprint: string | null; approval: boolean;
  card: { name: string; tasks: string[]; declaredTasks: string[] } | null;
  enabledBy: string; enabledAt: string; verifiedAt: string | null; invalidReason: string | null; updatedAt: string;
}
const record = (publishId: string, name: string, declared: string[], over: Partial<FakeRecord> = {}): FakeRecord => ({
  publishId, status: 'active', fingerprint: `${publishId.slice(4, 8)}f00d`, approval: false, card: { name, tasks: declared, declaredTasks: declared },
  enabledBy: 'u-admin', enabledAt: '2026-10-26T02:00:00.000Z', verifiedAt: '2026-10-30T02:00:00.000Z', invalidReason: null, updatedAt: '2026-10-30T02:00:00.000Z', ...over,
});
export const RECORDS = (): FakeRecord[] => [
  record(AUDIT_PUB, '审单 Agent（虚构）', ['review_advice@1']),
  record(KB_PUB, '知识库文档管家（PG 版）', []),
  record(MANUAL_PUB, '手动添加的初审 Agent（虚构）', ['first_review@1'], { status: 'invalid', invalidReason: 'AGENT_KEY_REJECTED' }),
];
export const PUBLICATIONS = () => [
  { publishId: AUDIT_PUB, name: '审单 Agent（虚构）', description: '', status: 'active', a2aReady: true, tasks: ['review_advice@1'], enableable: true, problems: [] },
  { publishId: KB_PUB, name: '知识库文档管家（PG 版）', description: '', status: 'active', a2aReady: true, tasks: [], enableable: true, problems: [] },
  { publishId: DRAFT_PUB, name: '报销问答助手（虚构）', description: '', status: 'active', a2aReady: true, tasks: [], enableable: true, problems: [] },
  { publishId: BROKEN_PUB, name: '旧版初审（虚构）', description: '', status: 'paused', a2aReady: false, tasks: [], enableable: false, problems: ['读不到名片：发布可能暂停了，或者 A2A 没打开'] },
];
export const AUDIT = (): Array<{ at: string; actor: string; action: string; publishId: string; result: string; fingerprint: string | null; reason: string }> => [
  { at: '2026-10-26T02:00:00.000Z', actor: 'u-admin', action: 'enable', publishId: AUDIT_PUB, result: 'ok', fingerprint: 'audif00d', reason: '在「Agent 接入」页启用' },
  { at: '2026-10-26T02:05:00.000Z', actor: 'u-admin', action: 'approve', publishId: AUDIT_PUB, result: 'ok', fingerprint: 'audif00d', reason: '审单用这个（虚构）' },
];
export const DOCUMENTS = [
  { id: 'doc-1', number: 'DGZF-F07-001', title: '虚构运维服务费', formName: '对公付款单', companyName: '九安（虚构）' },
  { id: 'doc-2', number: 'DGZF-F07-002', title: '虚构房租', formName: '对公付款单', companyName: '九安（虚构）' },
];
export const REVIEW_REQUEST = { envelope: 'jiuan.agent/v1', task: 'review_advice', taskVersion: 1, requestId: 'req-fake-1',
  context: { tenantId: 'jiuan07', scope: 'company', companyId: 'c-1', subject: null, locale: 'zh-CN' }, input: { document: { number: 'DGZF-F07-001' } } };
export const DESCRIBE_REQUEST = { envelope: 'jiuan.agent/v1', task: 'describe', taskVersion: 1, requestId: 'req-fake-2',
  context: { tenantId: 'jiuan07', scope: 'company', companyId: 'c-1', subject: null, locale: 'zh-CN' }, input: {} };
export const TEMPLATES = [
  { task: 'review_advice@1', title: '单据审核建议', request: REVIEW_REQUEST },
  { task: 'describe@1', title: '能力清单', request: DESCRIBE_REQUEST },
];
export const EVIDENCE_REF = 'ab'.repeat(32);
export const BASIS = [
  { kind: 'rule', ref: 'C05-2.3', page: null, note: '付款须附合同（虚构）' },
  { kind: 'field', ref: '金额', page: null, note: '付款 12,000 元（虚构）' },
  { kind: 'evidence', ref: EVIDENCE_REF, page: 2, note: '合同第 2 页（虚构）' },
];
export const CALLS = () => [
  { at: '2026-10-31T02:10:00.000Z', documentId: 'doc-1', number: 'DGZF-F07-001', task: 'review_advice@1', round: 2, trigger: 'upstream', publishId: AUDIT_PUB,
    status: 'completed', result: 'pass', errorCode: null, declinedReason: null, startedAt: '2026-10-31T02:09:08.000Z', finishedAt: '2026-10-31T02:10:00.000Z', latencyMs: 52_000,
    attempts: 1, agentVersion: '1.2.0', repaired: false, note: '原件齐全，金额一致（虚构）', basis: BASIS.slice(0, 2) },
  { at: '2026-10-31T01:50:00.000Z', documentId: 'doc-2', number: 'DGZF-F07-002', task: 'review_advice@1', round: 1, trigger: 'manual', publishId: AUDIT_PUB,
    status: 'failed', result: null, errorCode: 'AI_UNAVAILABLE', declinedReason: null, startedAt: '2026-10-31T01:48:00.000Z', finishedAt: '2026-10-31T01:50:00.000Z', latencyMs: 120_000,
    attempts: 2, agentVersion: null, repaired: null, note: '', basis: [] },
  { at: '2026-10-31T01:30:00.000Z', testId: 'test_aaaaaaaaaaaa', trigger: 'test', mode: 'text', publishId: KB_PUB, status: 'completed', task: null, input: '你好（虚构）',
    documentId: null, number: null, result: null, note: '', basis: [], reply: '我是知识库文档管家（虚构）', conforms: null, problems: [], envelope: null, errorCode: null,
    declinedReason: null, agentVersion: null, repaired: null, startedAt: '2026-10-31T01:29:57.000Z', finishedAt: '2026-10-31T01:30:00.000Z', latencyMs: 3000 },
];

const ok = (data: unknown, status = 200): FakeReply => ({ status, body: { data } });
const refuse = (status: number, code: string, message: string, details?: unknown): FakeReply => ({ status, body: { error: { code, message, ...(details ? { details } : {}) } } });
const CALL_KEY = /^nxa_[A-Za-z0-9_-]{16,200}$/;
const NEXUS_KEY = /^nxc_[A-Za-z0-9_-]{16,200}$/;
const reasonOk = (body: unknown) => typeof (body as { reason?: unknown })?.reason === 'string' && Boolean((body as { reason: string }).reason.trim());
const INVALID = refuse(400, 'AGENT_ACCESS_INVALID', '发布编号、调用密钥或理由格式不对。');

export interface FakeTest { testId: string; trigger: 'test'; mode: string; publishId: string; status: string; [key: string]: unknown }

export interface AgentsOptions {
  role?: Role;
  configured?: boolean;
  connected?: boolean;
  records?: FakeRecord[];
  approval?: string | null;
  publications?: ReturnType<typeof PUBLICATIONS>;
  calls?: ReturnType<typeof CALLS>;
  overrides?: Record<string, FakeRoute>;
}

/** 假测试台。overrides 里的路由（「方法 路径」）优先。 */
export function fakeAgents({ role = 'admin', configured = true, connected = true, records = RECORDS(), approval = AUDIT_PUB, publications = PUBLICATIONS(),
  calls = CALLS(), overrides = {} as Record<string, FakeRoute> }: AgentsOptions = {}) {
  const state = { records, approval, connected, publications, calls, audit: AUDIT(), tests: new Map<string, FakeTest>(), nextTest: 1 };
  const view = (item: FakeRecord) => ({ ...item, approval: item.publishId === state.approval });
  const find = (id: string) => state.records.find(item => item.publishId === id) ?? null;
  const put = (next: FakeRecord) => { state.records = [...state.records.filter(item => item.publishId !== next.publishId), next]; return view(next); };
  const audit = (action: string, publishId: string, reason: string) => state.audit.push({ at: '2026-10-31T03:00:00.000Z', actor: 'u-admin', action, publishId, result: 'ok', fingerprint: find(publishId)?.fingerprint ?? null, reason });
  const nameOf = (id: string) => state.publications.find(item => item.publishId === id)?.name ?? `Agent ${id}`;

  const routes: Record<string, FakeRoute> = {
    'GET /api/analysis/v1/session': { body: sessionBody(role) },
    [`GET ${BASE}`]: () => ok({ configured, records: [...state.records].sort((a, b) => a.publishId.localeCompare(b.publishId)).map(view),
      approval: state.approval ? { publishId: state.approval, setBy: 'u-admin', setAt: '2026-10-26T02:05:00.000Z' } : null, audit: state.audit }),
    [`POST ${BASE}`]: call => {
      const body = call.body as { publishId?: string; key?: string; reason?: string };
      if (!body?.publishId || !CALL_KEY.test(body.key ?? '') || !reasonOk(body)) return INVALID;
      const prior = find(body.publishId);
      if (prior && prior.status !== 'disabled') return refuse(409, 'AGENT_ACCESS_EXISTS', '这个发布已经启用；要换调用密钥请用「换钥匙」。');
      audit('enable', body.publishId, body.reason!);
      const declared = state.publications.find(item => item.publishId === body.publishId)?.tasks ?? [];
      return ok(put(record(body.publishId, prior?.card?.name ?? nameOf(body.publishId), declared, { fingerprint: 'c0ffee42' })));
    },
    [`GET ${BASE}/nexus`]: () => ok({ connected: state.connected, user: state.connected ? '管理员（虚构）' : null }),
    [`POST ${BASE}/nexus`]: call => {
      const key = (call.body as { apiKey?: string })?.apiKey ?? '';
      if (!NEXUS_KEY.test(key)) return refuse(400, 'AGENT_NEXUS_KEY_INVALID', 'Nexus API 密钥无效、已经用过（第一次连接后平台会换新），或者不属于这个 Nexus：在 Nexus「个人设置 › API 密钥」新建一把再连接。');
      state.connected = true;
      return ok({ connected: true, user: '管理员（虚构）' });
    },
    [`POST ${BASE}/nexus/disconnect`]: () => { state.connected = false; return ok({ connected: false, user: null }); },
    [`GET ${BASE}/publications`]: () => (state.connected ? ok({ items: state.publications }) : refuse(409, 'AGENT_NEXUS_NOT_CONNECTED', '还没有连接 Nexus：先在上面贴一次你的 Nexus API 密钥。')),
    [`GET ${BASE}/calls`]: () => ok({ items: state.calls }),
    [`GET ${BASE}/test-documents`]: () => ok({ items: DOCUMENTS }),
    [`GET ${BASE}/test-templates`]: () => ok({ items: TEMPLATES }),
  };
  const ids = () => [...new Set([...state.records.map(item => item.publishId), ...state.publications.map(item => item.publishId), MANUAL_PUB, 'pub_newone0007gggg'])];
  function register() {
    for (const id of ids()) {
      routes[`POST ${BASE}/${id}/rotate`] ??= call => {
        const body = call.body as { key?: string; reason?: string };
        const prior = find(id);
        if (!CALL_KEY.test(body?.key ?? '') || !reasonOk(body)) return INVALID;
        if (!prior) return refuse(404, 'AGENT_ACCESS_NOT_FOUND', '这个发布还没有启用。');
        audit('rotate', id, body.reason!);
        return ok(put({ ...prior, status: 'active', fingerprint: 'beadfeed', invalidReason: null }));
      };
      for (const action of ['disable', 'refresh', 'approve', 'unapprove']) {
        routes[`POST ${BASE}/${id}/${action}`] ??= call => {
          const prior = find(id);
          if (!reasonOk(call.body)) return INVALID;
          if (!prior) return refuse(404, 'AGENT_ACCESS_NOT_FOUND', '这个发布还没有启用。');
          const reason = (call.body as { reason: string }).reason;
          if (action === 'approve' && prior.status !== 'active') return refuse(409, 'AGENT_ACCESS_NOT_ACTIVE', '这个 Agent 现在不是「就绪」：先启用（或换好钥匙），再设为审批 Agent。');
          if (action === 'unapprove' && state.approval !== id) return refuse(409, 'AGENT_ACCESS_NOT_APPROVAL', '这个 Agent 不是审批 Agent。');
          if (action === 'approve') state.approval = id;
          if (action === 'unapprove') state.approval = null;
          audit(action, id, reason);
          if (action === 'disable') return ok(put({ ...prior, status: 'disabled' }));
          if (action === 'refresh') return ok(put({ ...prior, verifiedAt: '2026-10-31T03:00:00.000Z' }));
          return ok(view(prior));
        };
      }
      routes[`POST ${BASE}/${id}/test`] ??= (call: FakeCall) => {
        const body = call.body as { mode?: string; text?: string; request?: { task?: string; taskVersion?: number }; documentId?: string };
        if (body?.mode === 'text' && !body.text?.trim()) return refuse(400, 'AGENT_TEST_INVALID', '测试内容不完整：文本测试要写一段话（最多 4000 字），单据测试要选一张单据。');
        if (body?.mode === 'envelope' && body.request?.task === 'nope') {
          return refuse(400, 'AGENT_TEST_REQUEST_INVALID', '这个请求信封不合契约，没有发出去：按下面列出的地方改好再发。', { problems: [{ path: '/task', message: '契约里没有任务 nope@1' }] });
        }
        const testId = `test_${String(state.nextTest).padStart(12, '0')}`;
        state.nextTest += 1;
        const document = body?.mode === 'document' ? DOCUMENTS.find(item => item.id === body.documentId) ?? null : null;
        const test: FakeTest = { testId, trigger: 'test', mode: body?.mode ?? 'document', publishId: id, status: 'running',
          task: body?.mode === 'document' ? 'review_advice@1' : body?.mode === 'envelope' ? `${body.request?.task}@${body.request?.taskVersion}` : null,
          input: body?.mode === 'text' ? body.text : null, documentId: document?.id ?? null, number: document?.number ?? null, result: null, note: '', basis: [], reply: null,
          conforms: null, problems: [], envelope: null, errorCode: null, declinedReason: null, agentVersion: null, repaired: null,
          startedAt: '2026-10-31T03:00:00.000Z', finishedAt: null, latencyMs: null, at: '2026-10-31T03:00:00.000Z' };
        state.tests.set(testId, test);
        routes[`GET ${BASE}/tests/${testId}`] = () => ok(state.tests.get(testId));
        return ok(test, 202);
      };
    }
    Object.assign(routes, overrides);
  }
  register();
  const server = fakeApi(routes);
  /** 让一次「进行中」的测试收尾（字段照外壳 agent-tests.mjs 的 view）。 */
  function finish(testId: string, patch: Record<string, unknown>) {
    const test = state.tests.get(testId)!;
    state.tests.set(testId, { ...test, status: 'completed', finishedAt: '2026-10-31T03:00:41.000Z', at: '2026-10-31T03:00:41.000Z', latencyMs: 41_000, ...patch });
  }
  return { ...server, state, finish, register };
}

export { deferred } from './documentsFake';
