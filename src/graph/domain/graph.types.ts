import { ConnectorKind, NodeType } from '@prisma/client';

/** Pure graph-engine types: no Prisma models, no Nest. Distances are metres; transition costs are metre-equivalents. */

export type TraversalKind = 'WALK' | ConnectorKind;

export type AdjacencyEntry = {
  to: string;
  /** Edge length in metres for WALK, otherwise the transition cost in metre-equivalents. */
  cost: number;
  kind: TraversalKind;
  accessible: boolean;
  connectorId?: string;
};
export type Adjacency = ReadonlyMap<string, readonly AdjacencyEntry[]>;

export type SnapshotFloor = {
  id: string;
  floorNumber: number;
  /** null = not calibrated: its edges are left out of the graph and routes touching it are refused. */
  metersPerPixel: number | null;
  graphVersion: number;
};

export type SnapshotNode = { id: string; floorId: string; x: number; y: number; type: NodeType };

/** Immutable per-building routing graph; the unit GraphCacheService stores. */
export type GraphSnapshot = {
  buildingId: string;
  /** `floorId:graphVersion` of every published floor, sorted; two snapshots with the same key are interchangeable. */
  key: string;
  floors: ReadonlyMap<string, SnapshotFloor>;
  nodes: ReadonlyMap<string, SnapshotNode>;
  /** Node ids that are EXIT/EMERGENCY_EXIT nodes or carry an EXIT POI. */
  exitNodeIds: ReadonlySet<string>;
  /** Walking edges plus connector hops, with virtual car nodes (see snapshot-assembler). */
  adjacency: Adjacency;
  uncalibratedFloorIds: readonly string[];
};

export type RouteOptions = {
  blockedNodeIds?: ReadonlySet<string>;
  excludedKinds?: ReadonlySet<TraversalKind>;
  /** Skip every entry whose `accessible` is false. */
  requireAccessible?: boolean;
};

export type PathResult = { cost: number; nodeIds: string[]; entries: AdjacencyEntry[] } | null;

/** A move between two real nodes; a connector ride collapses its virtual hops into one leg. */
export type RouteLeg = {
  fromNodeId: string;
  toNodeId: string;
  kind: TraversalKind;
  connectorId?: string;
  /** Walking metres for WALK legs, 0 for connector rides. */
  walkMeters: number;
  /** Estimated seconds spent in a connector ride, 0 for WALK legs. */
  rideSeconds: number;
};

export type PlannedRoute = { cost: number; nodeIds: string[]; legs: RouteLeg[]; walkMeters: number; rideSeconds: number };

export const GRAPH_ERROR_CODES = {
  FLOOR_NOT_CALIBRATED: 'FLOOR_NOT_CALIBRATED',
  GRAPH_VERSION_CONFLICT: 'GRAPH_VERSION_CONFLICT',
  NODE_HAS_DEPENDENCIES: 'NODE_HAS_DEPENDENCIES',
  POI_SNAP_OUT_OF_RANGE: 'POI_SNAP_OUT_OF_RANGE',
  POI_NO_SNAP_TARGET: 'POI_NO_SNAP_TARGET',
  INVALID_CONNECTOR: 'INVALID_CONNECTOR',
} as const;
