import { useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Button } from './Button';
import { Icon } from './icons';
import { cx } from './cx';

/**
 * 拖放区（样稿 .drop：虚线框、浅底、上传图标）：拖进来或点「选择文件」都交给 onPick（一次一个文件）。
 * disabled 时（请求进行中）按钮和文件框不可用，拖进来的也不收；拖放的默认动作（浏览器打开文件）一律拦下。
 */
export function DropZone({ lead, hint, accept, inputLabel, onPick, disabled = false, children }: {
  lead: ReactNode; hint: ReactNode; accept: string; inputLabel: string; onPick: (file: File) => void; disabled?: boolean; children?: ReactNode;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  const [over, setOver] = useState(false);
  function onDragOver(event: DragEvent) {
    event.preventDefault();
    if (!disabled) setOver(true);
  }
  function onDrop(event: DragEvent) {
    event.preventDefault();
    setOver(false);
    const file = event.dataTransfer?.files?.[0];
    if (file && !disabled) onPick(file);
  }
  return (
    <div
      data-drop="" aria-disabled={disabled || undefined} onDragOver={onDragOver} onDragLeave={() => setOver(false)} onDrop={onDrop}
      className={cx('flex flex-col items-center gap-2 border-[1.5px] border-dashed px-6 py-[22px] text-center text-steel',
        over ? 'border-blue bg-blue-50' : 'border-blue-200 bg-sunken', disabled && 'opacity-55')}
    >
      <span className="text-blue"><Icon name="upload" size={26} /></span>
      <span className="flex flex-wrap items-center justify-center gap-2">
        <b className="font-semibold text-ink">{lead}</b>
        <Button size="sm" variant="primary" disabled={disabled} onClick={() => input.current?.click()}>选择文件</Button>
      </span>
      <span className="text-12">{hint}</span>
      {children}
      <input
        ref={input} type="file" accept={accept} hidden disabled={disabled} aria-label={inputLabel}
        onChange={event => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file) onPick(file);
        }}
      />
    </div>
  );
}
