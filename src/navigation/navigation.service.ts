import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { BuildingStatus, EdgeStatus, FloorPublishStatus, StoreStatus, TenantStatus } from '@prisma/client';
import { pageMeta } from '../common/pagination';
import { PrismaService } from '../database/prisma.service';
import { CreateRouteDto, PublicSearchQuery } from './navigation.dto';

type GraphEdge = { to: string; weight: number; kind: 'WALK' | 'ELEVATOR' };
type Graph = Map<string, GraphEdge[]>;
type DijkstraResult = { distance: number; nodeIds: string[]; edges: GraphEdge[] } | null;

export function dijkstra(graph: Graph, source: string, target: string): DijkstraResult {
  const distances = new Map<string, number>([[source, 0]]);
  const previous = new Map<string, { nodeId: string; edge: GraphEdge }>();
  const queue: Array<{ nodeId: string; distance: number }> = [{ nodeId: source, distance: 0 }];
  while (queue.length) {
    queue.sort((a, b) => a.distance - b.distance);
    const current = queue.shift()!;
    if (current.distance !== distances.get(current.nodeId)) continue;
    if (current.nodeId === target) break;
    for (const edge of graph.get(current.nodeId) ?? []) {
      const candidate = current.distance + edge.weight;
      if (candidate < (distances.get(edge.to) ?? Number.POSITIVE_INFINITY)) {
        distances.set(edge.to, candidate);
        previous.set(edge.to, { nodeId: current.nodeId, edge });
        queue.push({ nodeId: edge.to, distance: candidate });
      }
    }
  }
  const distance = distances.get(target);
  if (distance === undefined) return null;
  const nodeIds = [target]; const edges: GraphEdge[] = [];
  while (nodeIds[0] !== source) { const item = previous.get(nodeIds[0]); if (!item) return null; edges.unshift(item.edge); nodeIds.unshift(item.nodeId); }
  return { distance, nodeIds, edges };
}

@Injectable()
export class NavigationService {
  constructor(private readonly prisma: PrismaService) {}
  private readonly elevatorWeight = Number(process.env.ELEVATOR_TRANSITION_WEIGHT ?? 20);
  private readonly unitsPerMeter = Number(process.env.MAP_UNITS_PER_METER ?? 1);
  private readonly walkingSpeed = Number(process.env.ROUTE_WALKING_SPEED_MPS ?? 1.2);

  private activeBuildingWhere(id: string) { return { id, status: BuildingStatus.ACTIVE, deletedAt: null, tenant: { is: { status: TenantStatus.ACTIVE, archived: false, deletedAt: null } } }; }
  private async activeBuilding(id: string) { const building = await this.prisma.building.findFirst({ where: this.activeBuildingWhere(id) }); if (!building) throw new NotFoundException({ code: 'PUBLIC_BUILDING_NOT_FOUND', message: 'Published building not found' }); return building; }
  private async publishedFloors(buildingId: string) { return this.prisma.floor.findMany({ where: { buildingId, publishStatus: FloorPublishStatus.PUBLISHED, deletedAt: null }, orderBy: { floorNumber: 'asc' } }); }

  async listFloors(buildingId: string) { await this.activeBuilding(buildingId); return this.publishedFloors(buildingId); }
  async map(floorId: string) {
    const floor = await this.prisma.floor.findFirst({ where: { id: floorId, publishStatus: FloorPublishStatus.PUBLISHED, deletedAt: null, building: { is: { status: BuildingStatus.ACTIVE, deletedAt: null, tenant: { is: { status: TenantStatus.ACTIVE, archived: false, deletedAt: null } } } } } });
    if (!floor) throw new NotFoundException({ code: 'PUBLIC_FLOOR_NOT_FOUND', message: 'Published floor not found' });
    const [nodes, edges, pois, stores] = await this.prisma.$transaction([
      this.prisma.node.findMany({ where: { floorId, deletedAt: null }, orderBy: { createdAt: 'asc' } }),
      this.prisma.edge.findMany({ where: { floorId, deletedAt: null }, orderBy: { createdAt: 'asc' } }),
      this.prisma.poi.findMany({ where: { floorId, deletedAt: null }, orderBy: { createdAt: 'asc' } }),
      this.prisma.store.findMany({ where: { floorId, deletedAt: null, status: StoreStatus.ACTIVE }, orderBy: { name: 'asc' } }),
    ]);
    return { floor, nodes, edges, pois, stores };
  }

  async search(buildingId: string, query: PublicSearchQuery) {
    await this.activeBuilding(buildingId); const floors = await this.publishedFloors(buildingId); const floorIds = floors.map(({ id }) => id); if (!floorIds.length) return { items: [], pagination: pageMeta(query.page, query.limit, 0) };
    const term = query.q?.trim(); const nameFilter = term ? { contains: term, mode: 'insensitive' as const } : undefined;
    const [stores, pois] = await Promise.all([
      query.type === 'POI' ? [] : this.prisma.store.findMany({ where: { floorId: { in: floorIds }, deletedAt: null, status: StoreStatus.ACTIVE, ...(nameFilter ? { name: nameFilter } : {}), node: { is: { deletedAt: null } } }, include: { node: true } }),
      query.type === 'STORE' ? [] : this.prisma.poi.findMany({ where: { floorId: { in: floorIds }, deletedAt: null, ...(nameFilter ? { name: nameFilter } : {}), node: { is: { deletedAt: null } } }, include: { node: true } }),
    ]);
    const items = [...stores.map((store) => ({ type: 'STORE' as const, id: store.id, name: store.name, floorId: store.floorId, nodeId: store.nodeId!, x: store.node!.x, y: store.node!.y })), ...pois.map((poi) => ({ type: 'POI' as const, id: poi.id, name: poi.name, floorId: poi.floorId, nodeId: poi.nodeId, x: poi.node.x, y: poi.node.y }))].sort((a, b) => a.name.localeCompare(b.name));
    const total = items.length; return { items: items.slice((query.page - 1) * query.limit, query.page * query.limit), pagination: pageMeta(query.page, query.limit, total) };
  }

  async route(dto: CreateRouteDto) {
    const [source, store] = await Promise.all([
      this.prisma.node.findFirst({ where: { id: dto.fromNodeId, deletedAt: null }, include: { floor: { include: { building: { include: { tenant: true } } } } } }),
      this.prisma.store.findFirst({ where: { id: dto.toStoreId, deletedAt: null, status: StoreStatus.ACTIVE }, include: { node: true, floor: { include: { building: { include: { tenant: true } } } } } }),
    ]);
    if (!source || !store?.node || store.node.deletedAt) throw new NotFoundException({ code: 'ROUTE_ENDPOINT_NOT_FOUND', message: 'Route source or destination is not available' });
    const target = store.node;
    if (source.floor.buildingId !== store.floor.buildingId) throw new BadRequestException({ code: 'INVALID_ROUTE_SCOPE', message: 'Route endpoints must belong to the same building' });
    const building = source.floor.building;
    if (building.status !== BuildingStatus.ACTIVE || building.deletedAt || building.tenant.status !== TenantStatus.ACTIVE || building.tenant.archived || building.tenant.deletedAt || source.floor.publishStatus !== FloorPublishStatus.PUBLISHED || source.floor.deletedAt || store.floor.publishStatus !== FloorPublishStatus.PUBLISHED || store.floor.deletedAt) throw new NotFoundException({ code: 'ROUTE_NOT_PUBLISHED', message: 'Route endpoints must be published and available' });
    const floors = await this.publishedFloors(building.id); const floorIds = floors.map(({ id }) => id);
    const [nodes, edges, links] = await this.prisma.$transaction([
      this.prisma.node.findMany({ where: { floorId: { in: floorIds }, deletedAt: null } }),
      this.prisma.edge.findMany({ where: { floorId: { in: floorIds }, deletedAt: null, status: EdgeStatus.ACTIVE, ...(dto.wheelchairMode ? { accessible: true } : {}) } }),
      this.prisma.elevatorLink.findMany({ where: { buildingId: building.id, deletedAt: null } }),
    ]);
    const nodesById = new Map(nodes.map((node) => [node.id, node])); const graph: Graph = new Map(nodes.map((node) => [node.id, []]));
    const add = (from: string, edge: GraphEdge) => { const list = graph.get(from); if (list) list.push(edge); };
    for (const edge of edges) if (nodesById.has(edge.fromNodeId) && nodesById.has(edge.toNodeId)) { add(edge.fromNodeId, { to: edge.toNodeId, weight: edge.weight, kind: 'WALK' }); add(edge.toNodeId, { to: edge.fromNodeId, weight: edge.weight, kind: 'WALK' }); }
    for (const link of links) { const from = nodesById.get(link.nodeIdFrom); const to = nodesById.get(link.nodeIdTo); if (from && to && from.floorId !== to.floorId) { add(from.id, { to: to.id, weight: this.elevatorWeight, kind: 'ELEVATOR' }); add(to.id, { to: from.id, weight: this.elevatorWeight, kind: 'ELEVATOR' }); } }
    const result = dijkstra(graph, source.id, target.id); if (!result) throw new NotFoundException({ code: 'NO_ROUTE_FOUND', message: 'No available route was found' });
    const distanceMeters = result.distance / this.unitsPerMeter;
    const steps = result.nodeIds.map((nodeId, index) => { const node = nodesById.get(nodeId)!; const edge = result.edges[index]; const next = edge ? nodesById.get(edge.to)! : undefined; const transition = edge?.kind === 'ELEVATOR' ? 'ELEVATOR' as const : undefined; const bearing = next && edge?.kind === 'WALK' ? (Math.atan2(next.y - node.y, next.x - node.x) * 180 / Math.PI + 360) % 360 : null; return { nodeId, floorId: node.floorId, x: node.x, y: node.y, bearing, ...(transition ? { transition, targetFloorId: next!.floorId, instruction: `Take the elevator to floor ${next!.floorId}` } : { instruction: next ? 'Continue to the next point' : 'You have arrived' }) }; });
    return { totalDistance: distanceMeters, estimatedDurationSeconds: Math.max(1, Math.round(distanceMeters / this.walkingSpeed)), nodeIds: result.nodeIds, steps };
  }
}
