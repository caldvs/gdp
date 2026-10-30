'use client';

/**
 * Glass primitives: the bill photo behind everything, a dark sheet over
 * it, tick rows, one accent. See app/glass.css for the look and the
 * "Group Dine Pay redesign" canvas for the screens these build.
 */
import Link from 'next/link';
import { useBillImageUrl } from '@gdp/core/api/hooks/useBillImageUrl';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

/* ---------- Stage ---------- */

export type BackdropTone = 'dim' | 'soft' | 'deep';

/** The bill photo. Pass a `billId` to fetch its signed URL, or a `src`. */
export function Backdrop({ billId, src, tone = 'soft' }: { billId?: string; src?: string; tone?: BackdropTone }) {
  const q = useBillImageUrl(billId, !!billId && !src);
  const url = src ?? q.data?.url;
  if (!url) return <div className="g-backdrop g-backdrop--none" aria-hidden />;
  return (
    <div className={cx('g-backdrop', `g-backdrop--${tone}`)} aria-hidden>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt="" />
    </div>
  );
}

export function Screen({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('g-screen', className)}>{children}</div>;
}

export function TopBar({ left, right, title }: { left?: ReactNode; right?: ReactNode; title?: ReactNode }) {
  return (
    <div className="g-top">
      <div style={{ minWidth: 44 }}>{left}</div>
      {title ? <div className="g-top__title">{title}</div> : null}
      <div style={{ minWidth: 44, display: 'flex', justifyContent: 'flex-end' }}>{right}</div>
    </div>
  );
}

/** A floating pill button. Icon-only when only `label` is given. */
export function Fab({ href, label, icon, children, onClick, disabled, replace }: {
  href?: string; label: string; icon?: ReactNode; children?: ReactNode; onClick?: () => void; disabled?: boolean; replace?: boolean;
}) {
  const cls = cx('g-fab', !children && 'g-fab--icon');
  const body = <>{icon}{children}</>;
  if (href && !disabled) return <Link href={href} replace={replace} className={cls} aria-label={children ? undefined : label}>{body}</Link>;
  return <button type="button" className={cls} aria-label={children ? undefined : label} onClick={onClick} disabled={disabled}>{body}</button>;
}

/* ---------- Sheet ---------- */

export function Sheet({ size = 'auto', title, sub, head, children, foot, className }: {
  size?: 'auto' | 'mid' | 'tall'; title?: ReactNode; sub?: ReactNode; head?: ReactNode; children?: ReactNode; foot?: ReactNode; className?: string;
}) {
  return (
    <section className={cx('g-sheet', size === 'tall' && 'g-sheet--tall', size === 'mid' && 'g-sheet--mid', className)}>
      <div className="g-sheet__grab" aria-hidden />
      {head ?? (title || sub ? (
        <header className="g-sheet__head">
          {title ? <h1 className="g-sheet__title">{title}</h1> : null}
          {sub ? <p className="g-sheet__sub">{sub}</p> : null}
        </header>
      ) : null)}
      <div className="g-sheet__body">{children}</div>
      {foot ? <div className="g-sheet__foot">{foot}</div> : null}
    </section>
  );
}

export function Hero({ kicker, amount, title, note }: { kicker?: ReactNode; amount?: ReactNode; title?: ReactNode; note?: ReactNode }) {
  return (
    <div className="g-hero">
      {kicker ? <div className="g-hero__kicker">{kicker}</div> : null}
      {amount ? <div className="g-hero__amount">{amount}</div> : null}
      {title ? <div className="g-hero__title">{title}</div> : null}
      {note ? <div className="g-hero__note">{note}</div> : null}
    </div>
  );
}

/* ---------- Lists ---------- */

export function Label({ children }: { children: ReactNode }) {
  return <div className="g-label">{children}</div>;
}

export function List({ children, strong, className }: { children: ReactNode; strong?: boolean; className?: string }) {
  return <div className={cx('g-list', strong && 'g-list--strong', className)}>{children}</div>;
}

export function Check({ on }: { on: boolean }) {
  return (
    <span className={cx('g-check', on && 'g-check--on')} aria-hidden>
      {on ? <Tick size={14} /> : null}
    </span>
  );
}

export function Qty({ children }: { children: ReactNode }) {
  return <span className="g-qty">{children}</span>;
}

/** A row. Becomes a button when `onClick` is set, a link when `href` is. */
export function Row({ children, onClick, href, on, taken, disabled, className, ariaLabel, ariaPressed }: {
  children: ReactNode; onClick?: () => void; href?: string; on?: boolean; taken?: boolean; disabled?: boolean; className?: string; ariaLabel?: string; ariaPressed?: boolean;
}) {
  const cls = cx('g-row', on && 'g-row--on', taken && 'g-row--taken', className);
  if (href) return <Link href={href} className={cls} aria-label={ariaLabel}>{children}</Link>;
  if (onClick) return <button type="button" className={cls} onClick={onClick} disabled={disabled} aria-label={ariaLabel} aria-pressed={ariaPressed}>{children}</button>;
  return <div className={cls}>{children}</div>;
}

export function RowBody({ name, sub }: { name: ReactNode; sub?: ReactNode }) {
  return (
    <div className="g-row__body">
      <div className="g-row__name">{name}</div>
      {sub ? <div className="g-row__sub">{sub}</div> : null}
    </div>
  );
}

export function Price({ children, mute, note }: { children: ReactNode; mute?: boolean; note?: ReactNode }) {
  return (
    <div className={cx('g-row__price', mute && 'g-row__price--mute')}>
      {children}
      {note ? <div style={{ fontSize: 11, fontWeight: 400, color: 'var(--g-mute-2)' }}>{note}</div> : null}
    </div>
  );
}

export function KV({ k, v, total }: { k: ReactNode; v: ReactNode; total?: boolean }) {
  return (
    <div className={cx('g-row', total ? 'g-row--total' : 'g-row--kv')}>
      <span>{k}</span>
      <span>{v}</span>
    </div>
  );
}

export function Tag({ children, tone = 'line' }: { children: ReactNode; tone?: 'line' | 'accent' }) {
  return <span className={cx('g-tag', `g-tag--${tone}`)}>{children}</span>;
}

export function Paid({ children = 'paid' }: { children?: ReactNode }) {
  return <span className="g-paid"><Tick size={12} />{children}</span>;
}

/* ---------- Buttons ---------- */

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  href?: string; replace?: boolean; tone?: 'accent' | 'light' | 'ghost' | 'danger'; size?: 'base' | 'sm'; busy?: boolean;
};
export function Btn({ href, replace, tone = 'accent', size = 'base', busy, className, children, disabled, type, ...rest }: BtnProps) {
  const cls = cx('g-btn', tone !== 'accent' && `g-btn--${tone}`, size === 'sm' && 'g-btn--sm', className);
  if (href && !disabled) return <Link href={href} replace={replace} className={cls}>{children}</Link>;
  return (
    <button type={type ?? 'button'} className={cls} disabled={disabled || busy} {...rest}>
      {busy ? <span className={cx('g-spin', tone === 'accent' && 'g-spin--dark')} aria-hidden /> : children}
    </button>
  );
}

export function MiniBtn({ solid, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { solid?: boolean }) {
  return <button type="button" className={cx('g-mini-btn', solid && 'g-mini-btn--solid', className)} {...rest}>{children}</button>;
}

export function Split({ children }: { children: ReactNode }) {
  return <div className="g-split"><span>{children}</span></div>;
}

export function Notice({ title, children, error }: { title?: ReactNode; children?: ReactNode; error?: boolean }) {
  return (
    <div className={cx('g-notice', error && 'g-notice--error')} role={error ? 'alert' : undefined}>
      {title ? <b>{title}</b> : null}
      {children}
    </div>
  );
}

export function Spin() {
  return <span className="g-spin" aria-hidden />;
}

export function Centre({ children }: { children: ReactNode }) {
  return <div className="g-center">{children}</div>;
}

/* ---------- People ---------- */

const COLORS = ['#3A6EA5', '#2E7D6B', '#5B5BD6', '#B5651D', '#8E4585', '#2F7F9E', '#A0522D', '#4F7942'];
export function colorFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length]!;
}
export function initialsFor(name: string): string {
  const p = name.trim().split(/\s+/).filter(Boolean);
  if (p.length === 0) return '?';
  if (p.length === 1) return p[0]!.slice(0, 2).toUpperCase();
  return (p[0]![0]! + p[p.length - 1]![0]!).toUpperCase();
}
export function firstName(name: string | undefined, fallback = 'the host'): string {
  return name?.trim().split(/\s+/)[0] || fallback;
}

export function Avatar({ name, seed, size = 36, uri, ring }: { name: string; seed?: string; size?: number; uri?: string; ring?: boolean }) {
  const style = { width: size, height: size, fontSize: Math.round(size * 0.36), background: colorFor(seed ?? name), border: ring ? '2px solid #171A1F' : undefined } as const;
  return (
    <span className="g-avatar" style={style} aria-hidden>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {uri ? <img src={uri} alt="" /> : initialsFor(name)}
    </span>
  );
}

export function Faces({ people, spare = 0 }: { people: { name: string; seed?: string }[]; spare?: number }) {
  return (
    <span style={{ display: 'inline-flex' }} aria-hidden>
      {people.map((p, i) => (
        <span key={`${p.seed ?? p.name}-${i}`} style={{ marginLeft: i ? -6 : 0 }}><Avatar name={p.name} seed={p.seed} size={20} ring /></span>
      ))}
      {Array.from({ length: spare }).map((_, i) => (
        <span key={`s${i}`} style={{ marginLeft: -6, width: 20, height: 20, borderRadius: 10, border: '2px dashed rgba(255,255,255,0.4)', background: '#171A1F', boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 10 }}>+</span>
      ))}
    </span>
  );
}

/* ---------- Icons (stroke, inherit colour) ---------- */

const I = ({ d, size = 18, w = 2 }: { d: string; size?: number; w?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
export const Tick = ({ size = 16 }: { size?: number }) => <I d="m5 12 5 5 9-10" size={size} w={3} />;
export const Back = () => <I d="m15 6-6 6 6 6" w={2.2} />;
export const Close = () => <I d="M6 6l12 12M18 6 6 18" w={2.2} />;
export const Plus = ({ size = 18 }: { size?: number }) => <I d="M12 5v14M5 12h14" size={size} w={2.2} />;
export const Chevron = () => <I d="m9 6 6 6-6 6" />;
export const Pencil = () => <I d="M4 20h4l10-10-4-4L4 16z" size={14} />;
export const External = () => <I d="M7 17 17 7M9 7h8v8" size={16} w={2.2} />;
export const ShareIcon = () => <I d="M12 3v12M7 8l5-5 5 5M5 14v5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5" size={22} />;
export const CopyIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M15 9V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h4" /></svg>
);
export const QrIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><path d="M14 14h3v3M21 14v7h-7" /></svg>
);
export const BillsIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" /><path d="M9 8h6M9 12h6" /></svg>
);
export const LibraryIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 16 5-5 4 4 3-3 6 6" /><circle cx="16" cy="9" r="1.5" /></svg>
);
export const CameraIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 8a2 2 0 0 1 2-2h2l1.5-2h5L16 6h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" /><circle cx="12" cy="13" r="3.5" /></svg>
);
export const PersonIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>
);
