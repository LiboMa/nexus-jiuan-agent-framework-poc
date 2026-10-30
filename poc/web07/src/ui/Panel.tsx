import { useId, type ReactNode } from 'react';
import { cx } from './cx';

/** 白色卡片（圆角 4 px、1 px 分隔线）；有标题时带样稿的表头（12 × 16 内边距、底部分隔线）。 */
export function Panel({ title, extra, children, className }: { title?: ReactNode; extra?: ReactNode; children?: ReactNode; className?: string }) {
  const id = useId();
  return (
    <section aria-labelledby={title ? id : undefined} className={cx('rounded-box border border-line bg-surface', className)}>
      {title && (
        <header className="flex items-center gap-[10px] border-b border-line px-4 py-3">
          <h2 id={id} className="m-0 text-14 font-semibold">{title}</h2>
          {extra && <div className="ml-auto flex items-center gap-2 text-12 text-steel">{extra}</div>}
        </header>
      )}
      {children}
    </section>
  );
}
