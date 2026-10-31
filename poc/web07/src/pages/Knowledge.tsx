/**
 * 知识库（Spec 第 6 节；补丁 0005 的「公司制度」）：规则库由 Nexus 上的知识库 Agent 经 A2A 读写，页面只经外壳 /poc/kb/*。
 * 先问 /mode（冷启动约 10–20 秒）：没配置 / 没启用整页只说明怎么办；就绪时标题旁标 Agent 就绪，右上「检索」「上传制度」（弹框），
 * 下面制度清单和上传记录。分析员只读：看清单、查看、检索；没有上传、下线、恢复、删除，也没有上传记录（Spec 第 6 节角色）。
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '../api/session';
import { fetchMode, kbKeys } from '../api/knowledge';
import { AgentNotice, readyAgent } from '../knowledge/AgentNotice';
import { PolicyList } from '../knowledge/PolicyList';
import { SearchModal } from '../knowledge/SearchModal';
import { UploadHistory } from '../knowledge/UploadHistory';
import { UploadPolicyModal } from '../knowledge/UploadPolicyModal';
import { PageHeader } from '../shell/PageHeader';
import { Button } from '../ui/Button';
import { Panel } from '../ui/Panel';
import { Pill } from '../ui/Pill';

export function Knowledge() {
  const admin = useSession()?.user.role === 'admin';
  const mode = useQuery({ queryKey: kbKeys.mode, queryFn: fetchMode, retry: false });
  const agent = readyAgent(mode);
  const [uploading, setUploading] = useState(false);
  const [searching, setSearching] = useState(false);

  if (!agent) {
    return (
      <>
        <PageHeader title="知识库" />
        <Panel className="mt-[14px]"><AgentNotice mode={mode} admin={admin} /></Panel>
      </>
    );
  }
  return (
    <>
      <PageHeader
        title="知识库"
        note={<span data-agent="" className="inline-flex items-center gap-2"><span>{agent.name}</span><Pill tone="pass">就绪</Pill></span>}
        actions={<>
          <Button icon="search" onClick={() => setSearching(true)}>检索</Button>
          {admin && <Button variant="primary" icon="upload" onClick={() => setUploading(true)}>上传制度</Button>}
        </>}
      />
      <p className="m-0 mt-2 max-w-[880px] text-13 text-steel">{agent.lede}</p>
      <PolicyList agent={agent} ops={Array.isArray(mode.data?.ops) ? mode.data.ops : []} admin={admin} onUpload={() => setUploading(true)} />
      {admin && <UploadHistory />}
      <SearchModal open={searching} onClose={() => setSearching(false)} agent={agent} />
      {admin && <UploadPolicyModal open={uploading} onClose={() => setUploading(false)} />}
    </>
  );
}
