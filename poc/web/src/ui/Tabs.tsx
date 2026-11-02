import * as RadixTabs from '@radix-ui/react-tabs';
import type { ReactNode } from 'react';
import { cx } from './cx';

export interface TabItem { value: string; label: ReactNode; count?: number; content: ReactNode }

/** 页签（样稿抽屉 .dt、弹框 .tabs）：间距 18 px，选中项正文色加 2 px 主蓝下划线。Radix Tabs 只用 style 属性，不插 <style>。 */
export function Tabs({ items, value, defaultValue, onValueChange, label, className, listClassName }: {
  items: TabItem[]; value?: string; defaultValue?: string; onValueChange?: (value: string) => void;
  label?: string; className?: string; listClassName?: string;
}) {
  return (
    <RadixTabs.Root value={value} defaultValue={defaultValue ?? items[0]?.value} onValueChange={onValueChange} className={cx('flex min-h-0 flex-col', className)}>
      <RadixTabs.List aria-label={label} className={cx('flex gap-[18px] border-b border-line px-[18px]', listClassName)}>
        {items.map(item => (
          <RadixTabs.Trigger
            key={item.value}
            value={item.value}
            className={cx(
              'py-[9px] text-13 text-steel hover:text-ink',
              'data-[state=active]:font-semibold data-[state=active]:text-ink data-[state=active]:shadow-[inset_0_-2px_0_var(--color-blue)]',
            )}
          >
            {item.label}{item.count !== undefined && <> {item.count}</>}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      {items.map(item => (
        <RadixTabs.Content key={item.value} value={item.value} className="min-h-0 flex-1 focus-visible:outline-offset-[-2px]">
          {item.content}
        </RadixTabs.Content>
      ))}
    </RadixTabs.Root>
  );
}
