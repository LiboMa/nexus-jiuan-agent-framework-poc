import { Button } from '../ui/Button';

/** 「表格」开关：按下去换成表格视图，再按回到图。上下各收 4 px，卡片表头不因它比旁边的高。 */
export function TableToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return <Button size="sm" variant={on ? 'default' : 'ghost'} aria-pressed={on} onClick={onToggle} className="-my-1">表格</Button>;
}
