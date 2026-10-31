/**
 * 先确认再做的弹框：设为 / 取消审批 Agent（要写原因，Ruling T8b）、停用、断开 Nexus。说清做了以后会怎样；
 * warning 是要特别当心的那句（名片没有声明审批流的任务）。九安拒绝时原话留在弹框里。原因最多 200 字（九安的上限）。
 */
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { REASON_MAX } from '../api/agents';
import { clipChars } from '../api/knowledge';
import { messageOf } from '../knowledge/AgentNotice';
import { Button } from '../ui/Button';
import { Icon, type IconName } from '../ui/icons';
import { Modal } from '../ui/Modal';
import type { OneAtATime } from './useOneAtATime';

export interface ConfirmAsk {
  title: string; icon?: IconName; text: string; warning?: string | null; confirmLabel: string; cancelLabel?: string; danger?: boolean; working: string;
  /** 要人写原因（留痕）；不写的操作由调用方自动填。 */
  reason?: boolean;
  submit: (reason: string) => Promise<string | null>;
}

export function ConfirmModal({ ask, one, onClose, onDone, onLate }: {
  ask: ConfirmAsk | null; one: OneAtATime; onClose: () => void; onDone: (text: string | null) => void; onLate: (text: string) => void;
}) {
  const last = useRef<ConfirmAsk | null>(null);
  if (ask) last.current = ask;
  const shown = ask ?? last.current;
  return (
    <Modal open={Boolean(ask)} onOpenChange={next => { if (!next) onClose(); }} title={shown?.title ?? ''} icon={shown?.icon ?? 'warning'} width={480}>
      {shown && <ConfirmForm ask={shown} one={one} onCancel={onClose} onDone={onDone} onLate={onLate} />}
    </Modal>
  );
}

function ConfirmForm({ ask, one, onCancel, onDone, onLate }: {
  ask: ConfirmAsk; one: OneAtATime; onCancel: () => void; onDone: (text: string | null) => void; onLate: (text: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const id = useId();
  // 弹框关掉以后才回来的失败交给页面说
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (one.isBusy()) return;
    const text = reason.trim();
    if (ask.reason && !text) { setProblem('请写一句原因（会记进操作记录）'); return; }
    setProblem(null);
    setSending(true);
    try { onDone(await one.run(ask.working, () => ask.submit(text))); } catch (error) {
      if (!live.current) { onLate(messageOf(error)); return; }
      setProblem(messageOf(error));
      setSending(false);
    }
  }

  return (
    <form onSubmit={event => void submit(event)} noValidate>
      <div className="flex flex-col gap-3 px-[18px] pt-4">
        <p className="m-0 text-13 text-ink">{ask.text}</p>
        {ask.warning && (
          <p className="m-0 flex items-start gap-2 rounded-box border border-wait-200 bg-wait-50 px-3 py-2 text-13 text-wait-ink">
            <span className="mt-px text-wait"><Icon name="warning" size={16} /></span><span>{ask.warning}</span>
          </p>
        )}
        {ask.reason && (
          <div className="flex flex-col gap-1">
            <span className="text-12 font-medium text-steel"><label htmlFor={id}>原因</label><span className="ml-2 font-normal text-faint">必填，会记进操作记录；{REASON_MAX} 字以内</span></span>
            <textarea id={id} rows={2} value={reason} disabled={sending} placeholder="例如：换成新版的审单 Agent"
              className="w-full resize-y rounded-ctl border border-line bg-surface px-[10px] py-[6px] text-13 text-ink hover:border-faint focus:border-blue disabled:opacity-55"
              onChange={event => setReason(clipChars(event.target.value, REASON_MAX))} />
          </div>
        )}
        {sending && <p role="status" className="m-0 text-13 text-wait-ink">{ask.working}</p>}
        {problem && <p role="alert" className="m-0 text-13 text-fail-ink">{problem}</p>}
      </div>
      <footer className="flex justify-end gap-2 px-[18px] pb-4 pt-4">
        <Button onClick={onCancel}>{ask.cancelLabel ?? '取消'}</Button>
        <Button type="submit" variant={ask.danger ? 'danger' : 'primary'} busy={sending}>{ask.confirmLabel}</Button>
      </footer>
    </form>
  );
}
