'use client';

/**
 * #61: two optional questions the lead answers while the bill is read.
 * "Where are you?" lists food and drink places near them (#62) when the
 * browser shares its location, plus "Somewhere else" with a name field;
 * without a location, or with nothing near, it's just the name field.
 * "How many of you?" is 2–10, unset until they say. Both are optional.
 */
import { useEffect, useState } from 'react';
import { useNearbyVenues, type NearbyVenue } from '@gdp/core/api/hooks/useNearbyVenues';
import type { ScanVenue } from '@gdp/core/lib/scanAnswers';
import { Section } from './ui';

const PARTY_MIN = 2;
const PARTY_MAX = 10;

type Position = { state: 'asking' } | { state: 'here'; at: { lat: number; lng: number } } | { state: 'none' };

/** Asks the browser where we are, once. Refused, unsupported or slow → none. */
function usePosition(): Position {
  const [pos, setPos] = useState<Position>({ state: 'asking' });
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) { setPos({ state: 'none' }); return; }
    let done = false;
    const give = (p: Position) => { if (!done) { done = true; setPos(p); } };
    navigator.geolocation.getCurrentPosition(
      (g) => give({ state: 'here', at: { lat: g.coords.latitude, lng: g.coords.longitude } }),
      () => give({ state: 'none' }),
      { timeout: 10_000, maximumAge: 5 * 60_000, enableHighAccuracy: false },
    );
    // Some browsers never answer when the prompt is ignored.
    const t = setTimeout(() => give({ state: 'none' }), 12_000);
    return () => { done = true; clearTimeout(t); };
  }, []);
  return pos;
}

const street = (address?: string) => address?.split(',')[0]?.trim();
const distance = (m: number) => (m < 1000 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(1)} km`);

export function WhereAreYou({ venue, onChange }: { venue?: ScanVenue; onChange: (v: ScanVenue | null) => void }) {
  const pos = usePosition();
  const nearby = useNearbyVenues(pos.state === 'here' ? pos.at : null);
  const places: NearbyVenue[] = nearby.data ?? [];
  const looking = pos.state === 'asking' || (pos.state === 'here' && nearby.isPending);
  const picked = venue?.placeId ? places.find((p) => p.placeId === venue.placeId) : undefined;
  // "Somewhere else" is open when they've typed a name, or chose it.
  const [elseOpen, setElseOpen] = useState(!!venue && !venue.placeId);
  const [name, setName] = useState(venue && !venue.placeId ? venue.name : '');

  const nameField = (
    <div className="field">
      <label htmlFor="scan-venue" className="vh">Name of the place</label>
      <input
        id="scan-venue"
        className="input"
        value={name}
        maxLength={80}
        placeholder="Name of the place"
        autoFocus={places.length > 0}
        onChange={(e) => { setName(e.target.value); onChange(e.target.value.trim() ? { name: e.target.value } : null); }}
      />
    </div>
  );

  if (looking) {
    return (
      <Section title="Where are you?">
        <p className="small muted" role="status">Looking for places near you…</p>
      </Section>
    );
  }
  if (places.length === 0) return <Section title="Where are you?">{nameField}</Section>;

  return (
    <Section title="Where are you?">
      <div className="box" role="radiogroup" aria-label="Where are you?">
          {places.map((p) => (
            <label key={p.placeId} className="row row--choice">
              <input
                type="radio"
                name="scan-venue-choice"
                checked={!elseOpen && picked?.placeId === p.placeId}
                onChange={() => { setElseOpen(false); onChange({ name: p.name, placeId: p.placeId, ...(p.address ? { address: p.address } : {}) }); }}
              />
              <span className="row__main">
                <span className="row__title">{p.name}</span>
                <span className="row__sub">{[street(p.address), distance(p.distanceM)].filter(Boolean).join(' · ')}</span>
              </span>
            </label>
          ))}
          <label className="row row--choice">
            <input
              type="radio"
              name="scan-venue-choice"
              checked={elseOpen}
              onChange={() => { setElseOpen(true); onChange(name.trim() ? { name } : null); }}
            />
            <span className="row__main"><span className="row__title">Somewhere else</span></span>
          </label>
      </div>
      {elseOpen ? nameField : null}
    </Section>
  );
}

export function HowManyOfYou({ n, onChange }: { n?: number; onChange: (n: number | null) => void }) {
  return (
    <Section title="How many of you?">
      <div className="ways ways--left">
        <span className="stepper">
          <button type="button" aria-label="Fewer people" disabled={n === undefined} onClick={() => onChange(n === undefined || n <= PARTY_MIN ? null : n - 1)}>−</button>
        </span>
        <b aria-live="polite" aria-label={n === undefined ? 'Not set' : `${n} people`}>{n ?? '–'}</b>
        <span className="stepper">
          <button type="button" aria-label="More people" disabled={n !== undefined && n >= PARTY_MAX} onClick={() => onChange(n === undefined ? PARTY_MIN : n + 1)}>+</button>
        </span>
        <span className="small muted">incl. you</span>
      </div>
    </Section>
  );
}
