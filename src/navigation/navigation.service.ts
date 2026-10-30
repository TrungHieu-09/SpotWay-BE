import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { BuildingStatus, FloorPublishStatus, NodeType, PoiCategory, StoreStatus, TenantStatus } from '@prisma/client';
import { pageMeta } from '../common/pagination';
import { PrismaService } from '../database/prisma.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { GraphCacheService } from '../graph/application/graph-cache.service';
import { GRAPH_ERROR_CODES } from '../graph/domain/graph.types';
import { planRoute } from '../graph/domain/pathfinding/route-planner';
import { CreateRouteDto, PublicSearchQuery } from './navigation.dto';
import { buildGuidance } from './route-guidance';
import { mergeVerticalLinks } from './vertical-links';

@Injectable()
export class NavigationService {
  constructor(private readonly prisma: PrismaService, private readonly analytics: AnalyticsService, private readonly graphCache: GraphCacheService) {}
  private readonly walkingSpeed = Number(process.env.ROUTE_WALKING_SPEED_MPS ?? 1.2);

  private notCalibrated(floorIds: string[]) {
    return new ConflictException({ code: GRAPH_ERROR_CODES.FLOOR_NOT_CALIBRATED, message: 'Floor scale is not calibrated yet; set it with PATCH /floors/:id/calibration', floorIds });
  }

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
    const snapshot = await this.graphCache.get(building.id);
    const uncalibratedEndpoints = [source.floorId, endpointFloor?.id].filter((floorId): floorId is string => !!floorId && snapshot.uncalibratedFloorIds.includes(floorId));
    if (uncalibratedEndpoints.length) throw this.notCalibrated(uncalibratedEndpoints);
    const blockedNodeIds = new Set([
      ...(dto.hazardNodeIds ?? []),
      ...(dto.blockedNodeIds ?? []),
    ]);
    const targetIds: ReadonlySet<string> = evacuation
      ? requestedTarget
        ? new Set([requestedTarget.id])
        : snapshot.exitNodeIds
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
    const route = planRoute(snapshot, source.id, targetIds, {
      wheelchairMode: dto.wheelchairMode,
      evacuation,
      blockedNodeIds,
    });
    if (!route) {
      // Edges of an uncalibrated floor are not in the graph, so a missing route may only mean "not measured yet".
      if (snapshot.uncalibratedFloorIds.length) throw this.notCalibrated([...snapshot.uncalibratedFloorIds]);
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
    const distanceMeters = Math.round(route.walkMeters * 100) / 100;
    const steps = buildGuidance({
      nodeIds: route.nodeIds,
      legs: route.legs,
      node: (id) => snapshot.nodes.get(id)!,
      floorNumber: (floorId) => snapshot.floors.get(floorId)!.floorNumber,
      evacuation,
      lang: dto.lang ?? "en",
    });
    const response = {
      totalDistance: distanceMeters,
      estimatedDurationSeconds: Math.max(
        1,
        Math.round(route.walkMeters / this.walkingSpeed + route.rideSeconds),
      ),
      walkingDurationSeconds: Math.round(route.walkMeters / this.walkingSpeed),
      transitionDurationSeconds: Math.round(route.rideSeconds),
      requestedMode: mode,
      effectiveMode: evacuation ? "EVACUATION" : "NORMAL",
      warnings: [] as Array<{ code: string; severity: string; message: string }>,
      nodeIds: route.nodeIds,
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
    const [links, connectors, nodes, edges, pois, stores, revisions] = await Promise.all([
      this.prisma.elevatorLink.findMany({ where: { buildingId, deletedAt: null }, select: { id: true, nodeIdFrom: true, nodeIdTo: true } }),
      this.prisma.connector.findMany({ where: { buildingId, deletedAt: null }, select: { id: true, kind: true, accessible: true, stops: { select: { nodeId: true, floor: { select: { floorNumber: true } } } } } }),
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
      verticalLinks: mergeVerticalLinks(links, connectors),
      nodes,
      edges,
      pois,
      stores,
    };
  }
}
