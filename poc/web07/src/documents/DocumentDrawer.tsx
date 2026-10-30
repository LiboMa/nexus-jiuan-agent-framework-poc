/**
 * 单据抽屉（样稿 drawer-a.html；Spec 第 6 节）：右侧 430 px、没有蒙层（modal={false}，Ruling T5b）——后面的表格照样能点，点另一行就换单；
 * 关闭按钮和 Esc 关它。头部：单号、公司 · 事项、金额 · 提交日期，AI 建议更新过时标「AI 建议已更新」。
 * 页签：AI 建议 / 原件 N / 单据信息 / 历史；底部复核区（管理员、分析员）或只读说明（规则发布复核人）。
 * AI 建议进行中时每 3 秒读一次（只在抽屉开着、看的就是这张单时），停在结果上；停下时刷新复核状态和各轮。
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Role } from '../api/session';
import {
  ADVICE_POLL_MS, amountText, dayText, fetchAdvice, fetchDocument, fetchEvidence, fetchLatest, isDocumentId, itemText, keys,
  type DocumentItem,
} from '../api/documents';
import { Drawer } from '../ui/Drawer';
import { Pill } from '../ui/Pill';
import { Tabs } from '../ui/Tabs';
import { AdviceTab } from './AdviceTab';
import { DetailTab } from './DetailTab';
import { EvidenceTab } from './EvidenceTab';
import { HistoryTab } from './HistoryTab';
import { ReviewForm } from './ReviewForm';
import { EVIDENCE_PENDING, canAct } from './labels';


export function DocumentDrawer({ id, item, role, onClose, onReviewed, onNext, hasNext, returnFocus }: {
  id: string | null; item?: DocumentItem; role?: Role; onClose: () => void; onReviewed: (id: string) => void;
  onNext?: () => void; hasNext: boolean; returnFocus?: () => void;
}) {
  // 关的时候（动画还在放）留着上一张的内容
  const last = useRef<string | null>(null);
  if (id) last.current = id;
  const shownId = id ?? last.current;
  const open = Boolean(id);
  const valid = isDocumentId(shownId);
  const live = open && valid;
  const docId = shownId ?? '';
  const queryClient = useQueryClient();
  // 换一张单回到「AI 建议」页签
  const [tabOf, setTabOf] = useState<{ id: string | null; tab: string }>({ id: null, tab: 'advice' });
  const tab = tabOf.id === shownId ? tabOf.tab : 'advice';
  const setTab = (next: string) => setTabOf({ id: shownId, tab: next });

  const doc = useQuery({ queryKey: keys.document(docId), queryFn: () => fetchDocument(docId), enabled: live });
  const latest = useQuery({ queryKey: keys.latest(docId), queryFn: () => fetchLatest(docId), enabled: live });
  const advice = useQuery({ queryKey: keys.advice(docId), queryFn: () => fetchAdvice(docId), enabled: live,
    refetchInterval: query => (query.state.data?.status === 'running' ? ADVICE_POLL_MS : false) });
  const evidence = useQuery({ queryKey: keys.evidence(docId), queryFn: () => fetchEvidence(docId), enabled: live,
    refetchInterval: query => (EVIDENCE_PENDING.has(query.state.data?.status ?? '') ? ADVICE_POLL_MS : false) });

  // AI 建议从进行中停下来：复核状态（单据池和这张单的）和各轮跟着刷新
  const status = advice.data?.status;
  const previous = useRef<{ id: string; status?: string }>({ id: '' });
  useEffect(() => {
    if (previous.current.id === docId && previous.current.status === 'running' && status && status !== 'running') {
      void queryClient.invalidateQueries({ queryKey: ['reviews'] });
      void queryClient.invalidateQueries({ queryKey: keys.rounds(docId) });
    }
    previous.current = { id: docId, status };
  }, [docId, status, queryClient]);

  const data = doc.data ?? item;
  const version = doc.data?.version ?? item?.version ?? '';
  const company = data?.companyName?.trim();
  const what = data ? itemText(data) : '';
  const files = evidence.data?.manifest?.items;
  const outdated = latest.data?.state === 'outdated';

  const body = !valid
    ? <p role="alert" className="m-0 px-[18px] py-6 text-13 text-steel">这个地址里的单据编号不对：请回到单据池重新打开。</p>
    : (
      <Tabs
        label="单据内容" value={tab} onValueChange={setTab} className="min-h-0 flex-1"
        items={[
          { value: 'advice', label: 'AI 建议', content: <AdviceTab id={docId} version={version} role={role} advice={advice} /> },
          { value: 'evidence', label: '原件', count: Array.isArray(files) ? files.length : undefined,
            content: <EvidenceTab id={docId} version={version} role={role} evidence={evidence} basis={advice.data?.basis ?? []} /> },
          { value: 'detail', label: '单据信息', content: <DetailTab id={docId} /> },
          { value: 'history', label: '历史', content: <HistoryTab id={docId} /> },
        ]}
      />
    );

  return (
    <Drawer
      open={open}
      onOpenChange={next => { if (!next) onClose(); }}
      modal={false}
      closeOnOutside={false}
      onCloseAutoFocus={event => { event.preventDefault(); returnFocus?.(); }}
      title={data?.number || (doc.isError ? '单据' : '正在读取单据…')}
      headerExtra={(
        <span className="flex min-w-0 items-center gap-2">
          {(company || what) && <span className="truncate text-13 text-steel">{[company, what].filter(Boolean).join(' · ')}</span>}
          {outdated && <Pill tone="wait" icon="refresh">AI 建议已更新</Pill>}
        </span>
      )}
      subtitle={data ? `${amountText(data.amount, data.currency)} · 提交于 ${dayText(data.submittedAt)}` : undefined}
      footer={!valid ? undefined : canAct(role)
        ? <ReviewForm key={docId} id={docId} version={version} latest={latest} onReviewed={() => onReviewed(docId)} onNext={onNext} hasNext={hasNext} />
        : role === 'policy_reviewer'
          ? <p className="m-0 text-13 text-steel">你是规则发布复核人，这里只能查看：复核、重新审核和读取原件请换管理员或分析员账号。</p>
          : undefined}
    >
      {doc.isError && (
        <p role="alert" className="m-0 mx-[18px] mb-2 text-13 text-fail-ink">{doc.error.message}</p>
      )}
      {body}
    </Drawer>
  );
}
