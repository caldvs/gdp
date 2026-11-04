/** Part of a frame, as fractions of its width and height. */
export type Crop = { x: number; y: number; w: number; h: number };

type Rect = { left: number; top: number; width: number; height: number };

/** Room around the guide, so a bill that pokes out a little is still whole. */
export const CROP_MARGIN = 0.08;

/**
 * Where the camera's on-screen guide sits in the camera frame. The preview
 * fills the screen with `object-fit: cover`, so the screen shows only the
 * middle of the frame; a photo of the whole frame made the bill look small
 * and gave the reader few pixels of print (#173). Null when there's nothing
 * sensible to crop to.
 */
export function cropFor(
  frame: { width: number; height: number },
  view: Rect,
  box: Rect,
): Crop | null {
  if (!frame.width || !frame.height || !view.width || !view.height) return null;
  const scale = Math.max(view.width / frame.width, view.height / frame.height);
  const ox = (view.width - frame.width * scale) / 2;
  const oy = (view.height - frame.height * scale) / 2;
  const mx = box.width * CROP_MARGIN;
  const my = box.height * CROP_MARGIN;
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  const toX = (px: number) => clamp((px - view.left - ox) / scale / frame.width);
  const toY = (px: number) => clamp((px - view.top - oy) / scale / frame.height);
  const x = toX(box.left - mx);
  const y = toY(box.top - my);
  const w = toX(box.left + box.width + mx) - x;
  const h = toY(box.top + box.height + my) - y;
  return w > 0.05 && h > 0.05 ? { x, y, w, h } : null;
}
