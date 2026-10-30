import { Point, pixelDistance } from './coordinate-transform';

export type SnapCandidate = Point & { id: string };
export type SnapMatch = { nodeId: string; distanceMeters: number };

/**
 * Nearest candidate to `point` within `maxMeters`. A floor holds at most a few thousand nodes, so a linear scan is
 * deliberately preferred to a spatial index. Ties resolve to the lowest id so the result is deterministic.
 */
export function findNearestNode(candidates: readonly SnapCandidate[], point: Point, metersPerPixel: number, maxMeters: number): { match: SnapMatch | null; nearest: SnapMatch | null } {
  let nearest: SnapMatch | null = null;
  for (const candidate of candidates) {
    const distance = pixelDistance(candidate, point) * metersPerPixel;
    if (!nearest || distance < nearest.distanceMeters || (distance === nearest.distanceMeters && candidate.id < nearest.nodeId)) nearest = { nodeId: candidate.id, distanceMeters: distance };
  }
  const match = nearest && nearest.distanceMeters <= maxMeters ? nearest : null;
  return { match, nearest };
}
