import jpeg from 'jpeg-js';

/**
 * Turning a bill photo into what the model reads best.
 *
 * The model shrinks every image to about 1568px on its long side. A long
 * receipt is a narrow strip down the middle of a photo, so after that its
 * text is a few pixels high and prices and quantities get misread. Cropping
 * to the receipt and cutting a tall one into overlapping parts lets each part
 * reach the model at close to full detail.
 */

/** RGBA pixels. */
export type Raster = { width: number; height: number; data: Uint8Array };

/** Where the receipt is, as fractions of the photo's width and height. */
export type Box = { left: number; top: number; right: number; bottom: number };

/** The model's own resize limit: anything bigger is shrunk before it's read. */
export const MODEL_MAX_EDGE = 1568;

export function decodeJpeg(bytes: Uint8Array): Raster {
  const img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 512 });
  return { width: img.width, height: img.height, data: img.data };
}

export function encodeJpeg(r: Raster, quality = 85): Uint8Array {
  return new Uint8Array(
    jpeg.encode({ data: r.data, width: r.width, height: r.height }, quality).data,
  );
}

/** A copy of part of the raster, in pixels. */
export function crop(r: Raster, x: number, y: number, w: number, h: number): Raster {
  const data = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row++) {
    const from = ((y + row) * r.width + x) * 4;
    data.set(r.data.subarray(from, from + w * 4), row * w * 4);
  }
  return { width: w, height: h, data };
}

/** Shrinks so the long side is at most `maxEdge`, averaging the pixels each new one covers. */
export function downscale(r: Raster, maxEdge: number): Raster {
  const scale = Math.min(1, maxEdge / Math.max(r.width, r.height));
  if (scale === 1) return r;
  const w = Math.max(1, Math.round(r.width * scale));
  const h = Math.max(1, Math.round(r.height * scale));
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * r.height) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * r.height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * r.width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * r.width) / w));
      let rr = 0,
        g = 0,
        b = 0;
      for (let sy = y0; sy < y1; sy++) {
        let i = (sy * r.width + x0) * 4;
        for (let sx = x0; sx < x1; sx++, i += 4) {
          rr += r.data[i]!;
          g += r.data[i + 1]!;
          b += r.data[i + 2]!;
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (y * w + x) * 4;
      data[o] = rr / n;
      data[o + 1] = g / n;
      data[o + 2] = b / n;
      data[o + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

/**
 * The receipt's area in pixels, with a little margin, or null when it's
 * most of the photo anyway (or the box makes no sense).
 */
export function cropArea(
  width: number,
  height: number,
  box: Box,
): { x: number; y: number; w: number; h: number } | null {
  const ok = [box.left, box.top, box.right, box.bottom].every((v) => v >= 0 && v <= 1);
  if (!ok || box.right - box.left < 0.05 || box.bottom - box.top < 0.05) return null;
  const pad = 0.02;
  const x0 = Math.round(Math.max(0, box.left - pad) * width);
  const x1 = Math.round(Math.min(1, box.right + pad) * width);
  const y0 = Math.round(Math.max(0, box.top - pad) * height);
  const y1 = Math.round(Math.min(1, box.bottom + pad) * height);
  if ((x1 - x0) * (y1 - y0) > 0.85 * width * height) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * How to cut a tall image into parts, top to bottom: each part about
 * `aspect` times taller than wide, overlapping the next by a few lines so no
 * line is cut in half without also appearing whole. At most `max` parts.
 */
export function planSlices(
  width: number,
  height: number,
  { aspect = 1.4, overlap = 0.08, max = 4 } = {},
): { y: number; h: number }[] {
  const n = Math.min(max, Math.max(1, Math.ceil(height / (width * aspect))));
  if (n === 1) return [{ y: 0, h: height }];
  const step = height / n;
  const extra = Math.round(step * overlap);
  return Array.from({ length: n }, (_, i) => {
    const y0 = Math.max(0, Math.round(i * step) - extra);
    const y1 = Math.min(height, Math.round((i + 1) * step) + extra);
    return { y: y0, h: y1 - y0 };
  });
}

/**
 * The parts to send for one bill photo: cropped to `box` when given, cut into
 * overlapping parts when tall, each no bigger than the model will read.
 */
export function receiptParts(photo: Raster, box: Box | null): Uint8Array[] {
  const area = box ? cropArea(photo.width, photo.height, box) : null;
  const receipt = area ? crop(photo, area.x, area.y, area.w, area.h) : photo;
  return planSlices(receipt.width, receipt.height).map((s) =>
    encodeJpeg(downscale(crop(receipt, 0, s.y, receipt.width, s.h), MODEL_MAX_EDGE)),
  );
}
