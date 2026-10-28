import { BadRequestException } from '@nestjs/common';
import { NodeType, UserRole } from '@prisma/client';
import { GraphValidatorService } from './graph-validator.service';

const user = { userId: 'u', role: UserRole.BUILDING_OWNER, tenantId: 't' };
const floor = { id: 'floor-1', buildingId: 'b', deletedAt: null, metersPerPixel: 0.1 as number | null, graphVersion: 7 };

function build(over: { floor?: Partial<typeof floor>; nodes?: unknown[]; edges?: unknown[]; stores?: unknown[]; connectors?: unknown[]; links?: unknown[] } = {}) {
  const prisma = {
    floor: { findFirst: jest.fn().mockResolvedValue(floor), findFirstOrThrow: jest.fn().mockResolvedValue({ ...floor, ...over.floor }) },
    node: { findMany: jest.fn().mockResolvedValue(over.nodes ?? [{ id: 'a', x: 0, y: 0, type: NodeType.NORMAL }, { id: 'exit', x: 100, y: 0, type: NodeType.EXIT }]) },
    edge: { findMany: jest.fn().mockResolvedValue(over.edges ?? [{ id: 'e', fromNodeId: 'a', toNodeId: 'exit', weightMeters: 10 }]) },
    store: { findMany: jest.fn().mockResolvedValue(over.stores ?? [{ id: 's', nodeId: 'a' }]) },
    poi: { findMany: jest.fn().mockResolvedValue([]) },
    qrAnchor: { findMany: jest.fn().mockResolvedValue([]) },
    connector: { findMany: jest.fn().mockResolvedValue(over.connectors ?? []) },
    elevatorLink: { findMany: jest.fn().mockResolvedValue(over.links ?? []) },
    $transaction: jest.fn((queries: Promise<unknown>[]) => Promise.all(queries)),
  } as any;
  return new GraphValidatorService(prisma, { building: jest.fn() } as any);
}

describe('GraphValidatorService', () => {
  it('reports a valid floor with its graph version', async () => {
    expect(await build().validate(user, floor.id)).toEqual({ floorId: floor.id, graphVersion: 7, valid: true, issues: [] });
  });

  it('blocks publishing an uncalibrated floor', async () => {
    const service = build({ floor: { metersPerPixel: null } });
    await expect(service.assertFloorCanPublish(floor.id)).rejects.toMatchObject({ response: { code: 'FLOOR_NOT_CALIBRATED' } });
  });

  it('keeps the UNLINKED_ELEVATOR_NODE code and node ids so existing clients still understand the failure', async () => {
    const service = build({ nodes: [{ id: 'a', x: 0, y: 0, type: NodeType.NORMAL }, { id: 'lift', x: 5, y: 5, type: NodeType.ELEVATOR }, { id: 'exit', x: 100, y: 0, type: NodeType.EXIT }], edges: [{ id: 'e1', fromNodeId: 'a', toNodeId: 'lift', weightMeters: 0.7071 }, { id: 'e2', fromNodeId: 'a', toNodeId: 'exit', weightMeters: 10 }] });
    const error = await service.assertFloorCanPublish(floor.id).catch((e) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.getResponse()).toMatchObject({ code: 'UNLINKED_ELEVATOR_NODE', nodeIds: ['lift'] });
    expect(error.getResponse().issues).toEqual(expect.any(Array));
  });

  it('does not block on warnings alone', async () => {
    const service = build({ nodes: [{ id: 'a', x: 0, y: 0, type: NodeType.NORMAL }, { id: 'exit', x: 100, y: 0, type: NodeType.EXIT }, { id: 'lonely', x: 9, y: 9, type: NodeType.NORMAL }] });
    const report = await service.assertFloorCanPublish(floor.id);
    expect(report.valid).toBe(true);
    expect(report.issues.map((issue) => issue.code)).toEqual(['ISOLATED_NODE']);
  });

  it('maps connector stops and legacy links onto the floor under validation', async () => {
    const service = build({
      nodes: [{ id: 'a', x: 0, y: 0, type: NodeType.NORMAL }, { id: 'lift', x: 5, y: 5, type: NodeType.ELEVATOR }, { id: 'exit', x: 100, y: 0, type: NodeType.EXIT }],
      edges: [{ id: 'e1', fromNodeId: 'a', toNodeId: 'lift', weightMeters: 0.7071 }, { id: 'e2', fromNodeId: 'a', toNodeId: 'exit', weightMeters: 10 }],
      connectors: [{ id: 'c', kind: 'ELEVATOR', stops: [{ floorId: floor.id, nodeId: 'lift' }, { floorId: 'floor-2', nodeId: 'lift-2' }] }],
    });
    expect((await service.validate(user, floor.id)).valid).toBe(true);
  });
});
