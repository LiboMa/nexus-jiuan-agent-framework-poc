/**
 * 「Agent 接入」页的叫法（照补丁 0002 / 0003 的 platform-ops.js，换成新前端的说法）：状态、任务、错误码、触发方式、操作原因。
 */
import type { AgentRow, CallRow } from '../api/agents';
import type { Tone } from '../ui/Pill';

export const TASKS: Record<string, string> = {
  'first_review@1': '单据初审（first_review@1）', 'review_advice@1': '单据审核建议（review_advice@1）', 'describe@1': '能力清单（describe@1）',
};
const TASK_SHORT: Record<string, string> = { 'first_review@1': '单据初审', 'review_advice@1': '单据审核建议', 'describe@1': '能力清单' };
export const taskLabel = (task: string) => TASKS[task] ?? task;

/** 九安和外壳回的错误码 → 一句话（调用记录、测试结果、失效原因、操作记录都用）。 */
const RESULTS: Record<string, string> = {
  ok: '成功', AGENT_KEY_REJECTED: 'Nexus 不认这把密钥', AGENT_KEY_WRONG_PUBLICATION: '密钥属于别的发布或发布已暂停', AGENT_CARD_INVALID: '名片不合契约',
  AGENT_TASK_NOT_DECLARED: '名片没有声明本平台接入的任务', AGENT_PUBLICATION_NOT_FOUND: '读不到名片', AGENT_NEXUS_UNREACHABLE: '连不上 Nexus',
  AGENT_VERIFY_TIMEOUT: '验证超时', AGENT_ACCESS_EXISTS: '已启用过', AI_AUTH_INVALID: 'Nexus 拒绝了密钥',
  AGENT_ACCESS_NOT_ACTIVE: '这个 Agent 现在不是就绪', AGENT_ACCESS_NOT_APPROVAL: '不是审批 Agent', AGENT_NOT_READY: '这个 Agent 还没就绪（没启用或密钥失效）',
  AGENT_TASK_UNROUTED: '审批流没有可用的审批 Agent', AI_UNAVAILABLE: 'Nexus 暂时答不了（或超时）', AI_RATE_LIMIT: '调用太频繁', AI_NETWORK: '连不上 Nexus',
  AI_INVALID_RESPONSE: '回答不合契约',
};
export const resultText = (code: string | null | undefined) => (code ? RESULTS[code] ?? `未通过（${code}）` : '—');

export const ACTIONS: Record<string, string> = {
  enable: '启用', rotate: '换钥匙', disable: '停用', refresh: '重新验证', mark_invalid: '标记失效', approve: '设为审批 Agent', unapprove: '取消审批 Agent',
};
/** 不用人写原因的操作，原因照补丁 0002 自动填（留痕）；设为 / 取消审批 Agent 要人写（Ruling T8b）。 */
export const REASONS = {
  enable: '在「Agent 接入」页启用', rotate: '在「Agent 接入」页换钥匙', disable: '在「Agent 接入」页停用', refresh: '在「Agent 接入」页重新验证',
  manual: '在「Agent 接入」页手动添加（A2A 地址 + 调用密钥）',
} as const;

export const STATUS_TEXT: Record<string, string> = { active: '就绪', invalid: '密钥失效', disabled: '已停用' };
/** 一行 Agent 的状态：有启用记录看记录，没有看 Nexus 清单说能不能启用。 */
export function statusOf(agent: AgentRow): { text: string; tone: Tone } {
  const status = agent.record?.status;
  if (status === 'active') return { text: '就绪', tone: 'pass' };
  if (status === 'invalid') return { text: '密钥失效', tone: 'fail' };
  if (status === 'disabled') return { text: '已停用', tone: 'neutral' };
  if (agent.record) return { text: status || '状态待核实', tone: 'neutral' };
  return agent.item?.enableable ? { text: '未启用', tone: 'neutral' } : { text: '不能启用', tone: 'wait' };
}

// ---- 调用记录、测试结果 ----

const CALL_STATUS: Record<string, string> = { completed: '已完成', failed: '没有完成', declined: '没有给出建议', running: '审核中', superseded: '被新一轮取代' };
const CALL_TRIGGER: Record<string, string> = { upstream: '自动初审', manual: '单据页发起', person: '单据页发起', test: '测试' };
export const MODE_TEXT: Record<string, string> = { document: '单据', text: '文本', envelope: '请求信封' };
export const callStatus = (call: CallRow): { text: string; tone: Tone } => ({
  text: CALL_STATUS[call.status] ?? (call.status || '—'),
  tone: call.status === 'failed' || call.status === 'declined' || call.status === 'running' ? 'wait' : 'neutral',
});
/** 结论：单据看建议，请求信封看合不合契约，文本看有没有回复；没完成的没有结论。 */
export function conclusionOf(call: CallRow): { text: string; tone: Tone } | null {
  if (call.status !== 'completed') return null;
  if (call.mode === 'text') return { text: '已回复', tone: 'neutral' };
  if (call.mode === 'envelope') return call.conforms ? { text: '合格', tone: 'pass' } : { text: '不合格', tone: 'wait' };
  if (call.result === 'pass') return { text: '建议通过', tone: 'pass' };
  if (call.result === 'fail') return { text: '不建议通过', tone: 'fail' };
  return null;
}
export const triggerOf = (call: CallRow) => (call.trigger === 'test' ? `测试 · ${MODE_TEXT[call.mode ?? ''] ?? '单据'}` : CALL_TRIGGER[call.trigger ?? ''] ?? (call.trigger || '—'));
export const taskOf = (call: CallRow) => (call.task ? TASK_SHORT[call.task] ?? call.task : call.mode === 'text' ? '文本' : '—');
export const seconds = (ms: unknown) => (typeof ms === 'number' && Number.isFinite(ms) ? `${Math.round(ms / 1000)} 秒` : '—');
/** 原件依据的编号是附件内容的 sha256：只显示前 12 位。 */
export const shortRef = (ref: unknown) => (typeof ref === 'string' && /^[a-f0-9]{64}$/u.test(ref) ? `${ref.slice(0, 12)}…` : typeof ref === 'string' && ref.trim() ? ref : '—');
export const problemText = (problem: { path?: string; message?: string }) => `${problem.path || '/'}：${problem.message || '—'}`;
