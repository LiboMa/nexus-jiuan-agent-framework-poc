/**
 * 粘贴密钥的弹框（Spec 第 2 节「粘贴调用密钥」；Ruling T8c）：调用密钥（启用、重新启用、换钥匙、手动添加）和 Nexus API 密钥（连接 Nexus）共用。
 * 密钥框是不受控的 <input type="password" autocomplete="off">：值不进 React 状态，也不会写成 DOM 的 value 属性；
 * 提交时读出来马上清空（不管成没成），关弹框时清空，出错时已经是空的。密钥只作为参数交给 ask.submit() 放进请求体：
 * 不进查询键和 React Query 缓存（不经 useMutation 的 variables）、不进日志和错误文字（万一服务端的话里带了也换掉）、不进地址栏。
 * 验证要等（最长约三分钟）时可以先关掉弹框：结果由 onDone / onLate 交给页面说。
 */
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import { publishIdFrom } from '../api/agents';
import { messageOf } from '../knowledge/AgentNotice';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import type { OneAtATime } from './useOneAtATime';

export type SecretKind = 'call' | 'nexus';
export interface KeyAsk {
  title: string; submitLabel: string; kind: SecretKind; intro: ReactNode;
  /** 等待时说的话（弹框里和页面的状态行）。 */
  working: string;
  /** 手动添加：多一个 A2A 地址框，发布编号从地址里认。 */
  address?: boolean;
  /** 发请求（密钥只在这里用这一次）；成功后页面上要说的话（null 不用说）。 */
  submit: (key: string, publishId: string | null) => Promise<string | null>;
}

const RULES: Record<SecretKind, { label: string; placeholder: string; empty: string; other: RegExp; otherText: string }> = {
  call: { label: '调用密钥', placeholder: 'nxa_ 开头，贴上后不再显示', empty: '请贴上调用密钥', other: /^nxc_/u,
    otherText: '这是 Nexus API 密钥（nxc_ 开头），不是调用密钥：调用密钥是 nxa_ 开头的，在 Nexus「互联中心 › 对外发布」签发。请重新贴一次。' },
  nexus: { label: 'Nexus API 密钥', placeholder: 'nxc_ 开头，贴一次即可', empty: '请贴上 Nexus API 密钥', other: /^nxa_/u,
    otherText: '这是调用密钥（nxa_ 开头），不是 Nexus API 密钥：Nexus API 密钥是 nxc_ 开头的，在 Nexus「个人设置 › API 密钥」新建。请重新贴一次。' },
};
export const inputClass = 'h-[30px] w-full rounded-ctl border border-line bg-surface px-[10px] text-13 text-ink hover:border-faint focus:border-blue disabled:opacity-55';

export function KeyModal({ ask, one, onClose, onDone, onLate }: {
  ask: KeyAsk | null; one: OneAtATime; onClose: () => void; onDone: (text: string | null) => void;
  /** 弹框关掉以后才回来的失败：页面上说。 */
  onLate: (text: string) => void;
}) {
  // 关的动画里还要标题：留着上一次的
  const last = useRef<KeyAsk | null>(null);
  if (ask) last.current = ask;
  const shown = ask ?? last.current;
  const keyRef = useRef<HTMLInputElement>(null);
  // 怎么关的都一样（取消、×、Esc、点蒙层）：先清空密钥框——关的动画里它还在页面上
  const close = () => { if (keyRef.current) keyRef.current.value = ''; onClose(); };
  return (
    <Modal open={Boolean(ask)} onOpenChange={next => { if (!next) close(); }} title={shown?.title ?? ''} icon="key" width={480}>
      {shown && <KeyForm ask={shown} one={one} keyRef={keyRef} onCancel={close} onDone={onDone} onLate={onLate} />}
    </Modal>
  );
}

function KeyForm({ ask, one, keyRef, onCancel, onDone, onLate }: {
  ask: KeyAsk; one: OneAtATime; keyRef: RefObject<HTMLInputElement | null>; onCancel: () => void; onDone: (text: string | null) => void; onLate: (text: string) => void;
}) {
  const rule = RULES[ask.kind];
  const [address, setAddress] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const ids = { key: useId(), address: useId() };
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (one.isBusy()) return;
    const input = keyRef.current;
    const key = input?.value.trim() ?? '';
    if (input) input.value = '';
    const publishId = ask.address ? publishIdFrom(address) : null;
    if (ask.address && !publishId) { setProblem('认不出发布：请粘贴这个发布的 A2A 地址（含 /a2a/pub_…）'); return; }
    if (!key) { setProblem(rule.empty); return; }
    if (rule.other.test(key)) { setProblem(rule.otherText); return; }
    setProblem(null);
    setSending(true);
    try {
      onDone(await one.run(ask.working, () => ask.submit(key, publishId)));
    } catch (error) {
      const text = messageOf(error).split(key).join('（密钥已隐藏）');
      if (!live.current) { onLate(text); return; }
      setProblem(text);
      setSending(false);
    }
  }

  return (
    <form onSubmit={event => void submit(event)} noValidate>
      <div className="flex flex-col gap-3 px-[18px] pt-3">
        <p className="m-0 text-13 text-steel">{ask.intro}</p>
        {ask.address && (
          <label htmlFor={ids.address} className="flex flex-col gap-1">
            <span className="text-12 font-medium text-steel">A2A 地址</span>
            <input id={ids.address} className={inputClass} value={address} placeholder="https://…/a2a/pub_…" autoComplete="off" spellCheck={false} disabled={sending}
              onChange={event => setAddress(event.target.value.slice(0, 500))} />
          </label>
        )}
        <label htmlFor={ids.key} className="flex flex-col gap-1">
          <span className="text-12 font-medium text-steel">{rule.label}</span>
          {/* data-1p-ignore / data-lpignore：请密码管理器别记它（浏览器自己的「保存密码」提示挡不住，见报告） */}
          <input id={ids.key} ref={keyRef} type="password" autoComplete="off" spellCheck={false} autoCapitalize="off" className={inputClass}
            placeholder={rule.placeholder} disabled={sending} data-1p-ignore="" data-lpignore="true" />
        </label>
        {sending && <p role="status" className="m-0 text-13 text-wait-ink">{ask.working}</p>}
        {problem && <p role="alert" className="m-0 text-13 text-fail-ink">{problem}</p>}
      </div>
      <footer className="flex justify-end gap-2 px-[18px] pb-4 pt-4">
        <Button onClick={onCancel}>{sending ? '关闭（验证照常进行）' : '取消'}</Button>
        <Button type="submit" variant="primary" busy={sending}>{ask.submitLabel}</Button>
      </footer>
    </form>
  );
}
