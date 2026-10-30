/**
 * Logo（Spec 第 2 节，照 sub2api 的做法）：深海军蓝渐变方块（#142B56 → #0A1A39 → #061127，内描边 rgba(165,191,255,.35)，
 * 蓝色外光）里一笔青到蓝渐变（#79F4BD → #39D9E7 → #3875F6）的「文件 + 对勾」直角线条；旁边字标「九安审单」。
 * 整块画成一个 SVG（不靠 CSS 渐变），这样同一个形状也能直接当网站图标用（src/assets/favicon.svg）。
 */
import { useId } from 'react';

export const WORDMARK = '九安审单';

export function LogoMark({ size = 30, className }: { size?: number; className?: string }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const bg = `logo-bg-${id}`;
  const mark = `logo-mark-${id}`;
  return (
    <svg viewBox="0 0 30 30" width={size} height={size} className={['shrink-0 shadow-logo', className].filter(Boolean).join(' ')} aria-hidden="true" focusable="false">
      <defs>
        {/* CSS linear-gradient(150deg, …) 在方块上的等价方向 */}
        <linearGradient id={bg} x1="0.25" y1="0.067" x2="0.75" y2="0.933">
          <stop offset="0" stopColor="#142B56" />
          <stop offset="0.55" stopColor="#0A1A39" />
          <stop offset="1" stopColor="#061127" />
        </linearGradient>
        <linearGradient id={mark} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#79F4BD" />
          <stop offset="0.5" stopColor="#39D9E7" />
          <stop offset="1" stopColor="#3875F6" />
        </linearGradient>
      </defs>
      <rect data-logo-tile="" width="30" height="30" fill={`url(#${bg})`} />
      <rect x="0.5" y="0.5" width="29" height="29" fill="none" stroke="rgba(165,191,255,.35)" strokeWidth="1" />
      <g data-logo-mark="" transform="translate(6 6) scale(0.75)" fill="none" stroke={`url(#${mark})`} strokeWidth="2.2" strokeLinecap="square" strokeLinejoin="miter">
        <path d="M6 3h9l3 3v15H6z" />
        <path d="M9 13l2.5 2.5L16 11" />
      </g>
    </svg>
  );
}

export function Logo({ wordmark = true, size = 30 }: { wordmark?: boolean; size?: number }) {
  return (
    <span className="flex items-center gap-[10px] text-[15px] font-title tracking-[0.2px] text-ink" {...(wordmark ? {} : { role: 'img', 'aria-label': WORDMARK })}>
      <LogoMark size={size} />
      {wordmark && <span className="whitespace-nowrap">{WORDMARK}</span>}
    </span>
  );
}
