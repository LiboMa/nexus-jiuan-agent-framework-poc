import { useRef, useState, type KeyboardEvent } from 'react';

/**
 * 图里每一天（柱子、折线上的一天）的悬停和键盘焦点：指到或聚焦哪一天就提示哪一天（悬停和聚焦给的一样）。
 * 整张图只占一个 Tab 位（默认最后一天）；左右方向键按天走，Home / End 到头尾，Esc 收起提示。
 */
export function useRoving(count: number) {
  const [active, setActive] = useState<number | null>(null);
  const [focused, setFocused] = useState<number | null>(null);
  const [stop, setStop] = useState<number | null>(null);
  const nodes = useRef<Array<SVGGElement | null>>([]);
  const current = stop !== null && stop < count ? stop : count - 1;

  function onKeyDown(event: KeyboardEvent<SVGGElement>, index: number) {
    if (event.key === 'Escape') { setActive(null); return; }
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
    onPointerEnter: () => setActive(index),
    onPointerLeave: () => setActive(shown => (shown === index ? null : shown)),
    onFocus: () => { setActive(index); setFocused(index); setStop(index); },
    onBlur: () => { setActive(null); setFocused(null); },
    onKeyDown: (event: KeyboardEvent<SVGGElement>) => onKeyDown(event, index),
  });
  return { active, focused, itemProps };
}
