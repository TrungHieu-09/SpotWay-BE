import { Injectable, NotFoundException } from '@nestjs/common';
import { TenantStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { UpdateTenantDto } from './tenants.dto';
@Injectable()
export class TenantsService {
  constructor(private readonly prisma: PrismaService) {}
  list() { return this.prisma.tenant.findMany({ where: { deletedAt: null }, orderBy: { createdAt: 'desc' } }); }
  async find(id: string) { const tenant = await this.prisma.tenant.findFirst({ where: { id, deletedAt: null } }); if (!tenant) throw new NotFoundException({ code: 'TENANT_NOT_FOUND', message: 'Tenant was not found' }); return tenant; }
  /** The tenant status guard rejects deleted, archived and suspended tenants, so this also locks out its users. */
  async remove(id: string) { await this.find(id); await this.prisma.tenant.update({ where: { id }, data: { deletedAt: new Date(), archived: true, status: TenantStatus.SUSPENDED } }); return { id, deleted: true }; }
  async update(id: string, dto: UpdateTenantDto) { const tenant = await this.prisma.tenant.findFirst({ where: { id, deletedAt: null } }); if (!tenant) throw new NotFoundException({ code: 'TENANT_NOT_FOUND', message: 'Tenant was not found' }); return this.prisma.tenant.update({ where: { id }, data: { ...dto, name: dto.name?.trim() } }); }
}
