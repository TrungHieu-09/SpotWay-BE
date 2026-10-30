import { BuildingStatus, ConnectorKind, EdgeStatus, FloorPublishStatus, NodeType, StoreStatus, TenantStatus } from "@prisma/client";
import { GraphCacheService } from "../graph/application/graph-cache.service";
import { GraphSnapshotBuilder } from "../graph/application/graph-snapshot.builder";
import { NavigationService } from "./navigation.service";

describe("NavigationService.route", () => {
  const tenant = { id: "tenant", status: TenantStatus.ACTIVE, archived: false, deletedAt: null };
  const building = { id: "building", tenantId: tenant.id, status: BuildingStatus.ACTIVE, deletedAt: null, tenant };
  const floor = (id: string, floorNumber: number, metersPerPixel: number | null = 1) => ({
    id, buildingId: building.id, tenantId: tenant.id, floorNumber, metersPerPixel, graphVersion: 1,
    publishStatus: FloorPublishStatus.PUBLISHED, deletedAt: null, building,
  });
  const floor1 = floor("floor-1", 1);
  const floor2 = floor("floor-2", 2);
  const floor3 = floor("floor-3", 3);
  const node = (id: string, floorId = floor1.id, type: NodeType = NodeType.NORMAL) => ({ id, floorId, x: 0, y: 0, type, accessible: true, deletedAt: null });
  const edge = (fromNodeId: string, toNodeId: string, weightMeters: number, accessible = true, status: EdgeStatus = EdgeStatus.ACTIVE) => ({ fromNodeId, toNodeId, weightMeters, accessible, status });
  const connector = (id: string, kind: ConnectorKind, stops: Array<[string, string]>, accessible = true) => ({ id, kind, accessible, stops: stops.map(([floorId, nodeId]) => ({ floorId, nodeId })) });

  function setup(options: {
    nodes: ReturnType<typeof node>[];
    edges: ReturnType<typeof edge>[];
    floors?: Array<ReturnType<typeof floor>>;
    links?: Array<{ nodeIdFrom: string; nodeIdTo: string }>;
    connectors?: ReturnType<typeof connector>[];
    exitPoiNodeIds?: string[];
    storeTargetId?: string;
  }) {
    const floors = options.floors ?? [floor1, floor2, floor3];
    const floorOf = (id: string) => floors.find((item) => item.id === id)!;
    const source = { ...options.nodes[0], floor: floorOf(options.nodes[0].floorId) };
    const targetNode = options.storeTargetId ? options.nodes.find((item) => item.id === options.storeTargetId)! : undefined;
    const store = targetNode ? { id: "store", status: StoreStatus.ACTIVE, deletedAt: null, node: targetNode, floor: floorOf(targetNode.floorId) } : null;
    const prisma = {
      node: {
        findFirst: jest.fn().mockImplementation(({ where }: { where: { id: string } }) => {
          if (where.id === source.id) return Promise.resolve(source);
          const requested = options.nodes.find((item) => item.id === where.id);
          return Promise.resolve(requested ? { ...requested, floor: floorOf(requested.floorId), pois: [] } : null);
        }),
        findMany: jest.fn().mockResolvedValue(options.nodes),
      },
      store: { findFirst: jest.fn().mockResolvedValue(store) },
      floor: { findMany: jest.fn().mockResolvedValue(floors) },
      edge: { findMany: jest.fn().mockImplementation(({ where }: { where: { status?: EdgeStatus } }) => Promise.resolve(options.edges.filter((item) => !where.status || item.status === where.status))) },
      connector: { findMany: jest.fn().mockResolvedValue(options.connectors ?? []) },
      elevatorLink: { findMany: jest.fn().mockResolvedValue(options.links ?? []) },
      poi: { findMany: jest.fn().mockResolvedValue((options.exitPoiNodeIds ?? []).map((nodeId) => ({ nodeId }))) },
      $transaction: jest.fn((queries: Promise<unknown>[]) => Promise.all(queries)),
    };
    const analytics = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const cache = new GraphCacheService(new GraphSnapshotBuilder(prisma as never));
    return { service: new NavigationService(prisma as never, analytics as never, cache), prisma, cache };
  }
  const normal = (fromNodeId: string, extra: object = {}) => ({ fromNodeId, toStoreId: "store", wheelchairMode: false, ...extra });
  const codeOf = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { return (error as { getResponse(): { code: string } }).getResponse().code; } };

  it("routes across floors through a legacy elevator link in normal mode", async () => {
    const nodes = [node("start"), node("lift-1"), node("lift-2", floor2.id), node("target", floor2.id)];
    const { service } = setup({ nodes, edges: [edge("start", "lift-1", 2), edge("lift-2", "target", 3)], links: [{ nodeIdFrom: "lift-1", nodeIdTo: "lift-2" }], storeTargetId: "target" });
    const result = await service.route(normal("start"));
    expect(result.nodeIds).toEqual(["start", "lift-1", "lift-2", "target"]);
    expect(result.steps[1]).toMatchObject({ transition: "ELEVATOR", targetFloorId: floor2.id });
    expect(result.totalDistance).toBe(5);
  });

  it("charges a ride once plus the floors it crosses, so a 3-floor lift is one leg", async () => {
    const nodes = [node("start"), node("l1"), node("l2", floor2.id), node("l3", floor3.id), node("target", floor3.id)];
    const { service } = setup({
      nodes, edges: [edge("start", "l1", 1), edge("l3", "target", 1)], storeTargetId: "target",
      connectors: [connector("lift", ConnectorKind.ELEVATOR, [[floor1.id, "l1"], [floor2.id, "l2"], [floor3.id, "l3"]])],
    });
    const result = await service.route(normal("start"));
    expect(result.nodeIds).toEqual(["start", "l1", "l3", "target"]);
    expect(result.steps[1]).toMatchObject({ transition: "ELEVATOR", targetFloorId: floor3.id, instruction: "Take the elevator to floor 3" });
    expect(result.totalDistance).toBe(2);
    expect(result.estimatedDurationSeconds).toBe(Math.round(2 / 1.2 + 30 + 3 * 2));
  });

  it("returns turn-by-turn guidance and mode info, in Vietnamese when asked", async () => {
    const nodes = [node("start"), node("l1"), node("l2", floor2.id), node("target", floor2.id)];
    const { service } = setup({
      nodes, edges: [edge("start", "l1", 2), edge("l2", "target", 3)], storeTargetId: "target",
      connectors: [connector("lift", ConnectorKind.ELEVATOR, [[floor1.id, "l1"], [floor2.id, "l2"]])],
    });
    const vi = await service.route({ ...normal("start"), lang: "vi" } as never);
    expect(vi).toMatchObject({ effectiveMode: "NORMAL", requestedMode: "NORMAL", warnings: [] });
    expect(vi.steps[1]).toMatchObject({ maneuver: "ELEVATOR", waitSeconds: 30, transition: "ELEVATOR" });
    expect(vi.steps[1].instruction).toBe("Đi thang máy lên Tầng 2 (chờ ~30 s)");
    expect(vi.steps[0]).toMatchObject({ maneuver: "START", distanceMeters: 2 });
    expect(vi.steps[vi.steps.length - 1]).toMatchObject({ maneuver: "ARRIVE", instruction: "Đã đến điểm đến" });
    // mặc định giữ chữ tiếng Anh để client cũ không bị ảnh hưởng
    const en = await service.route(normal("start"));
    expect(en.steps[0].instruction).toBe("Continue to the next point");
  });

  it("prefers stairs for one floor and a lift for several", async () => {
    const nodes = [node("start"), node("lift-1"), node("stair-1"), node("lift-2", floor2.id), node("stair-2", floor2.id), node("lift-3", floor3.id), node("stair-3", floor3.id), node("t2", floor2.id), node("t3", floor3.id)];
    const connectors = [
      connector("lift", ConnectorKind.ELEVATOR, [[floor1.id, "lift-1"], [floor2.id, "lift-2"], [floor3.id, "lift-3"]]),
      connector("stairs", ConnectorKind.STAIR, [[floor1.id, "stair-1"], [floor2.id, "stair-2"], [floor3.id, "stair-3"]]),
    ];
    const edges = [edge("start", "lift-1", 1), edge("start", "stair-1", 1), edge("lift-2", "t2", 1), edge("stair-2", "t2", 1), edge("lift-3", "t3", 1), edge("stair-3", "t3", 1)];
    const oneFloor = await setup({ nodes, edges, connectors, storeTargetId: "t2" }).service.route(normal("start"));
    expect(oneFloor.steps[1]).toMatchObject({ transition: "STAIR" });
    const twoFloors = await setup({ nodes, edges, connectors, storeTargetId: "t3" }).service.route(normal("start"));
    expect(twoFloors.steps[1]).toMatchObject({ transition: "ELEVATOR" });
  });

  it("ignores inaccessible and BLOCKED edges in wheelchair mode and never takes stairs", async () => {
    const nodes = [node("start"), node("blocked"), node("inaccessible"), node("safe"), node("target"), node("s1"), node("s2", floor2.id), node("top", floor2.id)];
    const { service } = setup({
      nodes, storeTargetId: "target",
      edges: [
        edge("start", "blocked", 1), edge("blocked", "target", 1, true, EdgeStatus.BLOCKED),
        edge("start", "inaccessible", 1, false), edge("inaccessible", "target", 1, false),
        edge("start", "safe", 3), edge("safe", "target", 3),
      ],
    });
    expect((await service.route(normal("start", { wheelchairMode: true }))).nodeIds).toEqual(["start", "safe", "target"]);

    const stairsOnly = setup({ nodes, storeTargetId: "top", edges: [edge("start", "s1", 1), edge("s2", "top", 1)], connectors: [connector("st", ConnectorKind.STAIR, [[floor1.id, "s1"], [floor2.id, "s2"]])] });
    expect(await codeOf(stairsOnly.service.route(normal("start", { wheelchairMode: true })))).toBe("NO_ROUTE_FOUND");
    expect((await stairsOnly.service.route(normal("start"))).nodeIds).toEqual(["start", "s1", "s2", "top"]);
  });

  it("never uses an elevator during evacuation, but may use stairs, and selects a reachable exit", async () => {
    const nodes = [node("start"), node("lift-1"), node("local-exit", floor1.id, NodeType.EMERGENCY_EXIT), node("lift-2", floor2.id), node("remote-exit", floor2.id, NodeType.EXIT)];
    const { service } = setup({ nodes, edges: [edge("start", "lift-1", 1), edge("lift-2", "remote-exit", 1), edge("start", "local-exit", 10)], links: [{ nodeIdFrom: "lift-1", nodeIdTo: "lift-2" }] });
    const result = await service.route({ fromNodeId: "start", wheelchairMode: false, mode: "EVACUATION" });
    expect(result.nodeIds).toEqual(["start", "local-exit"]);

    const stairNodes = [node("start"), node("st-1"), node("st-2", floor2.id), node("exit-up", floor2.id, NodeType.EXIT)];
    const viaStairs = setup({ nodes: stairNodes, edges: [edge("start", "st-1", 1), edge("st-2", "exit-up", 1)], connectors: [connector("st", ConnectorKind.STAIR, [[floor1.id, "st-1"], [floor2.id, "st-2"]])] });
    expect((await viaStairs.service.route({ fromNodeId: "start", wheelchairMode: false, mode: "EVACUATION" })).nodeIds).toEqual(["start", "st-1", "st-2", "exit-up"]);
  });

  it("reroutes around hazard nodes to another safe exit", async () => {
    const nodes = [node("start"), node("fire"), node("safe"), node("exit-1", floor1.id, NodeType.EXIT), node("exit-2", floor1.id, NodeType.EMERGENCY_EXIT)];
    const { service } = setup({ nodes, edges: [edge("start", "fire", 1), edge("fire", "exit-1", 1), edge("start", "safe", 4), edge("safe", "exit-2", 1)] });
    const result = await service.route({ fromNodeId: "start", wheelchairMode: false, mode: "EVACUATION", hazardNodeIds: ["fire"] });
    expect(result.nodeIds).toEqual(["start", "safe", "exit-2"]);
  });

  it("automatically applies evacuation rules for an explicit emergency exit target", async () => {
    const nodes = [node("start"), node("exit", floor1.id, NodeType.EMERGENCY_EXIT)];
    const { service } = setup({ nodes, edges: [edge("start", "exit", 2)] });
    const result = await service.route({ fromNodeId: "start", toNodeId: "exit", wheelchairMode: false });
    expect(result.nodeIds).toEqual(["start", "exit"]);
    expect(result.steps.at(-1)?.instruction).toBe("You have reached a safe exit");
  });

  it("uses legacy EXIT POIs as evacuation targets", async () => {
    const { service } = setup({ nodes: [node("start"), node("poi-exit")], edges: [edge("start", "poi-exit", 2)], exitPoiNodeIds: ["poi-exit"] });
    const result = await service.route({ fromNodeId: "start", wheelchairMode: false, mode: "EVACUATION" });
    expect(result.nodeIds).toEqual(["start", "poi-exit"]);
  });

  describe("graph cache", () => {
    it("loads the building graph once for repeated routes and reloads only when a graphVersion changes", async () => {
      const nodes = [node("start"), node("target")];
      const { service, prisma } = setup({ nodes, edges: [edge("start", "target", 2)], storeTargetId: "target" });
      await service.route(normal("start"));
      await service.route(normal("start"));
      await service.route(normal("start"));
      expect(prisma.edge.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.node.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.floor.findMany).toHaveBeenCalledTimes(3); // the cheap version probe runs every time
      prisma.floor.findMany.mockResolvedValue([{ ...floor1, graphVersion: 2 }, floor2, floor3]);
      await service.route(normal("start"));
      expect(prisma.edge.findMany).toHaveBeenCalledTimes(2);
    });
  });

  describe("uncalibrated floors", () => {
    it("refuses a route that starts on an uncalibrated floor instead of guessing distances", async () => {
      const uncalibrated = floor("floor-1", 1, null);
      const nodes = [node("start"), node("target")];
      const { service } = setup({ nodes, floors: [uncalibrated, floor2, floor3], edges: [{ ...edge("start", "target", 2), weightMeters: null as never }], storeTargetId: "target" });
      expect(await codeOf(service.route(normal("start")))).toBe("FLOOR_NOT_CALIBRATED");
    });

    it("reports FLOOR_NOT_CALIBRATED rather than NO_ROUTE when the missing link may be on an unmeasured floor", async () => {
      const nodes = [node("start"), node("lift-1"), node("lift-2", floor2.id), node("target", floor2.id)];
      const { service } = setup({
        nodes, floors: [floor1, floor("floor-2", 2, null), floor3], storeTargetId: "target",
        edges: [edge("start", "lift-1", 1), { ...edge("lift-2", "target", 1), weightMeters: null as never }],
        connectors: [connector("lift", ConnectorKind.ELEVATOR, [[floor1.id, "lift-1"], [floor2.id, "lift-2"]])],
      });
      expect(await codeOf(service.route(normal("start")))).toBe("FLOOR_NOT_CALIBRATED");
    });
  });
});
