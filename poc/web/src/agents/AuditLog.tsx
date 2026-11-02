/** 操作记录（九安启用服务的 audit，最近 50 条；补丁 0002 收起放在最下面）：谁、什么时候、做了什么、结果、密钥指纹、原因。新的在前。 */
import { timeText } from '../api/documents';
import type { AuditEntry } from '../api/agents';
import { ACTIONS, resultText } from './labels';

const head = 'whitespace-nowrap border-b border-line px-3 py-[9px] text-left text-12 font-medium text-steel';
const cell = 'border-b border-line px-3 py-[9px] text-13';

export function AuditLog({ audit, nameOf }: { audit: AuditEntry[]; nameOf: (publishId: string) => string | null }) {
  const items = audit.slice().reverse();
  return (
    <details className="mt-[14px] rounded-box border border-line bg-surface">
      <summary className="cursor-pointer px-4 py-3 text-14 font-semibold">操作记录（{audit.length} 条）</summary>
      {items.length ? (
        <div className="overflow-x-auto border-t border-line">
          <table aria-label="操作记录" className="w-full border-collapse">
            <thead><tr>{['时间', '操作人', '操作', 'Agent', '结果', '密钥指纹', '原因'].map(name => <th key={name} scope="col" className={head}>{name}</th>)}</tr></thead>
            <tbody>
              {items.map((entry, index) => (
                <tr key={index}>
                  <td className={`${cell} whitespace-nowrap text-steel`}>{timeText(entry.at)}</td>
                  <td className={`${cell} whitespace-nowrap`}>{entry.actor || '—'}</td>
                  <td className={`${cell} whitespace-nowrap`}>{ACTIONS[entry.action ?? ''] ?? '操作待核实'}</td>
                  <td className={cell} title={entry.publishId}>{(entry.publishId && nameOf(entry.publishId)) || entry.publishId || '—'}</td>
                  <td className={`${cell} whitespace-nowrap`}>{resultText(entry.result)}</td>
                  <td className={`${cell} whitespace-nowrap`}>{entry.fingerprint ? `指纹 ${entry.fingerprint}` : '—'}</td>
                  <td className={cell}>{entry.reason || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="m-0 border-t border-line px-4 py-3 text-13 text-steel">还没有操作记录。</p>}
    </details>
  );
}
