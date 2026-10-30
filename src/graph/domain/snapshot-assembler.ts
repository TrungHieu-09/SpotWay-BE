import { ConnectorKind } from '@prisma/client';
import { AdjacencyEntry, GraphSnapshot, SnapshotFloor, SnapshotNode } from './graph.types';
import { TRANSITION_PROFILES } from './transition-costs';

export type SnapshotInput = {
  buildingId: string;
  floors: SnapshotFloor[];
  nodes: SnapshotNode[];
  edges: Array<{ fromNodeId: string; toNodeId: string; weightMeters: number | null; accessible: boolean }>;
  connectors: Array<{ id: string; kind: ConnectorKind; accessible: boolean; stops: Array<{ floorId: string; nodeId: string }> }>;
  /** Pairwise links kept for buildings that have not been moved to connectors yet. */
  legacyLinks: Array<{ nodeIdFrom: string; nodeIdTo: string }>;
  exitPoiNodeIds: string[];
};

export const snapshotKey = (floors: ReadonlyArray<Pick<SnapshotFloor, 'id' | 'graphVersion'>>) => floors.map((floor) => `${floor.id}:${floor.graphVersion}`).sort().join(',');
/** Virtual car node of a connector at one stop; never leaves the engine. */
export const carNodeId = (connectorId: string, stopNodeId: string) => `car:${connectorId}:${stopNodeId}`;

/**
 * Builds the immutable routing graph.
 *
 * A connector with k stops becomes k virtual "car" nodes: stop -> car costs half the boarding cost, car -> car costs
 * perFloor x floors, so any ride between two stops pays boarding once plus the floors it really crosses, with O(k)
 * edges instead of one per pair of stops.
 */
export function assembleSnapshot(input: SnapshotInput): GraphSnapshot {
  const floors = new Map(input.floors.map((floor) => [floor.id, floor]));
  const uncalibrated = new Set(input.floors.filter((floor) => floor.metersPerPixel === null).map((floor) => floor.id));
  const nodes = new Map(input.nodes.filter((node) => floors.has(node.floorId)).map((node) => [node.id, node]));
  const adjacency = new Map<string, AdjacencyEntry[]>();
  const add = (from: string, entry: AdjacencyEntry) => { const list = adjacency.get(from); if (list) list.push(entry); else adjacency.set(from, [entry]); };
  for (const id of nodes.keys()) adjacency.set(id, []);

  for (const edge of input.edges) {
    const from = nodes.get(edge.fromNodeId);
    const to = nodes.get(edge.toNodeId);
    if (!from || !to || from.floorId !== to.floorId || uncalibrated.has(from.floorId) || edge.weightMeters === null) continue;
    add(from.id, { to: to.id, cost: edge.weightMeters, kind: 'WALK', accessible: edge.accessible });
    add(to.id, { to: from.id, cost: edge.weightMeters, kind: 'WALK', accessible: edge.accessible });
  }

  const real = input.connectors.map((connector) => ({ ...connector }));
  const covered = new Set(real.flatMap((connector) => connector.stops.map((stop) => stop.nodeId)));
  for (const link of input.legacyLinks) {
    const a = nodes.get(link.nodeIdFrom);
    const b = nodes.get(link.nodeIdTo);
    if (!a || !b || (covered.has(a.id) && covered.has(b.id))) continue;
    real.push({ id: `legacy:${[a.id, b.id].sort().join('|')}`, kind: 'ELEVATOR', accessible: true, stops: [{ floorId: a.floorId, nodeId: a.id }, { floorId: b.floorId, nodeId: b.id }] });
  }

  for (const connector of real) {
    const stops = connector.stops
      .filter((stop) => nodes.has(stop.nodeId) && !uncalibrated.has(nodes.get(stop.nodeId)!.floorId))
      .map((stop) => ({ nodeId: stop.nodeId, floorNumber: floors.get(nodes.get(stop.nodeId)!.floorId)!.floorNumber }))
      .sort((a, b) => a.floorNumber - b.floorNumber);
    if (stops.length < 2) continue;
    const profile = TRANSITION_PROFILES[connector.kind];
    const entry = (to: string, cost: number): AdjacencyEntry => ({ to, cost, kind: connector.kind, accessible: connector.accessible, connectorId: connector.id });
    stops.forEach((stop, index) => {
      const car = carNodeId(connector.id, stop.nodeId);
      adjacency.set(car, []);
      add(stop.nodeId, entry(car, profile.boardingCost / 2));
      add(car, entry(stop.nodeId, profile.boardingCost / 2));
      if (index > 0) {
        const previous = stops[index - 1];
        const cost = profile.perFloorCost * Math.abs(stop.floorNumber - previous.floorNumber);
        add(carNodeId(connector.id, previous.nodeId), entry(car, cost));
        add(car, entry(carNodeId(connector.id, previous.nodeId), cost));
      }
    });
  }

  const exitNodeIds = new Set([...nodes.values()].filter((node) => node.type === 'EXIT' || node.type === 'EMERGENCY_EXIT').map((node) => node.id));
  for (const nodeId of input.exitPoiNodeIds) if (nodes.has(nodeId)) exitNodeIds.add(nodeId);

  return { buildingId: input.buildingId, key: snapshotKey(input.floors), floors, nodes, exitNodeIds, adjacency, uncalibratedFloorIds: [...uncalibrated] };
}
