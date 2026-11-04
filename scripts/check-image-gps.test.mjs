import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasGps, IMAGE_EXT } from './check-image-gps.mjs';

/** A TIFF block: IFD0 with Orientation, and (optionally) a GPS IFD with the given tags. */
function tiff({ le = true, gpsTags = null } = {}) {
  const b = Buffer.alloc(96);
  const u16 = (v, o) => (le ? b.writeUInt16LE(v, o) : b.writeUInt16BE(v, o));
  const u32 = (v, o) => (le ? b.writeUInt32LE(v, o) : b.writeUInt32BE(v, o));
  b.write(le ? 'II' : 'MM', 0, 'latin1');
  u16(42, 2);
  u32(8, 4);
  // IFD0 at 8: Orientation, plus the GPS pointer when there's a GPS IFD.
  u16(gpsTags ? 2 : 1, 8);
  u16(0x0112, 10); u16(3, 12); u32(1, 14); u16(6, 18);
  if (gpsTags) {
    u16(0x8825, 22); u16(4, 24); u32(1, 26); u32(40, 30);
    u16(gpsTags.length, 40);
    gpsTags.forEach((tag, i) => { u16(tag, 42 + i * 12); u16(5, 44 + i * 12); u32(3, 46 + i * 12); u32(0, 50 + i * 12); });
  }
  return b;
}

const jpeg = (t) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, t.length + 8]), Buffer.from('Exif\0\0', 'latin1'), t, Buffer.from([0xff, 0xd9])]);
const heicLike = (t) => Buffer.concat([Buffer.from('....ftypheic....mdat', 'latin1'), Buffer.alloc(100, 0x41), Buffer.from([0, 0, 0, 6]), Buffer.from('Exif\0\0', 'latin1'), t]);

test('finds a GPS position in EXIF, either byte order, in a JPEG or a HEIC-like box', () => {
  assert.equal(hasGps(jpeg(tiff({ gpsTags: [1, 2, 3, 4] }))), true);
  assert.equal(hasGps(jpeg(tiff({ le: false, gpsTags: [2] }))), true);
  assert.equal(hasGps(heicLike(tiff({ gpsTags: [4] }))), true);
});

test('passes EXIF with no GPS, or a GPS IFD with no position', () => {
  assert.equal(hasGps(jpeg(tiff())), false);
  assert.equal(hasGps(jpeg(tiff({ gpsTags: [0x0007, 0x001d] }))), false);
  assert.equal(hasGps(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), false);
});

test('finds GPS in XMP', () => {
  assert.equal(hasGps(Buffer.from('<x:xmpmeta><rdf:Description exif:GPSLatitude="53,29.03N"/></x:xmpmeta>')), true);
  assert.equal(hasGps(Buffer.from('<exif:GPSLongitude>2,14.1W</exif:GPSLongitude>')), true);
});

test('ignores random bytes that look like a TIFF header', () => {
  assert.equal(hasGps(Buffer.concat([Buffer.from('II*\0', 'latin1'), Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.alloc(32)])), false);
});

test('checks image files only', () => {
  assert.ok(IMAGE_EXT.test('a/b.HEIC'));
  assert.ok(IMAGE_EXT.test('x.jpeg'));
  assert.ok(!IMAGE_EXT.test('x.ts'));
});
