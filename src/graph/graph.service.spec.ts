import { BadRequestException, ConflictException } from '@nestjs/common';
import { NodeType, UserRole } from '@prisma/client';
import { GraphService } from './graph.service';

const user = { userId: 'user-1', role: UserRole.BUILDING_OWNER, tenantId: 'tenant-1' };
const floor = { id: 'floor-1', tenantId: 'tenant-1', buildingId: 'building-1', mapWidth: null, mapHeight: null, deletedAt: null };

describe('GraphService', () => {
  it('rejects an undirected duplicate edge', async () => {
    const prisma = {
      floor: { findFirst: jest.fn().mockResolvedValue(floor) },
      node: { findMany: jest.fn().mockResolvedValue([{ id: 'node-a', floorId: floor.id, tenantId: floor.tenantId, x: 0, y: 0 }, { id: 'node-b', floorId: floor.id, tenantId: floor.tenantId, x: 10, y: 0 }]) },
      edge: { findFirst: jest.fn().mockResolvedValue({ id: 'edge-existing' }) },
    } as any;
    const service = new GraphService(prisma, { building: jest.fn().mockResolvedValue({ id: floor.buildingId }) } as any);
    await expect(service.createEdge(user, floor.id, { fromNodeId: 'node-b', toNodeId: 'node-a' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects an edge whose nodes are not on the requested floor', async () => {
    const prisma = {
      floor: { findFirst: jest.fn().mockResolvedValue(floor) },
      node: { findMany: jest.fn().mockResolvedValue([{ id: 'node-a', floorId: floor.id, tenantId: floor.tenantId }, { id: 'node-b', floorId: 'other-floor', tenantId: floor.tenantId }]) },
    } as any;
    const service = new GraphService(prisma, { building: jest.fn().mockResolvedValue({ id: floor.buildingId }) } as any);
    await expect(service.createEdge(user, floor.id, { fromNodeId: 'node-a', toNodeId: 'node-b' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('blocks publishing when an elevator has no vertical link', async () => {
    const prisma = {
      node: { findMany: jest.fn().mockResolvedValue([{ id: 'elevator-1', type: NodeType.ELEVATOR }]) },
      elevatorLink: { findMany: jest.fn().mockResolvedValue([]) },
    } as any;
    const service = new GraphService(prisma, {} as any);
    await expect(service.assertFloorCanPublish(floor.id)).rejects.toBeInstanceOf(BadRequestException);
  });

  describe('applyNavigationDraft', () => {
    const sizedFloor = { ...floor, mapWidth: 1000, mapHeight: 1000 };
    const node = (id: string, x: number, y: number, extra = {}) => ({ id, x, y, type: NodeType.NORMAL, ...extra });
    const edge = (id: string, fromNodeId: string, toNodeId: string, extra = {}) => ({ id, fromNodeId, toNodeId, ...extra });

    function build() {
      let nodeSeq = 0; let edgeSeq = 0;
      const tx = {
        node: { create: jest.fn(async ({ data }) => ({ id: `real-node-${++nodeSeq}`, x: data.x, y: data.y })) },
        edge: { create: jest.fn(async () => ({ id: `real-edge-${++edgeSeq}` })) },
      };
      const prisma = { floor: { findFirst: jest.fn().mockResolvedValue(sizedFloor) }, $transaction: jest.fn(async (fn) => fn(tx)) } as any;
      const service = new GraphService(prisma, { building: jest.fn().mockResolvedValue({ id: floor.buildingId }) } as any);
      return { service, tx, prisma };
    }
    const apply = (service: GraphService, dto: any) => service.applyNavigationDraft(user, floor.id, dto);
    const codeOf = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { return (error as any).getResponse().code; } };

    it('creates only confirmed nodes/edges, recomputes weight and returns id mappings', async () => {
      const { service, tx } = build();
      const result = await apply(service, {
        nodes: [node('a', 0, 0), node('b', 300, 400), node('c', 10, 10, { confirmed: false })],
        edges: [edge('e1', 'a', 'b', { weight: 1 } as any), edge('e2', 'a', 'c', { confirmed: false })],
      });
      expect(result).toEqual({ nodesCreated: 2, edgesCreated: 1, nodeIds: { a: 'real-node-1', b: 'real-node-2' }, edgeIds: { e1: 'real-edge-1' }, replayed: false });
      expect((tx.edge.create.mock.calls as any)[0][0].data.weight).toBe(500);
    });

    it('rejects edges whose endpoint was not confirmed instead of skipping them', async () => {
      const { service, tx } = build();
      expect(await codeOf(apply(service, { nodes: [node('a', 0, 0), node('c', 1, 1, { confirmed: false })], edges: [edge('e1', 'a', 'c')] }))).toBe('DRAFT_EDGE_ENDPOINT_MISSING');
      expect(await codeOf(apply(service, { nodes: [node('a', 0, 0)], edges: [edge('e1', 'a', 'ghost')] }))).toBe('DRAFT_EDGE_ENDPOINT_MISSING');
      expect(tx.node.create).not.toHaveBeenCalled();
    });

    it('rejects duplicate node ids, duplicate undirected edges, self-loops, empty and out-of-bounds drafts', async () => {
      const { service } = build();
      expect(await codeOf(apply(service, { nodes: [node('a', 0, 0), node('a', 1, 1)], edges: [] }))).toBe('DRAFT_DUPLICATE_NODE');
      expect(await codeOf(apply(service, { nodes: [node('a', 0, 0), node('b', 1, 1)], edges: [edge('e1', 'a', 'b'), edge('e2', 'b', 'a')] }))).toBe('DRAFT_DUPLICATE_EDGE');
      expect(await codeOf(apply(service, { nodes: [node('a', 0, 0)], edges: [edge('e1', 'a', 'a')] }))).toBe('DRAFT_EDGE_SELF_LOOP');
      expect(await codeOf(apply(service, { nodes: [node('a', 0, 0, { confirmed: false })], edges: [] }))).toBe('NAVIGATION_DRAFT_EMPTY');
      expect(await codeOf(apply(service, { nodes: [node('a', 5000, 0)], edges: [] }))).toBe('INVALID_NODE_COORDINATES');
    });

    it('is idempotent per draftId: a retry or double click creates nothing twice', async () => {
      const { service, tx } = build();
      const dto = { draftId: '11111111-1111-4111-8111-111111111111', nodes: [node('a', 0, 0), node('b', 3, 4)], edges: [edge('e1', 'a', 'b')] };
      const [first, concurrent] = await Promise.all([apply(service, dto), apply(service, dto)]);
      const retry = await apply(service, dto);
      expect(first.replayed).toBe(false);
      expect(concurrent).toMatchObject({ replayed: true, nodeIds: first.nodeIds });
      expect(retry).toMatchObject({ replayed: true, edgeIds: first.edgeIds });
      expect(tx.node.create).toHaveBeenCalledTimes(2);
      expect(tx.edge.create).toHaveBeenCalledTimes(1);
    });

    it('does not remember a failed apply, so the Manager can retry', async () => {
      const { service, prisma } = build();
      prisma.$transaction.mockRejectedValueOnce(new Error('db down'));
      const dto = { draftId: '22222222-2222-4222-8222-222222222222', nodes: [node('a', 0, 0)], edges: [] };
      await expect(apply(service, dto)).rejects.toThrow('db down');
      expect(await apply(service, dto)).toMatchObject({ nodesCreated: 1, replayed: false });
    });
  });
});
