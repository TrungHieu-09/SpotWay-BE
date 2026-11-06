import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
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
      this.prisma.floor.count({ where: { tenantId, deletedAt: null } }),
      this.prisma.floor.count({ where: { tenantId, deletedAt: null, publishStatus: 'PUBLISHED' } }),
      this.prisma.user.count({ where: { tenantId, role: UserRole.BUILDING_MANAGER, deletedAt: null } }),
      this.prisma.user.count({ where: { tenantId, role: UserRole.STORE_OWNER, deletedAt: null } }),
      this.prisma.store.count({ where: { tenantId, deletedAt: null } }),
      this.prisma.promotion.count({ where: { store: { tenantId }, status: 'ACTIVE', deletedAt: null } }),
    ]);

    return {
      tenant: {
        id: tenant.id,
        name: tenant.name,
        subdomain: tenant.subdomain,
        status: tenant.status.toLowerCase(),
        createdAt: tenant.createdAt.toISOString(),
      },
      usage: {
        buildings: buildingsCount,
        areas: buildingsCount,
        managers: managersCount,
        storeOwners: storeOwnersCount,
        floors: floorsCount,
        publishedFloors: publishedFloorsCount,
        stores: storesCount,
        activePromotions: activePromotionsCount,
      },
    };
  }

  @Get('areas')
  @ApiOperation({ summary: 'List buildings/areas in the current workspace for staff assignment' })
  @ApiEnvelopeResponse(200, 'Tenant areas returned successfully')
  @ApiStandardErrors()
  async getAreas(@CurrentUser() user: AuthUser) {
    const tenantId = user.tenantId;
    if (!tenantId) return [];
    const buildings = await this.prisma.building.findMany({
      where: { tenantId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        address: true,
        status: true,
        createdAt: true,
      },
    });

    return buildings.map((b) => ({
      id: b.id,
      tenantId,
      buildingId: b.id,
      name: b.name,
      description: b.address ?? '',
      color: '#8B5CF6',
      status: b.status.toLowerCase(),
      createdAt: b.createdAt.toISOString(),
    }));
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
        assignments: {
          where: { building: { deletedAt: null } },
          select: { buildingId: true },
        },
      },
    });

    return users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.email.split('@')[0],
      role: u.role.toLowerCase(),
      tenantId: u.tenantId,
      areaIds: u.assignments.map((a) => a.buildingId),
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
    @Body()
    body: {
      email: string;
      name?: string;
      password?: string;
      role: 'building_manager' | 'store_owner';
      areaIds?: string[];
    },
  ) {
    const tenantId = user.tenantId;
    if (!tenantId) {
      throw new NotFoundException({ code: 'NO_TENANT', message: 'Tài khoản chưa thuộc không gian làm việc nào' });
    }

    const normalizedEmail = (body.email ?? '').trim().toLowerCase();
    if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      throw new BadRequestException({
        code: 'INVALID_EMAIL',
        message: 'Địa chỉ email không hợp lệ',
      });
    }

    const existing = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
    });
    if (existing && !existing.deletedAt) {
      throw new ConflictException({
        code: 'EMAIL_EXISTS',
        message: 'Tài khoản email này đã tồn tại trong hệ thống',
      });
    }

    const rawPassword =
      body.password && body.password.trim().length >= 8
        ? body.password.trim()
        : `SpotWay@${Math.floor(100000 + Math.random() * 900000)}`;
    const passwordHash = await bcrypt.hash(rawPassword, 12);
    const assignedRole =
      body.role === 'store_owner' ? UserRole.STORE_OWNER : UserRole.BUILDING_MANAGER;

    const requestedBuildingIds =
      assignedRole === UserRole.BUILDING_MANAGER && Array.isArray(body.areaIds)
        ? Array.from(new Set(body.areaIds.filter(Boolean)))
        : [];

    const validBuildings =
      requestedBuildingIds.length > 0
        ? await this.prisma.building.findMany({
            where: { id: { in: requestedBuildingIds }, tenantId, deletedAt: null },
            select: { id: true },
          })
        : [];
    const validBuildingIds = validBuildings.map((b) => b.id);

    const created = await this.prisma.$transaction(async (tx) => {
      const savedUser = existing
        ? await tx.user.update({
            where: { id: existing.id },
            data: {
              email: normalizedEmail,
              passwordHash,
              role: assignedRole,
              tenantId,
              deletedAt: null,
            },
          })
        : await tx.user.create({
            data: {
              email: normalizedEmail,
              passwordHash,
              role: assignedRole,
              tenantId,
            },
          });

      await tx.staffAssignment.deleteMany({ where: { userId: savedUser.id } });
      if (validBuildingIds.length > 0) {
        await tx.staffAssignment.createMany({
          data: validBuildingIds.map((buildingId) => ({
            userId: savedUser.id,
            buildingId,
          })),
          skipDuplicates: true,
        });
      }

      return savedUser;
    });

    return {
      id: created.id,
      email: created.email,
      name: body.name?.trim() || created.email.split('@')[0],
      role: created.role.toLowerCase(),
      tenantId: created.tenantId,
      areaIds: validBuildingIds,
      status: 'active',
      temporaryPassword: rawPassword,
      createdAt: created.createdAt.toISOString(),
    };
  }

  @Patch('users/:id')
  @ApiOperation({ summary: 'Update a manager or store owner in current workspace (areas, password reset, status)' })
  @ApiEnvelopeResponse(200, 'User updated successfully')
  @ApiStandardErrors()
  async updateUser(
    @CurrentUser() user: AuthUser,
    @Param('id') userId: string,
    @Body()
    body: {
      status?: 'active' | 'locked';
      resetPassword?: boolean;
      newPassword?: string;
      areaIds?: string[];
    },
  ) {
    const tenantId = user.tenantId;
    if (!tenantId) {
      throw new NotFoundException({ code: 'NO_TENANT', message: 'Tài khoản chưa thuộc không gian làm việc nào' });
    }

    const target = await this.prisma.user.findFirst({
      where: { id: userId, tenantId, deletedAt: null },
      include: {
        assignments: {
          where: { building: { deletedAt: null } },
          select: { buildingId: true },
        },
      },
    });

    if (!target) {
      throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'Không tìm thấy tài khoản nhân sự' });
    }

    let temporaryPassword: string | undefined;
    let nextPasswordHash: string | undefined;
    if (body.resetPassword) {
      temporaryPassword =
        body.newPassword && body.newPassword.trim().length >= 8
          ? body.newPassword.trim()
          : `SpotWay@${Math.floor(100000 + Math.random() * 900000)}`;
      nextPasswordHash = await bcrypt.hash(temporaryPassword, 12);
    }

    let nextAreaIds = target.assignments.map((a) => a.buildingId);
    if (Array.isArray(body.areaIds) && target.role === UserRole.BUILDING_MANAGER) {
      const requestedIds = Array.from(new Set(body.areaIds.filter(Boolean)));
      const validBuildings =
        requestedIds.length > 0
          ? await this.prisma.building.findMany({
              where: { id: { in: requestedIds }, tenantId, deletedAt: null },
              select: { id: true },
            })
          : [];
      nextAreaIds = validBuildings.map((b) => b.id);
    }

    await this.prisma.$transaction(async (tx) => {
      if (nextPasswordHash) {
        await tx.user.update({
          where: { id: userId },
          data: { passwordHash: nextPasswordHash },
        });
        await tx.refreshSession.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }

      if (Array.isArray(body.areaIds) && target.role === UserRole.BUILDING_MANAGER) {
        await tx.staffAssignment.deleteMany({ where: { userId } });
        if (nextAreaIds.length > 0) {
          await tx.staffAssignment.createMany({
            data: nextAreaIds.map((buildingId) => ({
              userId,
              buildingId,
            })),
            skipDuplicates: true,
          });
        }
      }
    });

    return {
      id: target.id,
      email: target.email,
      name: target.email.split('@')[0],
      role: target.role.toLowerCase(),
      tenantId: target.tenantId,
      areaIds: nextAreaIds,
      status: body.status ?? 'active',
      ...(temporaryPassword ? { temporaryPassword } : {}),
      createdAt: target.createdAt.toISOString(),
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
      throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'Không tìm thấy tài khoản' });
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { deletedAt: new Date() },
    });
    return { success: true };
  }
}

@ApiTags('Store Owners')
@ApiBearerAuth('bearerAuth')
@Controller('store-owners')
@Roles(UserRole.BUILDING_OWNER, UserRole.BUILDING_MANAGER, UserRole.ADMIN)
export class StoreOwnersController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@CurrentUser() user: AuthUser) {
    const tenantId = user.tenantId;
    if (!tenantId) return [];
    const owners = await this.prisma.user.findMany({
      where: { tenantId, role: UserRole.STORE_OWNER, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { stores: { where: { deletedAt: null } } } },
      },
    });
    return owners.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.email.split('@')[0],
      role: 'store_owner' as const,
      tenantId: u.tenantId,
      status: 'active' as const,
      storeCount: u._count.stores,
      createdAt: u.createdAt.toISOString(),
    }));
  }

  @Post()
  async create(
    @CurrentUser() user: AuthUser,
    @Body() body: { name?: string; email: string; password?: string },
  ) {
    const tenantId = user.tenantId;
    if (!tenantId) {
      throw new NotFoundException({ code: 'NO_TENANT', message: 'Tài khoản chưa thuộc không gian làm việc nào' });
    }
    const normalizedEmail = (body.email ?? '').trim().toLowerCase();
    if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      throw new BadRequestException({ code: 'INVALID_EMAIL', message: 'Địa chỉ email không hợp lệ' });
    }
    const existing = await this.prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existing && !existing.deletedAt) {
      throw new ConflictException({ code: 'EMAIL_EXISTS', message: 'Tài khoản email này đã tồn tại trong hệ thống' });
    }
    const rawPassword =
      body.password && body.password.trim().length >= 8
        ? body.password.trim()
        : `SpotWay@${Math.floor(100000 + Math.random() * 900000)}`;
    const passwordHash = await bcrypt.hash(rawPassword, 12);

    const created = existing
      ? await this.prisma.user.update({
          where: { id: existing.id },
          data: {
            email: normalizedEmail,
            passwordHash,
            role: UserRole.STORE_OWNER,
            tenantId,
            deletedAt: null,
          },
        })
      : await this.prisma.user.create({
          data: {
            email: normalizedEmail,
            passwordHash,
            role: UserRole.STORE_OWNER,
            tenantId,
          },
        });

    return {
      id: created.id,
      email: created.email,
      name: body.name?.trim() || created.email.split('@')[0],
      role: 'store_owner' as const,
      tenantId: created.tenantId,
      status: 'active' as const,
      storeCount: 0,
      temporaryPassword: rawPassword,
      createdAt: created.createdAt.toISOString(),
    };
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: { status?: 'active' | 'locked' },
  ) {
    const target = await this.prisma.user.findFirst({
      where: { id, tenantId: user.tenantId, role: UserRole.STORE_OWNER, deletedAt: null },
      include: { _count: { select: { stores: { where: { deletedAt: null } } } } },
    });
    if (!target) {
      throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'Không tìm thấy chủ gian hàng' });
    }
    return {
      id: target.id,
      email: target.email,
      name: target.email.split('@')[0],
      role: 'store_owner' as const,
      tenantId: target.tenantId,
      status: body.status ?? 'active',
      storeCount: target._count.stores,
      createdAt: target.createdAt.toISOString(),
    };
  }

  @Post(':id/reset-password')
  async resetPassword(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const target = await this.prisma.user.findFirst({
      where: { id, tenantId: user.tenantId, role: UserRole.STORE_OWNER, deletedAt: null },
      include: { _count: { select: { stores: { where: { deletedAt: null } } } } },
    });
    if (!target) {
      throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'Không tìm thấy chủ gian hàng' });
    }
    const temporaryPassword = `SpotWay@${Math.floor(100000 + Math.random() * 900000)}`;
    const passwordHash = await bcrypt.hash(temporaryPassword, 12);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id }, data: { passwordHash } }),
      this.prisma.refreshSession.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    return {
      id: target.id,
      email: target.email,
      name: target.email.split('@')[0],
      role: 'store_owner' as const,
      tenantId: target.tenantId,
      status: 'active' as const,
      storeCount: target._count.stores,
      temporaryPassword,
      createdAt: target.createdAt.toISOString(),
    };
  }

  @Delete(':id')
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const target = await this.prisma.user.findFirst({
      where: { id, tenantId: user.tenantId, role: UserRole.STORE_OWNER, deletedAt: null },
    });
    if (!target) {
      throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'Không tìm thấy chủ gian hàng' });
    }
    await this.prisma.user.update({ where: { id }, data: { deletedAt: new Date() } });
    return { success: true };
  }
}

