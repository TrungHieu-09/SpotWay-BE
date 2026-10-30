import { ConnectorKind } from '@prisma/client';
import { AdjacencyEntry, GraphSnapshot, PlannedRoute, RouteLeg, TraversalKind } from '../graph.types';
import { EVACUATION_EXCLUDED_KINDS, NOT_WHEELCHAIR_KINDS, rideSeconds } from '../transition-costs';
import { dijkstra } from './dijkstra';

export type PlanOptions = {
  wheelchairMode?: boolean;
  evacuation?: boolean;
  blockedNodeIds?: ReadonlySet<string>;
};

/** Cheapest route to the nearest target under the mode's rules, or null. Virtual connector nodes never appear in the result. */
export function planRoute(snapshot: GraphSnapshot, sourceId: string, targets: string | ReadonlySet<string>, options: PlanOptions = {}): PlannedRoute | null {
  const excludedKinds = new Set<TraversalKind>();
  if (options.wheelchairMode) NOT_WHEELCHAIR_KINDS.forEach((kind) => excludedKinds.add(kind));
  if (options.evacuation) EVACUATION_EXCLUDED_KINDS.forEach((kind) => excludedKinds.add(kind));
  const path = dijkstra(snapshot.adjacency, sourceId, targets, { blockedNodeIds: options.blockedNodeIds, excludedKinds, requireAccessible: options.wheelchairMode });
  if (!path) return null;

  const isReal = (id: string) => snapshot.nodes.has(id);
  const floorNumber = (id: string) => snapshot.floors.get(snapshot.nodes.get(id)!.floorId)!.floorNumber;
  const legs: RouteLeg[] = [];
  const entries: AdjacencyEntry[] = path.entries;
  for (let i = 0; i < entries.length;) {
    const from = path.nodeIds[i];
    const entry = entries[i];
    if (entry.kind === 'WALK') { legs.push({ fromNodeId: from, toNodeId: entry.to, kind: 'WALK', walkMeters: entry.cost, rideSeconds: 0 }); i += 1; continue; }
    let end = i;
    while (!isReal(path.nodeIds[end + 1])) end += 1; // stop -> car -> ... -> car -> stop
    const to = path.nodeIds[end + 1];
    legs.push({ fromNodeId: from, toNodeId: to, kind: entry.kind, connectorId: entry.connectorId, walkMeters: 0, rideSeconds: rideSeconds(entry.kind as ConnectorKind, Math.abs(floorNumber(to) - floorNumber(from))) });
    i = end + 1;
  }
  return {
    cost: path.cost,
    nodeIds: path.nodeIds.filter(isReal),
    legs,
    walkMeters: legs.reduce((sum, leg) => sum + leg.walkMeters, 0),
    rideSeconds: legs.reduce((sum, leg) => sum + leg.rideSeconds, 0),
  };
}
