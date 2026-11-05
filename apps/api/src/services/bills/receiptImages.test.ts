import { describe, expect, it } from 'vitest';
import {
  crop,
  cropArea,
  decodeJpeg,
  downscale,
  encodeJpeg,
  planSlices,
  receiptParts,
  type Raster,
} from './receiptImages.js';

const blank = (width: number, height: number, v = 255): Raster => ({
  width,
  height,
  data: new Uint8Array(width * height * 4).fill(v),
});

describe('planSlices', () => {
  it('leaves an ordinary photo whole', () => {
    expect(planSlices(1600, 2133)).toEqual([{ y: 0, h: 2133 }]);
  });

  it('cuts a long receipt into overlapping parts that cover it all', () => {
    const parts = planSlices(700, 3200);
    expect(parts).toHaveLength(4);
    expect(parts[0]!.y).toBe(0);
    expect(parts.at(-1)!.y + parts.at(-1)!.h).toBe(3200);
    for (let i = 1; i < parts.length; i++) {
      expect(parts[i]!.y).toBeLessThan(parts[i - 1]!.y + parts[i - 1]!.h); // overlaps
    }
  });

  it('never makes more than the limit', () => {
    expect(planSlices(100, 10_000)).toHaveLength(4);
  });
});

describe('cropArea', () => {
  it('pads the receipt a little', () => {
    expect(cropArea(1000, 1000, { left: 0.3, top: 0.1, right: 0.6, bottom: 0.9 })).toEqual({
      x: 280,
      y: 80,
      w: 340,
      h: 840,
    });
  });

  it("doesn't crop when the receipt is most of the photo", () => {
    expect(cropArea(1000, 1000, { left: 0.02, top: 0, right: 0.98, bottom: 1 })).toBeNull();
  });

  it('ignores a box that makes no sense', () => {
    expect(cropArea(1000, 1000, { left: 0.6, top: 0, right: 0.3, bottom: 1 })).toBeNull();
    expect(cropArea(1000, 1000, { left: -1, top: 0, right: 0.3, bottom: 2 })).toBeNull();
  });
});

describe('rasters', () => {
  it('crops the pixels asked for', () => {
    const r = blank(4, 4, 0);
    r.data.set([9, 9, 9, 255], (2 * 4 + 1) * 4); // pixel (1, 2)
    const c = crop(r, 1, 2, 2, 1);
    expect([c.width, c.height]).toEqual([2, 1]);
    expect(Array.from(c.data.subarray(0, 4))).toEqual([9, 9, 9, 255]);
  });

  it('downscales to the long edge, averaging', () => {
    const r = blank(400, 200, 100);
    const d = downscale(r, 100);
    expect([d.width, d.height]).toEqual([100, 50]);
    expect(d.data[0]).toBe(100);
    expect(downscale(r, 1000)).toBe(r);
  });

  it('round-trips through JPEG', () => {
    const r = decodeJpeg(encodeJpeg(blank(64, 32)));
    expect([r.width, r.height]).toEqual([64, 32]);
  });
});

// Real JPEG work in pure JS: seconds under coverage on a busy machine.
describe('receiptParts', { timeout: 20_000 }, () => {
  it('crops to the receipt and sends a long one in parts', () => {
    const photo = blank(600, 2400);
    const parts = receiptParts(photo, { left: 0.3, top: 0, right: 0.6, bottom: 1 });
    expect(parts).toHaveLength(4);
    const first = decodeJpeg(parts[0]!);
    expect(first.width).toBe(204); // 0.28–0.62 of 600
  });

  it('sends an ordinary photo whole, no bigger than the model reads', () => {
    const parts = receiptParts(blank(1600, 2133), null);
    expect(parts).toHaveLength(1);
    const r = decodeJpeg(parts[0]!);
    expect(Math.max(r.width, r.height)).toBe(1568);
  });
});
