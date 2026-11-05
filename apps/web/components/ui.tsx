'use client';

/**
 * Option D building blocks: plain mobile-web pieces styled by app/globals.css.
 * Pages compose these; nothing here knows about bills or sessions.
 */
import Link from 'next/link';
import { Children, ViewTransition, isValidElement, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode, type RefObject } from 'react';
import { Morph } from './PageTransition';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

/* ---------- Page ---------- */

/** The page column. `<main>` is one level up (PageTransition), so the
 * ActionBar after the page is inside it too. */
export function Page({ children, sub }: { children: ReactNode; sub?: boolean }) {
  return <div className={cx('page', sub && 'page--sub')}>{children}</div>;
}

export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="back">
      <ChevronLeft />
      {children}
    </Link>
  );
}

/** BackLink for going back within a page (no URL change). */
export function BackButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="back back--btn" onClick={onClick}>
      <ChevronLeft />
      {children}
    </button>
  );
}

/** `vt` names the heading so same-named text on the last page glides into it. */
export function Title({ title, sub, aside, vt }: { title: ReactNode; sub?: ReactNode; aside?: ReactNode; vt?: string }) {
  const body = (
    <div className="title">
      <h1><Morph name={vt}>{title}</Morph></h1>
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

/** A card of rows. `list` makes it a `<ul>` with each child in an `<li>`, for
 * rows that are a list (items, people, bills); a heading names it for
 * screen readers when the screen has none. */
export function Box({ children, list, label }: { children: ReactNode; list?: boolean; label?: string }) {
  if (!list) return <div className="box">{children}</div>;
  return (
    <ul className="box box--list" aria-label={label}>
      {Children.toArray(children).map((c, i) => <li key={isValidElement(c) && c.key != null ? c.key : i}>{c}</li>)}
    </ul>
  );
}

/** A list of cards with the gap between them (open bills). */
export function CardList({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <ul className="card-list" aria-label={label}>
      {Children.toArray(children).map((c, i) => <li key={isValidElement(c) && c.key != null ? c.key : i}>{c}</li>)}
    </ul>
  );
}

/* ---------- Tabs ---------- */

/** Two or three tabs over one panel. Arrow keys move between them. */
export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: { id: T; label: string }[]; value: T; onChange: (id: T) => void; label: string }) {
  const move = (dir: number) => {
    const i = tabs.findIndex((t) => t.id === value);
    const next = tabs[(i + dir + tabs.length) % tabs.length]!;
    onChange(next.id);
    if (typeof document !== 'undefined') document.getElementById(`tab-${next.id}`)?.focus();
  };
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          id={`tab-${t.id}`}
          aria-selected={t.id === value}
          aria-controls={t.id === value ? `panel-${t.id}` : undefined}
          tabIndex={t.id === value ? 0 : -1}
          className={cx('tab', t.id === value && 'tab--on')}
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => { if (e.key === 'ArrowRight') move(1); if (e.key === 'ArrowLeft') move(-1); }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** The panel for the selected tab; it fades in each time the tab changes. */
export function TabPanel({ id, children }: { id: string; children: ReactNode }) {
  return <div key={id} role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} className="tabpanel">{children}</div>;
}

/** Pulses its child once whenever `value` changes (not on first show). */
export function Pulse({ value, children }: { value: string | number; children: ReactNode }) {
  const [first] = useState(value);
  return <span key={String(value)} className={cx('pulse-wrap', value !== first && 'pulse')}>{children}</span>;
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
  /** Shared transition name for the title (see Title). */
  vt?: string;
};

function RowInner({ title, sub, end, strong, chevron, lead, vt }: RowProps) {
  return (
    <>
      {lead}
      <span className="row__main">
        <span className={cx('row__title', strong && 'row__title--strong')}><Morph name={vt}>{title}</Morph></span>
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

/** `action` ("Edit") is read out before the visible text, so the name still contains what's on screen. */
export function RowButton({ onClick, label, action, disabled, ...p }: RowProps & { onClick: () => void; label?: string; action?: string; disabled?: boolean }) {
  return (
    <button type="button" className={rowClass(p)} onClick={onClick} aria-label={label} disabled={disabled}>
      {action ? <span className="vh">{action} </span> : null}
      <RowInner {...p} />
    </button>
  );
}

export function Badge({ children, tone = 'plain' }: { children: ReactNode; tone?: 'ok' | 'warn' | 'plain' }) {
  return <span className={cx('badge', `badge--${tone}`)}>{children}</span>;
}

/** Label–value lines (Subtotal £104.00): a `<dl>`, one `<div>` per pair. */
export function Totals({ children, label }: { children: ReactNode; label?: string }) {
  return <dl className="totals" aria-label={label}>{children}</dl>;
}
export function TotalLine({ k, v, tone }: { k: ReactNode; v: ReactNode; tone?: 'mute' | 'total' }) {
  return <div className={cx('totals__line', tone && `totals__line--${tone}`)}><dt>{k}</dt><dd>{v}</dd></div>;
}
/** An editor in place of a TotalLine: `label` names the pair for screen readers. */
export function TotalEdit({ label, children }: { label: string; children: ReactNode }) {
  return <div className="totals__edit"><dt className="vh">{label}</dt><dd>{children}</dd></div>;
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

export function Button({ href, replace, tone = 'primary', small, busy, grow, className, children, disabled, type, onClick, ...rest }: BtnProps) {
  const cls = cx('btn', `btn--${tone}`, small && 'btn--sm', grow && 'grow', className);
  if (href && !disabled) return <Link href={href} replace={replace} className={cls}>{children}</Link>;
  // Busy isn't `disabled`: a disabled button drops focus to <body>, so the
  // keyboard user is lost while it saves. It's aria-disabled and ignores
  // clicks (and Enter submitting its form) instead.
  const waiting = busy && !disabled;
  return (
    <button
      type={type ?? 'button'}
      className={cls}
      disabled={disabled}
      aria-disabled={waiting || undefined}
      aria-busy={busy || undefined}
      onClick={waiting ? (e) => e.preventDefault() : onClick}
      {...rest}
    >
      {/* #196: the spinner replaces the label on screen but not its name. */}
      {busy ? <><span className={cx('spin', tone === 'primary' && 'spin--light')} aria-hidden /><span className="vh">{children}</span></> : children}
    </button>
  );
}

/** Fixed bottom bar for a screen's main action(s), within thumb reach.
 * Named so it stays put between pages while its buttons cross-fade. */
export function ActionBar({ children, stack, note }: { children: ReactNode; stack?: boolean; note?: ReactNode }) {
  return (
    <ViewTransition name="actionbar" share="bar" enter="bar" exit="bar" default="none">
      <div className="actionbar">
        <div className={cx('actionbar__in', stack && 'actionbar__in--stack')}>{children}</div>
        {note ? <p className="actionbar__note">{note}</p> : null}
      </div>
    </ViewTransition>
  );
}

/* ---------- People ---------- */

const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('') || '?';

export function Avatar({ name, you, sm }: { name: string; you?: boolean; sm?: boolean }) {
  return <span className={cx('avatar', you && 'avatar--you', sm && 'avatar--sm')} aria-hidden>{initials(name)}</span>;
}

/**
 * Who has an item, as initials instead of names — reads faster, and scales
 * to several claimants without crowding the row. The names themselves stay
 * for screen readers (visually hidden): avatars alone aren't accessible.
 */
export function AvatarStack({ names, max = 4 }: { names: string[]; max?: number }) {
  if (names.length === 0) return null;
  const shown = names.slice(0, max);
  const extra = names.length - shown.length;
  return (
    <span className="avatar-stack">
      <span className="vh">{names.join(', ')}</span>
      {shown.map((n, i) => <Avatar key={i} name={n} sm you={n === 'you' || n === 'You'} />)}
      {extra > 0 ? <span className="avatar avatar--sm avatar--more" aria-hidden>+{extra}</span> : null}
    </span>
  );
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

/** A modal panel: bottom sheet on phones, centred box on wider screens.
 * It rises in on mount; it drops away if the caller closes it inside
 * startTransition. A native `<dialog>` (useModal): focus moves in, Tab stays
 * in, Escape and a tap outside close it, and focus goes back after.
 * `describedBy`: the id of the element in `children` that says what the dialog is asking. */
export function Dialog({ title, children, actions, onClose, id = 'dialog-t', describedBy }: { title: ReactNode; children?: ReactNode; actions: ReactNode; onClose: () => void; id?: string; describedBy?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useModal(ref, onClose);
  return (
    <>
      {/* The dim behind the sheet, kept as its own element so it can fade out
          on close. Taps outside land on the dialog's ::backdrop (useModal). */}
      <ViewTransition exit="scrim-out" default="none">
        <div className="dialog-overlay" aria-hidden />
      </ViewTransition>
      <ViewTransition exit="sheet-out" default="none">
        <dialog ref={ref} className="dialog" aria-labelledby={id} aria-describedby={describedBy} tabIndex={-1}>
          <h2 id={id} className="dialog__t">{title}</h2>
          {children}
          <div className="dialog__actions">{actions}</div>
        </dialog>
      </ViewTransition>
    </>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Opens a `<dialog>` with showModal() while the component is mounted: the
 * page behind goes inert, focus moves to the dialog itself (so screen
 * readers read its name, and no button is pressed by accident), Tab wraps
 * inside it, Escape and a tap outside call onClose, and on unmount focus
 * goes back to what had it before (or, when that's gone, to a control with
 * the same name on the new screen, like Scan a bill after the camera).
 */
export function useModal(ref: RefObject<HTMLDialogElement | null>, onClose: () => void) {
  const close = useRef(onClose);
  useLayoutEffect(() => { close.current = onClose; });
  useLayoutEffect(() => {
    const d = ref.current;
    if (!d) return;
    const back = opener();
    if (!d.open) d.showModal();
    d.focus({ preventScroll: true });

    const onCancel = (e: Event) => {
      // Chrome won't let a page block Escape twice without a tap in between;
      // then the dialog closes itself and onNativeClose catches it.
      if (!e.cancelable) return;
      e.preventDefault();
      close.current();
    };
    const onNativeClose = () => close.current();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const all = [...d.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
      if (all.length === 0) { e.preventDefault(); return; }
      const first = all[0]!, last = all[all.length - 1]!;
      const at = document.activeElement;
      if (e.shiftKey && (at === first || at === d)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
    };
    // A tap on the backdrop is a click on the dialog, outside its box.
    const onClick = (e: MouseEvent) => {
      if (e.target !== d) return;
      const r = d.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close.current();
    };
    d.addEventListener('cancel', onCancel);
    d.addEventListener('close', onNativeClose);
    d.addEventListener('keydown', onKey);
    d.addEventListener('click', onClick);
    return () => {
      d.removeEventListener('cancel', onCancel);
      d.removeEventListener('close', onNativeClose);
      d.removeEventListener('keydown', onKey);
      d.removeEventListener('click', onClick);
      if (d.open) d.close();
      refocus(back);
    };
  }, [ref]);
}

// The control that opened a dialog. Usually it still has focus, but Safari
// doesn't focus buttons on tap, and the camera replaces the screen it was
// opened from, so the last control clicked (Enter and Space click too) stands in.
let lastClick: { el: HTMLElement; at: number } | null = null;
if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const el = e.target instanceof Element ? e.target.closest('a, button, input, select, textarea, [role="button"]') : null;
    if (el instanceof HTMLElement) lastClick = { el, at: Date.now() };
  }, true);
}
function opener(): HTMLElement | null {
  const a = document.activeElement;
  if (a instanceof HTMLElement && a !== document.body) return a;
  return lastClick && Date.now() - lastClick.at < 2000 ? lastClick.el : null;
}

/** Focus `el` again; if it's gone, the same kind of control with the same
 * name once the new screen is in. */
function refocus(el: HTMLElement | null) {
  if (!el) return;
  if (el.isConnected) { el.focus({ preventScroll: true }); return; }
  const name = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim();
  if (!name) return;
  setTimeout(() => {
    if (document.activeElement && document.activeElement !== document.body) return;
    const like = [...document.querySelectorAll<HTMLElement>(el.tagName)].find((x) => (x.getAttribute('aria-label') ?? x.textContent ?? '').trim() === name);
    like?.focus({ preventScroll: true });
  }, 0);
}

/* ---------- Feedback ---------- */

export function Notice({ title, children, tone = 'info' }: { title?: ReactNode; children?: ReactNode; tone?: 'info' | 'ok' | 'warn' | 'error' }) {
  return (
    <div className={cx('notice', `notice--${tone}`)} role={tone === 'error' ? 'alert' : tone === 'ok' || tone === 'warn' ? 'status' : undefined}>
      {tone === 'ok' ? <TickIcon /> : tone === 'warn' ? <WarnIcon /> : null}
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

/** A Centre state that stands in for the whole page (no PageTransition
 * around it), so it brings its own `<main>`. */
export function CentreMain({ children }: { children: ReactNode }) {
  return <main className="vt-page"><Centre>{children}</Centre></main>;
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
export const WarnIcon = ({ size = 22 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 9v4M12 16.5h.01M10.3 3.9 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /></svg>
);
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
