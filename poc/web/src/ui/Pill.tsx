import type { ReactNode } from 'react';
import { Icon, type IconName } from './icons';
import { cx } from './cx';

/** pass 通过、fail 不通过、wait 处理中、neutral 已处理 / 一般、info 公司制度、own 我的规则。 */
export type Tone = 'pass' | 'fail' | 'wait' | 'neutral' | 'info' | 'own';

const TONES: Record<Tone, string> = {
  pass: 'text-pass-ink border-pass-200 bg-pass-50',
  fail: 'text-fail-ink border-fail-200 bg-fail-50',
  wait: 'text-wait-ink border-wait-200 bg-wait-50',
  neutral: 'text-steel border-line bg-canvas',
  info: 'text-blue border-blue-200 bg-blue-50',
  own: 'text-own-ink border-own-200 bg-own-50',
};
// 状态色一律配图标和文字（红绿在色弱下区分度低）；文字用 -ink（Ruling T5a：基础色作 12 px 文字不到 4.5:1）。
const DEFAULT_ICON: Partial<Record<Tone, IconName>> = { pass: 'check', fail: 'cross' };

export function Pill({ tone = 'neutral', icon, children, className }: { tone?: Tone; icon?: IconName | null; children: ReactNode; className?: string }) {
  const shown = icon === null ? undefined : icon ?? DEFAULT_ICON[tone];
  return (
    <span data-tone={tone} className={cx('inline-flex items-center gap-[5px] whitespace-nowrap rounded-ctl border px-2 py-[2px] text-12 font-semibold', TONES[tone], className)}>
      {shown && <Icon name={shown} size={12} />}
      {children}
    </span>
  );
}
