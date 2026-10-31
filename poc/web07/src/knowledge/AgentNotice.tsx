/**
 * 知识库 Agent 还不能用时只说这一件事、怎么办（文案同补丁 0005）：读 /mode 时的等待和失败、不认识的方式、没配置、没启用。
 * 页面和「上传制度」弹框共用。「打开 Agent 接入」是普通链接（弹框可能挂在路由外面），只给管理员（分析员进不去那一页）。
 */
import type { UseQueryResult } from '@tanstack/react-query';
import { ApiError } from '../api/client';
import { DEFAULT_AGENT, agentOf, type KbMode } from '../api/knowledge';
import { Button } from '../ui/Button';
import { Empty } from '../ui/Empty';

export const messageOf = (error: unknown) => (error instanceof ApiError ? error.message : '没有成功，请稍后再试。');

/** 就绪回 null（调用方画正常内容）；否则回那句提示。 */
export function AgentNotice({ mode, admin }: { mode: UseQueryResult<KbMode, Error>; admin: boolean }) {
  if (mode.isPending) return <p role="status" className="m-0 px-4 py-10 text-center text-13 text-steel">正在连接{DEFAULT_AGENT.name}（约 10–20 秒）…</p>;
  if (mode.isError) {
    return <Empty icon="warning" title="知识库的状态没有读出来" description={messageOf(mode.error)}
      action={<Button icon="refresh" busy={mode.isFetching} onClick={() => void mode.refetch()}>重试</Button>} />;
  }
  const agent = agentOf(mode.data.mode);
  if (!agent) {
    return <Empty icon="warning" title={`不认识的知识库方式：${mode.data.mode || '—'}`} description="请管理员检查部署配置里的知识库方式（pg 或 s3vectors）后重新部署。" />;
  }
  if (mode.data.configured === false) {
    return <Empty icon="knowledge" title={`${agent.lead}还没配置`} description="部署配置里还没有它的发布编号：请管理员填上发布编号、重新部署，再到『Agent 接入』页启用。" />;
  }
  if (mode.data.ready !== true) {
    return admin
      ? <Empty icon="agent" title={`先在『Agent 接入』页启用${agent.name}`} description="启用要粘贴这个发布的调用密钥；启用后回到这里就能上传制度、检索。"
        action={<a href="#/agents" className="inline-flex h-[30px] items-center rounded-ctl border border-blue bg-blue px-3 text-13 font-semibold text-white hover:brightness-110">打开 Agent 接入</a>} />
      : <Empty icon="agent" title={`先在『Agent 接入』页启用${agent.name}`} description="请管理员在『Agent 接入』页粘贴调用密钥启用；启用后这里就能看制度清单、检索。" />;
  }
  return null;
}

/** /mode 说就绪了吗（是哪种方式）。 */
export function readyAgent(mode: UseQueryResult<KbMode, Error>) {
  const agent = agentOf(mode.data?.mode);
  return agent && mode.data?.configured !== false && mode.data?.ready === true ? agent : null;
}
