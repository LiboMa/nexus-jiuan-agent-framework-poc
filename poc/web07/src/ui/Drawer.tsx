import * as Dialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';
import { Icon } from './icons';
import { cx } from './cx';

/**
 * 右侧抽屉（样稿 drawer-a.html：宽 430、左分隔线、向左的阴影）：单据详情。头部标题 16 px + 副标题，正文可滚，底部可放复核区。
 * 不用 Radix 的 Dialog.Overlay（它经 react-remove-scroll 插 <style>）；样稿里抽屉本来也没有蒙层。
 * modal={false} + closeOnOutside={false}：抽屉开着时后面的页面照样能点（单据池点另一行就换单），只有关闭按钮和 Esc 关它。
 */
export function Drawer({ open, onOpenChange, title, subtitle, headerExtra, footer, children, width = 430, modal = true, closeOnOutside = true, onCloseAutoFocus }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: ReactNode; subtitle?: ReactNode; headerExtra?: ReactNode;
  footer?: ReactNode; children?: ReactNode; width?: number; modal?: boolean; closeOnOutside?: boolean; onCloseAutoFocus?: (event: Event) => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange} modal={modal}>
      <Dialog.Portal>
        <Dialog.Content
          aria-describedby={undefined}
          onInteractOutside={closeOnOutside ? undefined : event => event.preventDefault()}
          onCloseAutoFocus={onCloseAutoFocus}
          style={{ width, maxWidth: '100vw' }}
          className={cx(
            'fixed inset-y-0 right-0 z-30 flex flex-col border-l border-line bg-surface shadow-drawer',
            'data-[state=open]:animate-drawer-in data-[state=closed]:animate-drawer-out motion-reduce:animate-none focus:outline-none',
          )}
        >
          <header className="px-[18px] pt-4">
            <div className="flex items-center gap-2">
              {/* 单号不让位：头部挤的时候先截后面的公司 · 事项 */}
              <Dialog.Title className="m-0 max-w-[60%] shrink-0 truncate text-16 font-semibold">{title}</Dialog.Title>
              {headerExtra}
              <Dialog.Close className="-mr-1 ml-auto grid h-[26px] w-[26px] shrink-0 place-items-center rounded-ctl text-steel hover:bg-canvas hover:text-ink" aria-label="关闭">
                <Icon name="close" />
              </Dialog.Close>
            </div>
            {subtitle && <div className="mt-[2px] text-13 text-steel">{subtitle}</div>}
          </header>
          <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-auto">{children}</div>
          {footer && <footer className="border-t border-line bg-sunken px-[18px] py-[14px]">{footer}</footer>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
