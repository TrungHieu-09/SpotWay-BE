import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { CreateTenantDto, UpdateTenantDto } from './tenants.dto';
@Injectable()
export class TenantsService {
  constructor(private readonly prisma: PrismaService) {}
  list() { return this.prisma.tenant.findMany({ where: { deletedAt: null }, orderBy: { createdAt: 'desc' } }); }
  async create(dto: CreateTenantDto) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const tenant = await tx.tenant.create({ data: { name: dto.name.trim(), subdomain: dto.subdomain, servicePackage: dto.servicePackage } });
        const owner = await tx.user.create({ data: { email: dto.ownerEmail.trim().toLowerCase(), tenantId: tenant.id, role: UserRole.BUILDING_OWNER } });
        return { tenant, owner: { id: owner.id, email: owner.email, role: owner.role } };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException({ code: 'TENANT_OR_OWNER_ALREADY_EXISTS', message: 'Tenant subdomain or owner email already exists' });
      throw error;
    }
  }
  async update(id: string, dto: UpdateTenantDto) { const tenant = await this.prisma.tenant.findFirst({ where: { id, deletedAt: null } }); if (!tenant) throw new NotFoundException({ code: 'TENANT_NOT_FOUND', message: 'Tenant was not found' }); return this.prisma.tenant.update({ where: { id }, data: { ...dto, name: dto.name?.trim() } }); }
}
