'use client';

/**
 * #61, #135: what the lead is asked while the bill is read.
 *
 * Where: the receipt comes first. When the bill reader found the place on
 * the receipt it's shown with *Change*; only when it found none (or the lead
 * changes it) do we ask, with a name field and *Use my location*. The
 * browser is asked for location only when that's tapped, and the places
 * near them slide into room already held for them.
 *
 * How many: 2 by default, up to 99, lead included.
 */
import { useState } from 'react';
import { useNearbyVenues, type NearbyVenue } from '@gdp/core/api/hooks/useNearbyVenues';
import type { ScanVenue } from '@gdp/core/lib/scanAnswers';
import { Section } from './ui';

export const PARTY_MIN = 2;
export const PARTY_MAX = 99;
export const PARTY_DEFAULT = 2;

type Position = { state: 'idle' } | { state: 'asking' } | { state: 'here'; at: { lat: number; lng: number } } | { state: 'none' };

/** Asks the browser where we are, only when `ask` is called. */
function usePosition(): [Position, () => void] {
  const [pos, setPos] = useState<Position>({ state: 'idle' });
  const ask = () => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) { setPos({ state: 'none' }); return; }
    setPos({ state: 'asking' });
    let done = false;
    const give = (p: Position) => { if (!done) { done = true; setPos(p); } };
    navigator.geolocation.getCurrentPosition(
      (g) => give({ state: 'here', at: { lat: g.coords.latitude, lng: g.coords.longitude } }),
      () => give({ state: 'none' }),
      { timeout: 10_000, maximumAge: 5 * 60_000, enableHighAccuracy: false },
    );
    // Some browsers never answer when the prompt is ignored.
    setTimeout(() => give({ state: 'none' }), 12_000);
  };
  return [pos, ask];
}

const street = (address?: string) => address?.split(',')[0]?.trim();
const distance = (m: number) => (m < 1000 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(1)} km`);

function PinIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z" /><circle cx="12" cy="9.5" r="2.5" />
    </svg>
  );
}

/**
 * `found` is the place the bill reader read off the receipt (undefined while
 * the bill is still being read, null when there was none).
 */
export function WhereAreYou({ venue, found, onChange }: {
  venue?: ScanVenue;
  found: { name: string; address?: string } | null | undefined;
  onChange: (v: ScanVenue | null) => void;
}) {
  const [changing, setChanging] = useState(false);
  const [pos, ask] = usePosition();
  const nearby = useNearbyVenues(pos.state === 'here' ? pos.at : null);
  const places: NearbyVenue[] = nearby.data ?? [];
  const looking = pos.state === 'asking' || (pos.state === 'here' && nearby.isPending);
  const [name, setName] = useState(venue && !venue.placeId ? venue.name : '');

  // Still reading: nothing to ask yet.
  if (found === undefined && !venue) return null;

  // The receipt said where (or the lead already picked): show it.
  const shown = venue ?? found;
  if (shown && !changing) {
    return (
      <Section title="Where">
        <div className="box">
          <div className="row">
            <span className="row__main">
              <span className="row__title">{shown.name}</span>
              {street(shown.address) ? <span className="row__sub">{street(shown.address)}</span> : null}
            </span>
            <button type="button" className="link-btn" onClick={() => setChanging(true)}>Change</button>
          </div>
        </div>
      </Section>
    );
  }

  const pickedId = venue?.placeId;
  return (
    <Section title="Where are you?">
      <div className="field">
        <label htmlFor="scan-venue" className="vh">Name of the place</label>
        <input
          id="scan-venue"
          className="input"
          value={name}
          maxLength={80}
          placeholder="Name of the place"
          onChange={(e) => { setName(e.target.value); onChange(e.target.value.trim() ? { name: e.target.value } : null); }}
        />
      </div>
      {pos.state === 'idle' || pos.state === 'none' ? (
        <div>
          <button type="button" className="link-btn" onClick={ask} disabled={pos.state === 'none'}>
            <PinIcon />&nbsp;{pos.state === 'none' ? 'Location unavailable' : 'Use my location'}
          </button>
        </div>
      ) : null}
      {looking ? (
        <div className="box places places--wait" role="status" aria-label="Finding places near you">
          {[0, 1, 2].map((i) => <div key={i} className="row"><span className="skel" style={{ width: `${55 - i * 10}%` }} /></div>)}
        </div>
      ) : pos.state === 'here' ? (
        places.length ? (
          <div className="box places" role="radiogroup" aria-label="Places near you">
            {places.map((p, i) => (
              <label key={p.placeId} className="row row--choice places__row" style={{ animationDelay: `${i * 60}ms` }}>
                <input
                  type="radio"
                  name="scan-venue-choice"
                  checked={pickedId === p.placeId}
                  onChange={() => { setName(p.name); onChange({ name: p.name, placeId: p.placeId, ...(p.address ? { address: p.address } : {}) }); }}
                />
                <span className="row__main">
                  <span className="row__title">{p.name}</span>
                  <span className="row__sub">{[street(p.address), distance(p.distanceM)].filter(Boolean).join(' · ')}</span>
                </span>
              </label>
            ))}
          </div>
        ) : <p className="small muted">Nothing found near you. Type the name instead.</p>
      ) : null}
      {found && changing ? (
        <div><button type="button" className="link-btn" onClick={() => { setChanging(false); setName(''); onChange(null); }}>Use {found.name}</button></div>
      ) : null}
    </Section>
  );
}

export function HowManyOfYou({ n, onChange }: { n?: number; onChange: (n: number) => void }) {
  const v = n ?? PARTY_DEFAULT;
  return (
    <Section title="How many of you?">
      <div className="ways ways--left">
        <span className="stepper">
          <button type="button" aria-label="Fewer people" disabled={v <= PARTY_MIN} onClick={() => onChange(v - 1)}>−</button>
        </span>
        <b aria-live="polite" aria-label={`${v} people`}>{v}</b>
        <span className="stepper">
          <button type="button" aria-label="More people" disabled={v >= PARTY_MAX} onClick={() => onChange(v + 1)}>+</button>
        </span>
        <span className="small muted">incl. you</span>
      </div>
    </Section>
  );
}
