/**
 * 「我的规则」的三个弹框：上传后核对转出来的文字、查看全文、确认删除。规则的文字一律当纯文字放进 <pre>。
 */
import { useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { timeText } from '../api/documents';
import { thousands } from '../api/knowledge';
import { fetchRule, rulesKeys, type OwnRule, type OwnRuleText } from '../api/myRules';
import { messageOf } from '../knowledge/AgentNotice';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';

function RuleText({ text }: { text: string }) {
  return (
    <pre data-testid="rule-text" className="m-0 max-h-[360px] overflow-auto whitespace-pre-wrap break-words border border-line bg-sunken px-3 py-[10px] font-sans text-13 leading-[1.7] text-ink">
      {text}
    </pre>
  );
}

/** 刚上传：给审核员核对转出来的文字（不对就删掉，改好原文件再上传）。 */
export function CheckModal({ rule, onClose, onDelete }: { rule: OwnRuleText | null; onClose: () => void; onDelete: (rule: OwnRule) => void }) {
  const last = useRef<OwnRuleText | null>(null);
  if (rule) last.current = rule;
  const shown = rule ?? last.current;
  return (
    <Modal
      open={Boolean(rule)} onOpenChange={next => { if (!next) onClose(); }} title="核对转出来的文字" icon="myRules" width={560}
      description={shown ? `已上传「${shown.title}」：${thousands(shown.chars)} 字。下面是转出来的文字，请核对；不对就删掉这份，改好原文件再上传。` : undefined}
      footer={<>
        <Button variant="danger" onClick={() => { if (rule) onDelete(rule); }}>删掉这份</Button>
        <Button variant="primary" icon="check" onClick={onClose}>核对无误</Button>
      </>}
    >
      <div className="px-[18px] pt-3">{shown && <RuleText text={shown.text} />}</div>
    </Modal>
  );
}

/** 查看全文（GET /poc/custom-rules/:id）。 */
export function ViewModal({ rule, onClose }: { rule: OwnRule | null; onClose: () => void }) {
  const last = useRef<OwnRule | null>(null);
  if (rule) last.current = rule;
  const shown = rule ?? last.current;
  const id = shown?.id ?? '';
  const full = useQuery({ queryKey: rulesKeys.one(id), queryFn: () => fetchRule(id), enabled: Boolean(rule) });
  return (
    <Modal open={Boolean(rule)} onOpenChange={next => { if (!next) onClose(); }} title={shown?.title ?? '规则'} icon="myRules" width={560}
      description={shown ? `${thousands(shown.chars)} 字 · 上传于 ${timeText(shown.uploadedAt)}` : undefined}>
      <div className="px-[18px] pb-4 pt-3">
        {full.isPending ? <p role="status" className="m-0 text-13 text-steel">正在读取全文…</p>
          : full.isError ? <p role="alert" className="m-0 text-13 text-fail-ink">{messageOf(full.error)}</p>
            : <RuleText text={full.data.text ?? ''} />}
      </div>
    </Modal>
  );
}

/** 删除前再确认一次。 */
export function DeleteModal({ rule, busy, onClose, onConfirm }: { rule: OwnRule | null; busy: boolean; onClose: () => void; onConfirm: (rule: OwnRule) => void }) {
  const last = useRef<OwnRule | null>(null);
  if (rule) last.current = rule;
  const shown = rule ?? last.current;
  return (
    <Modal
      open={Boolean(rule)} onOpenChange={next => { if (!next) onClose(); }} title="删除规则" icon="warning"
      footer={<><Button onClick={onClose}>取消</Button><Button variant="danger" disabled={busy} onClick={() => { if (rule) onConfirm(rule); }}>确认删除</Button></>}
    >
      {shown && (
        <p className="m-0 px-[18px] pt-4 text-13 text-ink">
          删除「{shown.title}」（{thousands(shown.chars)} 字）？删了以后手动发起 AI 审核时不再带上它；还要用的话，重新上传原文件。
        </p>
      )}
    </Modal>
  );
}
