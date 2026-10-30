import { ConnectorKind } from '@prisma/client';

export type TransitionProfile = {
  /** Fixed cost of boarding and leaving, in metre-equivalents (paid once per ride, however many floors it spans). */
  boardingCost: number;
  /** Cost per floor travelled, in metre-equivalents. */
  perFloorCost: number;
  boardingSeconds: number;
  perFloorSeconds: number;
};

/**
 * Cost of using each vertical connector. Metre-equivalents let a long walk be traded against waiting for a lift:
 * with these numbers a lift beats stairs for 2+ floors, stairs win for a single floor.
 */
export const TRANSITION_PROFILES: Readonly<Record<ConnectorKind, TransitionProfile>> = {
  ELEVATOR: { boardingCost: 15, perFloorCost: 2, boardingSeconds: 30, perFloorSeconds: 3 },
  STAIR: { boardingCost: 2, perFloorCost: 10, boardingSeconds: 5, perFloorSeconds: 12 },
  ESCALATOR: { boardingCost: 3, perFloorCost: 5, boardingSeconds: 5, perFloorSeconds: 8 },
};

/** Connector kinds a wheelchair user cannot ride regardless of the connector's own accessible flag. */
export const NOT_WHEELCHAIR_KINDS: readonly ConnectorKind[] = [ConnectorKind.STAIR, ConnectorKind.ESCALATOR];

/** Connector kinds unsafe during an evacuation. */
export const EVACUATION_EXCLUDED_KINDS: readonly ConnectorKind[] = [ConnectorKind.ELEVATOR];

export function rideSeconds(kind: ConnectorKind, floors: number): number {
  const profile = TRANSITION_PROFILES[kind];
  return profile.boardingSeconds + profile.perFloorSeconds * floors;
}
