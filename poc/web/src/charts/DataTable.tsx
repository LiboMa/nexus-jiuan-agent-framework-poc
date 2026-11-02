import type { ReactNode } from 'react';
import { cx } from '../ui/cx';

/** 图的表格视图（每张图都有一份同样的数，不靠颜色、不靠悬停）。行、列都按序号作键。 */
export interface Column<T> { header: string; cell: (row: T, index: number) => ReactNode; numeric?: boolean }

export function DataTable<T>({ label, columns, rows }: { label: string; columns: Column<T>[]; rows: T[] }) {
  const head = 'whitespace-nowrap border-b border-line px-[10px] py-2 text-12 font-medium text-steel';
  return (
    <div className="overflow-x-auto">
      <table aria-label={label} className="w-full border-collapse text-13">
        <thead>
          <tr>{columns.map((column, index) => <th key={index} scope="col" className={cx(head, column.numeric ? 'text-right' : 'text-left')}>{column.header}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, at) => (
            <tr key={at}>
              {columns.map((column, index) => (
                <td key={index} className={cx('whitespace-nowrap border-b border-line px-[10px] py-[7px]', column.numeric ? 'text-right' : 'text-left')}>{column.cell(row, at)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
