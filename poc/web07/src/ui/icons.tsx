/**
 * 自绘直角线条图标：24 网格、描边 1.6、方头（square）、斜接拐角（miter）、矩形构图；不用圆角图标库。
 * 形状照样稿 drafts-v2.html / dashboard-a-v9.html 里的 <symbol>。
 */
import type { ReactElement } from 'react';

const SHAPES = {
  dashboard: <><rect x="4" y="4" width="7" height="9" /><rect x="13" y="4" width="7" height="5" /><rect x="13" y="11" width="7" height="9" /><rect x="4" y="15" width="7" height="5" /></>,
  documents: <><rect x="4" y="4" width="16" height="16" /><path d="M8 9h8M8 13h8M8 17h5" /></>,
  knowledge: <><rect x="4" y="5" width="16" height="4" /><rect x="4" y="11" width="16" height="4" /><rect x="4" y="17" width="16" height="3" /></>,
  myRules: <><rect x="4" y="4" width="16" height="16" /><path d="M8 9h2M8 14h2M13 9h3M13 14h3" /></>,
  agent: <><rect x="6" y="6" width="12" height="12" /><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" /></>,
  settings: <><rect x="9" y="9" width="6" height="6" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" /></>,
  upload: <><path d="M12 16V5M7 10l5-5 5 5" /><path d="M4 15v5h16v-5" /></>,
  search: <><rect x="4" y="4" width="12" height="12" /><path d="M16 16l5 5" /></>,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  cross: <path d="M6 6l12 12M18 6L6 18" />,
  close: <path d="M7 7l10 10M17 7L7 17" />,
  file: <><path d="M6 3h9l3 3v15H6z" /><path d="M15 3v3h3" /></>,
  chevronLeft: <path d="M14 6l-6 6 6 6" />,
  chevronRight: <path d="M10 6l6 6-6 6" />,
  // 两段直角箭头围成一圈：重新审核、刷新。
  refresh: <><path d="M5 11V5h12" /><path d="M14 2l3 3-3 3" /><path d="M19 13v6H7" /><path d="M10 22l-3-3 3-3" /></>,
  warning: <><path d="M12 3l10 18H2z" /><path d="M12 10v5M12 17v2" /></>,
  logout: <><path d="M10 4H4v16h6" /><path d="M14 8l4 4-4 4M18 12H9" /></>,
  // 方头钥匙：粘贴调用密钥、换钥匙、连接 Nexus。
  key: <><rect x="3" y="8" width="8" height="8" /><path d="M11 12h10M17 12v4M20 12v3" /></>,
} satisfies Record<string, ReactElement>;

export type IconName = keyof typeof SHAPES;
export const ICON_NAMES = Object.keys(SHAPES) as IconName[];

export interface IconProps {
  name: IconName;
  /** 边长（px），默认 18（样稿的导航、按钮图标）。 */
  size?: number;
  className?: string;
  /** 图标单独表达意思时给它一个名字；和文字放在一起时不用给（对读屏隐藏）。 */
  title?: string;
}

export function Icon({ name, size = 18, className, title }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6"
      strokeLinecap="square" strokeLinejoin="miter" className={['shrink-0', className].filter(Boolean).join(' ')} focusable="false"
      {...(title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true })}
    >
      {SHAPES[name]}
    </svg>
  );
}
