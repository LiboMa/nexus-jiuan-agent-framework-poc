import * as Dialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';
import { Icon, type IconName } from './icons';
import { cx } from './cx';

/**
 * 居中弹框（样稿 A 版 .modal：宽 440、距顶 70、圆角 4、蒙层 rgba(14,27,51,.16)）：上传制度、检索、查看全文、粘贴密钥、确认删除。
 * 用 Radix Dialog 管焦点、Esc、读屏；蒙层是自己的 div——Radix 的 Dialog.Overlay 会经 react-remove-scroll 往页面插 <style>，
 * 违反 style-src 'self'，所以不用它。
 */
export function Modal({ open, onOpenChange, title, icon, extra, description, footer, children, width = 440 }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: ReactNode; icon?: IconName; extra?: ReactNode;
  description?: ReactNode; footer?: ReactNode; children?: ReactNode; width?: number;
}) {
  const state = open ? 'open' : 'closed';
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <div data-state={state} className="fixed inset-0 z-40 bg-scrim data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out motion-reduce:animate-none" />
        <Dialog.Content
          {...(description ? {} : { 'aria-describedby': undefined })}
          style={{ width, maxWidth: 'calc(100vw - 32px)' }}
          className={cx(
            'fixed left-1/2 top-[70px] z-50 flex max-h-[calc(100vh-100px)] -translate-x-1/2 flex-col rounded-box border border-line bg-surface shadow-modal',
            'data-[state=open]:animate-modal-in data-[state=closed]:animate-modal-out motion-reduce:animate-none focus:outline-none',
          )}
        >
          <header className="flex items-center gap-[10px] border-b border-line px-[18px] py-4">
            {icon && <span className="text-blue"><Icon name={icon} /></span>}
            <Dialog.Title className="m-0 text-16 font-semibold">{title}</Dialog.Title>
            {extra && <span className="ml-2 flex items-center gap-2">{extra}</span>}
            <Dialog.Close className="-mr-1 ml-auto grid h-[26px] w-[26px] place-items-center rounded-ctl text-steel hover:bg-canvas hover:text-ink" aria-label="关闭">
              <Icon name="close" />
            </Dialog.Close>
          </header>
          {description && <Dialog.Description className="m-0 px-[18px] pt-3 text-13 text-steel">{description}</Dialog.Description>}
          <div className="min-h-0 flex-1 overflow-auto">{children}</div>
          {footer && <footer className="flex justify-end gap-2 px-[18px] pb-4 pt-2">{footer}</footer>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
