import { BadRequestException, ConflictException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { GraphService } from './graph.service';

const user = { userId: 'user-1', role: UserRole.BUILDING_OWNER, tenantId: 'tenant-1' };
const floor = { id: 'floor-1', tenantId: 'tenant-1', buildingId: 'building-1', mapWidth: null, mapHeight: null, deletedAt: null, metersPerPixel: 0.1 };
const access = { building: jest.fn().mockResolvedValue({ id: floor.buildingId }) } as any;

/** Runs the callback with a tx whose floor row accepts any version bump. */
function txWith(overrides: Record<string, unknown> = {}) {
  return {
    floor: { update: jest.fn().mockResolvedValue({ graphVersion: 5 }), updateMany: jest.fn().mockResolvedValue({ count: 1 }), findUniqueOrThrow: jest.fn().mockResolvedValue({ metersPerPixel: floor.metersPerPixel }), findUnique: jest.fn() },
    $executeRaw: jest.fn().mockResolvedValue(2),
    ...overrides,
  } as any;
}

describe('GraphService', () => {
  it('rejects an undirected duplicate edge', async () => {
    const prisma = {
      floor: { findFirst: jest.fn().mockResolvedValue(floor) },
      node: { findMany: jest.fn().mockResolvedValue([{ id: 'node-a', floorId: floor.id, tenantId: floor.tenantId, x: 0, y: 0 }, { id: 'node-b', floorId: floor.id, tenantId: floor.tenantId, x: 10, y: 0 }]) },
      edge: { findFirst: jest.fn().mockResolvedValue({ id: 'edge-existing' }) },
    } as any;
    await expect(new GraphService(prisma, access).createEdge(user, floor.id, { fromNodeId: 'node-b', toNodeId: 'node-a' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects an edge whose nodes are not on the requested floor', async () => {
    const prisma = {
      floor: { findFirst: jest.fn().mockResolvedValue(floor) },
      node: { findMany: jest.fn().mockResolvedValue([{ id: 'node-a', floorId: floor.id, tenantId: floor.tenantId }, { id: 'node-b', floorId: 'other-floor', tenantId: floor.tenantId }]) },
    } as any;
    await expect(new GraphService(prisma, access).createEdge(user, floor.id, { fromNodeId: 'node-a', toNodeId: 'node-b' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('stores the edge length in pixels and metres, and bumps the graph version', async () => {
    const tx = txWith({ edge: { create: jest.fn(async ({ data }) => ({ id: 'e1', ...data })) } });
    const prisma = {
      floor: { findFirst: jest.fn().mockResolvedValue(floor) },
      node: { findMany: jest.fn().mockResolvedValue([{ id: 'a', floorId: floor.id, tenantId: floor.tenantId, x: 0, y: 0 }, { id: 'b', floorId: floor.id, tenantId: floor.tenantId, x: 300, y: 400 }]) },
      edge: { findFirst: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(async (fn) => fn(tx)),
    } as any;
    await new GraphService(prisma, access).createEdge(user, floor.id, { fromNodeId: 'a', toNodeId: 'b' });
    expect(tx.edge.create.mock.calls[0][0].data).toMatchObject({ weight: 500, weightMeters: 50 });
    expect(tx.floor.update).toHaveBeenCalledWith(expect.objectContaining({ data: { graphVersion: { increment: 1 } } }));
  });

  it('leaves weightMeters null while the floor is uncalibrated', async () => {
    const tx = txWith({ edge: { create: jest.fn(async ({ data }) => data) } });
    tx.floor.findUniqueOrThrow.mockResolvedValue({ metersPerPixel: null });
    const prisma = {
      floor: { findFirst: jest.fn().mockResolvedValue({ ...floor, metersPerPixel: null }) },
      node: { findMany: jest.fn().mockResolvedValue([{ id: 'a', floorId: floor.id, tenantId: floor.tenantId, x: 0, y: 0 }, { id: 'b', floorId: floor.id, tenantId: floor.tenantId, x: 3, y: 4 }]) },
      edge: { findFirst: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(async (fn) => fn(tx)),
    } as any;
    await new GraphService(prisma, access).createEdge(user, floor.id, { fromNodeId: 'a', toNodeId: 'b' });
    expect(tx.edge.create.mock.calls[0][0].data).toMatchObject({ weight: 5, weightMeters: null });
  });

  describe('updateNode', () => {
    const existing = { id: 'n1', floorId: floor.id, tenantId: floor.tenantId, x: 10, y: 10, deletedAt: null, floor };
    function build() {
      const tx = txWith({ node: { update: jest.fn(async ({ data }) => ({ id: 'n1', ...data })) } });
      const prisma = { node: { findFirst: jest.fn().mockResolvedValue(existing) }, $transaction: jest.fn(async (fn) => fn(tx)) } as any;
      return { tx, service: new GraphService(prisma, access) };
    }

    it('recomputes adjacent edge weights when the node moves', async () => {
      const { tx, service } = build();
      await service.updateNode(user, 'n1', { x: 50 });
      expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it('does not touch edges when only the name changes, and never writes expectedGraphVersion to the node', async () => {
      const { tx, service } = build();
      await service.updateNode(user, 'n1', { name: ' Lobby ', expectedGraphVersion: 4 });
      expect(tx.$executeRaw).not.toHaveBeenCalled();
      expect(tx.node.update.mock.calls[0][0].data).toEqual({ name: 'Lobby' });
      expect(tx.floor.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: floor.id, graphVersion: 4 } }));
    });

    it('answers GRAPH_VERSION_CONFLICT when the floor changed since the editor loaded it', async () => {
      const { tx, service } = build();
      tx.floor.updateMany.mockResolvedValue({ count: 0 });
      tx.floor.findUnique.mockResolvedValue({ graphVersion: 9 });
      await expect(service.updateNode(user, 'n1', { x: 20, expectedGraphVersion: 4 })).rejects.toMatchObject({ response: { code: 'GRAPH_VERSION_CONFLICT', graphVersion: 9 } });
      expect(tx.node.update).not.toHaveBeenCalled();
    });
  });

  describe('deleteNode', () => {
    const existing = { id: 'n1', floorId: floor.id, tenantId: floor.tenantId, deletedAt: null, floor };
    const counts = (over: Partial<Record<'poi' | 'store' | 'qrAnchor' | 'connectorStop', number>> = {}) => ({
      poi: { count: jest.fn().mockResolvedValue(over.poi ?? 0) }, store: { count: jest.fn().mockResolvedValue(over.store ?? 0) },
      qrAnchor: { count: jest.fn().mockResolvedValue(over.qrAnchor ?? 0) }, connectorStop: { count: jest.fn().mockResolvedValue(over.connectorStop ?? 0) },
      node: { update: jest.fn() }, edge: { updateMany: jest.fn() }, elevatorLink: { updateMany: jest.fn() },
    });
    const run = (over = {}) => {
      const tx = txWith(counts(over));
      const prisma = { node: { findFirst: jest.fn().mockResolvedValue(existing) }, $transaction: jest.fn(async (fn) => fn(tx)) } as any;
      return { tx, result: new GraphService(prisma, access).deleteNode(user, 'n1') };
    };

    it('refuses to delete a node that still has a QR anchor', async () => {
      const { tx, result } = run({ qrAnchor: 2 });
      await expect(result).rejects.toMatchObject({ response: { code: 'NODE_HAS_DEPENDENCIES', dependencies: { qrAnchors: 2, pois: 0, stores: 0, connectorStops: 0 } } });
      expect(tx.node.update).not.toHaveBeenCalled();
    });

    it('refuses to delete a connector stop', async () => {
      const { result } = run({ connectorStop: 1 });
      await expect(result).rejects.toMatchObject({ response: { code: 'NODE_HAS_DEPENDENCIES' } });
    });

    it('soft-deletes a free node with its edges and links', async () => {
      const { tx, result } = run();
      await expect(result).resolves.toEqual({ id: 'n1', deleted: true, floorId: floor.id });
      expect(tx.edge.updateMany).toHaveBeenCalled();
      expect(tx.elevatorLink.updateMany).toHaveBeenCalled();
    });
  });
});
