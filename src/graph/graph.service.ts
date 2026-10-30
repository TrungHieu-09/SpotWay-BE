import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { EdgeStatus, NodeType } from '@prisma/client';
import { AuthUser } from '../common/auth.types';
import { TenantAccessService } from '../common/tenant-access.service';
import { PrismaService } from '../database/prisma.service';
import { assertInsideMap, bumpGraphVersion, dependencyConflict, loadFloor, nodeDependencyCounts, recomputeEdgeWeights, scaled } from './application/graph-support';
import { pixelDistance } from './domain/coordinate-transform';
import { CreateEdgeDto, CreateElevatorLinkDto, CreateNodeDto, UpdateEdgeDto, UpdateNodeDto } from './graph.dto';

/** Nodes, edges and the legacy elevator links. POIs, connectors, calibration and draft application have their own services. */
@Injectable()
export class GraphService {
  constructor(private readonly prisma: PrismaService, private readonly access: TenantAccessService) {}

  private floor(user: AuthUser, floorId: string) { return loadFloor(this.prisma, this.access, user, floorId); }
  private async node(user: AuthUser, id: string) {
    const node = await this.prisma.node.findFirst({ where: { id, deletedAt: null }, include: { floor: true } });
    if (!node || node.floor.deletedAt) throw new NotFoundException({ code: 'NODE_NOT_FOUND', message: 'Node not found' });
    await this.access.building(user, node.floor.buildingId);
    return node;
  }
  private pair(first: string, second: string) { return first < second ? [first, second] as const : [second, first] as const; }

  async listNodes(user: AuthUser, floorId: string) { await this.floor(user, floorId); return this.prisma.node.findMany({ where: { floorId, deletedAt: null }, orderBy: { createdAt: 'asc' } }); }
  async createNode(user: AuthUser, floorId: string, dto: CreateNodeDto) {
    const floor = await this.floor(user, floorId);
    assertInsideMap(floor, dto.x, dto.y);
    return this.prisma.$transaction(async (tx) => {
      await bumpGraphVersion(tx, floorId, dto.expectedGraphVersion);
      return tx.node.create({ data: { floorId, tenantId: floor.tenantId, x: dto.x, y: dto.y, name: dto.name?.trim() || null, type: dto.type, accessible: dto.accessible ?? true } });
    });
  }
  async getNode(user: AuthUser, id: string) { return this.node(user, id); }

  /** Moving a node recomputes the weight of every adjacent edge in the same transaction. */
  async updateNode(user: AuthUser, id: string, dto: UpdateNodeDto) {
    const node = await this.node(user, id);
    const { expectedGraphVersion, name, ...fields } = dto;
    const x = dto.x ?? node.x;
    const y = dto.y ?? node.y;
    assertInsideMap(node.floor, x, y);
    const moved = x !== node.x || y !== node.y;
    return this.prisma.$transaction(async (tx) => {
      await bumpGraphVersion(tx, node.floorId, expectedGraphVersion);
      const updated = await tx.node.update({ where: { id }, data: { ...fields, ...(name === undefined ? {} : { name: name.trim() || null }) } });
      if (moved) {
        const { metersPerPixel } = await tx.floor.findUniqueOrThrow({ where: { id: node.floorId }, select: { metersPerPixel: true } });
        await recomputeEdgeWeights(tx, node.floorId, metersPerPixel, id);
      }
      return updated;
    });
  }

  async deleteNode(user: AuthUser, id: string) {
    const node = await this.node(user, id);
    return this.prisma.$transaction(async (tx) => {
      await bumpGraphVersion(tx, node.floorId);
      const counts = await nodeDependencyCounts(tx, [id]);
      if (counts.total) throw dependencyConflict(counts);
      const now = new Date();
      await tx.node.update({ where: { id }, data: { deletedAt: now } });
      await tx.edge.updateMany({ where: { deletedAt: null, OR: [{ fromNodeId: id }, { toNodeId: id }] }, data: { deletedAt: now } });
      await tx.elevatorLink.updateMany({ where: { deletedAt: null, OR: [{ nodeIdFrom: id }, { nodeIdTo: id }] }, data: { deletedAt: now } });
      return { id, deleted: true, floorId: node.floorId };
    });
  }

  /**
   * Empties a floor's graph in ONE transaction: every node and edge, plus what hangs off them (POIs, and whole connectors
   * that stop here, since a connector with a missing stop is meaningless). Stores and QR anchors are business data that
   * this call must not silently drop, so they still block it. Deleting node by node instead takes one floor lock per node
   * (graphVersion bump) and times out on a floor of a few dozen nodes.
   */
  async clearFloorGraph(user: AuthUser, floorId: string) {
    await this.floor(user, floorId);
    return this.prisma.$transaction(async (tx) => {
      await bumpGraphVersion(tx, floorId);
      const nodeIds = (await tx.node.findMany({ where: { floorId, deletedAt: null }, select: { id: true } })).map((node) => node.id);
      if (!nodeIds.length) return { floorId, nodes: 0, edges: 0, pois: 0, connectors: 0 };
      const [stores, qrAnchors] = await Promise.all([
        tx.store.count({ where: { nodeId: { in: nodeIds }, deletedAt: null } }),
        tx.qrAnchor.count({ where: { nodeId: { in: nodeIds }, deletedAt: null } }),
      ]);
      if (stores + qrAnchors) throw dependencyConflict({ pois: 0, stores, qrAnchors, connectorStops: 0 });

      const now = new Date();
      const connectorIds = [...new Set((await tx.connectorStop.findMany({ where: { floorId }, select: { connectorId: true } })).map((stop) => stop.connectorId))];
      const stops = connectorIds.length ? await tx.connectorStop.findMany({ where: { connectorId: { in: connectorIds } }, select: { floorId: true, nodeId: true } }) : [];
      const linkedNodeIds = [...new Set([...nodeIds, ...stops.map((stop) => stop.nodeId)])];
      if (connectorIds.length) {
        await tx.connectorStop.deleteMany({ where: { connectorId: { in: connectorIds } } });
        await tx.connector.updateMany({ where: { id: { in: connectorIds } }, data: { deletedAt: now } });
      }
      await tx.elevatorLink.updateMany({ where: { deletedAt: null, OR: [{ nodeIdFrom: { in: linkedNodeIds } }, { nodeIdTo: { in: linkedNodeIds } }] }, data: { deletedAt: now } });
      const pois = await tx.poi.updateMany({ where: { floorId, deletedAt: null }, data: { deletedAt: now } });
      const edges = await tx.edge.updateMany({ where: { floorId, deletedAt: null }, data: { deletedAt: now } });
      const nodes = await tx.node.updateMany({ where: { floorId, deletedAt: null }, data: { deletedAt: now } });
      for (const otherFloorId of new Set(stops.map((stop) => stop.floorId).filter((id) => id !== floorId))) await bumpGraphVersion(tx, otherFloorId);
      return { floorId, nodes: nodes.count, edges: edges.count, pois: pois.count, connectors: connectorIds.length };
    }, { timeout: 60_000, maxWait: 10_000 });
  }

  async listEdges(user: AuthUser, floorId: string) { await this.floor(user, floorId); return this.prisma.edge.findMany({ where: { floorId, deletedAt: null }, orderBy: { createdAt: 'asc' } }); }
  async createEdge(user: AuthUser, floorId: string, dto: CreateEdgeDto) {
    const floor = await this.floor(user, floorId);
    if (dto.fromNodeId === dto.toNodeId) throw new BadRequestException({ code: 'EDGE_SELF_LOOP', message: 'An edge must connect two different nodes' });
    const nodes = await this.prisma.node.findMany({ where: { id: { in: [dto.fromNodeId, dto.toNodeId] }, deletedAt: null } });
    if (nodes.length !== 2 || nodes.some((node) => node.floorId !== floorId || node.tenantId !== floor.tenantId)) throw new BadRequestException({ code: 'INVALID_EDGE_NODES', message: 'Edge nodes must exist on the requested floor' });
    const [nodeLowId, nodeHighId] = this.pair(dto.fromNodeId, dto.toNodeId);
    const existing = await this.prisma.edge.findFirst({ where: { floorId, nodeLowId, nodeHighId, deletedAt: null } });
    if (existing) throw new ConflictException({ code: 'DUPLICATE_EDGE', message: 'An edge already exists for this node pair' });
    const from = nodes.find((node) => node.id === dto.fromNodeId)!;
    const to = nodes.find((node) => node.id === dto.toNodeId)!;
    const weight = pixelDistance(from, to);
    return this.prisma.$transaction(async (tx) => {
      await bumpGraphVersion(tx, floorId, dto.expectedGraphVersion);
      const { metersPerPixel } = await tx.floor.findUniqueOrThrow({ where: { id: floorId }, select: { metersPerPixel: true } });
      return tx.edge.create({ data: { tenantId: floor.tenantId, floorId, fromNodeId: dto.fromNodeId, toNodeId: dto.toNodeId, nodeLowId, nodeHighId, weight, weightMeters: scaled(weight, metersPerPixel), accessible: dto.accessible ?? true, status: dto.status ?? EdgeStatus.ACTIVE } });
    });
  }
  async getEdge(user: AuthUser, id: string) { const edge = await this.prisma.edge.findFirst({ where: { id, deletedAt: null }, include: { floor: true } }); if (!edge || edge.floor.deletedAt) throw new NotFoundException({ code: 'EDGE_NOT_FOUND', message: 'Edge not found' }); await this.access.building(user, edge.floor.buildingId); return edge; }
  async updateEdge(user: AuthUser, id: string, dto: UpdateEdgeDto) {
    const edge = await this.getEdge(user, id);
    return this.prisma.$transaction(async (tx) => { await bumpGraphVersion(tx, edge.floorId); return tx.edge.update({ where: { id }, data: dto }); });
  }
  async deleteEdge(user: AuthUser, id: string) {
    const edge = await this.getEdge(user, id);
    return this.prisma.$transaction(async (tx) => { await bumpGraphVersion(tx, edge.floorId); return tx.edge.update({ where: { id }, data: { deletedAt: new Date() } }); });
  }

  // Legacy pairwise links. Connectors (ConnectorService) supersede them; ELEVATOR connectors keep these rows in sync until they are dropped.
  async listElevatorLinks(user: AuthUser, buildingId: string) { await this.access.building(user, buildingId); return this.prisma.elevatorLink.findMany({ where: { buildingId, deletedAt: null }, orderBy: { createdAt: 'asc' } }); }
  async createElevatorLink(user: AuthUser, buildingId: string, dto: CreateElevatorLinkDto) {
    const building = await this.access.building(user, buildingId);
    if (dto.nodeIdFrom === dto.nodeIdTo) throw new BadRequestException({ code: 'INVALID_ELEVATOR_LINK', message: 'Elevator link requires two different nodes' });
    const nodes = await this.prisma.node.findMany({ where: { id: { in: [dto.nodeIdFrom, dto.nodeIdTo] }, deletedAt: null }, include: { floor: true } });
    if (nodes.length !== 2 || nodes.some((node) => node.type !== NodeType.ELEVATOR || node.floor.deletedAt || node.floor.buildingId !== buildingId || node.tenantId !== building.tenantId) || nodes[0].floorId === nodes[1].floorId) throw new BadRequestException({ code: 'INVALID_ELEVATOR_LINK', message: 'Elevator nodes must be on different floors in this building' });
    const [nodeLowId, nodeHighId] = this.pair(dto.nodeIdFrom, dto.nodeIdTo);
    const duplicate = await this.prisma.elevatorLink.findFirst({ where: { buildingId, nodeLowId, nodeHighId, deletedAt: null } });
    if (duplicate) throw new ConflictException({ code: 'DUPLICATE_ELEVATOR_LINK', message: 'This elevator link already exists' });
    return this.prisma.$transaction(async (tx) => {
      for (const node of nodes) await bumpGraphVersion(tx, node.floorId);
      return tx.elevatorLink.create({ data: { tenantId: building.tenantId, buildingId, nodeIdFrom: dto.nodeIdFrom, nodeIdTo: dto.nodeIdTo, nodeLowId, nodeHighId } });
    });
  }
  async deleteElevatorLink(user: AuthUser, id: string) {
    const link = await this.prisma.elevatorLink.findFirst({ where: { id, deletedAt: null } });
    if (!link) throw new NotFoundException({ code: 'ELEVATOR_LINK_NOT_FOUND', message: 'Elevator link not found' });
    await this.access.building(user, link.buildingId);
    const nodes = await this.prisma.node.findMany({ where: { id: { in: [link.nodeIdFrom, link.nodeIdTo] } }, select: { floorId: true } });
    return this.prisma.$transaction(async (tx) => {
      for (const floorId of new Set(nodes.map((node) => node.floorId))) await bumpGraphVersion(tx, floorId);
      return tx.elevatorLink.update({ where: { id }, data: { deletedAt: new Date() } });
    });
  }
}
