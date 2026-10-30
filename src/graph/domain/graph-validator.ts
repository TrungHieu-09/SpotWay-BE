import { ConnectorKind, NodeType, PoiCategory } from '@prisma/client';
import { GraphIssue } from '../dto/graph-validation.dto';
import { pixelDistance } from './coordinate-transform';
import { EVACUATION_EXCLUDED_KINDS } from './transition-costs';

export type FloorGraphInput = {
  metersPerPixel: number | null;
  nodes: Array<{ id: string; x: number; y: number; type: NodeType }>;
  edges: Array<{ id: string; fromNodeId: string; toNodeId: string; weightMeters: number | null }>;
  /** ACTIVE stores of the floor; nodeId is null when the store has no map position. */
  stores: Array<{ id: string; nodeId: string | null }>;
  pois: Array<{ id: string; nodeId: string; category: PoiCategory }>;
  qrAnchors: Array<{ id: string; nodeId: string }>;
  /** Connectors with a stop on this floor; stopFloorIds lists the floors of all their live stops. */
  connectors: Array<{ id: string; kind: ConnectorKind; stopFloorIds: string[]; floorNodeIds: string[] }>;
  /** Node ids of this floor that sit on a live legacy ElevatorLink. */
  legacyLinkedNodeIds: string[];
};

const WEIGHT_TOLERANCE = 0.01;
const error = (code: string, message: string, ids?: string[]): GraphIssue => ({ code, severity: 'ERROR', message, ...(ids?.length ? { ids } : {}) });
const warning = (code: string, message: string, ids?: string[]): GraphIssue => ({ code, severity: 'WARNING', message, ...(ids?.length ? { ids } : {}) });

/** Everything that must hold before a floor is shown to the public. Pure: same input, same issues, ERRORs first. */
export function validateFloorGraph(input: FloorGraphInput): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const nodes = new Map(input.nodes.map((node) => [node.id, node]));

  if (input.metersPerPixel === null) issues.push(error('FLOOR_NOT_CALIBRATED', 'Calibrate the floor scale before publishing (PATCH /floors/:id/calibration)'));

  // Edges
  const dangling = input.edges.filter((edge) => !nodes.has(edge.fromNodeId) || !nodes.has(edge.toNodeId));
  if (dangling.length) issues.push(error('DANGLING_EDGE', 'Edges reference a deleted node', dangling.map((edge) => edge.id)));
  const live = input.edges.filter((edge) => nodes.has(edge.fromNodeId) && nodes.has(edge.toNodeId));
  if (input.metersPerPixel !== null) {
    const missing = live.filter((edge) => edge.weightMeters === null);
    if (missing.length) issues.push(error('EDGE_WEIGHT_MISSING', 'Edges have no length in metres; recalibrate the floor', missing.map((edge) => edge.id)));
    const stale = live.filter((edge) => {
      if (edge.weightMeters === null) return false;
      const expected = pixelDistance(nodes.get(edge.fromNodeId)!, nodes.get(edge.toNodeId)!) * input.metersPerPixel!;
      return Math.abs(edge.weightMeters - expected) > Math.max(1e-6, expected * WEIGHT_TOLERANCE);
    });
    if (stale.length) issues.push(error('EDGE_WEIGHT_STALE', 'Edge lengths no longer match their node coordinates', stale.map((edge) => edge.id)));
  }

  // Anchors
  const missingAnchor = (rows: Array<{ id: string; nodeId: string | null }>) => rows.filter((row) => row.nodeId !== null && !nodes.has(row.nodeId)).map((row) => row.id);
  const brokenAnchors = [['STORE', missingAnchor(input.stores)], ['POI', missingAnchor(input.pois)], ['QR_ANCHOR', missingAnchor(input.qrAnchors)]] as const;
  for (const [kind, ids] of brokenAnchors) if (ids.length) issues.push(error(`${kind}_NODE_MISSING`, `${kind} points at a node that no longer exists on this floor`, ids));
  const unplaced = input.stores.filter((store) => store.nodeId === null).map((store) => store.id);
  if (unplaced.length) issues.push(warning('STORE_WITHOUT_NODE', 'Stores without a map position cannot be routed to', unplaced));

  // Connectors: a lift/stair serving fewer than two floors goes nowhere
  const shortConnectors = input.connectors.filter((connector) => new Set(connector.stopFloorIds).size < 2).map((connector) => connector.id);
  if (shortConnectors.length) issues.push(error('CONNECTOR_TOO_FEW_FLOORS', 'A connector must serve at least two floors', shortConnectors));
  const connectedNodes = new Set([...input.legacyLinkedNodeIds, ...input.connectors.flatMap((connector) => connector.floorNodeIds)]);
  const unlinked = (type: NodeType) => input.nodes.filter((node) => node.type === type && !connectedNodes.has(node.id)).map((node) => node.id);
  const unlinkedElevators = unlinked(NodeType.ELEVATOR);
  if (unlinkedElevators.length) issues.push(error('UNLINKED_ELEVATOR_NODE', 'Every elevator node must have a vertical link before publishing', unlinkedElevators));
  const unlinkedStairs = [...unlinked(NodeType.STAIR), ...unlinked(NodeType.ESCALATOR)];
  if (unlinkedStairs.length) issues.push(warning('UNLINKED_STAIR_NODE', 'Stair/escalator nodes without a connector lead nowhere', unlinkedStairs));

  // Connectivity (walking graph, BLOCKED edges count: they are temporary)
  const adjacency = new Map<string, string[]>(input.nodes.map((node) => [node.id, []]));
  for (const edge of live) { adjacency.get(edge.fromNodeId)!.push(edge.toNodeId); adjacency.get(edge.toNodeId)!.push(edge.fromNodeId); }
  const component = new Map<string, number>();
  const components: string[][] = [];
  for (const node of input.nodes) {
    if (component.has(node.id)) continue;
    const members: string[] = [];
    const stack = [node.id];
    component.set(node.id, components.length);
    while (stack.length) {
      const id = stack.pop()!;
      members.push(id);
      for (const next of adjacency.get(id)!) if (!component.has(next)) { component.set(next, components.length); stack.push(next); }
    }
    components.push(members);
  }
  const isolated = components.filter((members) => members.length === 1 && !connectedNodes.has(members[0])).map((members) => members[0]);
  if (isolated.length) issues.push(warning('ISOLATED_NODE', 'Nodes with no edge cannot be walked to', isolated));
  const walkable = components.filter((members) => members.length > 1 || connectedNodes.has(members[0]));
  if (walkable.length > 1) {
    const [, ...detached] = [...walkable].sort((a, b) => b.length - a.length);
    issues.push(error('GRAPH_DISCONNECTED', `The floor graph is split into ${walkable.length} separate parts; join them with edges`, detached.flat()));
  }

  // Egress: exits, EXIT POIs and stops of connectors that stay usable during an evacuation
  const anchored = [...input.stores.filter((store) => store.nodeId !== null).map((store) => ({ id: store.id, nodeId: store.nodeId! })), ...input.pois];
  const reachableAnchors = anchored.filter((anchor) => nodes.has(anchor.nodeId));
  if (reachableAnchors.length) {
    const egress = new Set<string>([
      ...input.nodes.filter((node) => node.type === NodeType.EXIT || node.type === NodeType.EMERGENCY_EXIT).map((node) => node.id),
      ...input.pois.filter((poi) => poi.category === PoiCategory.EXIT && nodes.has(poi.nodeId)).map((poi) => poi.nodeId),
      ...input.connectors.filter((connector) => !EVACUATION_EXCLUDED_KINDS.includes(connector.kind) && new Set(connector.stopFloorIds).size >= 2).flatMap((connector) => connector.floorNodeIds),
    ]);
    if (!egress.size) issues.push(error('NO_EXIT_ON_FLOOR', 'The floor has stores or POIs but no EXIT node, EXIT POI or stair/escalator to leave it'));
    else {
      const withEgress = new Set([...egress].map((id) => component.get(id)).filter((index): index is number => index !== undefined));
      const cut = reachableAnchors.filter((anchor) => !withEgress.has(component.get(anchor.nodeId)!)).map((anchor) => anchor.id);
      if (cut.length) issues.push(error('UNREACHABLE_FROM_EXIT', 'Stores or POIs have no walkable path to an exit', cut));
    }
  }

  return issues.sort((a, b) => Number(b.severity === 'ERROR') - Number(a.severity === 'ERROR'));
}
