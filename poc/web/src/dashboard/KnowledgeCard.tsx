/**
 * 知识库状态（样稿底排第一张）：Agent 状态、制度份数、规则条数、最近入库（取外壳的上传历史，看板不去调 Agent）。
 * 知识库页暂时只给管理员：只有管理员有「打开知识库」。
 */
import { agentOf } from '../api/knowledge';
import type { Dashboard } from '../api/dashboard';
import { dayText } from '../api/documents';
import type { IconName } from '../ui/icons';
import { Panel } from '../ui/Panel';
import { Pill, type Tone } from '../ui/Pill';
import { countText } from './format';

function statusOf(knowledge: Dashboard['knowledge']): { text: string; tone: Tone; icon?: IconName | null } {
  if (!agentOf(knowledge.mode)) return { text: '知识库方式不认识', tone: 'neutral', icon: 'warning' };
  if (!knowledge.configured) return { text: 'Agent 未配置', tone: 'neutral' };
  if (!knowledge.ready) return { text: 'Agent 未启用', tone: 'wait', icon: 'warning' };
  return { text: 'Agent 就绪', tone: 'pass' };
}

export function KnowledgeCard({ knowledge, admin }: { knowledge: Dashboard['knowledge']; admin: boolean }) {
  const status = statusOf(knowledge);
  const cells: Array<[string, string]> = [['制度', `${countText(knowledge.sources)} 份`], ['规则', `${countText(knowledge.rules)} 条`], ['最近入库', dayText(knowledge.lastIngestAt)]];
  return (
    <Panel title="知识库" extra={<Pill tone={status.tone} icon={status.icon}>{status.text}</Pill>}>
      <div className="grid grid-cols-3 gap-2 px-4 pt-[14px]">
        {cells.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <span className="block text-12 text-steel">{label}</span>
            <b className="block truncate text-16 font-semibold">{value}</b>
          </div>
        ))}
      </div>
      <div className="px-4 pb-[14px] pt-3 text-12">
        {admin ? <a href="#/knowledge" className="font-semibold text-blue hover:underline">打开知识库</a> : <span className="text-steel">制度由管理员上传和维护。</span>}
      </div>
    </Panel>
  );
}
