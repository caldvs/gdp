'use client';

import { useState } from 'react';

const FALLBACK_COLORS = ['#1a73e8', '#1e8e3e', '#9a6b00', '#a50e0e', '#7b1fa2', '#0277bd', '#5d4037', '#00838f'];

function colorForSeed(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return FALLBACK_COLORS[hash % FALLBACK_COLORS.length]!;
}

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

export function Avatar({ uri, displayName, size = 32, seed }: { uri?: string; displayName: string; size?: number; seed?: string }) {
  const dim = { width: size, height: size };
  const [failed, setFailed] = useState(false);
  if (uri && !failed) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={uri} alt={`${displayName}'s avatar`} className="avatar" style={dim} onError={() => setFailed(true)} />;
  }
  return (
    <span className="avatar" aria-hidden style={{ ...dim, background: colorForSeed(seed ?? displayName), fontSize: Math.round(size * 0.42) }}>
      {initialsFor(displayName)}
    </span>
  );
}
