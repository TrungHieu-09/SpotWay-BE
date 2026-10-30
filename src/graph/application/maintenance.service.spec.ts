import { EdgeStatus, UserRole } from '@prisma/client';
import { MaintenanceService } from './maintenance.service';

const user = { userId: 'u', role: UserRole.BUILDING_OWNER, tenantId: 't' };
const floor = { id: 'floor-1', buildingId: 'b', deletedAt: null, graphVersion: 3 };
const edges = [
  { id: 'e1', fromNodeId: 'a', toNodeId: 'b', status: EdgeStatus.ACTIVE },
  { id: 'e2', fromNodeId: 'b', toNodeId: 'c', status: EdgeStatus.BLOCKED },
];

function build(over: { nodeCount?: number; edgeCount?: number } = {}) {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ graph_version: 3 }]),
    node: { count: jest.fn().mockResolvedValue(over.nodeCount ?? 1) },
    edge: { count: jest.fn().mockResolvedValue(over.edgeCount ?? 1), updateMany: jest.fn().mockResolvedValue({ count: 2 }), findMany: jest.fn().mockResolvedValue(edges) },
    floor: { update: jest.fn().mockResolvedValue({ graphVersion: 4 }), updateMany: jest.fn().mockResolvedValue({ count: 1 }), findUnique: jest.fn() },
  };
  const prisma = { floor: { findFirst: jest.fn().mockResolvedValue(floor) }, edge: tx.edge, $transaction: jest.fn(async (fn) => fn(tx)) } as any;
  return { tx, service: new MaintenanceService(prisma, { building: jest.fn() } as any) };
}

describe('MaintenanceService', () => {
  it('blocks every edge around a node and bumps the graph version so cached routes are rebuilt', async () => {
    const { tx, service } = build();
    const result = await service.block(user, floor.id, { nodeIds: ['a'] });
    const call = tx.edge.updateMany.mock.calls[0][0];
    expect(call.data).toEqual({ status: EdgeStatus.BLOCKED });
    expect(call.where.OR).toEqual([{ fromNodeId: { in: ['a'] } }, { toNodeId: { in: ['a'] } }]);
    expect(tx.floor.update).toHaveBeenCalledWith(expect.objectContaining({ data: { graphVersion: { increment: 1 } } }));
    expect(result).toMatchObject({ floorId: floor.id, graphVersion: 4, changedEdges: 2 });
  });

  it('blocks single edges and re-opens them with unblock', async () => {
    const { tx, service } = build();
    await service.block(user, floor.id, { edgeIds: ['e1'] });
    expect(tx.edge.updateMany.mock.calls[0][0].where.OR).toEqual([{ id: { in: ['e1'] } }]);
    await service.unblock(user, floor.id, { edgeIds: ['e2'] });
    expect(tx.edge.updateMany.mock.calls[1][0].data).toEqual({ status: EdgeStatus.ACTIVE });
  });

  it('reports blocked edges and the nodes that can no longer be walked through', async () => {
    const { service } = build();
    expect(await service.report(user, floor.id)).toEqual({ floorId: floor.id, graphVersion: 3, blockedEdges: [{ id: 'e2', fromNodeId: 'b', toNodeId: 'c' }], blockedNodeIds: ['c'] });
  });

  it('rejects an empty selection and ids that are not on the floor', async () => {
    await expect(build().service.block(user, floor.id, {})).rejects.toMatchObject({ response: { code: 'INVALID_MAINTENANCE_SELECTION' } });
    await expect(build({ nodeCount: 0 }).service.block(user, floor.id, { nodeIds: ['other-floor-node'] })).rejects.toMatchObject({ response: { code: 'INVALID_MAINTENANCE_SELECTION' } });
    await expect(build({ edgeCount: 0 }).service.unblock(user, floor.id, { edgeIds: ['ghost'] })).rejects.toMatchObject({ response: { code: 'INVALID_MAINTENANCE_SELECTION' } });
  });
});
