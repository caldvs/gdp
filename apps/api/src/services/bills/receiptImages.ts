import type { Sharp, SharpConstructor } from 'sharp';

/**
 * Turning a bill photo into what the model reads best.
 *
 * The model shrinks every image to about 1568px on its long side. A long
 * receipt is a narrow strip down the middle of a photo, so after that its
 * text is a few pixels high and prices and quantities get misread. Cropping
 * to the receipt and cutting a tall one into overlapping parts lets each part
 * reach the model at close to full detail.
 *
 * The pixel work is sharp (libvips, native). It replaced pure-JS jpeg-js,
 * which took about 3.5s of a 10.7s read on Lambda (#172). Every step starts
 * from the uploaded JPEG: libvips decodes only what an extract needs, and
 * shrinks while decoding for the small copy.
 *
 * sharp loads on the first photo, not with the module: most requests never
 * touch a photo and shouldn't pay for libvips at cold start, and the bundle
 * (with Lambda's Linux binaries) still loads on a Mac for validate:bundle.
 */
let lib: Promise<SharpConstructor> | undefined;
function sharp(): Promise<SharpConstructor> {
  lib ??= import('sharp').then((m) => m.default);
  return lib;
}

/** The model's own resize limit: anything bigger is shrunk before it's read. */
export const MODEL_MAX_EDGE = 1568;

/** Where the receipt is, as fractions of the photo's width and height. */
export type Box = { left: number; top: number; right: number; bottom: number };

/** A photo and its size in pixels. */
export type Photo = { bytes: Uint8Array; width: number; height: number };

/**
 * The photo's size, read from its header. Null when it isn't an image sharp
 * can open, so the caller can send it on as it came. sharp failing to load
 * at all still throws: that's a broken deploy, not a bad photo.
 */
export async function openPhoto(bytes: Uint8Array): Promise<Photo | null> {
  const s = await sharp();
  try {
    const meta = await s(bytes, { failOn: 'error' }).metadata();
    return meta.width && meta.height ? { bytes, width: meta.width, height: meta.height } : null;
  } catch {
    return null;
  }
}

/** The whole photo, no more than `maxEdge` on its long side, as a JPEG. */
export async function smallCopy(photo: Photo, maxEdge: number, quality = 80): Promise<Uint8Array> {
  const s = await sharp();
  return jpegOf(
    s(photo.bytes).resize(maxEdge, maxEdge, { fit: 'inside', withoutEnlargement: true }),
    quality,
  );
}

/** Part of the photo, in pixels, no more than `maxEdge` on its long side, as a JPEG. */
export async function cropTo(
  photo: Photo,
  area: { x: number; y: number; w: number; h: number },
  maxEdge: number,
  quality = 85,
): Promise<Uint8Array> {
  const s = await sharp();
  return jpegOf(
    s(photo.bytes)
      .extract({ left: area.x, top: area.y, width: area.w, height: area.h })
      .resize(maxEdge, maxEdge, { fit: 'inside', withoutEnlargement: true }),
    quality,
  );
}

async function jpegOf(img: Sharp, quality: number): Promise<Uint8Array> {
  // White behind any transparency (a PNG), as the app's canvas does.
  const buf = await img.flatten({ background: '#ffffff' }).jpeg({ quality }).toBuffer();
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
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
export async function receiptParts(photo: Photo, box: Box | null): Promise<Uint8Array[]> {
  const area = (box ? cropArea(photo.width, photo.height, box) : null) ?? {
    x: 0,
    y: 0,
    w: photo.width,
    h: photo.height,
  };
  // libvips runs each on its own thread.
  return Promise.all(
    planSlices(area.w, area.h).map((s) =>
      cropTo(photo, { x: area.x, y: area.y + s.y, w: area.w, h: s.h }, MODEL_MAX_EDGE),
    ),
  );
}
