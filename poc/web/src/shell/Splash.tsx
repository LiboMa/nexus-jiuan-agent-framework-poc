import type { ReactNode } from 'react';
import { LogoMark } from '../ui/Logo';

/** 整页的等待 / 出错画面：不白屏，说清在做什么或发生了什么。 */
export function Splash({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="grid h-screen place-items-center bg-canvas px-6">
      <div className="flex max-w-[420px] flex-col items-center gap-3 text-center" aria-live="polite">
        <LogoMark size={36} />
        <div className="text-13 text-steel">{children}</div>
        {action}
      </div>
    </div>
  );
}
