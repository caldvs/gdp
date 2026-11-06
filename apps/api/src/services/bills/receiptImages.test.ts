import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import {
  MODEL_MAX_EDGE,
  cropArea,
  cropTo,
  openPhoto,
  planSlices,
  receiptParts,
  smallCopy,
} from './receiptImages.js';

/** A white JPEG, with black squares where asked. */
async function jpeg(
  width: number,
  height: number,
  black: { x: number; y: number; w: number; h: number }[] = [],
): Promise<Uint8Array> {
  const squares = await Promise.all(
    black.map(async (b) => ({
      input: await sharp({ create: { width: b.w, height: b.h, channels: 3, background: '#000' } })
        .png()
        .toBuffer(),
      left: b.x,
      top: b.y,
    })),
  );
  return new Uint8Array(
    await sharp({ create: { width, height, channels: 3, background: '#fff' } })
      .composite(squares)
      .jpeg()
      .toBuffer(),
  );
}

/** A photo the test knows opens. */
async function photoOf(bytes: Uint8Array) {
  const p = await openPhoto(bytes);
  if (!p) throw new Error('fixture did not open');
  return p;
}

async function size(bytes: Uint8Array): Promise<[number, number]> {
  const m = await sharp(bytes).metadata();
  return [m.width, m.height];
}

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

describe('pixels', () => {
  it('reads the size from the header, and refuses what isn’t an image', async () => {
    const p = await openPhoto(await jpeg(64, 32));
    expect([p?.width, p?.height]).toEqual([64, 32]);
    expect(await openPhoto(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it('crops the pixels asked for', async () => {
    // A black square at (10, 20)–(20, 30) on white.
    const bytes = await jpeg(64, 64, [{ x: 10, y: 20, w: 10, h: 10 }]);
    const out = await sharp(
      await cropTo(await photoOf(bytes), { x: 10, y: 20, w: 10, h: 10 }, 1000),
    )
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect([out.info.width, out.info.height]).toEqual([10, 10]);
    expect(out.data[(5 * 10 + 5) * out.info.channels]).toBeLessThan(40); // dark in the middle
  });

  it('shrinks to the long edge and never enlarges', async () => {
    const photo = await photoOf(await jpeg(400, 200));
    expect(await size(await smallCopy(photo, 100))).toEqual([100, 50]);
    expect(await size(await smallCopy(photo, 1000))).toEqual([400, 200]);
  });
});

describe('receiptParts', () => {
  it('crops to the receipt and sends a long one in parts', async () => {
    const photo = await photoOf(await jpeg(600, 2400));
    const parts = await receiptParts(photo, { left: 0.3, top: 0, right: 0.6, bottom: 1 });
    expect(parts).toHaveLength(4);
    expect((await size(parts[0]!))[0]).toBe(204); // 0.28–0.62 of 600
  });

  it('sends an ordinary photo whole, no bigger than the model reads', async () => {
    const parts = await receiptParts(await photoOf(await jpeg(1600, 2133)), null);
    expect(parts).toHaveLength(1);
    expect(Math.max(...(await size(parts[0]!)))).toBe(MODEL_MAX_EDGE);
  });

  it('keeps a real phone photo’s parts at the model’s full detail', async () => {
    const bytes = new Uint8Array(
      readFileSync(new URL('../../../fixtures/receipts/theholland.jpg', import.meta.url)),
    );
    const photo = await photoOf(bytes);
    expect([photo.width, photo.height]).toEqual([2409, 3200]);
    const parts = await receiptParts(photo, { left: 0.15, top: 0.1, right: 0.8, bottom: 0.92 });
    expect(parts).toHaveLength(2);
    for (const part of parts) expect(Math.max(...(await size(part)))).toBe(MODEL_MAX_EDGE);
  });
});
