import { NodeType, UserRole } from '@prisma/client';
import { DraftApplyService } from './draft-apply.service';

const user = { userId: 'user-1', role: UserRole.BUILDING_MANAGER, tenantId: 'tenant-1' };
const floor = { id: 'floor-1', tenantId: 'tenant-1', buildingId: 'building-1', mapWidth: 1000, mapHeight: 1000, deletedAt: null };
const DRAFT = '11111111-1111-4111-8111-111111111111';
const node = (id: string, x: number, y: number, extra = {}) => ({ id, x, y, type: NodeType.NORMAL, ...extra });
const edge = (id: string, fromNodeId: string, toNodeId: string, extra = {}) => ({ id, fromNodeId, toNodeId, ...extra });

function build({ metersPerPixel = 0.1 as number | null, existingNodes = [] as string[], deps = 0 } = {}) {
  const applications = new Map<string, unknown>();
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ graph_version: 3 }]),
    graphDraftApplication: {
      findUnique: jest.fn(async ({ where }) => { const key = `${where.floorId_draftId.floorId}:${where.floorId_draftId.draftId}`; return applications.has(key) ? { result: applications.get(key) } : null; }),
      create: jest.fn(async ({ data }) => { applications.set(`${data.floorId}:${data.draftId}`, data.result); }),
    },
    floor: { findUniqueOrThrow: jest.fn().mockResolvedValue({ metersPerPixel }), update: jest.fn().mockResolvedValue({ graphVersion: 4 }), updateMany: jest.fn() },
    node: { createMany: jest.fn(), findMany: jest.fn().mockResolvedValue(existingNodes.map((id) => ({ id }))), updateMany: jest.fn().mockResolvedValue({ count: existingNodes.length }) },
    edge: { createMany: jest.fn(), updateMany: jest.fn() },
    elevatorLink: { updateMany: jest.fn() },
    poi: { count: jest.fn().mockResolvedValue(deps) }, store: { count: jest.fn().mockResolvedValue(0) }, qrAnchor: { count: jest.fn().mockResolvedValue(0) }, connectorStop: { count: jest.fn().mockResolvedValue(0) },
  } as any;
  const prisma = {
    floor: { findFirst: jest.fn().mockResolvedValue(floor) },
    graphDraftApplication: { findUnique: jest.fn(async (args) => tx.graphDraftApplication.findUnique(args)) },
    $transaction: jest.fn(async (fn) => fn(tx)),
  } as any;
  const service = new DraftApplyService(prisma, { building: jest.fn().mockResolvedValue({ id: floor.buildingId }) } as any);
  return { service, tx, prisma, apply: (dto: any) => service.apply(user, floor.id, { draftId: DRAFT, ...dto }) };
}
const codeOf = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { return (error as any).getResponse().code; } };

describe('DraftApplyService', () => {
  it('bulk-inserts confirmed nodes/edges with two createMany calls, never one create per row', async () => {
    const { apply, tx } = build();
    const result = await apply({ nodes: [node('a', 0, 0), node('b', 300, 400), node('c', 10, 10, { confirmed: false })], edges: [edge('e1', 'a', 'b'), edge('e2', 'a', 'c', { confirmed: false })] });
    expect(tx.node.createMany).toHaveBeenCalledTimes(1);
    expect(tx.edge.createMany).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ nodesCreated: 2, edgesCreated: 1, nodesRemoved: 0, graphVersion: 4, replayed: false });
    expect(Object.keys(result.nodeIds)).toEqual(['a', 'b']);
  });

  it('recomputes weights from coordinates, in pixels and metres, and orders the undirected pair', async () => {
    const { apply, tx } = build({ metersPerPixel: 0.1 });
    const result = await apply({ nodes: [node('a', 0, 0), node('b', 300, 400)], edges: [edge('e1', 'a', 'b', { weight: 1 })] });
    const row = tx.edge.createMany.mock.calls[0][0].data[0];
    expect(row).toMatchObject({ weight: 500, weightMeters: 50, floorId: floor.id, tenantId: floor.tenantId, fromNodeId: result.nodeIds.a, toNodeId: result.nodeIds.b });
    expect(row.nodeLowId < row.nodeHighId).toBe(true);
  });

  it('writes weightMeters = null on an uncalibrated floor', async () => {
    const { apply, tx } = build({ metersPerPixel: null });
    await apply({ nodes: [node('a', 0, 0), node('b', 3, 4)], edges: [edge('e1', 'a', 'b')] });
    expect(tx.edge.createMany.mock.calls[0][0].data[0]).toMatchObject({ weight: 5, weightMeters: null });
  });

  it('is idempotent: the second apply of a draftId replays the stored result and writes nothing', async () => {
    const { apply, tx } = build();
    const dto = { nodes: [node('a', 0, 0), node('b', 3, 4)], edges: [edge('e1', 'a', 'b')] };
    const first = await apply(dto);
    const retry = await apply(dto);
    expect(first.replayed).toBe(false);
    expect(retry).toMatchObject({ replayed: true, nodeIds: first.nodeIds, edgeIds: first.edgeIds });
    expect(tx.node.createMany).toHaveBeenCalledTimes(1);
  });

  it('replays instead of duplicating when a concurrent request committed the same draft first', async () => {
    const { apply, tx } = build();
    tx.graphDraftApplication.findUnique.mockResolvedValueOnce(null);
    tx.graphDraftApplication.findUnique.mockResolvedValueOnce({ result: { nodesCreated: 1, edgesCreated: 0, nodesRemoved: 0, nodeIds: { a: 'x' }, edgeIds: {}, graphVersion: 9 } });
    expect(await apply({ nodes: [node('a', 0, 0)], edges: [] })).toMatchObject({ replayed: true, graphVersion: 9 });
    expect(tx.node.createMany).not.toHaveBeenCalled();
  });

  it('rejects a stale expectedGraphVersion before writing anything', async () => {
    const { apply, tx } = build();
    expect(await codeOf(apply({ expectedGraphVersion: 1, nodes: [node('a', 0, 0)], edges: [] }))).toBe('GRAPH_VERSION_CONFLICT');
    expect(tx.node.createMany).not.toHaveBeenCalled();
  });

  it('REPLACE soft-deletes the old graph first and reports how many nodes it removed', async () => {
    const { apply, tx } = build({ existingNodes: ['old-1', 'old-2'] });
    const result = await apply({ mode: 'REPLACE', nodes: [node('a', 0, 0)], edges: [] });
    expect(result.nodesRemoved).toBe(2);
    expect(tx.edge.updateMany).toHaveBeenCalled();
    expect(tx.node.createMany).toHaveBeenCalledTimes(1);
  });

  it('REPLACE is refused while POIs still reference the old nodes', async () => {
    const { apply, tx } = build({ existingNodes: ['old-1'], deps: 3 });
    expect(await codeOf(apply({ mode: 'REPLACE', nodes: [node('a', 0, 0)], edges: [] }))).toBe('NODE_HAS_DEPENDENCIES');
    expect(tx.node.createMany).not.toHaveBeenCalled();
  });

  it('rejects invalid drafts instead of silently skipping parts of them', async () => {
    const { apply, prisma } = build();
    expect(await codeOf(apply({ nodes: [node('a', 0, 0), node('c', 1, 1, { confirmed: false })], edges: [edge('e1', 'a', 'c')] }))).toBe('DRAFT_EDGE_ENDPOINT_MISSING');
    expect(await codeOf(apply({ nodes: [node('a', 0, 0)], edges: [edge('e1', 'a', 'ghost')] }))).toBe('DRAFT_EDGE_ENDPOINT_MISSING');
    expect(await codeOf(apply({ nodes: [node('a', 0, 0), node('a', 1, 1)], edges: [] }))).toBe('DRAFT_DUPLICATE_NODE');
    expect(await codeOf(apply({ nodes: [node('a', 0, 0), node('b', 1, 1)], edges: [edge('e1', 'a', 'b'), edge('e2', 'b', 'a')] }))).toBe('DRAFT_DUPLICATE_EDGE');
    expect(await codeOf(apply({ nodes: [node('a', 0, 0)], edges: [edge('e1', 'a', 'a')] }))).toBe('DRAFT_EDGE_SELF_LOOP');
    expect(await codeOf(apply({ nodes: [node('a', 0, 0, { confirmed: false })], edges: [] }))).toBe('NAVIGATION_DRAFT_EMPTY');
    expect(await codeOf(apply({ nodes: [node('a', 5000, 0)], edges: [] }))).toBe('INVALID_NODE_COORDINATES');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
