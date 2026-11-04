import { describe, expect, it } from 'vitest';
import { cropFor } from './cameraCrop';

const phone = { left: 0, top: 0, width: 390, height: 844 };

describe('cropFor (#173)', () => {
  it('maps a guide on a cover-fitted portrait preview into a 3:4 frame', () => {
    // 3024x4032 frame on a 390x844 screen: scale 844/4032, frame shown 633px wide, 121.5px cut each side.
    const crop = cropFor({ width: 3024, height: 4032 }, phone, { left: 25, top: 110, width: 340, height: 612 })!;
    const scale = 844 / 4032;
    const ox = (390 - 3024 * scale) / 2;
    expect(crop.x).toBeCloseTo((25 - 340 * 0.08 - ox) / scale / 3024, 6);
    expect(crop.y).toBeCloseTo((110 - 612 * 0.08) / 844, 6);
    expect(crop.w).toBeCloseTo((340 * 1.16) / scale / 3024, 6);
    expect(crop.h).toBeCloseTo((612 * 1.16) / 844, 6);
    // The bill (the guide) ends up most of the photo's width, not a third of it.
    expect(crop.w).toBeLessThan(0.65);
  });

  it('clamps to the frame when the margin runs off it', () => {
    const crop = cropFor({ width: 1000, height: 1000 }, { left: 0, top: 0, width: 100, height: 100 }, { left: 0, top: 0, width: 100, height: 100 })!;
    expect(crop).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('allows for where the preview sits on the page', () => {
    const a = cropFor({ width: 1000, height: 1000 }, { left: 0, top: 0, width: 100, height: 100 }, { left: 40, top: 40, width: 20, height: 20 })!;
    const b = cropFor({ width: 1000, height: 1000 }, { left: 10, top: 20, width: 100, height: 100 }, { left: 50, top: 60, width: 20, height: 20 })!;
    expect(b.x).toBeCloseTo(a.x, 9);
    expect(b.y).toBeCloseTo(a.y, 9);
  });

  it('gives up without a frame or with a guide too small to mean anything', () => {
    expect(cropFor({ width: 0, height: 0 }, phone, phone)).toBeNull();
    expect(cropFor({ width: 1000, height: 1000 }, phone, { left: 10, top: 10, width: 1, height: 1 })).toBeNull();
  });
});
