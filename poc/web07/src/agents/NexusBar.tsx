/**
 * 顶上的 Nexus 连接条（补丁 0001 / 0002 的 nexusBar）：连上了说是谁、给「刷新清单」「断开 Nexus」；没连上给一个醒目的「连接 Nexus」（弹框贴 Nexus API 密钥）。
 * 两种情况都能「手动添加 Agent」（A2A 地址 + 调用密钥）。读不到连接、读不到发布清单时原话说明，已启用的 Agent 照样列在下面；
 * 外壳说连接失效了（AGENT_NEXUS_RECONNECT / NOT_CONNECTED）就给「重新连接」。
 */
import type { UseQueryResult } from '@tanstack/react-query';
import type { NexusState, Publication } from '../api/agents';
import { ApiError } from '../api/client';
import { messageOf } from '../knowledge/AgentNotice';
import { Button } from '../ui/Button';
import { Panel } from '../ui/Panel';
import { Pill } from '../ui/Pill';

const RECONNECT: ReadonlySet<string> = new Set(['AGENT_NEXUS_RECONNECT', 'AGENT_NEXUS_NOT_CONNECTED']);

export function NexusBar({ nexus, published, busy, onConnect, onDisconnect, onManual }: {
  nexus: UseQueryResult<NexusState, Error>; published: UseQueryResult<Publication[], Error>; busy: boolean;
  onConnect: () => void; onDisconnect: () => void; onManual: () => void;
}) {
  // 每个按钮带 key：状态切换（读取中 → 没连上）时不把「手动添加」的 DOM 节点挪给「连接 Nexus」
  const manual = <Button key="manual" disabled={busy} onClick={onManual}>手动添加 Agent</Button>;
  let text, actions;
  if (nexus.isPending) {
    text = <p role="status" className="m-0 text-13 text-steel">正在读取 Nexus 连接…</p>;
    actions = [manual];
  } else if (nexus.isError) {
    text = <><b className="text-14 font-semibold">Nexus 连接没有读出来</b><p role="alert" className="m-0 text-13 text-fail-ink">{messageOf(nexus.error)}</p></>;
    actions = [<Button key="retry" icon="refresh" busy={nexus.isFetching} onClick={() => void nexus.refetch()}>重试</Button>, manual];
  } else if (nexus.data.connected) {
    text = (
      <>
        <span className="flex flex-wrap items-center gap-2"><Pill tone="pass">已连接 Nexus</Pill>{nexus.data.user && <b className="text-14 font-semibold">{nexus.data.user}</b>}</span>
        <span className="text-13 text-steel">下面列出你在 Nexus 上发布、开了 A2A 的 Agent；启用时只需贴它的调用密钥。</span>
        {published.isPending ? <p role="status" className="m-0 text-13 text-steel">正在读取 Nexus 上的发布（要几秒）…</p>
          : published.isError && <p role="alert" className="m-0 text-13 text-fail-ink">{messageOf(published.error)}</p>}
      </>
    );
    const stale = published.error instanceof ApiError && RECONNECT.has(published.error.code);
    actions = [
      stale && <Button key="reconnect" variant="primary" icon="key" disabled={busy} onClick={onConnect}>重新连接</Button>,
      <Button key="reload" icon="refresh" disabled={published.isFetching} onClick={() => void published.refetch()}>刷新清单</Button>,
      <Button key="disconnect" disabled={busy} onClick={onDisconnect}>断开 Nexus</Button>,
      manual,
    ];
  } else {
    text = (
      <>
        <b className="text-14 font-semibold">连接 Nexus，列出你在 Nexus 上发布的 Agent</b>
        <span className="text-13 text-steel">Nexus API 密钥在 Nexus「个人设置 › API 密钥」新建，贴一次即可。不连也可以手动添加 Agent。</span>
      </>
    );
    actions = [<Button key="connect" variant="primary" icon="key" disabled={busy} onClick={onConnect}>连接 Nexus</Button>, manual];
  }
  return (
    <Panel className="mt-[14px]">
      <section aria-label="Nexus 连接" className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">{text}</div>
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      </section>
    </Panel>
  );
}
