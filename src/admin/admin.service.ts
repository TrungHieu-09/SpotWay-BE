import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Tenant, TenantStatus, User, UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomBytes, randomInt } from 'crypto';
import { PrismaService } from '../database/prisma.service';
import { AssignableRole, CreateAdminUserDto, ResetAdminPasswordDto } from './admin.dto';

const ROLE_BY_NAME: Record<AssignableRole, UserRole> = {
  building_owner: UserRole.BUILDING_OWNER,
  building_manager: UserRole.BUILDING_MANAGER,
  store_owner: UserRole.STORE_OWNER,
};

type UserWithTenant = User & { tenant: Tenant | null };

/** Visitors browse the public map without an account, so a guest is never a listed or counted account. */
const ACCOUNT_FILTER = { deletedAt: null, role: { not: UserRole.GUEST } } satisfies Prisma.UserWhereInput;

/**
 * Accounts are handed out by an admin: email + password + role. The data model keeps every owner, manager and
 * store owner inside a tenant, but the admin never sees it: a Building Owner gets one created behind the scenes,
 * and managers / store owners join the tenant of the owner they are assigned to.
 */
@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  private serialize(user: UserWithTenant) {
    return {
      id: user.id,
      email: user.email,
      name: user.email.split('@')[0],
      role: user.role.toLowerCase(),
      tenantId: user.tenantId,
      tenantName: user.tenant && !user.tenant.deletedAt ? user.tenant.name : null,
      status: 'active' as const,
      mustChangePassword: false,
      createdByUserId: null,
      createdAt: user.createdAt.toISOString(),
    };
  }

  async overview() {
    const [byRole, buildings] = await Promise.all([
      this.prisma.user.groupBy({ by: ['role'], where: ACCOUNT_FILTER, _count: { _all: true } }),
      this.prisma.building.count({ where: { deletedAt: null } }),
    ]);
    const count = (role: UserRole) => byRole.find((row) => row.role === role)?._count._all ?? 0;
    return {
      users: {
        total: byRole.reduce((sum, row) => sum + row._count._all, 0),
        admin: count(UserRole.ADMIN),
        buildingOwner: count(UserRole.BUILDING_OWNER),
        buildingManager: count(UserRole.BUILDING_MANAGER),
        storeOwner: count(UserRole.STORE_OWNER),
      },
      buildings,
    };
  }

  async listUsers() {
    const users = await this.prisma.user.findMany({ where: ACCOUNT_FILTER, include: { tenant: true }, orderBy: { createdAt: 'desc' } });
    return users.map((user) => this.serialize(user));
  }

  async createUser(dto: CreateAdminUserDto) {
    const email = dto.email.trim().toLowerCase();
    const role = ROLE_BY_NAME[dto.role];
    // The email column is unique across soft-deleted rows too: an account that was removed is brought back instead.
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing && !existing.deletedAt) {
      throw new ConflictException({ code: 'EMAIL_EXISTS', message: 'Email này đã có tài khoản trong hệ thống.' });
    }
    const passwordHash = await bcrypt.hash(dto.password, 12);
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        let tenantId: string | null = null;
        if (role === UserRole.BUILDING_OWNER) tenantId = await this.createHiddenTenant(tx, email);
        else if (role === UserRole.BUILDING_MANAGER || role === UserRole.STORE_OWNER) tenantId = await this.tenantOfOwner(tx, dto.ownerId);
        const data = { email, passwordHash, role, tenantId, deletedAt: null };
        return existing
          ? tx.user.update({ where: { id: existing.id }, data, include: { tenant: true } })
          : tx.user.create({ data, include: { tenant: true } });
      });
      return this.serialize(created);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException({ code: 'EMAIL_EXISTS', message: 'Email này đã có tài khoản trong hệ thống.' });
      }
      throw error;
    }
  }

  async resetPassword(id: string, dto: ResetAdminPasswordDto) {
    const user = await this.prisma.user.findFirst({ where: { id, deletedAt: null } });
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'Không tìm thấy tài khoản.' });
    const temporaryPassword = dto.newPassword ? undefined : `SpotWay@${randomInt(100000, 1000000)}`;
    const passwordHash = await bcrypt.hash(dto.newPassword ?? temporaryPassword!, 12);
    const [updated] = await this.prisma.$transaction([
      this.prisma.user.update({ where: { id }, data: { passwordHash }, include: { tenant: true } }),
      this.prisma.refreshSession.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    return { ...this.serialize(updated), ...(temporaryPassword ? { temporaryPassword } : {}) };
  }

  async deleteUser(id: string, actorId: string) {
    if (id === actorId) {
      throw new ForbiddenException({ code: 'CANNOT_DELETE_SELF', message: 'Bạn không thể tự xóa tài khoản của mình.' });
    }
    const user = await this.prisma.user.findFirst({ where: { id, deletedAt: null } });
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'Không tìm thấy tài khoản.' });
    if (user.role === UserRole.BUILDING_OWNER && user.tenantId) {
      const members = await this.prisma.user.count({ where: { tenantId: user.tenantId, deletedAt: null, id: { not: user.id } } });
      if (members > 0) {
        throw new ConflictException({ code: 'OWNER_HAS_MEMBERS', message: 'Chủ tòa nhà này còn tài khoản quản lý/gian hàng thuộc về họ. Hãy xóa các tài khoản đó trước.' });
      }
    }
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id }, data: { deletedAt: new Date() } }),
      this.prisma.refreshSession.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    return { id, deleted: true };
  }

  private async createHiddenTenant(tx: Prisma.TransactionClient, ownerEmail: string) {
    const local = ownerEmail.split('@')[0];
    const slug = local.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'owner';
    const tenant = await tx.tenant.create({
      data: {
        name: local,
        subdomain: `${slug}-${randomBytes(3).toString('hex')}`,
        status: TenantStatus.ACTIVE,
      },
    });
    return tenant.id;
  }

  private async tenantOfOwner(tx: Prisma.TransactionClient, ownerId?: string) {
    if (!ownerId) {
      throw new BadRequestException({ code: 'OWNER_REQUIRED', message: 'Vui lòng chọn chủ tòa nhà mà tài khoản này thuộc về.' });
    }
    const owner = await tx.user.findFirst({ where: { id: ownerId, role: UserRole.BUILDING_OWNER, deletedAt: null, tenantId: { not: null } } });
    if (!owner?.tenantId) {
      throw new NotFoundException({ code: 'OWNER_NOT_FOUND', message: 'Không tìm thấy chủ tòa nhà đã chọn.' });
    }
    return owner.tenantId;
  }
}
