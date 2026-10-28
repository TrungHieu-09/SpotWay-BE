import { NodeType, UserRole } from '@prisma/client';
import { ConnectorService } from './connector.service';
import { FloorCalibrationService } from './floor-calibration.service';
import { PoiService } from './poi.service';

const user = { userId: 'user-1', role: UserRole.BUILDING_OWNER, tenantId: 'tenant-1' };
const floor = { id: 'floor-1', tenantId: 'tenant-1', buildingId: 'building-1', floorNumber: 1, mapWidth: 1000, mapHeight: 1000, deletedAt: null, metersPerPixel: 0.1 as number | null };
const building = { id: 'building-1', tenantId: 'tenant-1' };
const access = { building: jest.fn().mockResolvedValue(building) } as any;
const codeOf = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { return (error as any).getResponse().code; } };
const baseTx = (extra: Record<string, unknown> = {}) => ({ floor: { update: jest.fn().mockResolvedValue({ graphVersion: 2 }), updateMany: jest.fn().mockResolvedValue({ count: 1 }), findUnique: jest.fn() }, ...extra }) as any;

describe('FloorCalibrationService', () => {
  function build() {
    const tx = baseTx({ $executeRaw: jest.fn().mockResolvedValue(7) });
    tx.floor.update.mockResolvedValueOnce({ graphVersion: 2 }).mockResolvedValue({});
    const prisma = { floor: { findFirst: jest.fn().mockResolvedValue(floor) }, $transaction: jest.fn(async (fn) => fn(tx)) } as any;
    return { tx, calibrate: (dto: any) => new FloorCalibrationService(prisma, access).calibrate(user, floor.id, dto) };
  }

  it('sets the scale from two points and a real distance, then recomputes all edges', async () => {
    const { tx, calibrate } = build();
    const result = await calibrate({ pointA: { x: 0, y: 0 }, pointB: { x: 100, y: 0 }, realDistanceMeters: 5 });
    expect(result).toEqual({ floorId: floor.id, metersPerPixel: 0.05, edgesRecomputed: 7, graphVersion: 2 });
    expect(tx.floor.update).toHaveBeenCalledWith({ where: { id: floor.id }, data: { metersPerPixel: 0.05 } });
  });

  it('accepts a direct scale', async () => {
    const { calibrate } = build();
    expect(await calibrate({ metersPerPixel: 0.02 })).toMatchObject({ metersPerPixel: 0.02 });
  });

  it('requires exactly one calibration form and distinct points', async () => {
    const { calibrate } = build();
    expect(await codeOf(calibrate({}))).toBe('INVALID_CALIBRATION');
    expect(await codeOf(calibrate({ metersPerPixel: 0.1, pointA: { x: 0, y: 0 }, pointB: { x: 1, y: 1 }, realDistanceMeters: 1 }))).toBe('INVALID_CALIBRATION');
    expect(await codeOf(calibrate({ pointA: { x: 0, y: 0 }, realDistanceMeters: 1 }))).toBe('INVALID_CALIBRATION');
    expect(await codeOf(calibrate({ pointA: { x: 4, y: 4 }, pointB: { x: 4, y: 4 }, realDistanceMeters: 1 }))).toBe('INVALID_CALIBRATION');
  });
});

describe('PoiService', () => {
  const nodes = [{ id: 'near', x: 100, y: 100 }, { id: 'far', x: 900, y: 900 }];
  function build(floorOverride: Partial<typeof floor> = {}, createdNode: object | null = null) {
    const tx = baseTx({ poi: { create: jest.fn(async ({ data }) => ({ id: 'p1', ...data })), update: jest.fn(async ({ data }) => ({ id: 'p1', ...data })) } });
    const prisma = {
      floor: { findFirst: jest.fn().mockResolvedValue({ ...floor, ...floorOverride }) },
      node: { findMany: jest.fn().mockResolvedValue(nodes), findFirst: jest.fn().mockResolvedValue(createdNode) },
      poi: { findFirst: jest.fn() },
      $transaction: jest.fn(async (fn) => fn(tx)),
    } as any;
    return { tx, prisma, service: new PoiService(prisma, access) };
  }

  it('auto-snaps a POI to the nearest node and records the distance in metres', async () => {
    const { service, tx } = build();
    await service.create(user, floor.id, { x: 130, y: 140, name: ' WC ', category: 'RESTROOM' as any });
    expect(tx.poi.create.mock.calls[0][0].data).toMatchObject({ nodeId: 'near', x: 130, y: 140, snapDistanceMeters: 5, name: 'WC' });
  });

  it('refuses to snap beyond the limit and names the nearest node', async () => {
    const { service } = build();
    await expect(service.create(user, floor.id, { x: 500, y: 500, name: 'WC', category: 'RESTROOM' as any })).rejects.toMatchObject({ response: { code: 'POI_SNAP_OUT_OF_RANGE', nearestNodeId: expect.any(String) } });
  });

  it('never lets a client widen the server snap limit', async () => {
    const { service } = build();
    // 400px * 0.1 = 40 m, far above the 10 m server maximum even though the client asked for 100 m
    await expect(service.snap(user, floor.id, 500, 100, 100)).rejects.toMatchObject({ response: { code: 'POI_SNAP_OUT_OF_RANGE', maxSnapMeters: 10 } });
  });

  it('cannot auto-snap on an uncalibrated floor, but an explicit nodeId still works', async () => {
    const uncalibrated = build({ metersPerPixel: null });
    expect(await codeOf(uncalibrated.service.create(user, floor.id, { x: 10, y: 10, name: 'WC', category: 'RESTROOM' as any }))).toBe('FLOOR_NOT_CALIBRATED');
    const explicit = build({ metersPerPixel: null }, { id: 'near', x: 100, y: 100 });
    await explicit.service.create(user, floor.id, { x: 10, y: 10, nodeId: 'near', name: 'WC', category: 'RESTROOM' as any });
    expect(explicit.tx.poi.create.mock.calls[0][0].data).toMatchObject({ nodeId: 'near', snapDistanceMeters: null });
  });

  it('rejects positions outside the floor map', async () => {
    const { service } = build();
    expect(await codeOf(service.create(user, floor.id, { x: 5000, y: 1, name: 'WC', category: 'RESTROOM' as any }))).toBe('INVALID_NODE_COORDINATES');
  });

  it('re-snaps when a POI moves but not when only its name changes', async () => {
    const existing = { id: 'p1', floorId: floor.id, nodeId: 'near', x: 100, y: 100, deletedAt: null, floor };
    const { service, prisma, tx } = build();
    prisma.poi.findFirst.mockResolvedValue(existing);
    await service.update(user, 'p1', { name: 'Renamed' });
    expect(tx.poi.update.mock.calls[0][0].data).not.toHaveProperty('nodeId');
    await service.update(user, 'p1', { x: 880, y: 890 });
    expect(tx.poi.update.mock.calls[1][0].data).toMatchObject({ nodeId: 'far', x: 880, y: 890 });
  });
});

describe('ConnectorService', () => {
  const stopNode = (id: string, floorId: string, floorNumber: number, type: NodeType = NodeType.ELEVATOR, connectorStop: object | null = null) => ({ id, floorId, tenantId: 'tenant-1', type, connectorStop, floor: { id: floorId, floorNumber, buildingId: 'building-1', deletedAt: null } });
  function build(nodes: ReturnType<typeof stopNode>[]) {
    const tx = baseTx({
      connector: { create: jest.fn(async () => ({ id: 'c1', stops: [] })) },
      elevatorLink: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn(), updateMany: jest.fn() },
    });
    const prisma = { node: { findMany: jest.fn().mockResolvedValue(nodes) }, $transaction: jest.fn(async (fn) => fn(tx)) } as any;
    return { tx, service: new ConnectorService(prisma, access) };
  }
  const dto = (stops: Array<[string, string]>, kind = 'ELEVATOR') => ({ kind: kind as any, name: 'Lift A', stops: stops.map(([floorId, nodeId]) => ({ floorId, nodeId })) });

  it('creates an N-floor elevator and mirrors it as a chain of adjacent ElevatorLinks', async () => {
    const { service, tx } = build([stopNode('n3', 'f3', 3), stopNode('n1', 'f1', 1), stopNode('n2', 'f2', 2)]);
    await service.create(user, 'building-1', dto([['f3', 'n3'], ['f1', 'n1'], ['f2', 'n2']]));
    const pairs = tx.elevatorLink.create.mock.calls.map(([{ data }]: any) => [data.nodeLowId, data.nodeHighId]);
    expect(pairs).toEqual([['n1', 'n2'], ['n2', 'n3']]);
    expect(tx.floor.update).toHaveBeenCalledTimes(3);
  });

  it('does not mirror stairs or escalators into ElevatorLinks', async () => {
    const { service, tx } = build([stopNode('s1', 'f1', 1, NodeType.STAIR), stopNode('s2', 'f2', 2, NodeType.STAIR)]);
    await service.create(user, 'building-1', dto([['f1', 's1'], ['f2', 's2']], 'STAIR'));
    expect(tx.elevatorLink.create).not.toHaveBeenCalled();
  });

  it('rejects a node of the wrong type, a node on the wrong floor, two stops on one floor and an already-used node', async () => {
    expect(await codeOf(build([stopNode('n1', 'f1', 1, NodeType.NORMAL), stopNode('n2', 'f2', 2)]).service.create(user, 'building-1', dto([['f1', 'n1'], ['f2', 'n2']])))).toBe('INVALID_CONNECTOR');
    expect(await codeOf(build([stopNode('n1', 'f9', 1), stopNode('n2', 'f2', 2)]).service.create(user, 'building-1', dto([['f1', 'n1'], ['f2', 'n2']])))).toBe('INVALID_CONNECTOR');
    expect(await codeOf(build([stopNode('n1', 'f1', 1), stopNode('n2', 'f1', 1)]).service.create(user, 'building-1', dto([['f1', 'n1'], ['f1', 'n2']])))).toBe('INVALID_CONNECTOR');
    expect(await codeOf(build([stopNode('n1', 'f1', 1, NodeType.ELEVATOR, { connectorId: 'other' }), stopNode('n2', 'f2', 2)]).service.create(user, 'building-1', dto([['f1', 'n1'], ['f2', 'n2']])))).toBe('NODE_ALREADY_IN_CONNECTOR');
  });
});
