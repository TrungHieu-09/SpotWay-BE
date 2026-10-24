import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { BuildingStatus, EdgeStatus, FloorPublishStatus, NodeType, PoiCategory, StoreStatus, TenantStatus } from '@prisma/client';
import { pageMeta } from '../common/pagination';
import { PrismaService } from '../database/prisma.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { CreateRouteDto, PublicSearchQuery } from './navigation.dto';

export type GraphEdge = {
  to: string;
  weight: number;
  kind: "WALK" | "ELEVATOR";
};
export type Graph = Map<string, GraphEdge[]>;
export type DijkstraResult = {
  distance: number;
  nodeIds: string[];
  edges: GraphEdge[];
} | null;
export type DijkstraOptions = {
  blockedNodeIds?: ReadonlySet<string>;
  excludedKinds?: ReadonlySet<GraphEdge["kind"]>;
};

export function dijkstra(
  graph: Graph,
  source: string,
  target: string | ReadonlySet<string>,
  options: DijkstraOptions = {},
): DijkstraResult {
  const targets = typeof target === "string" ? new Set([target]) : target;
  if (!targets.size || options.blockedNodeIds?.has(source)) return null;
  const distances = new Map<string, number>([[source, 0]]);
  const previous = new Map<string, { nodeId: string; edge: GraphEdge }>();
  const queue: Array<{ nodeId: string; distance: number }> = [
    { nodeId: source, distance: 0 },
  ];
  let reachedTarget: string | undefined;
  while (queue.length) {
    queue.sort((a, b) => a.distance - b.distance);
    const current = queue.shift()!;
    if (current.distance !== distances.get(current.nodeId)) continue;
    if (targets.has(current.nodeId)) {
      reachedTarget = current.nodeId;
      break;
    }
    for (const edge of graph.get(current.nodeId) ?? []) {
      if (
        options.blockedNodeIds?.has(edge.to) ||
        options.excludedKinds?.has(edge.kind)
      )
        continue;
      const candidate = current.distance + edge.weight;
      if (candidate < (distances.get(edge.to) ?? Number.POSITIVE_INFINITY)) {
        distances.set(edge.to, candidate);
        previous.set(edge.to, { nodeId: current.nodeId, edge });
        queue.push({ nodeId: edge.to, distance: candidate });
      }
    }
  }
  if (!reachedTarget) return null;
  const distance = distances.get(reachedTarget)!;
  const nodeIds = [reachedTarget];
  const edges: GraphEdge[] = [];
  while (nodeIds[0] !== source) {
    const item = previous.get(nodeIds[0]);
    if (!item) return null;
    edges.unshift(item.edge);
    nodeIds.unshift(item.nodeId);
  }
  return { distance, nodeIds, edges };
}

@Injectable()
export class NavigationService {
  constructor(private readonly prisma: PrismaService, private readonly analytics: AnalyticsService) {}
  private readonly elevatorWeight = Number(process.env.ELEVATOR_TRANSITION_WEIGHT ?? 20);
  private readonly unitsPerMeter = Number(process.env.MAP_UNITS_PER_METER ?? 1);
  private readonly walkingSpeed = Number(process.env.ROUTE_WALKING_SPEED_MPS ?? 1.2);

  private activeBuildingWhere(id: string) { return { id, status: BuildingStatus.ACTIVE, deletedAt: null, tenant: { is: { status: TenantStatus.ACTIVE, archived: false, deletedAt: null } } }; }
  private async activeBuilding(id: string) { const building = await this.prisma.building.findFirst({ where: this.activeBuildingWhere(id) }); if (!building) throw new NotFoundException({ code: 'PUBLIC_BUILDING_NOT_FOUND', message: 'Published building not found' }); return building; }
  private async publishedFloors(buildingId: string) { return this.prisma.floor.findMany({ where: { buildingId, publishStatus: FloorPublishStatus.PUBLISHED, deletedAt: null }, orderBy: { floorNumber: 'asc' } }); }

  async listFloors(buildingId: string) { const building = await this.activeBuilding(buildingId); const floors = await this.publishedFloors(buildingId); void this.analytics.enqueue({ eventType: 'MAP_VIEWED', tenantId: building.tenantId, buildingId }).catch(() => undefined); return floors; }
  async map(floorId: string) {
    const floor = await this.prisma.floor.findFirst({ where: { id: floorId, publishStatus: FloorPublishStatus.PUBLISHED, deletedAt: null, building: { is: { status: BuildingStatus.ACTIVE, deletedAt: null, tenant: { is: { status: TenantStatus.ACTIVE, archived: false, deletedAt: null } } } } } });
    if (!floor) throw new NotFoundException({ code: 'PUBLIC_FLOOR_NOT_FOUND', message: 'Published floor not found' });
    const [nodes, edges, pois, stores] = await this.prisma.$transaction([
      this.prisma.node.findMany({ where: { floorId, deletedAt: null }, orderBy: { createdAt: 'asc' } }),
      this.prisma.edge.findMany({ where: { floorId, deletedAt: null }, orderBy: { createdAt: 'asc' } }),
      this.prisma.poi.findMany({ where: { floorId, deletedAt: null }, orderBy: { createdAt: 'asc' } }),
      this.prisma.store.findMany({ where: { floorId, deletedAt: null, status: StoreStatus.ACTIVE }, orderBy: { name: 'asc' } }),
    ]);
    void this.analytics.enqueue({ eventType: 'MAP_VIEWED', tenantId: floor.tenantId, buildingId: floor.buildingId, floorId }).catch(() => undefined);
    return { floor, nodes, edges, pois, stores };
  }

  async search(buildingId: string, query: PublicSearchQuery) {
    await this.activeBuilding(buildingId); const floors = await this.publishedFloors(buildingId); const floorIds = floors.map(({ id }) => id); if (!floorIds.length) return { items: [], pagination: pageMeta(query.page, query.limit, 0) };
    const term = query.q?.trim(); const nameFilter = term ? { contains: term, mode: 'insensitive' as const } : undefined;
    const [stores, pois, nodes] = await Promise.all([
      query.type === 'POI' || query.type === 'NODE' ? [] : this.prisma.store.findMany({ where: { floorId: { in: floorIds }, deletedAt: null, status: StoreStatus.ACTIVE, ...(nameFilter ? { name: nameFilter } : {}), node: { is: { deletedAt: null } } }, include: { node: true } }),
      query.type === 'STORE' || query.type === 'NODE' ? [] : this.prisma.poi.findMany({ where: { floorId: { in: floorIds }, deletedAt: null, ...(nameFilter ? { name: nameFilter } : {}), node: { is: { deletedAt: null } } }, include: { node: true } }),
      query.type === 'STORE' || query.type === 'POI' ? [] : this.prisma.node.findMany({ where: { floorId: { in: floorIds }, deletedAt: null, name: { not: null, ...(nameFilter ?? {}) } } }),
    ]);
    const items = [...stores.map((store) => ({ type: 'STORE' as const, id: store.id, name: store.name, floorId: store.floorId, nodeId: store.nodeId!, x: store.node!.x, y: store.node!.y })), ...pois.map((poi) => ({ type: 'POI' as const, id: poi.id, name: poi.name, floorId: poi.floorId, nodeId: poi.nodeId, x: poi.node.x, y: poi.node.y })), ...nodes.map((node) => ({ type: 'NODE' as const, id: node.id, name: node.name!, floorId: node.floorId, nodeId: node.id, x: node.x, y: node.y }))].sort((a, b) => a.name.localeCompare(b.name));
    const total = items.length; void this.analytics.enqueue({ eventType: 'SEARCH_PERFORMED', tenantId: floors[0].tenantId, buildingId, context: { query: term ?? null, resultCount: total, type: query.type ?? 'ALL' } }).catch(() => undefined); return { items: items.slice((query.page - 1) * query.limit, query.page * query.limit), pagination: pageMeta(query.page, query.limit, total) };
  }

  async route(dto: CreateRouteDto) {
    const mode = dto.mode ?? "NORMAL";
    if (dto.toStoreId && dto.toNodeId)
      throw new BadRequestException({
        code: "AMBIGUOUS_ROUTE_TARGET",
        message: "Provide either toStoreId or toNodeId, not both",
      });
    if (mode === "NORMAL" && !dto.toStoreId && !dto.toNodeId)
      throw new BadRequestException({
        code: "ROUTE_TARGET_REQUIRED",
        message:
          "A store or emergency exit target is required for normal routing",
      });
    const [source, store, requestedTarget] = await Promise.all([
      this.prisma.node.findFirst({
        where: { id: dto.fromNodeId, deletedAt: null },
        include: {
          floor: { include: { building: { include: { tenant: true } } } },
        },
      }),
      dto.toStoreId
        ? this.prisma.store.findFirst({
            where: {
              id: dto.toStoreId,
              deletedAt: null,
              status: StoreStatus.ACTIVE,
            },
            include: {
              node: true,
              floor: { include: { building: { include: { tenant: true } } } },
            },
          })
        : Promise.resolve(null),
      dto.toNodeId
        ? this.prisma.node.findFirst({
            where: { id: dto.toNodeId, deletedAt: null },
            include: {
              pois: { where: { category: PoiCategory.EXIT, deletedAt: null } },
              floor: { include: { building: { include: { tenant: true } } } },
            },
          })
        : Promise.resolve(null),
    ]);
    if (
      !source ||
      (mode === "NORMAL" &&
        dto.toStoreId &&
        (!store?.node || store.node.deletedAt)) ||
      (dto.toNodeId && !requestedTarget)
    )
      throw new NotFoundException({
        code: "ROUTE_ENDPOINT_NOT_FOUND",
        message: "Route source or destination is not available",
      });
    const requestedTargetIsExit =
      (!!requestedTarget &&
        ([NodeType.EXIT, NodeType.EMERGENCY_EXIT] as NodeType[]).includes(
          requestedTarget.type,
        )) ||
      !!requestedTarget?.pois.length;
    if (requestedTarget && !requestedTargetIsExit)
      throw new BadRequestException({
        code: "INVALID_EMERGENCY_EXIT",
        message: "toNodeId must identify an EXIT or EMERGENCY_EXIT node",
      });
    const evacuation = mode === "EVACUATION" || requestedTargetIsExit;
    const endpointFloor = requestedTarget?.floor ??
      (!evacuation ? store?.floor : undefined);
    if (endpointFloor && source.floor.buildingId !== endpointFloor.buildingId)
      throw new BadRequestException({
        code: "INVALID_ROUTE_SCOPE",
        message: "Route endpoints must belong to the same building",
      });
    const building = source.floor.building;
    if (
      building.status !== BuildingStatus.ACTIVE ||
      building.deletedAt ||
      building.tenant.status !== TenantStatus.ACTIVE ||
      building.tenant.archived ||
      building.tenant.deletedAt ||
      source.floor.publishStatus !== FloorPublishStatus.PUBLISHED ||
      source.floor.deletedAt ||
      (endpointFloor &&
        (endpointFloor.publishStatus !== FloorPublishStatus.PUBLISHED ||
          endpointFloor.deletedAt))
    )
      throw new NotFoundException({
        code: "ROUTE_NOT_PUBLISHED",
        message: "Route endpoints must be published and available",
      });
    const floors = await this.publishedFloors(building.id);
    const floorIds = floors.map(({ id }) => id);
    const [nodes, edges, links, exitPois] = await this.prisma.$transaction([
      this.prisma.node.findMany({
        where: { floorId: { in: floorIds }, deletedAt: null },
      }),
      this.prisma.edge.findMany({
        where: {
          floorId: { in: floorIds },
          deletedAt: null,
          status: EdgeStatus.ACTIVE,
          ...(dto.wheelchairMode ? { accessible: true } : {}),
        },
      }),
      this.prisma.elevatorLink.findMany({
        where: { buildingId: building.id, deletedAt: null },
      }),
      this.prisma.poi.findMany({
        where: {
          floorId: { in: floorIds },
          deletedAt: null,
          category: PoiCategory.EXIT,
        },
        select: { nodeId: true },
      }),
    ]);
    const blockedNodeIds = new Set([
      ...(dto.hazardNodeIds ?? []),
      ...(dto.blockedNodeIds ?? []),
    ]);
    const availableNodes = nodes.filter((node) => !blockedNodeIds.has(node.id));
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    const graph: Graph = new Map(availableNodes.map((node) => [node.id, []]));
    const add = (from: string, edge: GraphEdge) => {
      const list = graph.get(from);
      if (list) list.push(edge);
    };
    for (const edge of edges)
      if (
        edge.status === EdgeStatus.ACTIVE &&
        (!dto.wheelchairMode || edge.accessible) &&
        graph.has(edge.fromNodeId) &&
        graph.has(edge.toNodeId)
      ) {
        add(edge.fromNodeId, {
          to: edge.toNodeId,
          weight: edge.weight,
          kind: "WALK",
        });
        add(edge.toNodeId, {
          to: edge.fromNodeId,
          weight: edge.weight,
          kind: "WALK",
        });
      }
    if (!evacuation)
      for (const link of links) {
        const from = nodesById.get(link.nodeIdFrom);
        const to = nodesById.get(link.nodeIdTo);
        if (
          from &&
          to &&
          from.floorId !== to.floorId &&
          graph.has(from.id) &&
          graph.has(to.id)
        ) {
          add(from.id, {
            to: to.id,
            weight: this.elevatorWeight,
            kind: "ELEVATOR",
          });
          add(to.id, {
            to: from.id,
            weight: this.elevatorWeight,
            kind: "ELEVATOR",
          });
        }
      }
    const exitNodeIds = new Set(
      [
        ...nodes
          .filter(
            (node) =>
              node.type === NodeType.EXIT ||
              node.type === NodeType.EMERGENCY_EXIT,
          )
          .map((node) => node.id),
        ...exitPois.map((poi) => poi.nodeId),
      ].filter((nodeId) => graph.has(nodeId)),
    );
    const targetIds = evacuation
      ? requestedTarget
        ? new Set([requestedTarget.id])
        : exitNodeIds
      : new Set([store!.node!.id]);
    const routeContext = {
      fromNodeId: source.id,
      toStoreId: store?.id ?? null,
      toNodeId: requestedTarget?.id ?? null,
      wheelchairMode: dto.wheelchairMode,
      mode: evacuation ? "EVACUATION" : "NORMAL",
      hazardNodeIds: [...blockedNodeIds],
    };
    void this.analytics
      .enqueue({
        eventType: "ROUTE_REQUESTED",
        tenantId: building.tenantId,
        buildingId: building.id,
        floorId: source.floorId,
        context: routeContext,
      })
      .catch(() => undefined);
    const result = dijkstra(graph, source.id, targetIds, {
      blockedNodeIds,
      excludedKinds: evacuation ? new Set(["ELEVATOR"]) : undefined,
    });
    if (!result) {
      void this.analytics
        .enqueue({
          eventType: "ROUTE_NOT_FOUND",
          tenantId: building.tenantId,
          buildingId: building.id,
          floorId: source.floorId,
          context: { ...routeContext, routeStatus: "NO_ROUTE" },
        })
        .catch(() => undefined);
      throw new NotFoundException({
        code: "NO_ROUTE_FOUND",
        message: evacuation
          ? "No safe emergency exit route was found"
          : "No available route was found",
      });
    }
    const distanceMeters = result.distance / this.unitsPerMeter;
    const steps = result.nodeIds.map((nodeId, index) => {
      const node = nodesById.get(nodeId)!;
      const edge = result.edges[index];
      const next = edge ? nodesById.get(edge.to)! : undefined;
      const transition =
        edge?.kind === "ELEVATOR" ? ("ELEVATOR" as const) : undefined;
      const bearing =
        next && edge?.kind === "WALK"
          ? ((Math.atan2(next.y - node.y, next.x - node.x) * 180) / Math.PI +
              360) %
            360
          : null;
      return {
        nodeId,
        floorId: node.floorId,
        x: node.x,
        y: node.y,
        bearing,
        ...(transition
          ? {
              transition,
              targetFloorId: next!.floorId,
              instruction: `Take the elevator to floor ${next!.floorId}`,
            }
          : {
              instruction: next
                ? "Continue to the next point"
                : evacuation
                  ? "You have reached a safe exit"
                  : "You have arrived",
            }),
      };
    });
    const response = {
      totalDistance: distanceMeters,
      estimatedDurationSeconds: Math.max(
        1,
        Math.round(distanceMeters / this.walkingSpeed),
      ),
      nodeIds: result.nodeIds,
      steps,
    };
    void this.analytics
      .enqueue({
        eventType: "ROUTE_RESOLVED",
        tenantId: building.tenantId,
        buildingId: building.id,
        floorId: source.floorId,
        context: {
          ...routeContext,
          routeStatus: "RESOLVED",
          totalDistance: distanceMeters,
        },
      })
      .catch(() => undefined);
    return response;
  }

  async overview(buildingId: string) {
    const building = await this.activeBuilding(buildingId); const floors = await this.publishedFloors(buildingId);
    const floorIds = floors.map((f) => f.id);
    const [links, nodes, edges, pois, stores, revisions] = await Promise.all([
      this.prisma.elevatorLink.findMany({ where: { buildingId, deletedAt: null }, select: { id: true, nodeIdFrom: true, nodeIdTo: true } }),
      floorIds.length ? this.prisma.node.findMany({ where: { floorId: { in: floorIds }, deletedAt: null }, select: { id: true, floorId: true, x: true, y: true, type: true, accessible: true } }) : Promise.resolve([]),
      floorIds.length ? this.prisma.edge.findMany({ where: { floorId: { in: floorIds }, deletedAt: null }, select: { id: true, floorId: true, fromNodeId: true, toNodeId: true, weight: true } }) : Promise.resolve([]),
      floorIds.length ? this.prisma.poi.findMany({ where: { floorId: { in: floorIds }, deletedAt: null }, select: { id: true, floorId: true, nodeId: true, name: true, category: true } }) : Promise.resolve([]),
      floorIds.length ? this.prisma.store.findMany({ where: { floorId: { in: floorIds }, deletedAt: null, status: StoreStatus.ACTIVE }, select: { id: true, floorId: true, nodeId: true, name: true, status: true } }) : Promise.resolve([]),
      floorIds.length ? this.prisma.floorMapRevision.findMany({ where: { floorId: { in: floorIds } }, distinct: ['floorId'], orderBy: [{ floorId: 'asc' }, { version: 'desc' }], select: { floorId: true, version: true, editorState: true, publishedAt: true } }) : Promise.resolve([]),
    ]);
    const revisionByFloor = new Map(revisions.map((revision) => [revision.floorId, revision]));
    const minFloor = floors.reduce((minimum, floor) => Math.min(minimum, floor.floorNumber), 0);
    return {
      building: { id: building.id, defaultFloorHeight: building.defaultFloorHeight, name: building.name },
      floors: floors.map((floor) => ({
        id: floor.id,
        floorNumber: floor.floorNumber,
        name: floor.name,
        elevation: floor.elevation ?? (floor.floorNumber - minFloor) * building.defaultFloorHeight,
        mapImageUrl: floor.mapImageUrl,
        mapWidth: floor.mapWidth,
        mapHeight: floor.mapHeight,
        mapRevision: revisionByFloor.get(floor.id),
      })),
      verticalLinks: links.map((link) => ({ ...link, kind: 'ELEVATOR' })),
      nodes,
      edges,
      pois,
      stores,
    };
  }
}
