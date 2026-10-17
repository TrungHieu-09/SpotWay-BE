import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { EdgeStatus, NodeType, UserRole } from '@prisma/client';
import { AuthUser } from '../common/auth.types';
import { TenantAccessService } from '../common/tenant-access.service';
import { PrismaService } from '../database/prisma.service';
import { ApplyNavigationDraftDto, CreateEdgeDto, CreateElevatorLinkDto, CreateNodeDto, CreatePoiDto, UpdateEdgeDto, UpdateNodeDto, UpdatePoiDto } from './graph.dto';

@Injectable()
export class GraphService {
  constructor(private readonly prisma: PrismaService, private readonly access: TenantAccessService) {}

  private async floor(user: AuthUser, floorId: string) {
    const floor = await this.prisma.floor.findFirst({ where: { id: floorId, deletedAt: null } });
    if (!floor) throw new NotFoundException({ code: 'FLOOR_NOT_FOUND', message: 'Floor not found' });
    await this.access.building(user, floor.buildingId);
    return floor;
  }
  private async node(user: AuthUser, id: string) {
    const node = await this.prisma.node.findFirst({ where: { id, deletedAt: null }, include: { floor: true } });
    if (!node || node.floor.deletedAt) throw new NotFoundException({ code: 'NODE_NOT_FOUND', message: 'Node not found' });
    await this.access.building(user, node.floor.buildingId);
    return node;
  }
  private coordinate(floor: { mapWidth: number | null; mapHeight: number | null }, x: number, y: number) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || (floor.mapWidth !== null && x > floor.mapWidth) || (floor.mapHeight !== null && y > floor.mapHeight)) throw new BadRequestException({ code: 'INVALID_NODE_COORDINATES', message: 'Node coordinates are outside the floor map bounds' });
  }
  private pair(first: string, second: string) { return first < second ? [first, second] as const : [second, first] as const; }

  async listNodes(user: AuthUser, floorId: string) { await this.floor(user, floorId); return this.prisma.node.findMany({ where: { floorId, deletedAt: null }, orderBy: { createdAt: 'asc' } }); }
  async createNode(user: AuthUser, floorId: string, dto: CreateNodeDto) { const floor = await this.floor(user, floorId); this.coordinate(floor, dto.x, dto.y); return this.prisma.node.create({ data: { floorId, tenantId: floor.tenantId, x: dto.x, y: dto.y, name: dto.name?.trim() || null, type: dto.type, accessible: dto.accessible ?? true } }); }
  async getNode(user: AuthUser, id: string) { return this.node(user, id); }
  async updateNode(user: AuthUser, id: string, dto: UpdateNodeDto) { const node = await this.node(user, id); const x = dto.x ?? node.x; const y = dto.y ?? node.y; this.coordinate(node.floor, x, y); return this.prisma.node.update({ where: { id }, data: { ...dto, name: dto.name?.trim() } }); }
  async deleteNode(user: AuthUser, id: string) { const node = await this.node(user, id); const [poiCount, storeCount] = await this.prisma.$transaction([this.prisma.poi.count({ where: { nodeId: id, deletedAt: null } }), this.prisma.store.count({ where: { nodeId: id, deletedAt: null } })]); if (poiCount || storeCount) throw new ConflictException({ code: 'NODE_HAS_DEPENDENCIES', message: 'Remove attached POIs and stores before deleting this node' }); const now = new Date(); await this.prisma.$transaction([this.prisma.node.update({ where: { id }, data: { deletedAt: now } }), this.prisma.edge.updateMany({ where: { deletedAt: null, OR: [{ fromNodeId: id }, { toNodeId: id }] }, data: { deletedAt: now } }), this.prisma.elevatorLink.updateMany({ where: { deletedAt: null, OR: [{ nodeIdFrom: id }, { nodeIdTo: id }] }, data: { deletedAt: now } })]); return { id, deleted: true, floorId: node.floorId }; }

  async listEdges(user: AuthUser, floorId: string) { await this.floor(user, floorId); return this.prisma.edge.findMany({ where: { floorId, deletedAt: null }, orderBy: { createdAt: 'asc' } }); }
  async createEdge(user: AuthUser, floorId: string, dto: CreateEdgeDto) { const floor = await this.floor(user, floorId); if (dto.fromNodeId === dto.toNodeId) throw new BadRequestException({ code: 'EDGE_SELF_LOOP', message: 'An edge must connect two different nodes' }); const nodes = await this.prisma.node.findMany({ where: { id: { in: [dto.fromNodeId, dto.toNodeId] }, deletedAt: null } }); if (nodes.length !== 2 || nodes.some((node) => node.floorId !== floorId || node.tenantId !== floor.tenantId)) throw new BadRequestException({ code: 'INVALID_EDGE_NODES', message: 'Edge nodes must exist on the requested floor' }); const [nodeLowId, nodeHighId] = this.pair(dto.fromNodeId, dto.toNodeId); const existing = await this.prisma.edge.findFirst({ where: { floorId, nodeLowId, nodeHighId, deletedAt: null } }); if (existing) throw new ConflictException({ code: 'DUPLICATE_EDGE', message: 'An edge already exists for this node pair' }); const from = nodes.find((node) => node.id === dto.fromNodeId)!; const to = nodes.find((node) => node.id === dto.toNodeId)!; return this.prisma.edge.create({ data: { tenantId: floor.tenantId, floorId, fromNodeId: dto.fromNodeId, toNodeId: dto.toNodeId, nodeLowId, nodeHighId, weight: Math.hypot(from.x - to.x, from.y - to.y), accessible: dto.accessible ?? true, status: dto.status ?? EdgeStatus.ACTIVE } }); }
  async getEdge(user: AuthUser, id: string) { const edge = await this.prisma.edge.findFirst({ where: { id, deletedAt: null }, include: { floor: true } }); if (!edge || edge.floor.deletedAt) throw new NotFoundException({ code: 'EDGE_NOT_FOUND', message: 'Edge not found' }); await this.access.building(user, edge.floor.buildingId); return edge; }
  async updateEdge(user: AuthUser, id: string, dto: UpdateEdgeDto) { await this.getEdge(user, id); return this.prisma.edge.update({ where: { id }, data: dto }); }
  async deleteEdge(user: AuthUser, id: string) { await this.getEdge(user, id); return this.prisma.edge.update({ where: { id }, data: { deletedAt: new Date() } }); }

  async listPois(user: AuthUser, floorId: string) { await this.floor(user, floorId); return this.prisma.poi.findMany({ where: { floorId, deletedAt: null }, orderBy: { createdAt: 'asc' } }); }
  private async ensurePoiNode(floorId: string, nodeId: string) { const node = await this.prisma.node.findFirst({ where: { id: nodeId, floorId, deletedAt: null } }); if (!node) throw new BadRequestException({ code: 'INVALID_POI_NODE', message: 'POI node must exist on the requested floor' }); }
  async createPoi(user: AuthUser, floorId: string, dto: CreatePoiDto) { const floor = await this.floor(user, floorId); await this.ensurePoiNode(floorId, dto.nodeId); return this.prisma.poi.create({ data: { tenantId: floor.tenantId, floorId, nodeId: dto.nodeId, name: dto.name.trim(), category: dto.category, icon: dto.icon?.trim() } }); }
  async getPoi(user: AuthUser, id: string) { const poi = await this.prisma.poi.findFirst({ where: { id, deletedAt: null }, include: { floor: true } }); if (!poi || poi.floor.deletedAt) throw new NotFoundException({ code: 'POI_NOT_FOUND', message: 'POI not found' }); await this.access.building(user, poi.floor.buildingId); return poi; }
  async updatePoi(user: AuthUser, id: string, dto: UpdatePoiDto) { const poi = await this.getPoi(user, id); if (dto.nodeId) await this.ensurePoiNode(poi.floorId, dto.nodeId); return this.prisma.poi.update({ where: { id }, data: { ...dto, name: dto.name?.trim(), icon: dto.icon?.trim() } }); }
  async deletePoi(user: AuthUser, id: string) { await this.getPoi(user, id); return this.prisma.poi.update({ where: { id }, data: { deletedAt: new Date() } }); }

  async listElevatorLinks(user: AuthUser, buildingId: string) { await this.access.building(user, buildingId); return this.prisma.elevatorLink.findMany({ where: { buildingId, deletedAt: null }, orderBy: { createdAt: 'asc' } }); }
  async createElevatorLink(user: AuthUser, buildingId: string, dto: CreateElevatorLinkDto) { const building = await this.access.building(user, buildingId); if (dto.nodeIdFrom === dto.nodeIdTo) throw new BadRequestException({ code: 'INVALID_ELEVATOR_LINK', message: 'Elevator link requires two different nodes' }); const nodes = await this.prisma.node.findMany({ where: { id: { in: [dto.nodeIdFrom, dto.nodeIdTo] }, deletedAt: null }, include: { floor: true } }); if (nodes.length !== 2 || nodes.some((node) => node.type !== NodeType.ELEVATOR || node.floor.deletedAt || node.floor.buildingId !== buildingId || node.tenantId !== building.tenantId) || nodes[0].floorId === nodes[1].floorId) throw new BadRequestException({ code: 'INVALID_ELEVATOR_LINK', message: 'Elevator nodes must be on different floors in this building' }); const [nodeLowId, nodeHighId] = this.pair(dto.nodeIdFrom, dto.nodeIdTo); const duplicate = await this.prisma.elevatorLink.findFirst({ where: { buildingId, nodeLowId, nodeHighId, deletedAt: null } }); if (duplicate) throw new ConflictException({ code: 'DUPLICATE_ELEVATOR_LINK', message: 'This elevator link already exists' }); return this.prisma.elevatorLink.create({ data: { tenantId: building.tenantId, buildingId, nodeIdFrom: dto.nodeIdFrom, nodeIdTo: dto.nodeIdTo, nodeLowId, nodeHighId } }); }
  async deleteElevatorLink(user: AuthUser, id: string) { const link = await this.prisma.elevatorLink.findFirst({ where: { id, deletedAt: null } }); if (!link) throw new NotFoundException({ code: 'ELEVATOR_LINK_NOT_FOUND', message: 'Elevator link not found' }); await this.access.building(user, link.buildingId); return this.prisma.elevatorLink.update({ where: { id }, data: { deletedAt: new Date() } }); }

  async applyNavigationDraft(user: AuthUser, floorId: string, dto: ApplyNavigationDraftDto) {
    const floor = await this.floor(user, floorId);
    const accepted = dto.nodes.filter((node) => node.confirmed !== false);
    if (!accepted.length) throw new BadRequestException({ code: 'NAVIGATION_DRAFT_EMPTY', message: 'Confirm at least one suggested node before applying the draft' });
    accepted.forEach((node) => this.coordinate(floor, node.x, node.y));
    return this.prisma.$transaction(async (tx) => {
      const ids = new Map<string, string>();
      for (const proposal of accepted) {
        const node = await tx.node.create({ data: { floorId, tenantId: floor.tenantId, x: proposal.x, y: proposal.y, name: proposal.name?.trim() || null, type: proposal.type, accessible: proposal.accessible ?? true } });
        ids.set(proposal.id, node.id);
      }
      let edgeCount = 0;
      for (const proposal of dto.edges.filter((edge) => edge.confirmed !== false)) {
        const fromNodeId = ids.get(proposal.fromNodeId); const toNodeId = ids.get(proposal.toNodeId);
        if (!fromNodeId || !toNodeId || fromNodeId === toNodeId) continue;
        const [nodeLowId, nodeHighId] = this.pair(fromNodeId, toNodeId);
        const [from, to] = await Promise.all([tx.node.findUniqueOrThrow({ where: { id: fromNodeId } }), tx.node.findUniqueOrThrow({ where: { id: toNodeId } })]);
        await tx.edge.create({ data: { tenantId: floor.tenantId, floorId, fromNodeId, toNodeId, nodeLowId, nodeHighId, weight: Math.hypot(from.x - to.x, from.y - to.y), accessible: proposal.accessible ?? true } }); edgeCount++;
      }
      return { nodesCreated: ids.size, edgesCreated: edgeCount };
    });
  }

  async assertFloorCanPublish(floorId: string) { const elevators = await this.prisma.node.findMany({ where: { floorId, type: NodeType.ELEVATOR, deletedAt: null }, select: { id: true } }); if (!elevators.length) return; const links = await this.prisma.elevatorLink.findMany({ where: { deletedAt: null, OR: elevators.flatMap(({ id }) => [{ nodeIdFrom: id }, { nodeIdTo: id }]) }, select: { nodeIdFrom: true, nodeIdTo: true } }); const linked = new Set(links.flatMap((link) => [link.nodeIdFrom, link.nodeIdTo])); const missing = elevators.filter(({ id }) => !linked.has(id)).map(({ id }) => id); if (missing.length) throw new BadRequestException({ code: 'UNLINKED_ELEVATOR_NODE', message: 'Every elevator node must have a vertical link before publishing', nodeIds: missing }); }
}
