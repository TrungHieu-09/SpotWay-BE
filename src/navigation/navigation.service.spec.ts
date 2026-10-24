import {
  BuildingStatus,
  EdgeStatus,
  FloorPublishStatus,
  NodeType,
  StoreStatus,
  TenantStatus,
} from "@prisma/client";
import { NavigationService, dijkstra } from "./navigation.service";

describe("dijkstra", () => {
  it("selects the lowest total weight path", () => {
    const graph = new Map([
      [
        "a",
        [
          { to: "b", weight: 10, kind: "WALK" as const },
          { to: "c", weight: 2, kind: "WALK" as const },
        ],
      ],
      ["b", [{ to: "d", weight: 1, kind: "WALK" as const }]],
      [
        "c",
        [
          { to: "b", weight: 2, kind: "WALK" as const },
          { to: "d", weight: 20, kind: "WALK" as const },
        ],
      ],
      ["d", []],
    ]);
    expect(dijkstra(graph, "a", "d")).toEqual({
      distance: 5,
      nodeIds: ["a", "c", "b", "d"],
      edges: [
        { to: "c", weight: 2, kind: "WALK" },
        { to: "b", weight: 2, kind: "WALK" },
        { to: "d", weight: 1, kind: "WALK" },
      ],
    });
  });

  it("returns null when no path exists", () => {
    const graph = new Map([
      ["a", []],
      ["b", []],
    ]);
    expect(dijkstra(graph, "a", "b")).toBeNull();
  });

  it("finds the nearest target while excluding hazards and elevators", () => {
    const graph = new Map([
      [
        "start",
        [
          { to: "fire", weight: 1, kind: "WALK" as const },
          { to: "safe", weight: 4, kind: "WALK" as const },
          { to: "lift", weight: 1, kind: "ELEVATOR" as const },
        ],
      ],
      ["fire", [{ to: "exit-near", weight: 1, kind: "WALK" as const }]],
      ["safe", [{ to: "exit-safe", weight: 1, kind: "WALK" as const }]],
      ["lift", [{ to: "exit-lift", weight: 1, kind: "WALK" as const }]],
      ["exit-near", []],
      ["exit-safe", []],
      ["exit-lift", []],
    ]);
    expect(
      dijkstra(
        graph,
        "start",
        new Set(["exit-near", "exit-safe", "exit-lift"]),
        {
          blockedNodeIds: new Set(["fire"]),
          excludedKinds: new Set(["ELEVATOR"]),
        },
      ),
    ).toEqual({
      distance: 5,
      nodeIds: ["start", "safe", "exit-safe"],
      edges: [
        { to: "safe", weight: 4, kind: "WALK" },
        { to: "exit-safe", weight: 1, kind: "WALK" },
      ],
    });
  });
});

describe("NavigationService.route", () => {
  const tenant = {
    id: "tenant",
    status: TenantStatus.ACTIVE,
    archived: false,
    deletedAt: null,
  };
  const building = {
    id: "building",
    tenantId: tenant.id,
    status: BuildingStatus.ACTIVE,
    deletedAt: null,
    tenant,
  };
  const floor = (id: string, floorNumber: number) => ({
    id,
    buildingId: building.id,
    tenantId: tenant.id,
    floorNumber,
    publishStatus: FloorPublishStatus.PUBLISHED,
    deletedAt: null,
    building,
  });
  const floor1 = floor("floor-1", 1);
  const floor2 = floor("floor-2", 2);
  const node = (
    id: string,
    floorId = floor1.id,
    type: NodeType = NodeType.NORMAL,
  ) => ({ id, floorId, x: 0, y: 0, type, accessible: true, deletedAt: null });
  const edge = (
    fromNodeId: string,
    toNodeId: string,
    weight: number,
    accessible = true,
    status: EdgeStatus = EdgeStatus.ACTIVE,
  ) => ({ fromNodeId, toNodeId, weight, accessible, status });

  function setup(options: {
    nodes: ReturnType<typeof node>[];
    edges: ReturnType<typeof edge>[];
    links?: Array<{ nodeIdFrom: string; nodeIdTo: string }>;
    exitPoiNodeIds?: string[];
    storeTargetId?: string;
  }) {
    const source = { ...options.nodes[0], floor: floor1 };
    const targetNode = options.storeTargetId
      ? options.nodes.find((item) => item.id === options.storeTargetId)!
      : undefined;
    const store = targetNode
      ? {
          id: "store",
          status: StoreStatus.ACTIVE,
          deletedAt: null,
          node: targetNode,
          floor: targetNode.floorId === floor1.id ? floor1 : floor2,
        }
      : null;
    const prisma = {
      node: {
        findFirst: jest
          .fn()
          .mockImplementation(({ where }: { where: { id: string } }) => {
            if (where.id === source.id) return Promise.resolve(source);
            const requested = options.nodes.find(
              (item) => item.id === where.id,
            );
            return Promise.resolve(
              requested
                ? {
                    ...requested,
                    floor: requested.floorId === floor1.id ? floor1 : floor2,
                    pois: [],
                  }
                : null,
            );
          }),
        findMany: jest.fn().mockResolvedValue(options.nodes),
      },
      store: { findFirst: jest.fn().mockResolvedValue(store) },
      floor: { findMany: jest.fn().mockResolvedValue([floor1, floor2]) },
      edge: { findMany: jest.fn().mockResolvedValue(options.edges) },
      elevatorLink: {
        findMany: jest.fn().mockResolvedValue(options.links ?? []),
      },
      poi: {
        findMany: jest
          .fn()
          .mockResolvedValue(
            (options.exitPoiNodeIds ?? []).map((nodeId) => ({ nodeId })),
          ),
      },
      $transaction: jest.fn((queries: Promise<unknown>[]) =>
        Promise.all(queries),
      ),
    };
    const analytics = { enqueue: jest.fn().mockResolvedValue(undefined) };
    return {
      service: new NavigationService(prisma as never, analytics as never),
      prisma,
    };
  }

  it("routes across floors through an elevator in normal mode", async () => {
    const nodes = [
      node("start"),
      node("lift-1"),
      node("lift-2", floor2.id),
      node("target", floor2.id),
    ];
    const { service } = setup({
      nodes,
      edges: [edge("start", "lift-1", 2), edge("lift-2", "target", 3)],
      links: [{ nodeIdFrom: "lift-1", nodeIdTo: "lift-2" }],
      storeTargetId: "target",
    });
    const result = await service.route({
      fromNodeId: "start",
      toStoreId: "store",
      wheelchairMode: false,
    });
    expect(result.nodeIds).toEqual(["start", "lift-1", "lift-2", "target"]);
    expect(result.steps[1]).toMatchObject({
      transition: "ELEVATOR",
      targetFloorId: floor2.id,
    });
  });

  it("ignores inaccessible and BLOCKED edges in wheelchair mode", async () => {
    const nodes = [
      node("start"),
      node("blocked"),
      node("inaccessible"),
      node("safe"),
      node("target"),
    ];
    const { service, prisma } = setup({
      nodes,
      edges: [
        edge("start", "blocked", 1),
        edge("blocked", "target", 1, true, EdgeStatus.BLOCKED),
        edge("start", "inaccessible", 1, false),
        edge("inaccessible", "target", 1, false),
        edge("start", "safe", 3),
        edge("safe", "target", 3),
      ],
      storeTargetId: "target",
    });
    const result = await service.route({
      fromNodeId: "start",
      toStoreId: "store",
      wheelchairMode: true,
    });
    expect(result.nodeIds).toEqual(["start", "safe", "target"]);
    expect(prisma.edge.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          accessible: true,
          status: EdgeStatus.ACTIVE,
        }),
      }),
    );
  });

  it("never uses an elevator during evacuation and selects a reachable exit", async () => {
    const nodes = [
      node("start"),
      node("lift-1"),
      node("local-exit", floor1.id, NodeType.EMERGENCY_EXIT),
      node("lift-2", floor2.id),
      node("remote-exit", floor2.id, NodeType.EXIT),
    ];
    const { service } = setup({
      nodes,
      edges: [
        edge("start", "lift-1", 1),
        edge("lift-2", "remote-exit", 1),
        edge("start", "local-exit", 10),
      ],
      links: [{ nodeIdFrom: "lift-1", nodeIdTo: "lift-2" }],
    });
    const result = await service.route({
      fromNodeId: "start",
      wheelchairMode: false,
      mode: "EVACUATION",
    });
    expect(result.nodeIds).toEqual(["start", "local-exit"]);
    expect(
      result.steps.every(
        (step) => !("transition" in step) || step.transition !== "ELEVATOR",
      ),
    ).toBe(true);
  });

  it("reroutes around hazard nodes to another safe exit", async () => {
    const nodes = [
      node("start"),
      node("fire"),
      node("safe"),
      node("exit-1", floor1.id, NodeType.EXIT),
      node("exit-2", floor1.id, NodeType.EMERGENCY_EXIT),
    ];
    const { service } = setup({
      nodes,
      edges: [
        edge("start", "fire", 1),
        edge("fire", "exit-1", 1),
        edge("start", "safe", 4),
        edge("safe", "exit-2", 1),
      ],
    });
    const result = await service.route({
      fromNodeId: "start",
      wheelchairMode: false,
      mode: "EVACUATION",
      hazardNodeIds: ["fire"],
    });
    expect(result.nodeIds).toEqual(["start", "safe", "exit-2"]);
  });

  it("automatically applies evacuation rules for an explicit emergency exit target", async () => {
    const nodes = [
      node("start"),
      node("exit", floor1.id, NodeType.EMERGENCY_EXIT),
    ];
    const { service } = setup({
      nodes,
      edges: [edge("start", "exit", 2)],
    });
    const result = await service.route({
      fromNodeId: "start",
      toNodeId: "exit",
      wheelchairMode: false,
    });
    expect(result.nodeIds).toEqual(["start", "exit"]);
    expect(result.steps.at(-1)?.instruction).toBe(
      "You have reached a safe exit",
    );
  });

  it("uses legacy EXIT POIs as evacuation targets", async () => {
    const nodes = [node("start"), node("poi-exit")];
    const { service } = setup({
      nodes,
      edges: [edge("start", "poi-exit", 2)],
      exitPoiNodeIds: ["poi-exit"],
    });
    const result = await service.route({
      fromNodeId: "start",
      wheelchairMode: false,
      mode: "EVACUATION",
    });
    expect(result.nodeIds).toEqual(["start", "poi-exit"]);
  });
});
