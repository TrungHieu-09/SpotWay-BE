import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { BuildingStatus, FloorPublishStatus, TenantStatus, UserRole } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { AnalyticsService } from '../analytics/analytics.service';
import { AuthUser } from '../common/auth.types'; import { TenantAccessService } from '../common/tenant-access.service'; import { PrismaService } from '../database/prisma.service';

@Injectable()
export class QrService {
  constructor(private readonly prisma: PrismaService, private readonly access: TenantAccessService, private readonly analytics: AnalyticsService) {}
  private hash(token: string) { return createHash('sha256').update(token).digest('hex'); }
  async create(user: AuthUser, nodeId: string, label: string) {
    const node = await this.prisma.node.findFirst({ where: { id: nodeId, deletedAt: null }, include: { floor: true } });
    if (!node || node.floor.deletedAt) throw new NotFoundException({ code: 'NODE_NOT_FOUND', message: 'Node was not found' });
    await this.access.building(user, node.floor.buildingId);
    const token = randomBytes(32).toString('base64url');
    const anchor = await this.prisma.qrAnchor.create({ data: { tenantId: node.tenantId, buildingId: node.floor.buildingId, floorId: node.floorId, nodeId, tokenHash: this.hash(token), label: label.trim() } });
    return { ...anchor, token };
  }
  async list(user: AuthUser, nodeId: string) { const node = await this.prisma.node.findFirst({ where: { id: nodeId, deletedAt: null }, include: { floor: true } }); if (!node || node.floor.deletedAt) throw new NotFoundException({ code: 'NODE_NOT_FOUND', message: 'Node was not found' }); await this.access.building(user, node.floor.buildingId); return this.prisma.qrAnchor.findMany({ where: { nodeId, deletedAt: null }, orderBy: { createdAt: 'desc' }, select: { id: true, label: true, nodeId: true, floorId: true, buildingId: true, createdAt: true } }); }
  async remove(user: AuthUser, id: string) { const anchor = await this.prisma.qrAnchor.findFirst({ where: { id, deletedAt: null } }); if (!anchor) throw new NotFoundException({ code: 'QR_ANCHOR_NOT_FOUND', message: 'QR anchor was not found' }); await this.access.building(user, anchor.buildingId); return this.prisma.qrAnchor.update({ where: { id }, data: { deletedAt: new Date() } }); }
  async resolve(token: string) {
    const anchor = await this.prisma.qrAnchor.findFirst({ where: { tokenHash: this.hash(token), deletedAt: null }, include: { node: true, floor: { include: { building: { include: { tenant: true } } } } } });
    if (!anchor || anchor.node.deletedAt || anchor.floor.deletedAt || anchor.floor.publishStatus !== FloorPublishStatus.PUBLISHED || anchor.floor.building.deletedAt || anchor.floor.building.status !== BuildingStatus.ACTIVE || anchor.floor.building.tenant.deletedAt || anchor.floor.building.tenant.archived || anchor.floor.building.tenant.status !== TenantStatus.ACTIVE) throw new NotFoundException({ code: 'QR_NOT_AVAILABLE', message: 'QR location is not publicly available' });
    void this.analytics.enqueue({ eventType: 'QR_SCANNED', tenantId: anchor.tenantId, buildingId: anchor.buildingId, floorId: anchor.floorId, context: { fromNodeId: anchor.nodeId } }).catch(() => undefined);
    return { nodeId: anchor.nodeId, floorId: anchor.floorId, buildingId: anchor.buildingId, x: anchor.node.x, y: anchor.node.y, label: anchor.label };
  }
}
