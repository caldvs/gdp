import { blobToArrayBuffer, sha256Hex } from './hash';

export type ProcessedImage = {
  /** Object URL of the processed JPEG, for previews. Revoke when done. */
  uri: string;
  blob: Blob;
  sizeBytes: number;
  mimeType: 'image/jpeg';
  sha256: string;
};

const MAX_WIDTH = 1600;
const JPEG_QUALITY = 0.8;

/**
 * Browser version of gdp-mobile's processImage: convert HEIC if needed,
 * scale to at most 1600px wide, re-encode as JPEG (q 0.8) and hash it.
 * Same output shape, so the upload hook and server-side dedup behave
 * exactly as they did in the Expo web build.
 */
export async function processImage(file: Blob, fileName?: string): Promise<ProcessedImage> {
  let source: Blob = file;
  // Chrome and Firefox can't decode HEIC; Safari can, but converting
  // everywhere keeps one code path. libheif (heic2any) is loaded lazily.
  if (isHeicLike(file.type, fileName)) {
    source = await convertHeicToJpeg(file);
  }

  const bitmap = await decode(source);
  const scale = Math.min(1, MAX_WIDTH / bitmap.width);
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

  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Could not prepare the photo.'))),
      'image/jpeg',
      JPEG_QUALITY,
    ),
  );
  const sha256 = await sha256Hex(await blobToArrayBuffer(blob));
  return {
    uri: URL.createObjectURL(blob),
    blob,
    sizeBytes: blob.size,
    mimeType: 'image/jpeg',
    sha256,
  };
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
