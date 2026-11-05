export interface ImageSize { width: number; height: number }
export interface ImageTransform { scale: number; x: number; y: number }
export const MAX_SCALE = 4;
export const DOUBLE_TAP_SCALE = 2.5;
export const DISMISS_DISTANCE = 120;

export function fitImage(viewport: ImageSize, image: ImageSize): ImageSize {
  if (viewport.width <= 0 || viewport.height <= 0 || image.width <= 0 || image.height <= 0) return { width: 0, height: 0 };
  const ratio = Math.min(viewport.width / image.width, viewport.height / image.height);
  return { width: image.width * ratio, height: image.height * ratio };
}

export function clampImage(viewport: ImageSize, image: ImageSize, value: ImageTransform): ImageTransform {
  const scale = Math.min(MAX_SCALE, Math.max(1, Number.isFinite(value.scale) ? value.scale : 1));
  const fitted = fitImage(viewport, image);
  const boundX = Math.max(0, (fitted.width * scale - viewport.width) / 2);
  const boundY = Math.max(0, (fitted.height * scale - viewport.height) / 2);
  const clamp = (n: number, bound: number) => bound === 0 ? 0 : Math.min(bound, Math.max(-bound, Number.isFinite(n) ? n : 0));
  return { scale, x: clamp(value.x, boundX), y: clamp(value.y, boundY) };
}

/** Preserve the image point under the fingers; initial finger spacing is measured, never assumed. */
export function pinchImage(
  start: ImageTransform, initialDistance: number, distance: number,
  anchor: { x: number; y: number }, movement: { x: number; y: number },
): ImageTransform {
  const scale = Math.min(MAX_SCALE, Math.max(1, start.scale * distance / Math.max(1, initialDistance)));
  const ratio = scale / start.scale;
  return { scale, x: anchor.x + (start.x - anchor.x) * ratio + movement.x, y: anchor.y + (start.y - anchor.y) * ratio + movement.y };
}
