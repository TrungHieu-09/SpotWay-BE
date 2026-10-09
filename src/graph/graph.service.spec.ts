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
});
