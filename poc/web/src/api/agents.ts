/**
 * 「Agent 接入」页要的接口（补丁 0001–0003）。九安自己的启用服务（src/agent-enablement.mjs，只在测试实例上有、只给管理员）：
 *   GET  /platform/agent-access                         { configured, records[], approval, audit[] }
 *   POST /platform/agent-access {publishId, key, reason}   粘贴调用密钥启用（当场向 Nexus 验证名片与密钥，最长约三分钟）
 *   POST /platform/agent-access/:id/rotate {key, reason}   换钥匙；/:id/(disable|refresh|approve|unapprove) {reason}
 * 测试台外壳挂在九安 platformRoutes 上的几条（poc/app 的 nexus-access / agent-tests / agent-calls，只给管理员）：
 *   GET  /platform/agent-access/nexus                    { connected, user }；POST {apiKey} 连接；POST /nexus/disconnect 断开
 *   GET  /platform/agent-access/publications             { items[] }：Nexus 上开了 A2A 的发布（能不能启用、不能的原因）
 *   POST /platform/agent-access/:pub/test                202 一次测试：{mode:'text', text} | {mode:'envelope', request} | {mode:'document', documentId}
 *   GET  /platform/agent-access/tests/:testId · /test-documents · /test-templates · /calls
 * 都是 /platform 下的写：九安照样查 Origin 和 CSRF、自己读 JSON 请求体，api() 已带 X-CSRF-Token 和 Content-Type。
 * 密钥（调用密钥 nxa_、Nexus API 密钥 nxc_）只作为参数交给 enableAgent / rotateKey / connectNexus 放进请求体：
 * 不进查询键、不进 React Query 缓存（调用方不用 useMutation 传它）、不进日志和错误文字。
 */
import { ApiError, api } from './client';
import type { BasisItem } from './documents';

const PATH = '/platform/agent-access';
export const PUBLISH_ID = /^pub_[A-Za-z0-9_-]{4,80}$/u;
/** 测试开始后每 3 秒问一次（和旧页面一样），最多等 5 分钟。 */
export const TEST_POLL_MS = 3000;
export const TEST_WAIT_MS = 300_000;
export const TEXT_MAX = 4000;
export const REASON_MAX = 200;
/** 审批流的任务：只有审批 Agent 接（补丁 0003）。 */
export const FLOW_TASKS: readonly string[] = ['first_review@1', 'review_advice@1'];

export interface AccessCard { name?: string | null; tasks?: string[]; declaredTasks?: string[] }
export interface AccessRecord {
  publishId: string; status: 'active' | 'invalid' | 'disabled' | string; fingerprint?: string | null; approval?: boolean; card?: AccessCard | null;
  enabledBy?: string | null; enabledAt?: string | null; verifiedAt?: string | null; invalidReason?: string | null; updatedAt?: string | null;
}
export interface AuditEntry { at?: string; actor?: string; action?: string; publishId?: string; result?: string; fingerprint?: string | null; reason?: string | null }
export interface AccessState { configured: boolean; records: AccessRecord[]; approval: { publishId: string; setBy?: string; setAt?: string } | null; audit: AuditEntry[] }
export interface NexusState { connected: boolean; user: string | null }
export interface Publication {
  publishId: string; name?: string | null; description?: string | null; status?: string | null; a2aReady?: boolean; tasks?: string[]; enableable?: boolean; problems?: string[];
}
export interface Problem { code?: string | null; path?: string; message?: string }
export type TestMode = 'text' | 'envelope' | 'document';
/** 调用记录的一行（agent-calls.mjs 的 rowOf），或一次测试（agent-tests.mjs 的 view，多 testId / mode / input / reply …）。 */
export interface CallRow {
  at?: string | null; documentId?: string | null; number?: string | null; task?: string | null; round?: number | null; trigger?: string | null; publishId?: string | null;
  status: string; result?: 'pass' | 'fail' | string | null; errorCode?: string | null; declinedReason?: string | null; startedAt?: string | null; finishedAt?: string | null;
  latencyMs?: number | null; attempts?: number | null; agentVersion?: string | null; repaired?: boolean | null; note?: string | null; basis?: BasisItem[] | null;
  testId?: string; mode?: TestMode | string; input?: string | null; reply?: string | null; conforms?: boolean | null; problems?: Problem[] | null; envelope?: unknown;
}
export interface TestDocument { id: string; number?: string | null; title?: string | null; formName?: string | null; companyName?: string | null }
export interface TestTemplate { task: string; title?: string; request: unknown }
export type TestInput = { mode: 'text'; text: string } | { mode: 'envelope'; request: Record<string, unknown> } | { mode: 'document'; documentId: string };

const objects = <T,>(value: unknown): T[] => (Array.isArray(value) ? value.filter(item => item && typeof item === 'object') as T[] : []);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
// 发布编号进路径前先认一遍（列表里来的，正常都对；不对的不发）
const pub = (publishId: string) => {
  if (!PUBLISH_ID.test(publishId)) throw new ApiError(0, 'BAD_PATH', '发布编号不对，请刷新页面重试。');
  return publishId;
};

export async function fetchAccess(): Promise<AccessState> {
  const data = await api<Partial<AccessState> | null>(PATH);
  const approval = data?.approval && typeof data.approval.publishId === 'string' ? data.approval : null;
  return { configured: data?.configured !== false, records: objects<AccessRecord>(data?.records).filter(item => typeof item.publishId === 'string'), approval, audit: objects<AuditEntry>(data?.audit) };
}
export const enableAgent = (publishId: string, key: string, reason: string) => api<AccessRecord>(PATH, { method: 'POST', body: { publishId: pub(publishId), key, reason } });
export const rotateKey = (publishId: string, key: string, reason: string) => api<AccessRecord>(`${PATH}/${pub(publishId)}/rotate`, { method: 'POST', body: { key, reason } });
export type AccessAction = 'disable' | 'refresh' | 'approve' | 'unapprove';
export const runAction = (publishId: string, action: AccessAction, reason: string) => api<AccessRecord>(`${PATH}/${pub(publishId)}/${action}`, { method: 'POST', body: { reason } });

export async function fetchNexus(): Promise<NexusState> {
  const data = await api<Partial<NexusState> | null>(`${PATH}/nexus`);
  return { connected: data?.connected === true, user: typeof data?.user === 'string' && data.user ? data.user : null };
}
export async function connectNexus(apiKey: string): Promise<NexusState> {
  const data = await api<Partial<NexusState> | null>(`${PATH}/nexus`, { method: 'POST', body: { apiKey } });
  return { connected: data?.connected === true, user: typeof data?.user === 'string' && data.user ? data.user : null };
}
export const disconnectNexus = () => api<NexusState>(`${PATH}/nexus/disconnect`, { method: 'POST' });
export async function fetchPublications(): Promise<Publication[]> {
  const data = await api<{ items?: unknown } | null>(`${PATH}/publications`);
  return objects<Publication>(data?.items).filter(item => typeof item.publishId === 'string').map(item => ({ ...item, tasks: strings(item.tasks), problems: strings(item.problems) }));
}

export async function fetchCalls(): Promise<CallRow[]> {
  const data = await api<{ items?: unknown } | null>(`${PATH}/calls`);
  return objects<CallRow>(data?.items);
}
export async function fetchTestDocuments(): Promise<TestDocument[]> {
  const data = await api<{ items?: unknown } | null>(`${PATH}/test-documents`);
  return objects<TestDocument>(data?.items).filter(item => typeof item.id === 'string');
}
export async function fetchTestTemplates(): Promise<TestTemplate[]> {
  const data = await api<{ items?: unknown } | null>(`${PATH}/test-templates`);
  return objects<TestTemplate>(data?.items).filter(item => typeof item.task === 'string');
}
export const startTest = (publishId: string, input: TestInput) => api<CallRow>(`${PATH}/${pub(publishId)}/test`, { method: 'POST', body: input });
export const fetchTest = (testId: string) => api<CallRow>(`${PATH}/tests/${encodeURIComponent(testId)}`);

export const agentKeys = {
  access: ['agents', 'access'] as const,
  nexus: ['agents', 'nexus'] as const,
  publications: ['agents', 'publications'] as const,
  calls: ['agents', 'calls'] as const,
  documents: ['agents', 'test-documents'] as const,
  templates: ['agents', 'test-templates'] as const,
  test: (testId: string) => ['agents', 'test', testId] as const,
};

// ---- 合成一张表（Ruling T8a）----

export interface AgentRow { publishId: string; name: string; item: Publication | null; record: AccessRecord | null }
/** 按发布编号把 Nexus 上的发布和已启用的记录合成一行：Nexus 上的按原顺序在前，只在这里启用过的（手动添加、或已不在 Nexus 清单里的）在后。 */
export function mergeAgents(records: AccessRecord[], published: Publication[]): AgentRow[] {
  const rows = new Map<string, AgentRow>();
  for (const item of published) rows.set(item.publishId, { publishId: item.publishId, name: item.name?.trim() || item.publishId, item, record: null });
  for (const record of records) {
    const prior = rows.get(record.publishId);
    rows.set(record.publishId, { publishId: record.publishId, name: prior?.item?.name?.trim() || record.card?.name?.trim() || record.publishId, item: prior?.item ?? null, record });
  }
  return [...rows.values()];
}
/** 名片自己声明的任务（补丁 0003 的 card.declaredTasks；老的记录只有 card.tasks；没启用的看 Nexus 清单里的）。 */
export const declaredOf = (agent: AgentRow): string[] => strings(agent.record ? agent.record.card?.declaredTasks ?? agent.record.card?.tasks : agent.item?.tasks);
/** 「https://…/a2a/pub_x」「…/a2a/pub_x/.well-known/agent-card.json」或「pub_x」→ 发布编号；认不出回空（同补丁 0002 的 publishIdFrom）。 */
export function publishIdFrom(text: string): string {
  const value = String(text || '').trim();
  const match = /\/a2a\/(pub_[A-Za-z0-9_-]{4,80})(?:[/?#]|$)/u.exec(value) || /^(pub_[A-Za-z0-9_-]{4,80})$/u.exec(value);
  return match ? match[1] : '';
}
