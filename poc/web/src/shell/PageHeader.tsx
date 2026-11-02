import type { ReactNode } from 'react';

/** 页面标题（22 px / 650）+ 旁注 + 右侧操作（样稿：「工作台 10 月 30 日 · 周四 … 今天 / 近 14 天 / 本月 · 上传制度」）。 */
export function PageHeader({ title, note, actions }: { title: ReactNode; note?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <h1 className="m-0 text-22 font-title">{title}</h1>
      {note && <span className="text-13 text-steel">{note}</span>}
      {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
    </div>
  );
}
