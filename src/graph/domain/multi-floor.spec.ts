import { NodeType } from '@prisma/client';
import { validateFloorGraph } from './graph-validator';
import { planRoute } from './pathfinding/route-planner';
import { assembleSnapshot } from './snapshot-assembler';

/** One corridor per floor (door - lift), one lift serving every floor, floor numbers deliberately not 1..N. */
function building(floorNumbers: number[]) {
  const floors = floorNumbers.map((floorNumber, i) => ({ id: `f${i}`, floorNumber, metersPerPixel: 0.1, graphVersion: 1 }));
  const nodes = floors.flatMap((floor) => [
    { id: `${floor.id}-door`, floorId: floor.id, x: 0, y: 0, type: NodeType.NORMAL },
    { id: `${floor.id}-lift`, floorId: floor.id, x: 100, y: 0, type: NodeType.ELEVATOR },
  ]);
  const edges = floors.map((floor) => ({ fromNodeId: `${floor.id}-door`, toNodeId: `${floor.id}-lift`, weightMeters: 10, accessible: true }));
  const connectors = [{ id: 'lift', kind: 'ELEVATOR' as const, accessible: true, stops: floors.map((floor) => ({ floorId: floor.id, nodeId: `${floor.id}-lift` })) }];
  return { floors, snapshot: assembleSnapshot({ buildingId: 'b', floors, nodes, edges, connectors, legacyLinks: [], exitPoiNodeIds: [] }) };
}

describe.each([[2, [1, 2]], [5, [-1, 0, 1, 2, 3]], [12, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]], [4, [1, 3, 10, 40]]])('a building with %i floors', (count, numbers) => {
  const { floors, snapshot } = building(numbers);

  it('routes between the first and the last floor on one lift ride', () => {
    const route = planRoute(snapshot, 'f0-door', `f${count - 1}-door`)!;
    const rides = route.legs.filter((leg) => leg.kind === 'ELEVATOR');
    expect(rides).toHaveLength(1);
    expect(route.walkMeters).toBe(20);
    expect(rides[0].rideSeconds).toBe(30 + 3 * (numbers[count - 1] - numbers[0]));
  });

  it('routes between any two floors', () => {
    for (const from of floors) for (const to of floors) {
      if (from.id === to.id) continue;
      expect(planRoute(snapshot, `${from.id}-door`, `${to.id}-door`)).not.toBeNull();
    }
  });
});

describe('floor validation does not depend on how many floors the building has', () => {
  const lift = (floorCount: number) => ({ id: 'c', kind: 'ELEVATOR' as const, stopFloorIds: Array.from({ length: floorCount }, (_, i) => `f${i}`), floorNodeIds: ['lift'] });
  const floorWith = (floorCount: number) => ({
    metersPerPixel: 0.1,
    nodes: [{ id: 'door', x: 0, y: 0, type: NodeType.EXIT }, { id: 'lift', x: 100, y: 0, type: NodeType.ELEVATOR }],
    edges: [{ id: 'e', fromNodeId: 'door', toNodeId: 'lift', weightMeters: 10 }],
    stores: [], pois: [], qrAnchors: [], connectors: [lift(floorCount)], legacyLinkedNodeIds: [],
  });

  it.each([2, 3, 10, 50])('accepts a lift that serves %i floors', (floorCount) => {
    expect(validateFloorGraph(floorWith(floorCount))).toEqual([]);
  });

  it('still rejects a lift that serves one floor', () => {
    expect(validateFloorGraph(floorWith(1)).map((issue) => issue.code)).toContain('CONNECTOR_TOO_FEW_FLOORS');
  });
});
