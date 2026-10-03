/**
 * Form controls.
 *
 *   <HoloInput prefix="$" value={cap} onChange={(e) => setCap(e.target.value)} invalid={bad} />
 *   <HoloSelect value={v} onChange={(e) => setV(e.target.value)} options={[{ value: 'a', label: 'A' }]} />
 *   <HoloToggle checked={on} onChange={setOn} label="Round-ups on" detail="Pausing stops new accrual." />
 *   <HoloSegmented value={roundTo} onChange={setRoundTo} options={[1, 5, 10]} format={(v) => `$${v}`} />
 */
import {
  forwardRef,
  useRef,
  type CSSProperties,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { GlyphArrowDown, GlyphCheck } from './HoloGlyphs';
import { FONT_CHROME, FONT_TEXT, INK } from './tokens';

/* ─────────────────────────────── input ─────────────────────────────── */

export interface HoloInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'prefix'> {
  /** Text / node before the value inside the well (e.g. "$"). */
  prefix?: ReactNode;
  /** Text / node after the value (e.g. "USDG"). */
  suffix?: ReactNode;
  /** Red-pink ring + aria-invalid. */
  invalid?: boolean;
  /** sm 26 · md 32 · lg 40 px. */
  inputSize?: 'sm' | 'md' | 'lg';
  /** Fixed width of the whole field (px or CSS). */
  width?: number | string;
  /** Stretch to the container. */
  block?: boolean;
  /** Style for the outer well. `style` goes to the <input>. */
  fieldStyle?: CSSProperties;
}

export const HoloInput = forwardRef<HTMLInputElement, HoloInputProps>(function HoloInput(
  { prefix, suffix, invalid = false, inputSize = 'md', width, block = false, fieldStyle, className, disabled, ...rest },
  ref,
) {
  const cls = [
    'holo-field',
    inputSize !== 'md' ? `holo-field--${inputSize}` : '',
    block ? 'holo-field--block' : '',
    invalid ? 'holo-field--invalid' : '',
    disabled ? 'holo-field--disabled' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <span className={cls} style={{ width, ...fieldStyle }}>
      {prefix != null && <span className="holo-field__affix">{prefix}</span>}
      <input ref={ref} className={['holo-field__input', className ?? ''].join(' ').trim()} aria-invalid={invalid || undefined} disabled={disabled} {...rest} />
      {suffix != null && <span className="holo-field__affix" style={{ fontWeight: 400 }}>{suffix}</span>}
    </span>
  );
});

/* ─────────────────────────────── select ─────────────────────────────── */

export interface HoloSelectOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

export interface HoloSelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  /** Options (or pass <option> children yourself). */
  options?: HoloSelectOption[];
  invalid?: boolean;
  inputSize?: 'sm' | 'md' | 'lg';
  width?: number | string;
  block?: boolean;
  fieldStyle?: CSSProperties;
}

export const HoloSelect = forwardRef<HTMLSelectElement, HoloSelectProps>(function HoloSelect(
  { options, children, invalid = false, inputSize = 'md', width, block = false, fieldStyle, className, disabled, ...rest },
  ref,
) {
  const cls = [
    'holo-field',
    'holo-field--select',
    inputSize !== 'md' ? `holo-field--${inputSize}` : '',
    block ? 'holo-field--block' : '',
    invalid ? 'holo-field--invalid' : '',
    disabled ? 'holo-field--disabled' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <span className={cls} style={{ width, ...fieldStyle }}>
      <select ref={ref} className={['holo-field__input', className ?? ''].join(' ').trim()} aria-invalid={invalid || undefined} disabled={disabled} {...rest}>
        {options
          ? options.map((o) => (
              <option key={o.value} value={o.value} disabled={o.disabled}>
                {typeof o.label === 'string' || typeof o.label === 'number' ? o.label : o.value}
              </option>
            ))
          : children}
      </select>
      <span className="holo-field__arrow" aria-hidden>
        <GlyphArrowDown />
      </span>
    </span>
  );
});

/* ─────────────────────────────── toggle ─────────────────────────────── */

export interface HoloToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: ReactNode;
  /** One line of consequence under the label. */
  detail?: ReactNode;
  disabled?: boolean;
  style?: CSSProperties;
  id?: string;
}

/** Win98 checkbox with a pixel check; the whole row is the hit target (role="checkbox"). */
export function HoloToggle({ checked, onChange, label, detail, disabled = false, style, id }: HoloToggleProps) {
  return (
    <button
      type="button"
      id={id}
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      className="holo-toggle"
      onClick={() => onChange(!checked)}
      style={style}
    >
      <span className="holo-toggle__box">{checked && <GlyphCheck scale={2} />}</span>
      <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontFamily: FONT_CHROME, fontWeight: 400, fontSize: 18, lineHeight: 1.05, color: INK.body }}>{label}</span>
        {detail && <span style={{ fontFamily: FONT_TEXT, fontSize: 11, lineHeight: 1.5, color: INK.muted }}>{detail}</span>}
      </span>
    </button>
  );
}

/* ────────────────────────────── segmented ────────────────────────────── */

export interface HoloSegmentOption<T> {
  value: T;
  label?: ReactNode;
  /** Tooltip / title. */
  hint?: string;
  disabled?: boolean;
}

export interface HoloSegmentedProps<T extends string | number> {
  value: T | null | undefined;
  /** Receives the chosen option's value (T is inferred from `options` / `value`, so a useState setter fits). */
  onChange: (v: NoInfer<T>) => void;
  /** Plain values or option objects. */
  options: readonly (T | HoloSegmentOption<T>)[];
  /** Label for plain values, e.g. (v) => `$${v}`. */
  format?: (v: NoInfer<T>) => ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** Stretch options to fill the row. */
  block?: boolean;
  disabled?: boolean;
  /** Accessible name for the radio group. */
  ariaLabel?: string;
  style?: CSSProperties;
}

/** The "$1 / $5 / $10" picker: a sunken tray of raised keys; the chosen one is pressed chrome. */
export function HoloSegmented<T extends string | number>({
  value,
  onChange,
  options,
  format,
  size = 'md',
  block = false,
  disabled = false,
  ariaLabel,
  style,
}: HoloSegmentedProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const opts: HoloSegmentOption<T>[] = options.map((o) =>
    typeof o === 'object' && o !== null ? (o as HoloSegmentOption<T>) : { value: o as T },
  );
  const selectedIdx = opts.findIndex((o) => o.value === value);
  const focusIdx = selectedIdx >= 0 ? selectedIdx : 0;

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    for (let step = 1; step <= opts.length; step++) {
      const j = (i + dir * step + opts.length) % opts.length;
      if (!opts[j].disabled) {
        onChange(opts[j].value);
        refs.current[j]?.focus();
        break;
      }
    }
  };

  const cls = ['holo-seg', size !== 'md' ? `holo-seg--${size}` : '', block ? 'holo-seg--block' : ''].filter(Boolean).join(' ');
  return (
    <div role="radiogroup" aria-label={ariaLabel} aria-disabled={disabled || undefined} className={cls} style={style}>
      {opts.map((o, i) => {
        const on = i === selectedIdx;
        return (
          <button
            key={String(o.value)}
            ref={(el) => (refs.current[i] = el)}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={i === focusIdx ? 0 : -1}
            title={o.hint}
            disabled={disabled || o.disabled}
            className="holo-seg__opt"
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {o.label ?? (format ? format(o.value) : String(o.value))}
          </button>
        );
      })}
    </div>
  );
}
