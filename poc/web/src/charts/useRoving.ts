import { useRef, useState, type KeyboardEvent } from 'react';

/**
 * 图里每一天（柱子、折线上的一天）的悬停和键盘焦点：指到或聚焦哪一天就提示哪一天（悬停和聚焦给的一样）。
 * 整张图只占一个 Tab 位（默认最后一天）；左右方向键按天走，Home / End 到头尾，Esc 收起提示。
 * 焦点框只给键盘（:focus-visible，见各图里的 group-focus-visible:），鼠标点一下不画。
 * days 是这批日子的标识（例如日期串）：换了一批（换窗口）就把提示收起——被删掉的 <g> 不会发 pointerleave，
 * 留着的 <g> 现在是另一天；指针再动一下就提示新的那一天。active 也一律限在 count 以内，绝不指到不存在的一天。
 * Tab 位也回到最后一天（不留在旧窗口的位置上：那个位置现在是另一天）。
 */
export function useRoving(count: number, days: string) {
  const [hovered, setHovered] = useState<number | null>(null);
  const [stop, setStop] = useState<number | null>(null);
  const [seen, setSeen] = useState(days);
  if (seen !== days) {
    setSeen(days);
    setHovered(null);
    setStop(null);
  }
  const active = hovered !== null && hovered >= 0 && hovered < count ? hovered : null;
  const nodes = useRef<Array<SVGGElement | null>>([]);
  const current = stop !== null && stop < count ? stop : count - 1;

  function onKeyDown(event: KeyboardEvent<SVGGElement>, index: number) {
    if (event.key === 'Escape') { setHovered(null); return; }
    const to = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? index + 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? index - 1
        : event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : null;
    if (to === null) return;
    event.preventDefault();
    nodes.current[Math.max(0, Math.min(count - 1, to))]?.focus();
  }

  const itemProps = (index: number) => ({
    ref: (node: SVGGElement | null) => { nodes.current[index] = node; },
    tabIndex: index === current ? 0 : -1,
    onPointerEnter: () => setHovered(index),
    onPointerMove: () => setHovered(index),
    onPointerLeave: () => setHovered(shown => (shown === index ? null : shown)),
    onFocus: () => { setHovered(index); setStop(index); },
    onBlur: () => setHovered(null),
    onKeyDown: (event: KeyboardEvent<SVGGElement>) => onKeyDown(event, index),
  });
  return { active, itemProps };
}

/** 一天的 <g> 和它的悬停区：键盘聚焦时（只在 :focus-visible 时）给悬停区画 1.5 px 主蓝框。 */
export const DAY_CLASS = 'group outline-none';
export const RING_CLASS = 'group-focus-visible:stroke-blue group-focus-visible:[stroke-width:1.5px]';
