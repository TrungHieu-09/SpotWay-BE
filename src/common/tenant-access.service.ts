import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AuthUser } from './auth.types';
import { PrismaService } from '../database/prisma.service';
@Injectable()
export class TenantAccessService {
  constructor(private readonly prisma: PrismaService) {}
  async building(user: AuthUser, buildingId: string) {
    const building = await this.prisma.building.findFirst({ where: { id: buildingId, deletedAt: null } });
    if (!building) throw new NotFoundException({ code: 'BUILDING_NOT_FOUND', message: 'Building not found' });
    if (user.role === UserRole.ADMIN) return building;
    if (building.tenantId !== user.tenantId) throw new ForbiddenException({ code: 'TENANT_ACCESS_DENIED', message: 'Cross-tenant access is denied' });
    if (user.role === UserRole.BUILDING_MANAGER) { const assigned = await this.prisma.staffAssignment.findUnique({ where: { userId_buildingId: { userId: user.userId, buildingId } } }); if (!assigned) throw new ForbiddenException({ code: 'BUILDING_ACCESS_DENIED', message: 'Manager is not assigned to this building' }); }
    if (user.role !== UserRole.BUILDING_OWNER && user.role !== UserRole.BUILDING_MANAGER) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Building access is denied' });
    return building;
  }
}
