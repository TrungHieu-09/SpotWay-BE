import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuthUser } from '../../common/auth.types';
import { TenantAccessService } from '../../common/tenant-access.service';
import { PrismaService } from '../../database/prisma.service';
import { distanceMeters } from '../domain/coordinate-transform';
import { GRAPH_ERROR_CODES } from '../domain/graph.types';
import { findNearestNode } from '../domain/nearest-node';
import { CreatePoiV2Dto, SnapResultResponse, UpdatePoiV2Dto } from '../dto/poi-v2.dto';
import { assertInsideMap, bumpGraphVersion, loadFloor } from './graph-support';

const DEFAULT_MAX_SNAP_METERS = 10;

type Placement = { x: number; y: number; nodeId?: string; maxSnapMeters?: number };

@Injectable()
export class PoiService {
  constructor(private readonly prisma: PrismaService, private readonly access: TenantAccessService) {}

  /** Upper bound for client-supplied snap limits. */
  private get maxSnapMeters() {
    const configured = Number(process.env.POI_MAX_SNAP_METERS);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_SNAP_METERS;
  }

  async list(user: AuthUser, floorId: string) { await loadFloor(this.prisma, this.access, user, floorId); return this.prisma.poi.findMany({ where: { floorId, deletedAt: null }, orderBy: { createdAt: 'asc' } }); }

  async get(user: AuthUser, id: string) {
    const poi = await this.prisma.poi.findFirst({ where: { id, deletedAt: null }, include: { floor: true } });
    if (!poi || poi.floor.deletedAt) throw new NotFoundException({ code: 'POI_NOT_FOUND', message: 'POI not found' });
    await this.access.building(user, poi.floor.buildingId);
    return poi;
  }

  /** Nearest eligible node to (x, y), without writing anything. Needs a calibrated floor because the limit is in metres. */
  async snap(user: AuthUser, floorId: string, x: number, y: number, maxSnapMeters?: number): Promise<SnapResultResponse> {
    const floor = await loadFloor(this.prisma, this.access, user, floorId);
    assertInsideMap(floor, x, y);
    return this.resolveSnap(floor, { x, y, maxSnapMeters });
  }

  async create(user: AuthUser, floorId: string, dto: CreatePoiV2Dto) {
    const floor = await loadFloor(this.prisma, this.access, user, floorId);
    assertInsideMap(floor, dto.x, dto.y);
    const anchor = await this.resolveAnchor(floor, dto);
    return this.prisma.$transaction(async (tx) => {
      await bumpGraphVersion(tx, floorId);
      return tx.poi.create({ data: { tenantId: floor.tenantId, floorId, nodeId: anchor.nodeId, x: dto.x, y: dto.y, snapDistanceMeters: anchor.distanceMeters, name: dto.name.trim(), category: dto.category, icon: dto.icon?.trim() } });
    });
  }

  async update(user: AuthUser, id: string, dto: UpdatePoiV2Dto) {
    const poi = await this.get(user, id);
    const x = dto.x ?? poi.x;
    const y = dto.y ?? poi.y;
    if (x === null || y === null) throw new BadRequestException({ code: 'POI_POSITION_REQUIRED', message: 'This POI has no position yet; send both x and y' });
    assertInsideMap(poi.floor, x, y);
    const repositioned = dto.x !== undefined || dto.y !== undefined || dto.nodeId !== undefined;
    const anchor = repositioned ? await this.resolveAnchor(poi.floor, { x, y, nodeId: dto.nodeId, maxSnapMeters: dto.maxSnapMeters }) : null;
    const { maxSnapMeters: _ignored, nodeId: _node, ...fields } = dto;
    return this.prisma.$transaction(async (tx) => {
      await bumpGraphVersion(tx, poi.floorId);
      return tx.poi.update({ where: { id }, data: { ...fields, name: dto.name?.trim(), icon: dto.icon?.trim(), ...(anchor ? { nodeId: anchor.nodeId, snapDistanceMeters: anchor.distanceMeters, x, y } : {}) } });
    });
  }

  async remove(user: AuthUser, id: string) {
    const poi = await this.get(user, id);
    return this.prisma.$transaction(async (tx) => { await bumpGraphVersion(tx, poi.floorId); return tx.poi.update({ where: { id }, data: { deletedAt: new Date() } }); });
  }

  /** Soft-deletes every POI of a floor in one statement (one graphVersion bump) instead of one transaction per POI. */
  async removeAllOnFloor(user: AuthUser, floorId: string) {
    await loadFloor(this.prisma, this.access, user, floorId);
    return this.prisma.$transaction(async (tx) => {
      await bumpGraphVersion(tx, floorId);
      const { count } = await tx.poi.updateMany({ where: { floorId, deletedAt: null }, data: { deletedAt: new Date() } });
      return { floorId, pois: count };
    }, { timeout: 30_000, maxWait: 10_000 });
  }

  /** Explicit nodeId is validated and measured; otherwise the POI snaps to the nearest node. */
  private async resolveAnchor(floor: { id: string; metersPerPixel: number | null; tenantId: string }, placement: Placement): Promise<{ nodeId: string; distanceMeters: number | null }> {
    if (!placement.nodeId) return this.resolveSnap(floor, placement);
    const node = await this.prisma.node.findFirst({ where: { id: placement.nodeId, floorId: floor.id, tenantId: floor.tenantId, deletedAt: null } });
    if (!node) throw new BadRequestException({ code: 'INVALID_POI_NODE', message: 'POI node must exist on the requested floor' });
    return { nodeId: node.id, distanceMeters: distanceMeters(node, placement, floor.metersPerPixel) };
  }

  private async resolveSnap(floor: { id: string; metersPerPixel: number | null; tenantId: string }, placement: Placement): Promise<SnapResultResponse> {
    if (floor.metersPerPixel === null) throw new ConflictException({ code: GRAPH_ERROR_CODES.FLOOR_NOT_CALIBRATED, message: 'Calibrate the floor scale (PATCH /floors/:id/calibration) or pass an explicit nodeId' });
    const limit = Math.min(placement.maxSnapMeters ?? this.maxSnapMeters, this.maxSnapMeters);
    const nodes = await this.prisma.node.findMany({ where: { floorId: floor.id, tenantId: floor.tenantId, deletedAt: null }, select: { id: true, x: true, y: true } });
    const { match, nearest } = findNearestNode(nodes, placement, floor.metersPerPixel, limit);
    if (!nearest) throw new ConflictException({ code: GRAPH_ERROR_CODES.POI_NO_SNAP_TARGET, message: 'This floor has no nodes to attach the POI to' });
    if (!match) throw new BadRequestException({ code: GRAPH_ERROR_CODES.POI_SNAP_OUT_OF_RANGE, message: `The nearest node is ${nearest.distanceMeters.toFixed(1)} m away, beyond the ${limit} m snap limit`, nearestNodeId: nearest.nodeId, distanceMeters: nearest.distanceMeters, maxSnapMeters: limit });
    return { nodeId: match.nodeId, distanceMeters: Math.round(match.distanceMeters * 1e6) / 1e6 };
  }
}
