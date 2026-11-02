/**
 * Agent 列表（Rulings T8a / T8b）：Nexus 上的发布和这里启用过的合成一张表，一个发布一行。状态以启用记录为准，没有记录的看 Nexus 清单能不能启用；
 * 只有一行标「审批 Agent」（审批流只调它），别的就绪的标「供前端工作流调用（不进审批流）」。每行只给合它状态的操作（补丁 0002 的 agentCard）：
 *   就绪：测试 · 设为 / 取消审批 Agent · 重新验证 · 停用    密钥失效：换钥匙 ·（取消审批 Agent）· 停用
 *   已停用：重新启用 ·（取消审批 Agent）               没启用：能启用的给「启用」，不能的写明原因
 * 「重新验证」是用存着的密钥再向 Nexus 验一次名片和密钥（补丁里叫 refresh）；不叫「复核」，那是全站审核员复核 AI 建议的意思。
 * 一次一个操作：进行中所有按钮不可用。
 */
import { timeText } from '../api/documents';
import { declaredOf, type AgentRow } from '../api/agents';
import { Button } from '../ui/Button';
import { Pill } from '../ui/Pill';
import { cx } from '../ui/cx';
import { resultText, statusOf, taskLabel } from './labels';

export interface AgentHandlers {
  enable: (agent: AgentRow) => void; rotate: (agent: AgentRow) => void; test: (agent: AgentRow) => void; approve: (agent: AgentRow) => void;
  unapprove: (agent: AgentRow) => void; refresh: (agent: AgentRow) => void; disable: (agent: AgentRow) => void;
}

const head = 'whitespace-nowrap border-b border-line px-3 py-[9px] text-left text-12 font-medium text-steel';
const cell = 'border-b border-line px-3 py-[11px] align-top';

export function AgentTable({ agents, approvalId, listed, busy, on }: {
  agents: AgentRow[]; approvalId: string | null; listed: boolean; busy: boolean; on: AgentHandlers;
}) {
  return (
    <div className="overflow-x-auto">
      <table aria-label="Agent 列表" className="w-full border-collapse">
        <thead>
          <tr>{['名称', '状态', '用途', '名片声明的任务', '调用密钥', '操作'].map(name => <th key={name} scope="col" className={head}>{name}</th>)}</tr>
        </thead>
        <tbody>
          {agents.map(agent => <Row key={agent.publishId} agent={agent} approval={agent.publishId === approvalId} listed={listed} busy={busy} on={on} />)}
        </tbody>
      </table>
    </div>
  );
}

function Row({ agent, approval, listed, busy, on }: { agent: AgentRow; approval: boolean; listed: boolean; busy: boolean; on: AgentHandlers }) {
  const { record, item } = agent;
  const status = statusOf(agent);
  const active = record?.status === 'active';
  const declared = declaredOf(agent);
  const act = (label: string, run: (agent: AgentRow) => void, primary = false) => (
    <Button key={label} size="sm" variant={primary ? 'primary' : 'default'} disabled={busy} onClick={() => run(agent)}>{label}</Button>
  );
  const approvalAct = approval ? act('取消审批 Agent', on.unapprove) : active ? act('设为审批 Agent', on.approve) : null;
  const actions = active ? [act('测试', on.test), approvalAct, act('重新验证', on.refresh), act('停用', on.disable)]
    : record?.status === 'invalid' ? [act('换钥匙', on.rotate, true), approvalAct, act('停用', on.disable)]
      : record?.status === 'disabled' ? [act('重新启用', on.enable, true), approvalAct]
        : !record && item?.enableable ? [act('启用', on.enable, true)] : [];
  // Nexus 清单说它现在不能启用的原因：没启用的写在状态下；已启用的照记录的状态，原因作为提示（名片可能改坏了，下次重新验证会失败）
  const problems = item && !item.enableable ? (item.problems?.length ? item.problems : [item.a2aReady ? '名片不合契约' : 'A2A 还没就绪']) : [];
  return (
    <tr data-publish={agent.publishId} className="hover:bg-canvas">
      <td className={cx(cell, 'min-w-[200px] max-w-[300px]')}>
        <b className="block break-words font-semibold">{agent.name}</b>
        <span className="block break-all text-12 text-faint">{agent.publishId}</span>
        {record && !item && listed && <span className="block text-12 text-faint">不在你的 Nexus 发布清单里</span>}
      </td>
      <td className={cx(cell, 'min-w-[150px] max-w-[220px]')}>
        <Pill tone={status.tone} icon={status.tone === 'wait' ? 'warning' : undefined}>{status.text}</Pill>
        {/* 两条原因可能一字不差：按位置作 key */}
        {problems.map((problem, index) => <span key={index} className="mt-1 block text-12 text-wait-ink">{record ? `Nexus 上现在：${problem}` : problem}</span>)}
        {record?.status === 'invalid' && record.invalidReason && <span className="mt-1 block text-12 text-fail-ink">失效原因：{resultText(record.invalidReason)}</span>}
      </td>
      <td className={cx(cell, 'whitespace-nowrap')}>
        {approval ? (
          <>
            <span data-approval-tag=""><Pill tone="info" icon={null}>审批 Agent</Pill></span>
            <span className={cx('mt-1 block text-12', active ? 'text-steel' : 'text-wait-ink')}>{active ? '审批流只调它' : '现在不可用，审批流暂停'}</span>
          </>
        ) : active ? <span className="text-13 text-steel">供前端工作流调用（不进审批流）</span> : <span className="text-faint">—</span>}
      </td>
      <td className={cx(cell, 'text-13')}>
        {declared.length ? declared.map(task => <span key={task} className="block">{taskLabel(task)}</span>)
          : <span className="text-steel">{record || item?.enableable ? '名片没有声明任务' : '—'}</span>}
      </td>
      <td className={cx(cell, 'whitespace-nowrap text-13')}>
        {record?.fingerprint ? <span className="block">指纹 {record.fingerprint}</span> : <span className="text-faint">—</span>}
        {record?.status === 'disabled' ? <span className="block text-12 text-faint">密钥已清除</span>
          : record?.verifiedAt && <span className="block text-12 text-faint">最近验证 {timeText(record.verifiedAt)}</span>}
      </td>
      <td className={cell}><div className="flex flex-wrap gap-[6px]">{actions}</div></td>
    </tr>
  );
}
