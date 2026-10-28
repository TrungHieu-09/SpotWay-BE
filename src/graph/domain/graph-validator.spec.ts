import { ConnectorKind, NodeType, PoiCategory } from '@prisma/client';
import { FloorGraphInput, validateFloorGraph } from './graph-validator';

const node = (id: string, x: number, y: number, type: NodeType = NodeType.NORMAL) => ({ id, x, y, type });
const edge = (id: string, fromNodeId: string, toNodeId: string, weightMeters: number | null) => ({ id, fromNodeId, toNodeId, weightMeters });

/** A healthy floor: a - b - exit, scale 0.1 m/px, one store at b. */
function healthy(over: Partial<FloorGraphInput> = {}): FloorGraphInput {
  return {
    metersPerPixel: 0.1,
    nodes: [node('a', 0, 0), node('b', 100, 0), node('exit', 200, 0, NodeType.EXIT)],
    edges: [edge('e1', 'a', 'b', 10), edge('e2', 'b', 'exit', 10)],
    stores: [{ id: 'store', nodeId: 'a' }], pois: [], qrAnchors: [], connectors: [], legacyLinkedNodeIds: [],
    ...over,
  };
}
const codes = (input: FloorGraphInput, severity?: 'ERROR' | 'WARNING') => validateFloorGraph(input).filter((issue) => !severity || issue.severity === severity).map((issue) => issue.code);

describe('validateFloorGraph', () => {
  it('accepts a calibrated, connected floor whose store can reach an exit', () => {
    expect(validateFloorGraph(healthy())).toEqual([]);
  });

  it('requires a calibrated floor, and reports it first', () => {
    const issues = validateFloorGraph(healthy({ metersPerPixel: null, nodes: [node('a', 0, 0)], edges: [], stores: [] }));
    expect(issues[0]).toMatchObject({ code: 'FLOOR_NOT_CALIBRATED', severity: 'ERROR' });
  });

  it('flags edges whose length is missing or no longer matches the node coordinates', () => {
    expect(codes(healthy({ edges: [edge('e1', 'a', 'b', null), edge('e2', 'b', 'exit', 10)] }))).toContain('EDGE_WEIGHT_MISSING');
    const stale = validateFloorGraph(healthy({ edges: [edge('e1', 'a', 'b', 10), edge('e2', 'b', 'exit', 99)] })).find((issue) => issue.code === 'EDGE_WEIGHT_STALE');
    expect(stale?.ids).toEqual(['e2']);
    expect(codes(healthy({ edges: [edge('e1', 'a', 'b', 10.05), edge('e2', 'b', 'exit', 10)] }))).toEqual([]); // within 1%
  });

  it('flags edges that reference deleted nodes', () => {
    expect(codes(healthy({ edges: [edge('e1', 'a', 'b', 10), edge('e2', 'b', 'exit', 10), edge('e3', 'a', 'ghost', 5)] }), 'ERROR')).toEqual(['DANGLING_EDGE']);
  });

  it('flags a floor split into separate walkable parts, naming the smaller part', () => {
    const issues = validateFloorGraph(healthy({
      nodes: [node('a', 0, 0), node('b', 100, 0), node('exit', 200, 0, NodeType.EXIT), node('x', 0, 500), node('y', 100, 500)],
      edges: [edge('e1', 'a', 'b', 10), edge('e2', 'b', 'exit', 10), edge('e3', 'x', 'y', 10)],
      stores: [],
    }));
    expect(issues.find((issue) => issue.code === 'GRAPH_DISCONNECTED')?.ids?.sort()).toEqual(['x', 'y']);
  });

  it('treats an edgeless node as a warning, not a split', () => {
    const input = healthy({ nodes: [...healthy().nodes, node('lonely', 400, 400)] });
    expect(codes(input, 'ERROR')).toEqual([]);
    expect(codes(input, 'WARNING')).toEqual(['ISOLATED_NODE']);
  });

  it('flags stores and POIs that cannot walk to an exit', () => {
    const input = healthy({
      nodes: [node('a', 0, 0), node('b', 100, 0), node('exit', 200, 0, NodeType.EXIT), node('p', 0, 500), node('q', 100, 500)],
      edges: [edge('e1', 'a', 'b', 10), edge('e2', 'b', 'exit', 10), edge('e3', 'p', 'q', 10)],
      stores: [{ id: 'cut-store', nodeId: 'q' }], pois: [{ id: 'ok-poi', nodeId: 'a', category: PoiCategory.INFO }],
    });
    expect(validateFloorGraph(input).find((issue) => issue.code === 'UNREACHABLE_FROM_EXIT')?.ids).toEqual(['cut-store']);
  });

  it('requires some way out when the floor has anything to find', () => {
    const noExit = healthy({ nodes: [node('a', 0, 0), node('b', 100, 0)], edges: [edge('e1', 'a', 'b', 10)] });
    expect(codes(noExit, 'ERROR')).toEqual(['NO_EXIT_ON_FLOOR']);
    expect(codes({ ...noExit, stores: [] }, 'ERROR')).toEqual([]); // nothing to be reached
  });

  it('accepts an EXIT POI or a stair stop as the way out, but not an elevator', () => {
    const base = healthy({ nodes: [node('a', 0, 0), node('b', 100, 0)], edges: [edge('e1', 'a', 'b', 10)] });
    expect(codes({ ...base, pois: [{ id: 'exit-poi', nodeId: 'b', category: PoiCategory.EXIT }] }, 'ERROR')).toEqual([]);
    const connector = (kind: ConnectorKind) => ({ ...base, nodes: [node('a', 0, 0), node('b', 100, 0, kind === 'STAIR' ? NodeType.STAIR : NodeType.ELEVATOR)], connectors: [{ id: 'c', kind, stopFloorIds: ['f1', 'f2'], floorNodeIds: ['b'] }] });
    expect(codes(connector('STAIR'), 'ERROR')).toEqual([]);
    expect(codes(connector('ELEVATOR'), 'ERROR')).toEqual(['NO_EXIT_ON_FLOOR']);
  });

  it('flags a connector that serves fewer than two floors', () => {
    const input = healthy({ connectors: [{ id: 'lonely-lift', kind: ConnectorKind.ELEVATOR, stopFloorIds: ['f1'], floorNodeIds: ['a'] }] });
    expect(validateFloorGraph(input).find((issue) => issue.code === 'CONNECTOR_TOO_FEW_FLOORS')?.ids).toEqual(['lonely-lift']);
  });

  it('requires elevator nodes to be linked by a connector or a legacy link; stairs only warn', () => {
    const withElevator = (extra: Partial<FloorGraphInput>) => healthy({ nodes: [...healthy().nodes, node('lift', 50, 50, NodeType.ELEVATOR)], edges: [...healthy().edges, edge('e3', 'a', 'lift', 7.0711)], ...extra });
    expect(codes(withElevator({}), 'ERROR')).toEqual(['UNLINKED_ELEVATOR_NODE']);
    expect(codes(withElevator({ legacyLinkedNodeIds: ['lift'] }), 'ERROR')).toEqual([]);
    expect(codes(withElevator({ connectors: [{ id: 'c', kind: ConnectorKind.ELEVATOR, stopFloorIds: ['f1', 'f2'], floorNodeIds: ['lift'] }] }), 'ERROR')).toEqual([]);
    const stair = healthy({ nodes: [...healthy().nodes, node('st', 50, 50, NodeType.STAIR)], edges: [...healthy().edges, edge('e3', 'a', 'st', 7.0711)] });
    expect(codes(stair, 'ERROR')).toEqual([]);
    expect(codes(stair, 'WARNING')).toEqual(['UNLINKED_STAIR_NODE']);
  });

  it('flags POIs, stores and QR anchors whose node is gone, and warns about stores without a position', () => {
    const issues = codes(healthy({ stores: [{ id: 's1', nodeId: 'ghost' }, { id: 's2', nodeId: null }], pois: [{ id: 'p1', nodeId: 'ghost', category: PoiCategory.INFO }], qrAnchors: [{ id: 'q1', nodeId: 'ghost' }] }));
    expect(issues).toEqual(expect.arrayContaining(['STORE_NODE_MISSING', 'POI_NODE_MISSING', 'QR_ANCHOR_NODE_MISSING', 'STORE_WITHOUT_NODE']));
  });

  it('lists ERRORs before WARNINGs', () => {
    const severities = validateFloorGraph(healthy({ metersPerPixel: null, nodes: [...healthy().nodes, node('lonely', 9, 9)] })).map((issue) => issue.severity);
    expect(severities).toEqual([...severities].sort((a, b) => Number(b === 'ERROR') - Number(a === 'ERROR')));
  });
});
