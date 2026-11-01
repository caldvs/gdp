'use client';

/**
 * Option D building blocks: plain mobile-web pieces styled by app/globals.css.
 * Pages compose these; nothing here knows about bills or sessions.
 */
import Link from 'next/link';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

/* ---------- Page ---------- */

export function Page({ children, sub }: { children: ReactNode; sub?: boolean }) {
  return <main className={cx('page', sub && 'page--sub')}>{children}</main>;
}

export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="back">
      <ChevronLeft />
      {children}
    </Link>
  );
}

export function Title({ title, sub, aside }: { title: ReactNode; sub?: ReactNode; aside?: ReactNode }) {
  const body = (
    <div className="title">
      <h1>{title}</h1>
      {sub ? <p>{sub}</p> : null}
    </div>
  );
  return aside ? <div className="title-row">{body}{aside}</div> : body;
}

export function Section({ title, children }: { title?: ReactNode; children: ReactNode }) {
  return (
    <section className="section">
      {title ? <h2 className="section__h">{title}</h2> : null}
      {children}
    </section>
  );
}

export function Box({ children }: { children: ReactNode }) {
  return <div className="box">{children}</div>;
}

/* ---------- Rows ---------- */

type RowProps = {
  title: ReactNode;
  sub?: ReactNode;
  end?: ReactNode;
  strong?: boolean;
  tall?: boolean;
  card?: boolean;
  muted?: boolean;
  chevron?: boolean;
  lead?: ReactNode;
};

function RowInner({ title, sub, end, strong, chevron, lead }: RowProps) {
  return (
    <>
      {lead}
      <span className="row__main">
        <span className={cx('row__title', strong && 'row__title--strong')}>{title}</span>
        {sub ? <span className="row__sub">{sub}</span> : null}
      </span>
      {end !== undefined && end !== null ? <span className="row__end">{end}</span> : null}
      {chevron ? <ChevronRight /> : null}
    </>
  );
}

const rowClass = (p: RowProps) => cx('row', p.tall && 'row--tall', p.card && 'row--card', p.muted && 'row--muted');

export function Row(p: RowProps) {
  return <div className={rowClass(p)}><RowInner {...p} /></div>;
}

export function RowLink({ href, ...p }: RowProps & { href: string }) {
  return <Link href={href} className={rowClass(p)}><RowInner chevron {...p} /></Link>;
}

export function RowButton({ onClick, label, disabled, ...p }: RowProps & { onClick: () => void; label?: string; disabled?: boolean }) {
  return (
    <button type="button" className={rowClass(p)} onClick={onClick} aria-label={label} disabled={disabled}>
      <RowInner {...p} />
    </button>
  );
}

export function Badge({ children, tone = 'plain' }: { children: ReactNode; tone?: 'ok' | 'warn' | 'plain' }) {
  return <span className={cx('badge', `badge--${tone}`)}>{children}</span>;
}

export function Totals({ children }: { children: ReactNode }) {
  return <div className="totals">{children}</div>;
}
export function TotalLine({ k, v, tone }: { k: ReactNode; v: ReactNode; tone?: 'mute' | 'total' }) {
  return <div className={cx('totals__line', tone && `totals__line--${tone}`)}><span>{k}</span><span>{v}</span></div>;
}

export function Stats({ items }: { items: { k: string; v: string; warn?: boolean }[] }) {
  return (
    <div className="stats">
      {items.map((s) => (
        <div key={s.k} className="stat">
          <div className="stat__k">{s.k}</div>
          <div className={cx('stat__v', s.warn && 'stat__v--warn')}>{s.v}</div>
        </div>
      ))}
    </div>
  );
}

/* ---------- Buttons ---------- */

type Tone = 'primary' | 'secondary' | 'danger' | 'text';
type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { href?: string; replace?: boolean; tone?: Tone; small?: boolean; busy?: boolean; grow?: boolean };

export function Button({ href, replace, tone = 'primary', small, busy, grow, className, children, disabled, type, ...rest }: BtnProps) {
  const cls = cx('btn', `btn--${tone}`, small && 'btn--sm', grow && 'grow', className);
  if (href && !disabled) return <Link href={href} replace={replace} className={cls}>{children}</Link>;
  return (
    <button type={type ?? 'button'} className={cls} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {busy ? <span className={cx('spin', tone === 'primary' && 'spin--light')} aria-hidden /> : children}
    </button>
  );
}

/** Fixed bottom bar for a screen's main action(s), within thumb reach. */
export function ActionBar({ children, stack }: { children: ReactNode; stack?: boolean }) {
  return (
    <div className="actionbar">
      <div className={cx('actionbar__in', stack && 'actionbar__in--stack')}>{children}</div>
    </div>
  );
}

/* ---------- People ---------- */

const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('') || '?';

export function Avatar({ name, you }: { name: string; you?: boolean }) {
  return <span className={cx('avatar', you && 'avatar--you')} aria-hidden>{initials(name)}</span>;
}

/** Who's at the table: an initial and first name each, in the order they joined. */
export function Diners({ people, hostId, meId }: { people: { userId: string; displayName?: string }[]; hostId: string; meId?: string }) {
  return (
    <ul className="diners" aria-label="At the table">
      {people.map((p) => {
        const name = p.userId === meId ? 'You' : firstName(p.displayName, 'Guest');
        return (
          <li key={p.userId} className="diner">
            <Avatar name={p.displayName || name} you={p.userId === meId} />
            <span>{name}{p.userId === hostId ? <span className="muted"> · host</span> : null}</span>
          </li>
        );
      })}
    </ul>
  );
}

/* ---------- Dialog ---------- */

/** A modal panel: bottom sheet on phones, centred box on wider screens. */
export function Dialog({ title, children, actions, onClose, id = 'dialog-t' }: { title: ReactNode; children?: ReactNode; actions: ReactNode; onClose: () => void; id?: string }) {
  return (
    <>
      <div className="dialog-overlay" onClick={onClose} aria-hidden />
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={id} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
        <h2 id={id} className="dialog__t">{title}</h2>
        {children}
        <div className="dialog__actions">{actions}</div>
      </div>
    </>
  );
}

/* ---------- Feedback ---------- */

export function Notice({ title, children, tone = 'info' }: { title?: ReactNode; children?: ReactNode; tone?: 'info' | 'ok' | 'error' }) {
  return (
    <div className={cx('notice', `notice--${tone}`)} role={tone === 'error' ? 'alert' : tone === 'ok' ? 'status' : undefined}>
      {tone === 'ok' ? <TickIcon /> : null}
      <div>
        {title ? <b>{title}</b> : null}
        {children}
      </div>
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <span className="spin" role="status" aria-label={label} />;
}

const SKELETON_WIDTHS = [55, 40, 62, 46, 70, 50];

/** Grey rows in the shape of a bill, shown while one is being read or loaded. */
export function BillSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="box" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="row skel-row">
          <span className="skel" style={{ width: 20 }} />
          <span className="skel" style={{ width: `${SKELETON_WIDTHS[i % SKELETON_WIDTHS.length]}%` }} />
          <span className="skel skel--end" style={{ width: 52 }} />
        </div>
      ))}
      <div className="row skel-row">
        <span className="skel skel--lg" style={{ width: 60 }} />
        <span className="skel skel--lg skel--end" style={{ width: 70 }} />
      </div>
    </div>
  );
}

export type StepState = 'todo' | 'busy' | 'done';

/** A short list of stages, each waiting, in progress or done. */
export function Steps({ steps }: { steps: { label: string; state: StepState }[] }) {
  return (
    <div className="steps" role="status" aria-live="polite">
      {steps.map((s) => (
        <div key={s.label} className={cx('row', 'step', `step--${s.state}`)}>
          <span className="step__icon" aria-hidden="true">
            {s.state === 'done' ? (
              <svg className="step__tick" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5 9-10" /></svg>
            ) : s.state === 'busy' ? (
              <span className="spin spin--sm" />
            ) : (
              <span className="step__dot" />
            )}
          </span>
          {s.label}
        </div>
      ))}
    </div>
  );
}

export function Centre({ children }: { children: ReactNode }) {
  return <div className="centre">{children}</div>;
}

/* ---------- Icons (stroke, inherit colour) ---------- */

const I = ({ d, size = 20, w = 2 }: { d: string; size?: number; w?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
export const ChevronLeft = () => <I d="m15 6-6 6 6 6" w={2.2} />;
export const ChevronRight = () => <span className="chev"><I d="m9 6 6 6-6 6" /></span>;
export const MenuIcon = () => <I d="M4 7h16M4 12h16M4 17h16" size={28} />;
export const CloseIcon = () => <I d="M6 6l12 12M18 6 6 18" size={28} />;
export const PlusIcon = () => <I d="M12 5v14M5 12h14" size={18} w={2.2} />;
export const TickIcon = ({ size = 22 }: { size?: number }) => <I d="m5 12 5 5 9-10" size={size} w={2.5} />;
export const CopyIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>
);
export const PhotoIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 3h9l4 4v14H6z" /><path d="M9 10h7M9 14h7M9 18h4" /></svg>
);
export const MailIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></svg>
);
export const ShareIcon = () => <I d="M12 3v12M7 8l5-5 5 5M5 14v5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5" />;
export const QrIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><path d="M14 14h3v3M21 14v7h-7" /></svg>
);

/* ---------- Helpers ---------- */

export function firstName(name: string | undefined, fallback = 'the host'): string {
  return name?.trim().split(/\s+/)[0] || fallback;
}

export function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return 'Today';
  const y = new Date(today); y.setDate(today.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
