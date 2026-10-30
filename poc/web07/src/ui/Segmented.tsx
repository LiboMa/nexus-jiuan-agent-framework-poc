import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from './cx';

export interface SegmentedOption<V extends string> { value: V; label: ReactNode; count?: number }

/**
 * 分段选择（样稿 .seg）：页面标题下的「待复核 / 已复核 / 全部」、工作台右上的「今天 / 近 14 天 / 本月」。
 * 语义是单选组：点选或左右方向键切换，只有选中的一项在 Tab 顺序里。
 */
export function Segmented<V extends string>({ options, value, onChange, label, className }: {
  options: SegmentedOption<V>[]; value: V; onChange: (value: V) => void; label: string; className?: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = (index + step + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  }
  return (
    <div role="radiogroup" aria-label={label} className={cx('inline-flex border border-line bg-surface', className)}>
      {options.map((option, index) => {
        const on = option.value === value;
        return (
          <button
            key={option.value}
            ref={node => { refs.current[index] = node; }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={event => onKeyDown(event, index)}
            className={cx(
              'border-r border-line px-[14px] py-[6px] text-13 last:border-r-0',
              on ? 'font-semibold text-ink shadow-[inset_0_-2px_0_var(--color-blue)]' : 'text-steel hover:text-ink',
            )}
          >
            {option.label}{option.count !== undefined && <> {option.count}</>}
          </button>
        );
      })}
    </div>
  );
}
