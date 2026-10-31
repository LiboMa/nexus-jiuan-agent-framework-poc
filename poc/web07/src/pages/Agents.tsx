/**
 * Agent 接入（Spec 第 6 节；补丁 0001–0003 用新风格重做；Rulings T8a–T8e）。只给管理员：导航的 canSee 和路由的 Guard 挡住别的角色，
 * 他们打开 #/agents 只看到「没有权限」，这一页根本不挂上、不发请求；九安和外壳那头也只认管理员。
 *   连接条：连 Nexus（弹框贴 Nexus API 密钥）/ 断开 / 手动添加（A2A 地址 + 调用密钥）
 *   审批流现在调谁（一行）+ Agent 列表：Nexus 上的发布和已启用的按发布编号合成一张表；启用、换钥匙（弹框贴调用密钥）、设为 / 取消审批 Agent（确认 + 原因）、
 *   测试（单据 / 文本 / 请求信封，弹框）、重新验证、停用
 *   调用记录（默认收起，展开看备注和依据）、操作记录（收起）
 * 先读启用记录；部署里配了 Nexus 地址（configured）才问 Nexus 连接，连上了才读发布清单（要几秒）。写操作一次一个（useOneAtATime）。
 */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FLOW_TASKS, agentKeys, connectNexus, declaredOf, disconnectNexus, enableAgent, fetchAccess, fetchNexus, fetchPublications, mergeAgents, rotateKey, runAction,
  type AccessRecord, type AgentRow,
} from '../api/agents';
import { AgentTable, type AgentHandlers } from '../agents/AgentTable';
import { AuditLog } from '../agents/AuditLog';
import { CallsPanel } from '../agents/CallsPanel';
import { ConfirmModal, type ConfirmAsk } from '../agents/ConfirmModal';
import { KeyModal, type KeyAsk } from '../agents/KeyModal';
import { NexusBar } from '../agents/NexusBar';
import { TestModal } from '../agents/TestModal';
import { REASONS, STATUS_TEXT } from '../agents/labels';
import { useOneAtATime } from '../agents/useOneAtATime';
import { messageOf } from '../knowledge/AgentNotice';
import { PageHeader } from '../shell/PageHeader';
import { Button } from '../ui/Button';
import { Empty } from '../ui/Empty';
import { Icon } from '../ui/icons';
import { Panel } from '../ui/Panel';
import { cx } from '../ui/cx';

type Notice = { text: string; ok: boolean };
const CALL_KEY_INTRO = '调用密钥在 Nexus「互联中心 › 对外发布」签发，nxa_ 开头。平台当场向 Nexus 验证名片和密钥，通过后加密保存；页面上只显示指纹，不再显示密钥。请直接粘贴，不要经聊天或邮件转发。';
const VERIFYING = '正在向 Nexus 当场验证名片与密钥，最长约三分钟…';

export function Agents() {
  const queryClient = useQueryClient();
  const access = useQuery({ queryKey: agentKeys.access, queryFn: fetchAccess });
  const usable = access.data?.configured !== false;
  const nexus = useQuery({ queryKey: agentKeys.nexus, queryFn: fetchNexus, enabled: Boolean(access.data) && usable, retry: false });
  const connected = usable && nexus.data?.connected === true;
  const published = useQuery({ queryKey: agentKeys.publications, queryFn: fetchPublications, enabled: connected, retry: false });

  const records = access.data?.records ?? [];
  const agents = mergeAgents(records, connected ? published.data ?? [] : []);
  // 审批 Agent 只认一个：九安给的 approval，老一点的回复里只有记录上的 approval 标记
  const approvalId = access.data?.approval?.publishId ?? records.find(record => record.approval === true)?.publishId ?? null;
  const names = new Map(agents.map(agent => [agent.publishId, agent.name]));
  const nameOf = (publishId: string) => names.get(publishId) ?? null;

  const one = useOneAtATime();
  const [notice, setNotice] = useState<Notice | null>(null);
  const [keyAsk, setKeyAsk] = useState<KeyAsk | null>(null);
  const [confirm, setConfirm] = useState<ConfirmAsk | null>(null);
  const [testing, setTesting] = useState<{ agent: AgentRow; open: boolean } | null>(null);

  // 写完重读启用记录（等它读完再关弹框，表就是新的）；调用记录在后台跟着刷新
  const reread = async () => {
    void queryClient.invalidateQueries({ queryKey: agentKeys.calls });
    await queryClient.invalidateQueries({ queryKey: agentKeys.access });
  };
  const done = (text: string | null) => { setKeyAsk(null); setConfirm(null); if (text) setNotice({ text, ok: true }); };
  const late = (text: string) => setNotice({ text, ok: false });
  const open = (ask: () => void) => { if (one.isBusy()) return; setNotice(null); ask(); };
  const fingerprint = (record: AccessRecord | null | undefined) => record?.fingerprint || '—';

  function enableAsk(agent: AgentRow): KeyAsk {
    const label = agent.record?.status === 'disabled' ? '重新启用' : '启用';
    return { title: `${label}「${agent.name}」`, submitLabel: `验证并${label}`, kind: 'call', intro: CALL_KEY_INTRO, working: VERIFYING,
      submit: async key => {
        const record = await enableAgent(agent.publishId, key, REASONS.enable);
        await reread();
        return `已${label}「${agent.name}」，密钥指纹 ${fingerprint(record)}。`;
      } };
  }
  const on: AgentHandlers = {
    enable: agent => open(() => setKeyAsk(enableAsk(agent))),
    rotate: agent => open(() => setKeyAsk({ title: `给「${agent.name}」换一把调用密钥`, submitLabel: '验证并更换', kind: 'call', intro: CALL_KEY_INTRO, working: VERIFYING,
      submit: async key => {
        const record = await rotateKey(agent.publishId, key, REASONS.rotate);
        await reread();
        return `已给「${agent.name}」换好调用密钥，新密钥指纹 ${fingerprint(record)}。`;
      } })),
    test: agent => setTesting(now => ({ agent: now?.agent.publishId === agent.publishId ? now.agent : agent, open: true })),
    approve: agent => open(() => {
      const current = approvalId && approvalId !== agent.publishId ? nameOf(approvalId) || approvalId : null;
      const declaresFlow = declaredOf(agent).some(task => FLOW_TASKS.includes(task));
      setConfirm({ title: '设为审批 Agent', icon: 'agent', reason: true, confirmLabel: '确认设为审批 Agent', working: `正在把「${agent.name}」设为审批 Agent…`,
        text: current ? `审批流以后只调「${agent.name}」，不再调「${current}」：单据池里新的 AI 独立建议都发给它。` : `审批流（单据池的 AI 独立建议）以后调「${agent.name}」。`,
        warning: declaresFlow ? null : `「${agent.name}」的名片没有声明审批流的任务（单据审核建议 review_advice@1 或单据初审 first_review@1）。设为审批 Agent 后，单据池里每张对公付款单都会发给它审，它多半答不了，AI 独立建议就出不来。只有确定它能审单时才这样做。`,
        submit: async reason => { await runAction(agent.publishId, 'approve', reason); await reread(); return `已把「${agent.name}」设为审批 Agent：审批流只调它。`; } });
    }),
    unapprove: agent => open(() => setConfirm({ title: '取消审批 Agent', reason: true, confirmLabel: '确认取消审批 Agent', cancelLabel: '返回', danger: true,
      working: `正在取消「${agent.name}」的审批 Agent…`,
      text: `取消后审批流没有 Agent：新单据的 AI 独立建议会停下，等你再指定一个审批 Agent（指定后自动补上）。「${agent.name}」照样就绪，供前端工作流调用。`,
      submit: async reason => { await runAction(agent.publishId, 'unapprove', reason); await reread(); return `已取消「${agent.name}」的审批 Agent：审批流现在没有 Agent。`; } })),
    disable: agent => open(() => setConfirm({ title: '停用 Agent', confirmLabel: '确认停用', danger: true, working: `正在停用「${agent.name}」…`,
      text: `停用后九安不再调用「${agent.name}」${agent.publishId === approvalId ? '（它是审批 Agent：审批流会暂停，重新启用后自动接上）' : ''}，存着的调用密钥一并清除；以后要用，重新贴一次密钥即可。`,
      submit: async () => { await runAction(agent.publishId, 'disable', REASONS.disable); await reread(); return `已停用「${agent.name}」，存着的调用密钥已清除。`; } })),
    refresh: agent => {
      if (one.isBusy()) return;
      setNotice(null);
      void one.run(`正在用存着的密钥重新验证「${agent.name}」…`, async () => {
        try {
          const record = await runAction(agent.publishId, 'refresh', REASONS.refresh);
          setNotice({ text: `重新验证完成：「${agent.name}」${STATUS_TEXT[record?.status ?? ''] ?? '状态待核实'}。`, ok: true });
        } catch (error) {
          setNotice({ text: messageOf(error), ok: false });
        } finally { await reread(); }
      });
    },
  };
  const connect = () => open(() => setKeyAsk({ title: '连接 Nexus', submitLabel: '连接', kind: 'nexus', working: '正在连接 Nexus…',
    intro: '贴一次你自己的 Nexus API 密钥（nxc_ 开头，在 Nexus「个人设置 › API 密钥」新建），这里就能列出你在 Nexus 上发布的 Agent。密钥交给平台保存、自动续期，页面上不再显示。',
    submit: async key => {
      const state = await connectNexus(key);
      queryClient.setQueryData(agentKeys.nexus, state);
      void queryClient.invalidateQueries({ queryKey: agentKeys.publications });
      return null;
    } }));
  const disconnect = () => open(() => setConfirm({ title: '断开 Nexus', confirmLabel: '确认断开', working: '正在断开 Nexus…',
    text: '断开后这里不再列出你在 Nexus 上发布的 Agent；已启用的 Agent 照常可用。以后要再连，需要在 Nexus「个人设置 › API 密钥」新建一把密钥。',
    submit: async () => {
      const state = await disconnectNexus();
      queryClient.setQueryData(agentKeys.nexus, { connected: state?.connected === true, user: null });
      queryClient.removeQueries({ queryKey: agentKeys.publications });
      return '已断开 Nexus。';
    } }));
  const manual = () => open(() => setKeyAsk({ title: '手动添加 Agent', submitLabel: '验证并添加', kind: 'call', address: true, working: VERIFYING,
    intro: '没连 Nexus，或清单里没有的发布：贴上它的 A2A 地址和调用密钥（都在 Nexus「互联中心 › 对外发布」）。平台当场验证后加密保存，页面上只显示指纹。',
    submit: async (key, publishId) => {
      const record = await enableAgent(publishId!, key, REASONS.manual);
      await reread();
      return `已添加「${record?.card?.name || publishId}」，密钥指纹 ${fingerprint(record)}。`;
    } }));
  function refreshAll() {
    setNotice(null);
    void access.refetch();
    void queryClient.invalidateQueries({ queryKey: agentKeys.calls });
    if (access.data && usable) void nexus.refetch().then(result => { if (result.data?.connected) void published.refetch(); });
  }

  const testAgent = testing ? agents.find(agent => agent.publishId === testing.agent.publishId) ?? testing.agent : null;
  return (
    <>
      <PageHeader title="Agent 接入" note="只有管理员能操作，每次操作留痕"
        actions={<Button icon="refresh" disabled={access.isFetching || Boolean(one.busy)} onClick={refreshAll}>刷新</Button>} />
      <p className="m-0 mt-2 max-w-[880px] text-13 text-steel">
        把 Nexus 上的 Agent 接进九安。启用时只需贴它的调用密钥，平台当场验证名片与密钥后加密保存；启用后 Agent 就绪，供前端工作流调用，审批流只调你指定的那一个审批 Agent。页面只显示密钥指纹，不显示密钥本身。
      </p>

      {access.isPending ? <Panel className="mt-[14px]"><p role="status" className="m-0 px-4 py-10 text-center text-13 text-steel">正在读取 Agent 接入…</p></Panel>
        : access.isError && !access.data ? (
          <Panel className="mt-[14px]">
            <Empty icon="warning" title="Agent 接入没有读出来" description={messageOf(access.error)}
              action={<Button icon="refresh" busy={access.isFetching} onClick={() => void access.refetch()}>重新读取</Button>} />
          </Panel>
        ) : (
          <>
            {usable ? <NexusBar nexus={nexus} published={published} busy={Boolean(one.busy)} onConnect={connect} onDisconnect={disconnect} onManual={manual} />
              : <p className="m-0 mt-[14px] flex items-center gap-2 rounded-box border border-wait-200 bg-wait-50 px-4 py-3 text-13 text-wait-ink"><Icon name="warning" size={16} />部署配置里没有 Nexus 地址，暂不能启用 Agent。</p>}
            <Panel title="Agent 列表" className="mt-[14px]" extra={<span>{agents.length} 个</span>}>
              {usable && records.length > 0 && <ApprovalLine approvalId={approvalId} records={records} nameOf={nameOf} />}
              {one.busy && !keyAsk && !confirm ? <p role="status" className="m-0 px-4 pt-3 text-13 text-wait-ink">{one.busy}</p>
                : notice && <p role={notice.ok ? 'status' : 'alert'} className={cx('m-0 px-4 pt-3 text-13', notice.ok ? 'text-pass-ink' : 'text-fail-ink')}>{notice.text}</p>}
              {agents.length ? <div className="mt-2"><AgentTable agents={agents} approvalId={approvalId} listed={connected && published.isSuccess} busy={Boolean(one.busy)} on={on} /></div> : (
                <Empty icon="agent" title={connected ? '你在 Nexus 上还没有开了 A2A 的发布' : '还没有 Agent'}
                  description={connected ? '在 Nexus「互联中心 › 对外发布」发布一个 Agent 并打开 A2A，再点「刷新清单」。' : '连接 Nexus 列出你发布的 Agent，或手动添加一个。'} />
              )}
            </Panel>
          </>
        )}

      {/* 读到启用记录以后才读调用记录：读不到时（多半是没有权限或这一页没开）只留一个出错的面板，也不多发一个注定被拒的请求 */}
      {access.data && <CallsPanel nameOf={nameOf} />}
      {access.data && <AuditLog audit={access.data.audit} nameOf={nameOf} />}

      <KeyModal ask={keyAsk} one={one} onClose={() => setKeyAsk(null)} onDone={done} onLate={late} />
      <ConfirmModal ask={confirm} one={one} onClose={() => setConfirm(null)} onDone={done} onLate={late} />
      {testing && testAgent && (
        <TestModal key={testAgent.publishId} agent={testAgent} open={testing.open} isApproval={testAgent.publishId === approvalId}
          onClose={() => setTesting(now => (now ? { ...now, open: false } : now))} />
      )}
    </>
  );
}

/** 审批流现在调谁（补丁 0003 的 approvalLine）：没有审批 Agent、或它不可用时，说清审批流停在哪。 */
function ApprovalLine({ approvalId, records, nameOf }: { approvalId: string | null; records: AccessRecord[]; nameOf: (publishId: string) => string | null }) {
  const record = approvalId ? records.find(item => item.publishId === approvalId) ?? null : null;
  const name = approvalId ? nameOf(approvalId) || record?.card?.name || approvalId : '';
  const [text, ok] = !approvalId ? ['审批流还没有审批 Agent：单据池的 AI 独立建议停着。在一个就绪的 Agent 上点「设为审批 Agent」。', false]
    : record?.status === 'active' ? [`审批流调用「${name}」：单据池里对公付款单的 AI 独立建议都发给它；其他就绪的 Agent 只供前端工作流调用。`, true]
      : [`审批 Agent「${name}」现在不可用（${record ? STATUS_TEXT[record.status] ?? record.status : '没有启用记录'}）：审批流暂停，恢复后自动接上。`, false];
  return (
    <p className={cx('m-0 mx-4 mt-3 flex items-start gap-2 border px-3 py-2 text-13', ok ? 'border-line bg-sunken text-ink shadow-[inset_2px_0_0_var(--color-pass)]' : 'border-wait-200 bg-wait-50 text-wait-ink')}>
      <span className={cx('mt-px', ok ? 'text-pass' : 'text-wait')}><Icon name={ok ? 'check' : 'warning'} size={16} /></span>
      <span>{text}</span>
    </p>
  );
}
