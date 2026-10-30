export type Point = { x: number; y: number };

const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

/** Euclidean distance in pixels. */
export function pixelDistance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Distance in metres; null when the floor has no scale yet. */
export function distanceMeters(a: Point, b: Point, metersPerPixel: number | null): number | null {
  return metersPerPixel === null ? null : round6(pixelDistance(a, b) * metersPerPixel);
}

/** Scale from two map points and the real distance between them; null when the points coincide or the input is not usable. */
export function scaleFromReference(a: Point, b: Point, realDistanceMeters: number): number | null {
  const pixels = pixelDistance(a, b);
  if (!Number.isFinite(pixels) || pixels <= 0 || !Number.isFinite(realDistanceMeters) || realDistanceMeters <= 0) return null;
  return realDistanceMeters / pixels;
}
