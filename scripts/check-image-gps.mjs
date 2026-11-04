#!/usr/bin/env node
// Refuses to commit images that say where they were taken (#156). The repo
// is public, and phone photos of bills carry GPS coordinates in EXIF (or XMP).
//
//   node scripts/check-image-gps.mjs --staged   the pre-commit hook: staged images
//   node scripts/check-image-gps.mjs FILE...    any files
//
// No exiftool needed: it looks for EXIF's TIFF structure anywhere in the file
// (JPEG APP1, HEIC/AVIF Exif items, PNG eXIf, WebP EXIF all embed one) and
// for a GPS IFD with a latitude or longitude in it, and for XMP GPS fields.
// To clean a photo: exiftool -all= -tagsfromfile @ -Orientation -ICC_Profile -overwrite_original FILE
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const IMAGE_EXT = /\.(jpe?g|png|heic|heif|avif|webp|tiff?|gif|dng)$/i;

const GPS_IFD_POINTER = 0x8825;
const GPS_LATITUDE = 0x0002;
const GPS_LONGITUDE = 0x0004;

/** Whether the TIFF structure at `start` has a GPS IFD with a position in it. */
function tiffHasGps(buf, start) {
  const le = buf[start] === 0x49;
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const readIfd = (rel) => {
    const at = start + rel;
    if (rel < 8 || at + 2 > buf.length) return null;
    const count = u16(at);
    if (count === 0 || count > 500 || at + 2 + count * 12 > buf.length) return null;
    const tags = new Map();
    for (let i = 0; i < count; i++) {
      const e = at + 2 + i * 12;
      tags.set(u16(e), u32(e + 8));
    }
    return tags;
  };
  const ifd0 = readIfd(u32(start + 4));
  const gpsAt = ifd0?.get(GPS_IFD_POINTER);
  if (gpsAt === undefined) return false;
  const gps = readIfd(gpsAt);
  return !!gps && (gps.has(GPS_LATITUDE) || gps.has(GPS_LONGITUDE));
}

const XMP_GPS = /(exif:GPS(Latitude|Longitude)|GPS(Latitude|Longitude)\s*=)/;

/** Whether an image's bytes carry a GPS position (EXIF or XMP). */
export function hasGps(buf) {
  for (let i = 0; i + 8 <= buf.length; i++) {
    const b = buf[i];
    if (b !== 0x49 && b !== 0x4d) continue;
    const ii = b === 0x49 && buf[i + 1] === 0x49 && buf[i + 2] === 0x2a && buf[i + 3] === 0x00;
    const mm = b === 0x4d && buf[i + 1] === 0x4d && buf[i + 2] === 0x00 && buf[i + 3] === 0x2a;
    if ((ii || mm) && tiffHasGps(buf, i)) return true;
  }
  return XMP_GPS.test(buf.toString('latin1'));
}

function stagedImages() {
  const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], { encoding: 'utf8' });
  return out.split('\0').filter((p) => p && IMAGE_EXT.test(p));
}

function main(args) {
  const staged = args[0] === '--staged';
  const files = staged ? stagedImages() : args.filter((p) => IMAGE_EXT.test(p));
  const bad = files.filter((f) => {
    // Check what's staged, not what's in the working tree.
    const buf = staged ? execFileSync('git', ['show', `:${f}`], { maxBuffer: 256 * 1024 * 1024 }) : readFileSync(f);
    return hasGps(buf);
  });
  if (bad.length) {
    console.error(
      `These images say where they were taken (GPS in EXIF/XMP), and the repo is public:\n` +
        bad.map((f) => `  ${f}`).join('\n') +
        `\nStrip it: exiftool -all= -tagsfromfile @ -Orientation -ICC_Profile -overwrite_original <file>, then git add it again.`,
    );
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv.slice(2));
