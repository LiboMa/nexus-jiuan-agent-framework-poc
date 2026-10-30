import type { ReactNode } from 'react';
import { Icon, type IconName } from './icons';

/** 空状态：说清发生了什么（title）、怎么办（description / action）。 */
export function Empty({ icon = 'file', title, description, action }: { icon?: IconName; title: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <span className="grid h-10 w-10 place-items-center bg-blue-50 text-blue"><Icon name={icon} size={20} /></span>
      <p className="m-0 mt-1 text-14 font-semibold text-ink">{title}</p>
      {description && <p className="m-0 max-w-[420px] text-13 text-steel">{description}</p>}
      {action && <div className="mt-2 flex gap-2">{action}</div>}
    </div>
  );
}
