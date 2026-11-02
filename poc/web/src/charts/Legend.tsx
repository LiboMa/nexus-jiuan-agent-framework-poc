import { Icon, type IconName } from '../ui/icons';

/**
 * 图例（两个及以上系列时总是有）：色块（系列色，只给图形）+ 图标 + 文字（文字用正文色系，不穿系列色）。
 * 状态色配 ✓ / ✕：红绿在色弱下只差 ΔE 6.2，光靠颜色分不开（Ruling T7d）。
 */
export interface LegendItem { label: string; color: string; icon?: IconName; iconClass?: string }

export function Legend({ items }: { items: LegendItem[] }) {
  return (
    <ul aria-label="图例" className="m-0 flex list-none flex-wrap items-center gap-x-3 gap-y-1 p-0 text-12 text-steel">
      {items.map((item, index) => (
        <li key={index} className="inline-flex items-center gap-[5px] whitespace-nowrap">
          <svg width="10" height="10" aria-hidden="true" focusable="false"><rect data-swatch="" width="10" height="10" fill={item.color} /></svg>
          {item.icon && <Icon name={item.icon} size={12} className={item.iconClass} />}
          {item.label}
        </li>
      ))}
    </ul>
  );
}
