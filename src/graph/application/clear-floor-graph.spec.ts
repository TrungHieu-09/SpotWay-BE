import { UserRole } from '@prisma/client';
import { GraphService } from '../graph.service';
import { PoiService } from './poi.service';

const user = { userId: 'user-1', role: UserRole.BUILDING_OWNER, tenantId: 'tenant-1' };
const floor = { id: 'floor-1', tenantId: 'tenant-1', buildingId: 'building-1', floorNumber: 1, mapWidth: 1000, mapHeight: 1000, deletedAt: null, metersPerPixel: 0.1 };
const access = { building: jest.fn().mockResolvedValue({ id: 'building-1', tenantId: 'tenant-1' }) } as any;
const codeOf = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { return (error as any).getResponse().code; } };

function build(opts: { nodes?: string[]; stores?: number; qr?: number; stops?: Array<{ connectorId: string; floorId: string; nodeId: string }> } = {}) {
  const nodeIds = opts.nodes ?? ['n1', 'n2', 'n3'];
  const stops = opts.stops ?? [];
  const tx = {
    floor: { update: jest.fn().mockResolvedValue({ graphVersion: 5 }) },
    node: { findMany: jest.fn().mockResolvedValue(nodeIds.map((id) => ({ id }))), updateMany: jest.fn().mockResolvedValue({ count: nodeIds.length }) },
    edge: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
    poi: { updateMany: jest.fn().mockResolvedValue({ count: 4 }) },
    store: { count: jest.fn().mockResolvedValue(opts.stores ?? 0) },
    qrAnchor: { count: jest.fn().mockResolvedValue(opts.qr ?? 0) },
    connectorStop: {
      findMany: jest.fn(async ({ where }) => (where.floorId ? stops.filter((s) => s.floorId === where.floorId) : stops)),
      deleteMany: jest.fn().mockResolvedValue({ count: stops.length }),
    },
    connector: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    elevatorLink: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
  } as any;
  const prisma = { floor: { findFirst: jest.fn().mockResolvedValue(floor) }, $transaction: jest.fn(async (fn) => fn(tx)) } as any;
  return { tx, prisma, run: () => new GraphService(prisma, access).clearFloorGraph(user, floor.id) };
}

describe('GraphService.clearFloorGraph', () => {
  it('soft-deletes every node, edge and POI of the floor in one transaction with one version bump', async () => {
    const { tx, prisma, run } = build();
    await expect(run()).resolves.toEqual({ floorId: 'floor-1', nodes: 3, edges: 2, pois: 4, connectors: 0 });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.floor.update).toHaveBeenCalledTimes(1);
    expect(tx.node.updateMany.mock.calls[0][0].where).toEqual({ floorId: 'floor-1', deletedAt: null });
    expect(tx.poi.updateMany.mock.calls[0][0].where).toEqual({ floorId: 'floor-1', deletedAt: null });
  });

  it('removes whole connectors that stop on this floor and bumps the other floors they served', async () => {
    const stops = [{ connectorId: 'c1', floorId: 'floor-1', nodeId: 'n1' }, { connectorId: 'c1', floorId: 'floor-2', nodeId: 'm1' }];
    const { tx, run } = build({ stops });
    await expect(run()).resolves.toMatchObject({ connectors: 1 });
    expect(tx.connectorStop.deleteMany).toHaveBeenCalledWith({ where: { connectorId: { in: ['c1'] } } });
    expect(tx.connector.updateMany.mock.calls[0][0].where).toEqual({ id: { in: ['c1'] } });
    expect(tx.elevatorLink.updateMany.mock.calls[0][0].where.OR[0].nodeIdFrom.in).toEqual(expect.arrayContaining(['n1', 'm1']));
    expect(tx.floor.update.mock.calls.map((call: any[]) => call[0].where.id)).toEqual(['floor-1', 'floor-2']);
  });

  it('refuses while stores or QR anchors are attached (business data is never dropped silently)', async () => {
    const withStore = build({ stores: 1 });
    expect(await codeOf(withStore.run())).toBe('NODE_HAS_DEPENDENCIES');
    expect(withStore.tx.node.updateMany).not.toHaveBeenCalled();
    expect(await codeOf(build({ qr: 2 }).run())).toBe('NODE_HAS_DEPENDENCIES');
  });

  it('is a no-op on an empty floor', async () => {
    const { tx, run } = build({ nodes: [] });
    await expect(run()).resolves.toEqual({ floorId: 'floor-1', nodes: 0, edges: 0, pois: 0, connectors: 0 });
    expect(tx.node.updateMany).not.toHaveBeenCalled();
  });
});

describe('PoiService.removeAllOnFloor', () => {
  it('soft-deletes all POIs of the floor with a single update', async () => {
    const tx = { floor: { update: jest.fn().mockResolvedValue({ graphVersion: 2 }) }, poi: { updateMany: jest.fn().mockResolvedValue({ count: 12 }) } } as any;
    const prisma = { floor: { findFirst: jest.fn().mockResolvedValue(floor) }, $transaction: jest.fn(async (fn) => fn(tx)) } as any;
    await expect(new PoiService(prisma, access).removeAllOnFloor(user, floor.id)).resolves.toEqual({ floorId: 'floor-1', pois: 12 });
    expect(tx.poi.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.floor.update).toHaveBeenCalledTimes(1);
  });
});
