import { useLayoutEffect, useRef, useState } from 'react';

/**
 * 量容器的宽度（px），图按真实宽度画（不靠 viewBox 拉伸，字不会变形）；窗口、侧栏一变就重画。
 * 量不到（jsdom、还没排版）时用 fallback。
 */
export function useWidth<T extends HTMLElement>(fallback = 560) {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => { const next = Math.floor(node.getBoundingClientRect().width); if (next > 0) setWidth(next); };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}
