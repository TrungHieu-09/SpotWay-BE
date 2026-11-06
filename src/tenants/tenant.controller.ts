import { Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ServicePackage, UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { CurrentUser } from '../common/current-user.decorator';
import { AuthUser } from '../common/auth.types';
import { Roles } from '../common/roles.decorator';
import { PrismaService } from '../database/prisma.service';
import { ApiEnvelopeResponse, ApiStandardErrors } from '../common/swagger';

@ApiTags('Tenant (Self-service)')
@ApiBearerAuth('bearerAuth')
@Controller('tenant')
@Roles(UserRole.BUILDING_OWNER, UserRole.ADMIN)
export class TenantController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('overview')
  @ApiOperation({ summary: 'Get current tenant overview, plan and usage' })
  @ApiEnvelopeResponse(200, 'Tenant overview returned successfully')
  @ApiStandardErrors()
  async getOverview(@CurrentUser() user: AuthUser) {
    const tenantId = user.tenantId;
    if (!tenantId) {
      throw new NotFoundException({
        code: 'NO_TENANT',
        message: 'Tài khoản chưa thuộc không gian làm việc nào',
      });
    }

    const tenant = await this.prisma.tenant.findFirst({
      where: { id: tenantId, deletedAt: null },
    });
    if (!tenant) {
      throw new NotFoundException({
        code: 'TENANT_NOT_FOUND',
        message: 'Không gian làm việc không tồn tại hoặc đã bị đóng',
      });
    }

    const [
      buildingsCount,
      floorsCount,
      publishedFloorsCount,
      managersCount,
      storeOwnersCount,
      storesCount,
      activePromotionsCount,
    ] = await Promise.all([
      this.prisma.building.count({ where: { tenantId, deletedAt: null } }),
      this.prisma.floor.count({ where: { tenantId } }),
      this.prisma.floor.count({ where: { tenantId, publishStatus: 'PUBLISHED' } }),
      this.prisma.user.count({ where: { tenantId, role: UserRole.BUILDING_MANAGER, deletedAt: null } }),
      this.prisma.user.count({ where: { tenantId, role: UserRole.STORE_OWNER, deletedAt: null } }),
      this.prisma.store.count({ where: { tenantId, deletedAt: null } }),
      this.prisma.promotion.count({ where: { store: { tenantId }, status: 'ACTIVE' } }),
    ]);

    const isEnterprise = tenant.servicePackage === ServicePackage.ENTERPRISE;
    const isPro = tenant.servicePackage === ServicePackage.PRO;

    return {
      tenant: {
        id: tenant.id,
        name: tenant.name,
        subdomain: tenant.subdomain,
        planId: tenant.servicePackage,
        status: tenant.status.toLowerCase(),
        planExpiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        createdAt: tenant.createdAt.toISOString(),
      },
      plan: {
        id: tenant.servicePackage,
        name: isEnterprise
          ? 'Gói Doanh Nghiệp (Enterprise)'
          : isPro
            ? 'Gói Chuyên Nghiệp (Pro)'
            : 'Gói Khởi Đầu (Starter)',
        maxBuildings: isEnterprise ? 100 : isPro ? 10 : 3,
        maxManagers: isEnterprise ? 50 : isPro ? 10 : 2,
        maxStoreOwners: isEnterprise ? 500 : isPro ? 50 : 10,
        priceVnd: isEnterprise ? 4999000 : isPro ? 1999000 : 0,
        durationMonths: 12,
      },
      usage: {
        buildings: buildingsCount,
        areas: 0,
        managers: managersCount,
        storeOwners: storeOwnersCount,
        floors: floorsCount,
        publishedFloors: publishedFloorsCount,
        stores: storesCount,
        activePromotions: activePromotionsCount,
      },
    };
  }

  @Get('users')
  @ApiOperation({ summary: 'List users in the current workspace' })
  @ApiEnvelopeResponse(200, 'Tenant users returned successfully')
  @ApiStandardErrors()
  async getUsers(@CurrentUser() user: AuthUser) {
    const tenantId = user.tenantId;
    if (!tenantId) return [];
    const users = await this.prisma.user.findMany({
      where: { tenantId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        email: true,
        role: true,
        tenantId: true,
        createdAt: true,
      },
    });

    return users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.email.split('@')[0],
      role: u.role.toLowerCase(),
      tenantId: u.tenantId,
      status: 'active',
      mustChangePassword: false,
      createdAt: u.createdAt.toISOString(),
    }));
  }

  @Post('users')
  @ApiOperation({ summary: 'Create a manager or store owner account for current workspace' })
  @ApiEnvelopeResponse(201, 'User created successfully')
  @ApiStandardErrors()
  async createUser(
    @CurrentUser() user: AuthUser,
    @Body() body: { email: string; name?: string; role: 'building_manager' | 'store_owner' },
  ) {
    const tenantId = user.tenantId;
    if (!tenantId) {
      throw new NotFoundException({ code: 'NO_TENANT', message: 'User has no workspace' });
    }

    const normalizedEmail = body.email.trim().toLowerCase();
    const existing = await this.prisma.user.findFirst({
      where: { email: normalizedEmail, deletedAt: null },
    });
    if (existing) {
      throw new NotFoundException({
        code: 'EMAIL_EXISTS',
        message: 'Tài khoản email này đã tồn tại trong hệ thống',
      });
    }

    const tempPassword = `SpotWay@${Math.floor(100000 + Math.random() * 900000)}`;
    const passwordHash = await bcrypt.hash(tempPassword, 12);
    const assignedRole =
      body.role === 'store_owner' ? UserRole.STORE_OWNER : UserRole.BUILDING_MANAGER;

    const created = await this.prisma.user.create({
      data: {
        email: normalizedEmail,
        passwordHash,
        role: assignedRole,
        tenantId,
      },
    });

    return {
      id: created.id,
      email: created.email,
      name: body.name || created.email.split('@')[0],
      role: created.role.toLowerCase(),
      tenantId: created.tenantId,
      status: 'active',
      temporaryPassword: tempPassword,
      createdAt: created.createdAt.toISOString(),
    };
  }

  @Delete('users/:id')
  @ApiOperation({ summary: 'Remove a user from current workspace' })
  @ApiEnvelopeResponse(200, 'User removed successfully')
  @ApiStandardErrors()
  async removeUser(@CurrentUser() user: AuthUser, @Param('id') userId: string) {
    const target = await this.prisma.user.findFirst({
      where: { id: userId, tenantId: user.tenantId, deletedAt: null },
    });
    if (!target) {
      throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found' });
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { deletedAt: new Date() },
    });
    return { success: true };
  }

  @Get('plans')
  @ApiOperation({ summary: 'List available plans' })
  @ApiEnvelopeResponse(200, 'Plans returned successfully')
  getPlans() {
    return [
      {
        id: 'FREE',
        name: 'Gói Khởi Đầu (Starter)',
        maxBuildings: 3,
        maxManagers: 2,
        maxStoreOwners: 10,
        priceVnd: 0,
        durationMonths: 12,
      },
      {
        id: 'PRO',
        name: 'Gói Chuyên Nghiệp (Pro)',
        maxBuildings: 10,
        maxManagers: 10,
        maxStoreOwners: 50,
        priceVnd: 1999000,
        durationMonths: 12,
      },
      {
        id: 'ENTERPRISE',
        name: 'Gói Doanh Nghiệp (Enterprise)',
        maxBuildings: 100,
        maxManagers: 50,
        maxStoreOwners: 500,
        priceVnd: 4999000,
        durationMonths: 12,
      },
    ];
  }

  @Get('invoices')
  @ApiOperation({ summary: 'List invoices' })
  @ApiEnvelopeResponse(200, 'Invoices returned successfully')
  getInvoices() {
    return [];
  }
}

