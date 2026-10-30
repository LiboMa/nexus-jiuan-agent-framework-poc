/**
 * 抽屉的「原件」页签：原件清单、每个原件的读取状态和识别出文字的页数（字样照九安 analysisEvidenceView），AI 依据引用了哪一页；
 * 「读取原件」= 九安的 POST /documents/:id/evidence/read {sourceVersion}（一次最多 3 个），读的时候每 3 秒看一次。规则发布复核人只看。
 */
import { useMutation, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type { Role } from '../api/session';
import { keys, readEvidence, type BasisItem, type Evidence } from '../api/documents';
import { Button } from '../ui/Button';
import { Icon } from '../ui/icons';
import { Pill, type Tone } from '../ui/Pill';
import { cx } from '../ui/cx';
import { EVIDENCE_PENDING, canAct } from './labels';

const FILE_STATES: Record<string, [string, Tone]> = {
  ready: ['文字已读取', 'pass'], extraction_partial: ['文字部分读取', 'wait'], read_failed: ['读取失败', 'fail'],
  unsupported: ['格式暂不支持', 'wait'], extraction_failed: ['文字解析失败', 'fail'],
};
const COVERAGE: Record<string, string> = {
  manifest_not_returned: '平台还没读到这张单的附件清单，暂时不能判断附件齐不齐。',
  manifest_empty: '这张单的附件栏是空的；附件清单是否完整还没确认。',
  metadata_incomplete: '有附件的信息不全，等平台补齐后再读取。',
  pending_read: '还有原件没读：点「读取原件」继续，一次最多 3 个。',
  read_failed: '有原件读取失败，是读取环节的问题，不是单据缺件。',
  extraction_insufficient: '有原件的文字没解析全，相关条款还核对不了。',
  observed_content_ready: '已见原件的文字都读到了；合同、账单和这次付款是否对得上，还要人工核对。',
};

function summary(value: Evidence, actor: boolean): { title: string; text: string; tone?: 'wait' } {
  const ask = '需要读取请找管理员或分析员。';
  switch (value.status) {
    case 'not_run': return { title: '还没读取原件', text: actor ? '点「读取原件」读取，一次最多 3 个。' : ask };
    case 'queued': case 'running': return { title: '正在读取原件', text: '一般要几十秒，这里每 3 秒自动刷新。' };
    case 'completed': return { title: '原件已读取', text: COVERAGE[value.coverage?.status ?? ''] ?? '这里只列当前单据版本已取得的原件。' };
    case 'failed': return { title: '原件没有读完', text: actor ? '点「读取原件」再试；一直不成请联系管理员。' : ask, tone: 'wait' };
    case 'stale': case 'interrupted': return { title: '原件需要重新读取', text: `单据已更新或上次读取中断，旧结果不展示${actor ? '：点「读取原件」重新读取。' : `。${ask}`}`, tone: 'wait' };
    default: return { title: '原件状态暂时读不到', text: '请稍后再打开这一页；一直这样请联系管理员。', tone: 'wait' };
  }
}

export function EvidenceTab({ id, version, role, evidence, basis }: {
  id: string; version: string; role?: Role; evidence: UseQueryResult<Evidence, Error>; basis: BasisItem[];
}) {
  const queryClient = useQueryClient();
  const actor = canAct(role);
  const read = useMutation({ mutationFn: () => readEvidence(id, version), onSuccess: data => { queryClient.setQueryData(keys.evidence(id), data); } });
  const value = evidence.data;
  if (evidence.isPending) return <div className="px-[18px] py-[14px]"><p role="status" className="m-0 text-13 text-steel">正在读取原件状态…</p></div>;
  if (!value) {
    return (
      <div className="px-[18px] py-[14px]">
        <p role="alert" className="m-0 text-13 text-fail-ink">{evidence.error?.message ?? '原件状态没有读出来，请稍后重试。'}</p>
        <Button size="sm" icon="refresh" className="mt-2" onClick={() => void evidence.refetch()}>重新读取</Button>
      </div>
    );
  }
  const pending = EVIDENCE_PENDING.has(value.status);
  const head = summary(value, actor);
  const items = Array.isArray(value.manifest?.items) ? value.manifest.items : [];
  const files = Array.isArray(value.files) ? value.files : [];
  const counts = value.coverage?.counts;
  const cited = (name: string) => [...new Set(basis.filter(item => item.kind === 'evidence' && Number.isSafeInteger(item.page) && typeof item.ref === 'string' && item.ref.includes(name)).map(item => item.page as number))];
  return (
    <div className="px-[18px] py-[14px]">
      <div className={cx('flex items-start gap-[10px] border px-[14px] py-3', head.tone ? 'border-wait-200 bg-wait-50' : 'border-line bg-canvas')}>
        <span className={cx('mt-px', head.tone ? 'text-wait' : 'text-blue')}><Icon name={pending ? 'refresh' : 'file'} /></span>
        <div className="min-w-0 flex-1">
          <p className="m-0 text-14 font-semibold">{head.title}</p>
          {value.status === 'failed' && value.errorCode && <p className="m-0 mt-1 text-12 text-steel">错误码 {value.errorCode}</p>}
          <p className="m-0 mt-1 text-13 text-steel">{head.text}</p>
        </div>
        {actor && (
          <Button size="sm" icon="file" busy={read.isPending} disabled={pending || value.canRun === false || !version} onClick={() => read.mutate()}>读取原件</Button>
        )}
      </div>
      {read.isError && <p role="alert" className="m-0 mt-2 text-13 text-fail-ink">{read.error.message}</p>}
      {counts && (
        <p className="m-0 mt-3 text-12 text-steel">
          共 {counts.total ?? 0} 个 · 文字已读取 {counts.ready ?? 0} 个 · 待读取 {counts.pendingRead ?? 0} 个 · 平台待处理 {(counts.metadataIncomplete ?? 0) + (counts.readFailed ?? 0) + (counts.extractionInsufficient ?? 0)} 个
        </p>
      )}
      {items.length ? (
        <ul aria-label="原件清单" className="m-0 mt-2 list-none p-0">
          {items.map(item => {
            const file = files.find(entry => entry.attachmentId === item.id);
            const [label, tone]: [string, Tone] = file ? FILE_STATES[file.status] ?? ['读取状态待核实', 'neutral'] : item.metadataState === 'available' ? ['还没读取', 'neutral'] : ['附件信息不全', 'wait'];
            const name = item.name || '没有名字的附件';
            const pages = cited(name);
            return (
              <li key={item.id} className="flex items-start gap-[10px] border-t border-line py-[10px] first:border-t-0">
                <span className="mt-px text-faint"><Icon name="file" size={16} /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <b data-file-name="" className="break-all font-semibold">{name}</b>
                    <Pill tone={tone} icon={tone === 'wait' ? 'warning' : undefined}>{label}</Pill>
                  </div>
                  {Number.isSafeInteger(file?.pageCount) && (
                    <div className="text-12 text-steel">已识别文字 {file?.recognizedPageCount ?? 0} / {file?.pageCount} 页</div>
                  )}
                  {pages.length > 0 && <div className="text-12 text-steel">AI 引用了第 {pages.join('、')} 页</div>}
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="m-0 mt-3 text-13 text-steel">这张单还没有可列出的原件；平台读完附件清单后会出现在这里。</p>
      )}
    </div>
  );
}
