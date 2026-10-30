import type { ButtonHTMLAttributes } from 'react';
import { Icon, type IconName } from './icons';
import { cx } from './cx';

export type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** md = 30 px 高（样稿），sm = 26 px（抽屉里的「重新审核」）。 */
  size?: 'md' | 'sm';
  icon?: IconName;
  /** 请求进行中：不可点，读屏报「忙」。 */
  busy?: boolean;
}

const VARIANTS: Record<ButtonVariant, string> = {
  default: 'border-line bg-surface text-ink hover:bg-canvas',
  primary: 'border-blue bg-blue text-white hover:brightness-110',
  ghost: 'border-transparent bg-transparent text-steel hover:bg-canvas hover:text-ink',
  danger: 'border-fail bg-surface text-fail hover:bg-fail-50',
};

export function Button({ variant = 'default', size = 'md', icon, busy = false, disabled, type = 'button', className, children, ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx(
        'inline-flex items-center justify-center gap-[6px] whitespace-nowrap rounded-ctl border text-13 font-semibold',
        'disabled:cursor-not-allowed disabled:opacity-55',
        size === 'md' ? 'h-[30px] px-3' : 'h-[26px] px-[10px]',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {icon && <Icon name={icon} size={size === 'md' ? 16 : 14} />}
      {children}
    </button>
  );
}
