import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConnectorKind, NodeType, Prisma } from '@prisma/client';
import { AuthUser } from '../../common/auth.types';
import { TenantAccessService } from '../../common/tenant-access.service';
import { PrismaService } from '../../database/prisma.service';
import { GRAPH_ERROR_CODES } from '../domain/graph.types';
import { ConnectorStopDto, CreateConnectorDto, UpdateConnectorDto } from '../dto/connector.dto';
import { bumpGraphVersion, Tx } from './graph-support';

const NODE_TYPE_FOR_KIND: Record<ConnectorKind, NodeType> = { ELEVATOR: NodeType.ELEVATOR, STAIR: NodeType.STAIR, ESCALATOR: NodeType.ESCALATOR };
const invalid = (message: string, extra: Record<string, unknown> = {}) => new BadRequestException({ code: GRAPH_ERROR_CODES.INVALID_CONNECTOR, message, ...extra });
const pairOf = (a: string, b: string) => (a < b ? [a, b] as const : [b, a] as const);

type OrderedStop = { floorId: string; nodeId: string; floorNumber: number };

@Injectable()
export class ConnectorService {
  constructor(private readonly prisma: PrismaService, private readonly access: TenantAccessService) {}

  async list(user: AuthUser, buildingId: string) {
    await this.access.building(user, buildingId);
    return this.prisma.connector.findMany({ where: { buildingId, deletedAt: null }, include: { stops: { select: { floorId: true, nodeId: true } } }, orderBy: { createdAt: 'asc' } });
  }

  async create(user: AuthUser, buildingId: string, dto: CreateConnectorDto) {
    const building = await this.access.building(user, buildingId);
    const stops = await this.validateStops(building, dto.kind, dto.stops);
    return this.write(() => this.prisma.$transaction(async (tx) => {
      const connector = await tx.connector.create({ data: { tenantId: building.tenantId, buildingId, kind: dto.kind, name: dto.name.trim(), accessible: dto.accessible ?? true, stops: { create: stops.map(({ floorId, nodeId }) => ({ floorId, nodeId })) } }, include: { stops: { select: { floorId: true, nodeId: true } } } });
      await this.syncLegacyLinks(tx, building, dto.kind, [], stops);
      for (const floorId of stops.map((stop) => stop.floorId)) await bumpGraphVersion(tx, floorId);
      return connector;
    }));
  }

  async update(user: AuthUser, id: string, dto: UpdateConnectorDto) {
    const connector = await this.find(user, id);
    const building = await this.access.building(user, connector.buildingId);
    const previous = await this.orderedStops(this.prisma, connector.id);
    const next = dto.stops ? await this.validateStops(building, connector.kind, dto.stops, connector.id) : null;
    return this.write(() => this.prisma.$transaction(async (tx) => {
      if (next) { await tx.connectorStop.deleteMany({ where: { connectorId: id } }); await tx.connectorStop.createMany({ data: next.map(({ floorId, nodeId }) => ({ connectorId: id, floorId, nodeId })) }); }
      const updated = await tx.connector.update({ where: { id }, data: { name: dto.name?.trim(), accessible: dto.accessible }, include: { stops: { select: { floorId: true, nodeId: true } } } });
      if (next) await this.syncLegacyLinks(tx, building, connector.kind, previous, next);
      for (const floorId of new Set([...previous, ...(next ?? [])].map((stop) => stop.floorId))) await bumpGraphVersion(tx, floorId);
      return updated;
    }));
  }

  async remove(user: AuthUser, id: string) {
    const connector = await this.find(user, id);
    const building = await this.access.building(user, connector.buildingId);
    const previous = await this.orderedStops(this.prisma, id);
    return this.prisma.$transaction(async (tx) => {
      await tx.connectorStop.deleteMany({ where: { connectorId: id } });
      await tx.connector.update({ where: { id }, data: { deletedAt: new Date() } });
      await this.syncLegacyLinks(tx, building, connector.kind, previous, []);
      for (const floorId of new Set(previous.map((stop) => stop.floorId))) await bumpGraphVersion(tx, floorId);
      return { id, deleted: true };
    });
  }

  private async find(user: AuthUser, id: string) {
    const connector = await this.prisma.connector.findFirst({ where: { id, deletedAt: null } });
    if (!connector) throw new NotFoundException({ code: 'CONNECTOR_NOT_FOUND', message: 'Connector not found' });
    await this.access.building(user, connector.buildingId);
    return connector;
  }

  /** Every stop must be a live node of the matching type, on its own floor of this building, and not already serve another connector. */
  private async validateStops(building: { id: string; tenantId: string }, kind: ConnectorKind, stops: ConnectorStopDto[], connectorId?: string): Promise<OrderedStop[]> {
    if (new Set(stops.map((stop) => stop.floorId)).size !== stops.length) throw invalid('A connector may have only one stop per floor');
    if (new Set(stops.map((stop) => stop.nodeId)).size !== stops.length) throw invalid('A node may appear only once in a connector');
    const nodes = await this.prisma.node.findMany({ where: { id: { in: stops.map((stop) => stop.nodeId) }, deletedAt: null }, include: { floor: true, connectorStop: true } });
    const byId = new Map(nodes.map((node) => [node.id, node]));
    for (const stop of stops) {
      const node = byId.get(stop.nodeId);
      if (!node || node.floorId !== stop.floorId || node.tenantId !== building.tenantId || node.floor.deletedAt || node.floor.buildingId !== building.id) throw invalid('Every stop node must exist on the stated floor of this building', { nodeId: stop.nodeId });
      if (node.type !== NODE_TYPE_FOR_KIND[kind]) throw invalid(`A ${kind} connector needs ${NODE_TYPE_FOR_KIND[kind]} nodes`, { nodeId: node.id, nodeType: node.type });
      if (node.connectorStop && node.connectorStop.connectorId !== connectorId) throw new ConflictException({ code: 'NODE_ALREADY_IN_CONNECTOR', message: 'This node already belongs to another connector', nodeId: node.id });
    }
    return stops.map((stop) => ({ ...stop, floorNumber: byId.get(stop.nodeId)!.floor.floorNumber })).sort((a, b) => a.floorNumber - b.floorNumber);
  }

  private async orderedStops(db: Tx | PrismaService, connectorId: string): Promise<OrderedStop[]> {
    const rows = await db.connectorStop.findMany({ where: { connectorId }, include: { floor: { select: { floorNumber: true } } } });
    return rows.map((row) => ({ floorId: row.floorId, nodeId: row.nodeId, floorNumber: row.floor.floorNumber })).sort((a, b) => a.floorNumber - b.floorNumber);
  }

  /** Keeps ElevatorLink (what route() and publish still read) in step with ELEVATOR connectors: one link per pair of adjacent stops. */
  private async syncLegacyLinks(tx: Tx, building: { id: string; tenantId: string }, kind: ConnectorKind, before: OrderedStop[], after: OrderedStop[]) {
    if (kind !== ConnectorKind.ELEVATOR) return;
    const pairs = (stops: OrderedStop[]) => stops.slice(1).map((stop, i) => pairOf(stops[i].nodeId, stop.nodeId));
    const wanted = new Set(pairs(after).map(([low, high]) => `${low}|${high}`));
    const stale = pairs(before).filter(([low, high]) => !wanted.has(`${low}|${high}`));
    if (stale.length) await tx.elevatorLink.updateMany({ where: { buildingId: building.id, deletedAt: null, OR: stale.map(([nodeLowId, nodeHighId]) => ({ nodeLowId, nodeHighId })) }, data: { deletedAt: new Date() } });
    for (const [nodeLowId, nodeHighId] of pairs(after)) {
      const exists = await tx.elevatorLink.findFirst({ where: { buildingId: building.id, nodeLowId, nodeHighId, deletedAt: null }, select: { id: true } });
      if (!exists) await tx.elevatorLink.create({ data: { tenantId: building.tenantId, buildingId: building.id, nodeIdFrom: nodeLowId, nodeIdTo: nodeHighId, nodeLowId, nodeHighId } });
    }
  }

  /** The unique indexes are the last line of defence against two requests claiming the same node/floor. */
  private async write<T>(run: () => Promise<T>): Promise<T> {
    try { return await run(); } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException({ code: 'NODE_ALREADY_IN_CONNECTOR', message: 'A stop of this connector is already used by another connector' });
      throw error;
    }
  }
}
