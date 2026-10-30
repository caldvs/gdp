// Calm / "bistro" primitives — DOM ports of gdp-mobile's
// src/components/bistro. Same names and props where it made sense, so
// screens read the same as their React Native originals.
import Link from 'next/link';
import { Children, forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import { Avatar } from '../Avatar';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

/* ---------- Typography ---------- */
export function DisplayText({ size = 'lg', className, children, as: Tag = 'h1', style }: {
  size?: 'sm' | 'md' | 'lg'; className?: string; children: ReactNode; as?: 'h1' | 'h2' | 'h3' | 'p' | 'div'; style?: React.CSSProperties;
}) {
  return <Tag className={cx('gdp-display', `gdp-display--${size}`, className)} style={style}>{children}</Tag>;
}

export function Mini({ children, className, style }: { children: ReactNode; className?: string; style?: React.CSSProperties }) {
  return <p className={cx('gdp-mini', className)} style={style}>{children}</p>;
}

export function BodyText({ children, className, strong, style }: { children: ReactNode; className?: string; strong?: boolean; style?: React.CSSProperties }) {
  return <p className={cx('gdp-body', strong && 'gdp-body--strong', className)} style={style}>{children}</p>;
}

/* ---------- Buttons ---------- */
type ButtonVariant = 'accent' | 'ghost' | 'quiet';
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant; size?: 'base' | 'lg'; href?: string; replace?: boolean;
};
export function Button({ variant = 'accent', size = 'base', className, href, replace, children, type, ...rest }: ButtonProps) {
  const cls = cx('btn', variant !== 'accent' && `btn--${variant}`, size === 'lg' && 'btn--lg', className);
  if (href && !rest.disabled) {
    return <Link href={href} replace={replace} className={cls}>{children}</Link>;
  }
  return <button type={type ?? 'button'} className={cls} {...rest}>{children}</button>;
}

export function LinkButton({ children, tone = 'accent', align = 'start', className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: 'accent' | 'mute'; align?: 'start' | 'center';
}) {
  return (
    <button type="button" className={cx('link-btn', tone === 'mute' && 'link-btn--mute', align === 'center' && 'link-btn--center', className)} {...rest}>
      {children}
    </button>
  );
}

export function Spinner({ label }: { label?: string }) {
  return <span className="spinner" role="status" aria-label={label ?? 'Loading'} />;
}

export function CenterSpinner() {
  return <div className="center"><Spinner /></div>;
}

/* ---------- Receipt card ---------- */
export function Receipt({ children, caption, noDividers, list, inset, className, style }: {
  children: ReactNode; caption?: string; noDividers?: boolean; list?: boolean; inset?: boolean; className?: string; style?: React.CSSProperties;
}) {
  const rows = Children.toArray(children).filter(Boolean);
  return (
    <div className={cx('receipt', list && 'receipt--list', inset && 'receipt--inset', noDividers && 'receipt--nodiv', className)} style={style}>
      {caption ? <Mini className="receipt__caption">{caption}</Mini> : null}
      {rows}
    </div>
  );
}

export function ReceiptItem({ name, sub, price, right }: { name: string; sub?: string; price?: string; right?: ReactNode }) {
  return (
    <div className="ritem">
      <div style={{ minWidth: 0 }}>
        <div className="ritem__name">{name}</div>
        {sub ? <div className="ritem__sub">{sub}</div> : null}
      </div>
      {right ?? <span className="ritem__price">{price ?? ''}</span>}
    </div>
  );
}

export function Rule({ style }: { style?: React.CSSProperties }) {
  return <hr className="rule" style={style} />;
}

/* ---------- Totals ---------- */
export function TotalsRow({ label, value, emphasis = 'default', valueColor }: {
  label: string; value: string; emphasis?: 'default' | 'strong'; valueColor?: string;
}) {
  return (
    <div className={cx('totals-row', emphasis === 'strong' && 'totals-row--strong')}>
      <Mini>{label}</Mini>
      <span className="totals-row__v" style={valueColor ? { color: valueColor } : undefined}>{value}</span>
    </div>
  );
}

const fmtSigned = (pence: number) => `${pence < 0 ? '−' : ''}£${(Math.abs(pence) / 100).toFixed(2)}`;

export function BillTotals({ subtotalPence, servicePence, taxPence, totalPence, totalLabel = 'TOTAL' }: {
  subtotalPence: number; servicePence?: number; taxPence?: number; totalPence: number; totalLabel?: string;
}) {
  return (
    <div className="totals">
      <TotalsRow label="subtotal" value={fmtSigned(subtotalPence)} />
      {servicePence && servicePence > 0 ? <TotalsRow label="service" value={fmtSigned(servicePence)} /> : null}
      {taxPence && taxPence > 0 ? <TotalsRow label="tax" value={fmtSigned(taxPence)} /> : null}
      <div className="mt-xs"><TotalsRow label={totalLabel} value={fmtSigned(totalPence)} emphasis="strong" /></div>
    </div>
  );
}

/* ---------- Chips ---------- */
export type ChipVariant = 'default' | 'live' | 'ok' | 'accent';
export function Chip({ children, variant = 'default' }: { children: string; variant?: ChipVariant }) {
  return <span className={cx('gdp-chip', (variant === 'ok' || variant === 'accent') && 'gdp-chip--ok', variant === 'live' && 'gdp-chip--live')}>{children}</span>;
}

export type SessionStatus = 'setup' | 'claiming' | 'paying' | 'settled' | 'abandoned';
export function SessionChip({ status }: { status: SessionStatus }) {
  switch (status) {
    case 'claiming': return <Chip variant="live">claiming</Chip>;
    case 'paying': return <Chip variant="live">paying</Chip>;
    case 'settled': return <Chip variant="ok">settled</Chip>;
    case 'abandoned': return <Chip>ended</Chip>;
    default: return <Chip>setup</Chip>;
  }
}

/* ---------- Hero amount ---------- */
export function HeroAmount({ caption, amount, note, aside, size = 72 }: {
  caption?: string; amount: string; note?: ReactNode; aside?: ReactNode; size?: number;
}) {
  const noteContent = note ?? aside;
  const dot = amount.lastIndexOf('.');
  const highlight = dot < 0 ? amount : amount.slice(0, dot);
  const rest = dot < 0 ? '' : amount.slice(dot);
  return (
    <div className="gdp-amount" style={{ margin: '8px 0 22px' }}>
      {caption ? <Mini>{caption}</Mini> : null}
      <div className="gdp-amount__num" style={{ fontSize: `clamp(48px, 17vw, ${size}px)` }}>
        <em>{highlight}</em>{rest}
      </div>
      {noteContent ? (typeof noteContent === 'string' ? <div className="gdp-amount__note">{noteContent}</div> : noteContent) : null}
    </div>
  );
}

/* ---------- Notice ---------- */
export function Notice({ title, detail, children, neutral, className }: {
  title?: string; detail?: ReactNode; children?: ReactNode; neutral?: boolean; className?: string;
}) {
  return (
    <div className={cx('gdp-notice', neutral && 'gdp-notice--neutral', className)} role={neutral ? undefined : 'alert'}>
      {title ? <b>{title}</b> : null}
      {title && detail ? <br /> : null}
      {detail}
      {children}
    </div>
  );
}

/* ---------- Section ---------- */
const GAP = { xs: 4, sm: 8, md: 12, base: 16, lg: 22, xl: 32, xxl: 48 } as const;
export function Section({ label, children, gap = 'sm', className }: { label?: string; children: ReactNode; gap?: keyof typeof GAP; className?: string }) {
  return (
    <section className={cx('stack gap-xs', className)}>
      {label ? <Mini>{label}</Mini> : null}
      <div className="stack" style={{ gap: GAP[gap] }}>{children}</div>
    </section>
  );
}

/* ---------- Text field ---------- */
export type TextFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'prefix'> & {
  label?: string; error?: string | null; variant?: 'default' | 'mono' | 'compact'; prefix?: ReactNode; containerClassName?: string;
};
export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, error, variant = 'default', prefix, containerClassName, id, ...input }, ref,
) {
  const inputId = id ?? (label ? `f-${label.replace(/\W+/g, '-')}` : undefined);
  return (
    <div className={cx('field', variant !== 'default' && `field--${variant}`, error && 'field--error', containerClassName)}>
      {label ? <label htmlFor={inputId} className="gdp-mini">{label}</label> : null}
      <div className="field__box">
        {prefix ? <span className="field__prefix">{prefix}</span> : null}
        <input ref={ref} id={inputId} className="field__input" aria-invalid={!!error} {...input} />
      </div>
      {error ? <Notice title="Check that." detail={error} /> : null}
    </div>
  );
});

/* ---------- Claim row ---------- */
export type ClaimState = 'default' | 'mine' | 'joinable' | 'taken';
export function Claim({ name, meta, subContent, price, state = 'default', onPress, right }: {
  name: string; meta?: string; subContent?: ReactNode; price: string; state?: ClaimState; onPress?: () => void; right?: ReactNode;
}) {
  const body = (
    <>
      <div className="claim__body">
        <div className="claim__name">
          {name}
          {state === 'mine' && !meta && !subContent ? <span className="claim__yours">yours</span> : null}
        </div>
        {subContent ? subContent : meta ? <div className={cx('claim__meta', state === 'joinable' && 'claim__meta--accent')}>{meta}</div> : null}
      </div>
      {right ?? <span className="num claim__price">{price}</span>}
    </>
  );
  const cls = cx('claim', `claim--${state}`, onPress && 'claim--clickable');
  // The row itself is clickable for mine/joinable (toggle), but it also
  // contains its own icon buttons, so it's a div with a keyboard handler
  // rather than a <button> (buttons can't nest).
  return onPress ? (
    <div
      className={cls}
      role="button"
      tabIndex={0}
      onClick={(e) => { if ((e.target as HTMLElement).closest('.claim__ctl')) return; onPress(); }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPress(); } }}
    >
      {body}
    </div>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export type ClaimSharer = { userId: string; displayName: string; avatarUrl?: string };
export function SharerStack({ sharers }: { sharers: ClaimSharer[] }) {
  const visible = sharers.slice(0, 3);
  const extra = sharers.length - visible.length;
  return (
    <span className="sharers">
      {visible.map((s) => (
        <span key={s.userId}><Avatar uri={s.avatarUrl} displayName={s.displayName} seed={s.userId} size={22} /></span>
      ))}
      {extra > 0 ? <span className="sharers__more">+{extra}</span> : null}
    </span>
  );
}
