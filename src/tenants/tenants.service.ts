import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, TenantStatus, UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { PrismaService } from '../database/prisma.service';
import { CreateTenantDto, UpdateTenantDto } from './tenants.dto';
@Injectable()
export class TenantsService {
  constructor(private readonly prisma: PrismaService) {}
  list() { return this.prisma.tenant.findMany({ where: { deletedAt: null }, orderBy: { createdAt: 'desc' } }); }
  async find(id: string) { const tenant = await this.prisma.tenant.findFirst({ where: { id, deletedAt: null } }); if (!tenant) throw new NotFoundException({ code: 'TENANT_NOT_FOUND', message: 'Tenant was not found' }); return tenant; }
  /** The tenant status guard rejects deleted, archived and suspended tenants, so this also locks out its users. */
  async remove(id: string) { await this.find(id); await this.prisma.tenant.update({ where: { id }, data: { deletedAt: new Date(), archived: true, status: TenantStatus.SUSPENDED } }); return { id, deleted: true }; }
  async create(dto: CreateTenantDto) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const tenant = await tx.tenant.create({ data: { name: dto.name.trim(), subdomain: dto.subdomain, servicePackage: dto.servicePackage } });
        // The owner needs a password to sign in: issue a temporary one that must be replaced at first login.
        const temporaryPassword = `${randomBytes(9).toString('base64url')}Aa1`;
        const owner = await tx.user.create({ data: { email: dto.ownerEmail.trim().toLowerCase(), tenantId: tenant.id, role: UserRole.BUILDING_OWNER, passwordHash: await bcrypt.hash(temporaryPassword, 12), mustChangePassword: true } });
        return { tenant, owner: { id: owner.id, email: owner.email, role: owner.role }, temporaryPassword };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException({ code: 'TENANT_OR_OWNER_ALREADY_EXISTS', message: 'Tenant subdomain or owner email already exists' });
      throw error;
    }
  }
  async update(id: string, dto: UpdateTenantDto) { const tenant = await this.prisma.tenant.findFirst({ where: { id, deletedAt: null } }); if (!tenant) throw new NotFoundException({ code: 'TENANT_NOT_FOUND', message: 'Tenant was not found' }); return this.prisma.tenant.update({ where: { id }, data: { ...dto, name: dto.name?.trim() } }); }
}
