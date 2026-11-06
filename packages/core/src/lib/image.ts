import { blobToArrayBuffer, sha256Hex } from './hash';

export type ProcessedImage = {
  /** Object URL of the processed JPEG, for previews. Revoke when done. */
  uri: string;
  blob: Blob;
  sizeBytes: number;
  mimeType: 'image/jpeg';
  sha256: string;
};

// Long receipts need the detail: the API crops to the receipt and reads a
// long one in parts, each at up to the model's 1568px. 3200 on the long side
// is about a phone photo's full width.
const MAX_EDGE = 3200;
// The API takes up to 5 MB. Busy photos at high quality can pass that, so
// step the quality down until it fits.
const JPEG_QUALITIES = [0.85, 0.75, 0.6];
const MAX_BYTES = 4.5 * 1024 * 1024;

/**
 * Browser version of gdp-mobile's processImage: decode (HEIC too), scale to
 * at most 3200px on the long side, re-encode as JPEG (under the API's 5 MB)
 * and hash it.
 */
export async function processImage(file: Blob, fileName?: string): Promise<ProcessedImage> {
  const bitmap = await decodeAny(file, fileName);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not prepare the photo.');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap.image, 0, 0, width, height);
  bitmap.close();

  const toJpeg = (quality: number) =>
    new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('Could not prepare the photo.'))),
        'image/jpeg',
        quality,
      ),
    );
  let blob = await toJpeg(JPEG_QUALITIES[0]!);
  for (const q of JPEG_QUALITIES.slice(1)) {
    if (blob.size <= MAX_BYTES) break;
    blob = await toJpeg(q);
  }
  const sha256 = await sha256Hex(await blobToArrayBuffer(blob));
  return {
    uri: URL.createObjectURL(blob),
    blob,
    sizeBytes: blob.size,
    mimeType: 'image/jpeg',
    sha256,
  };
}

/**
 * Safari (so every browser on an iPhone) decodes HEIC itself. Desktop Chrome
 * and Firefox can't, and only then is libheif (heic2any, ~1 MB, slow) loaded
 * to convert it. The server can't do it either: sharp's prebuilt libvips
 * reads AVIF but not HEVC-coded HEIC.
 */
async function decodeAny(file: Blob, fileName?: string): Promise<Decoded> {
  if (!isHeicLike(file.type, fileName)) return decode(file);
  try {
    return await decode(file);
  } catch {
    return decode(await convertHeicToJpeg(file));
  }
}

type Decoded = { image: CanvasImageSource; width: number; height: number; close: () => void };

async function decode(blob: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    try {
      // Respect EXIF orientation so phone photos aren't sideways.
      const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      return { image: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch {
      // fall back to <img> below
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("This browser can't open that image. Try a JPEG or PNG."));
      el.src = url;
    });
    return { image: img, width: img.naturalWidth, height: img.naturalHeight, close: () => {} };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function isHeicLike(mime: string, fileName?: string): boolean {
  if (mime && /image\/hei[fc]/i.test(mime)) return true;
  // iPhone exports often arrive with no MIME type in the browser.
  return !!fileName && /\.(heic|heif)$/i.test(fileName);
}

async function convertHeicToJpeg(blob: Blob): Promise<Blob> {
  const { default: heic2any } = await import('heic2any');
  const out = await heic2any({ blob, toType: 'image/jpeg', quality: 0.9 });
  return Array.isArray(out) ? (out[0] as Blob) : (out as Blob);
}
