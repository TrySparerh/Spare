/**
 * HoloButton — Win98 push button in pastel: white highlight, lilac shadow, 1px
 * indigo hard edge, pressed state on :active. Primary gets the holographic
 * chrome face, a 1px indigo outline (the Win98 "default button" ring) and a
 * sparkle in the corner.
 *
 *   <HoloButton variant="primary" onClick={save}>Save rule</HoloButton>
 *   <HoloButton size="sm" active={x === 5} onClick={() => setX(5)}>$5</HoloButton>
 */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

export interface HoloButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  children: ReactNode;
  /** primary (chrome, the one action) · secondary (default) · danger (destructive) · ghost (text-only). */
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  /** sm 24px · md 30px · lg 40px (taller on mobile for touch). */
  size?: 'sm' | 'md' | 'lg';
  /** Latched / toggled-on (pressed bevel). Sets aria-pressed. */
  active?: boolean;
  /** Full width. */
  block?: boolean;
  /** Leading icon / glyph. */
  icon?: ReactNode;
}

export const HoloButton = forwardRef<HTMLButtonElement, HoloButtonProps>(function HoloButton(
  { children, variant = 'secondary', size = 'md', active, block = false, icon, className, type = 'button', ...rest },
  ref,
) {
  const cls = [
    'holo-btn',
    variant !== 'secondary' ? `holo-btn--${variant}` : '',
    size !== 'md' ? `holo-btn--${size}` : '',
    active ? 'is-active' : '',
    block ? 'holo-btn--block' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button ref={ref} type={type} className={cls} aria-pressed={active === undefined ? undefined : active} {...rest}>
      {icon && (
        <span aria-hidden style={{ display: 'inline-flex', flexShrink: 0 }}>
          {icon}
        </span>
      )}
      {children}
    </button>
  );
});

export default HoloButton;
