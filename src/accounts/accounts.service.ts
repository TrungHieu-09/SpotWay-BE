import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Prisma, Tenant, TenantStatus, User, UserAccountStatus, UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { AuthUser } from '../common/auth.types';
import { PrismaService } from '../database/prisma.service';
import { STORE_WITH_BUILDING, serializeStore } from '../stores/store-serializer';
import { ADMIN_ASSIGNABLE_ROLES, CreateAdminUserDto, CreateStaffDto } from './accounts.dto';

const BCRYPT_ROUNDS = 12;
const ROLE_OF: Record<(typeof ADMIN_ASSIGNABLE_ROLES)[number], UserRole> = {
  building_owner: UserRole.BUILDING_OWNER,
  building_manager: UserRole.BUILDING_MANAGER,
  store_owner: UserRole.STORE_OWNER,
};
const STAFF_ROLES: UserRole[] = [UserRole.BUILDING_MANAGER, UserRole.STORE_OWNER];

type StaffPatch = { status?: 'active' | 'locked'; resetPassword?: boolean };

@Injectable()
export class AccountsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Shape the FE expects (lowercase role, active/locked status, display name). `areaIds` are the buildings a manager is assigned to. */
  toDto(user: User & { assignments?: { buildingId: string }[] }) {
    return {
      id: user.id,
      tenantId: user.tenantId,
      role: user.role.toLowerCase(),
      name: user.name?.trim() || user.email.split('@')[0],
      email: user.email,
      areaIds: (user.assignments ?? []).map((assignment) => assignment.buildingId),
      createdByUserId: null as string | null,
      mustChangePassword: user.mustChangePassword,
      status: user.status === UserAccountStatus.LOCKED ? 'locked' : 'active',
      createdAt: user.createdAt.toISOString(),
    };
  }

  private tenantDto(tenant: Tenant) {
    return {
      id: tenant.id,
      name: tenant.name,
      subdomain: tenant.subdomain,
      status: tenant.status === TenantStatus.ACTIVE ? 'active' : 'suspended',
      createdAt: tenant.createdAt.toISOString(),
    };
  }

  /** 12 characters from an unambiguous alphabet, always containing upper-case, lower-case and a digit. */
  generatePassword() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    const bytes = randomBytes(10);
    let out = '';
    for (const byte of bytes) out += alphabet[byte % alphabet.length];
    return `${out}Aa${(bytes[0] % 8) + 2}`.slice(0, 13);
  }

  // ---- own account ----------------------------------------------------------------------------

  async me(userId: string) {
    const user = await this.prisma.user.findFirst({ where: { id: userId, deletedAt: null }, include: { tenant: true } });
    if (!user) throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'Account no longer exists' });
    return { ...this.toDto(user), tenant: user.tenant ? this.tenantDto(user.tenant) : null };
  }

  async updateProfile(userId: string, name: string) {
    const clean = name.trim();
    if (!clean) throw new BadRequestException({ code: 'NAME_REQUIRED', message: 'Name must not be empty' });
    await this.prisma.user.update({ where: { id: userId }, data: { name: clean } });
    return this.me(userId);
  }

  async changePassword(userId: string, currentPassword: string | undefined, newPassword: string) {
    const user = await this.prisma.user.findFirst({ where: { id: userId, deletedAt: null } });
    if (!user) throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'Account no longer exists' });
    // Replacing a temporary password does not require typing it again; any other change needs the current one.
    if (!user.mustChangePassword) {
      const valid = Boolean(currentPassword && user.passwordHash && (await bcrypt.compare(currentPassword, user.passwordHash)));
      if (!valid) throw new BadRequestException({ code: 'CURRENT_PASSWORD_INVALID', message: 'Current password is incorrect' });
    }
    if (user.passwordHash && (await bcrypt.compare(newPassword, user.passwordHash))) {
      throw new BadRequestException({ code: 'PASSWORD_UNCHANGED', message: 'New password must differ from the current one' });
    }
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { passwordHash: await bcrypt.hash(newPassword, BCRYPT_ROUNDS), mustChangePassword: false } }),
      this.prisma.refreshSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    return this.me(userId);
  }

  // ---- shared helpers -------------------------------------------------------------------------

  private async createUser(data: Prisma.UserUncheckedCreateInput, password: string) {
    try {
      return await this.prisma.user.create({ data: { ...data, passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS), mustChangePassword: true } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException({ code: 'EMAIL_EXISTS', message: 'Email is already registered' });
      throw error;
    }
  }

  private async findManaged(tenantId: string, id: string, roles: UserRole[]) {
    const user = await this.prisma.user.findFirst({ where: { id, tenantId, role: { in: roles }, deletedAt: null } });
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'Account was not found' });
    return user;
  }

  private requireTenant(user: AuthUser) {
    if (!user.tenantId) throw new ForbiddenException({ code: 'TENANT_REQUIRED', message: 'Account is not attached to a workspace' });
    return user.tenantId;
  }

  private async applyPatch(target: User, patch: StaffPatch) {
    const data: Prisma.UserUpdateInput = {};
    let temporaryPassword: string | undefined;
    if (patch.status) data.status = patch.status === 'locked' ? UserAccountStatus.LOCKED : UserAccountStatus.ACTIVE;
    if (patch.resetPassword) {
      temporaryPassword = this.generatePassword();
      data.passwordHash = await bcrypt.hash(temporaryPassword, BCRYPT_ROUNDS);
      data.mustChangePassword = true;
    }
    const updated = await this.prisma.user.update({ where: { id: target.id }, data });
    // Locking or resetting must end every session that still holds a refresh token.
    if (patch.status === 'locked' || patch.resetPassword) await this.prisma.refreshSession.updateMany({ where: { userId: target.id, revokedAt: null }, data: { revokedAt: new Date() } });
    return { ...this.toDto(updated), ...(temporaryPassword ? { temporaryPassword } : {}) };
  }

  /** Soft delete: frees the email, revokes sessions and drops building assignments. A store owner must first be unassigned. */
  private async removeUser(target: User) {
    if (target.role === UserRole.STORE_OWNER && (await this.prisma.store.count({ where: { ownerId: target.id, deletedAt: null } })) > 0) {
      throw new ConflictException({ code: 'STORE_OWNER_HAS_STORE', message: 'Unassign the store before deleting this account' });
    }
    await this.prisma.$transaction([
      this.prisma.staffAssignment.deleteMany({ where: { userId: target.id } }),
      this.prisma.refreshSession.updateMany({ where: { userId: target.id, revokedAt: null }, data: { revokedAt: new Date() } }),
      this.prisma.user.update({ where: { id: target.id }, data: { deletedAt: new Date(), email: `deleted+${target.id}@spotway.invalid`, googleId: null, passwordHash: null } }),
    ]);
    return { id: target.id, deleted: true };
  }

  // ---- Building Owner: own workspace ----------------------------------------------------------

  async tenantOverview(user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const tenant = await this.prisma.tenant.findFirst({ where: { id: tenantId, deletedAt: null } });
    if (!tenant) throw new NotFoundException({ code: 'TENANT_NOT_FOUND', message: 'Workspace was not found' });
    const now = new Date();
    const [buildings, managers, storeOwners, floors, publishedFloors, stores, activePromotions] = await Promise.all([
      this.prisma.building.count({ where: { tenantId, deletedAt: null } }),
      this.prisma.user.count({ where: { tenantId, role: UserRole.BUILDING_MANAGER, deletedAt: null } }),
      this.prisma.user.count({ where: { tenantId, role: UserRole.STORE_OWNER, deletedAt: null } }),
      this.prisma.floor.count({ where: { tenantId, deletedAt: null } }),
      this.prisma.floor.count({ where: { tenantId, deletedAt: null, publishStatus: 'PUBLISHED' } }),
      this.prisma.store.count({ where: { tenantId, deletedAt: null } }),
      this.prisma.promotion.count({ where: { tenantId, deletedAt: null, status: 'ACTIVE', startAt: { lte: now }, endAt: { gte: now } } }),
    ]);
    return { tenant: this.tenantDto(tenant), usage: { buildings, areas: 0, managers, storeOwners, floors, publishedFloors, stores, activePromotions } };
  }

  async tenantUsers(user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const users = await this.prisma.user.findMany({ where: { tenantId, role: { in: STAFF_ROLES }, deletedAt: null }, include: { assignments: { select: { buildingId: true } } }, orderBy: { createdAt: 'desc' } });
    return users.map((item) => this.toDto(item));
  }

  /** FE "areas" are the workspace's buildings. */
  async tenantAreas(user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const buildings = await this.prisma.building.findMany({ where: { tenantId, deletedAt: null }, orderBy: { createdAt: 'asc' } });
    return buildings.map((building) => ({ id: building.id, tenantId, buildingId: building.id, name: building.name, description: building.address ?? undefined, color: '#2563eb', createdAt: building.createdAt.toISOString() }));
  }

  async createStaff(user: AuthUser, dto: CreateStaffDto) {
    const tenantId = this.requireTenant(user);
    const temporaryPassword = dto.password ?? this.generatePassword();
    const created = await this.createUser({ email: dto.email.trim().toLowerCase(), name: dto.name.trim(), role: ROLE_OF[dto.role], tenantId }, temporaryPassword);
    if (created.role === UserRole.BUILDING_MANAGER && dto.areaIds?.length) await this.syncAssignments(tenantId, created.id, dto.areaIds);
    return { ...this.toDto(created), areaIds: created.role === UserRole.BUILDING_MANAGER ? await this.assignedBuildings(created.id) : [], temporaryPassword };
  }

  async updateStaff(user: AuthUser, id: string, patch: StaffPatch & { areaIds?: string[] }) {
    const tenantId = this.requireTenant(user);
    const target = await this.findManaged(tenantId, id, STAFF_ROLES);
    if (patch.areaIds !== undefined && target.role === UserRole.BUILDING_MANAGER) await this.syncAssignments(tenantId, target.id, patch.areaIds);
    const result = await this.applyPatch(target, patch);
    return { ...result, areaIds: target.role === UserRole.BUILDING_MANAGER ? await this.assignedBuildings(target.id) : [] };
  }

  private async assignedBuildings(userId: string) {
    return (await this.prisma.staffAssignment.findMany({ where: { userId }, select: { buildingId: true } })).map((row) => row.buildingId);
  }

  /** Makes the manager's building assignments exactly `buildingIds` (all must belong to the workspace). */
  private async syncAssignments(tenantId: string, userId: string, buildingIds: string[]) {
    const unique = [...new Set(buildingIds)];
    const valid = await this.prisma.building.findMany({ where: { id: { in: unique }, tenantId, deletedAt: null }, select: { id: true } });
    if (valid.length !== unique.length) throw new BadRequestException({ code: 'BUILDING_NOT_FOUND', message: 'One or more buildings do not belong to this workspace' });
    await this.prisma.$transaction([
      this.prisma.staffAssignment.deleteMany({ where: { userId, buildingId: { notIn: unique } } }),
      this.prisma.staffAssignment.createMany({ data: unique.map((buildingId) => ({ userId, buildingId })), skipDuplicates: true }),
    ]);
  }

  async deleteStaff(user: AuthUser, id: string) {
    return this.removeUser(await this.findManaged(this.requireTenant(user), id, STAFF_ROLES));
  }

  // ---- store owners (Owner / Manager of the workspace) ----------------------------------------

  async storeOwners(user: AuthUser) {
    const tenantId = this.requireTenant(user);
    const owners = await this.prisma.user.findMany({ where: { tenantId, role: UserRole.STORE_OWNER, deletedAt: null }, orderBy: { createdAt: 'desc' } });
    const counts = await this.prisma.store.groupBy({ by: ['ownerId'], where: { tenantId, deletedAt: null, ownerId: { in: owners.map((o) => o.id) } }, _count: { _all: true } });
    const byOwner = new Map(counts.map((row) => [row.ownerId, row._count._all]));
    return owners.map((owner) => ({ ...this.toDto(owner), storeCount: byOwner.get(owner.id) ?? 0 }));
  }

  async createStoreOwner(user: AuthUser, name: string, email: string) {
    const tenantId = this.requireTenant(user);
    const temporaryPassword = this.generatePassword();
    const created = await this.createUser({ email: email.trim().toLowerCase(), name: name.trim(), role: UserRole.STORE_OWNER, tenantId }, temporaryPassword);
    return { ...this.toDto(created), storeCount: 0, temporaryPassword };
  }

  async patchStoreOwner(user: AuthUser, id: string, patch: StaffPatch) {
    const target = await this.findManaged(this.requireTenant(user), id, [UserRole.STORE_OWNER]);
    const result = await this.applyPatch(target, patch);
    return { ...result, storeCount: await this.prisma.store.count({ where: { ownerId: id, deletedAt: null } }) };
  }

  async deleteStoreOwner(user: AuthUser, id: string) {
    return this.removeUser(await this.findManaged(this.requireTenant(user), id, [UserRole.STORE_OWNER]));
  }

  async storesOfOwner(user: AuthUser, ownerId: string) {
    const where: Prisma.StoreWhereInput = { ownerId, deletedAt: null };
    if (user.role === UserRole.STORE_OWNER) {
      if (user.userId !== ownerId) throw new ForbiddenException({ code: 'STORE_ACCESS_DENIED', message: 'Store access is denied' });
    } else if (user.role !== UserRole.ADMIN) {
      where.tenantId = this.requireTenant(user);
    }
    return (await this.prisma.store.findMany({ where, include: STORE_WITH_BUILDING, orderBy: { createdAt: 'desc' } })).map(serializeStore);
  }

  // ---- Admin ----------------------------------------------------------------------------------

  async adminOverview() {
    const grouped = await this.prisma.user.groupBy({ by: ['role'], where: { deletedAt: null }, _count: { _all: true } });
    const count = (role: UserRole) => grouped.find((row) => row.role === role)?._count._all ?? 0;
    const admin = count(UserRole.ADMIN);
    const buildingOwner = count(UserRole.BUILDING_OWNER);
    const buildingManager = count(UserRole.BUILDING_MANAGER);
    const storeOwner = count(UserRole.STORE_OWNER);
    const buildings = await this.prisma.building.count({ where: { deletedAt: null } });
    return { users: { total: admin + buildingOwner + buildingManager + storeOwner, admin, buildingOwner, buildingManager, storeOwner }, buildings };
  }

  async adminUsers() {
    const users = await this.prisma.user.findMany({ where: { deletedAt: null, role: { not: UserRole.GUEST } }, include: { tenant: true }, orderBy: { createdAt: 'desc' } });
    return users.map((item) => ({ ...this.toDto(item), tenantName: item.tenant?.name ?? null }));
  }

  async adminCreateUser(dto: CreateAdminUserDto) {
    const email = dto.email.trim().toLowerCase();
    const role = ROLE_OF[dto.role];
    if (role === UserRole.BUILDING_OWNER) {
      // A Building Owner gets a fresh workspace named after the account.
      const local = email.split('@')[0];
      const slug = local.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'workspace';
      const subdomain = `${slug}-${randomBytes(3).toString('hex')}`;
      try {
        return await this.prisma.$transaction(async (tx) => {
          const tenant = await tx.tenant.create({ data: { name: `Workspace ${local}`.slice(0, 100), subdomain } });
          const created = await tx.user.create({ data: { email, name: local, role, tenantId: tenant.id, passwordHash: await bcrypt.hash(dto.password, BCRYPT_ROUNDS), mustChangePassword: true } });
          return { ...this.toDto(created), tenantName: tenant.name };
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException({ code: 'EMAIL_EXISTS', message: 'Email is already registered' });
        throw error;
      }
    }
    if (!dto.ownerId) throw new BadRequestException({ code: 'OWNER_REQUIRED', message: 'ownerId is required for this role' });
    const owner = await this.prisma.user.findFirst({ where: { id: dto.ownerId, role: UserRole.BUILDING_OWNER, deletedAt: null }, include: { tenant: true } });
    if (!owner?.tenantId) throw new BadRequestException({ code: 'OWNER_NOT_FOUND', message: 'Building Owner was not found' });
    const created = await this.createUser({ email, name: email.split('@')[0], role, tenantId: owner.tenantId }, dto.password);
    return { ...this.toDto(created), tenantName: owner.tenant?.name ?? null };
  }

  async adminResetPassword(id: string, newPassword?: string) {
    const target = await this.prisma.user.findFirst({ where: { id, deletedAt: null, role: { not: UserRole.GUEST } } });
    if (!target) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'Account was not found' });
    const password = newPassword ?? this.generatePassword();
    const updated = await this.prisma.user.update({ where: { id }, data: { passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS), mustChangePassword: true } });
    await this.prisma.refreshSession.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    return { ...this.toDto(updated), ...(newPassword ? {} : { temporaryPassword: password }) };
  }

  /** Admin locks or unlocks any account. A locked account cannot sign in or refresh, and the guard stops its open sessions at once. */
  async adminSetStatus(actor: AuthUser, id: string, status: 'active' | 'locked') {
    if (actor.userId === id) throw new BadRequestException({ code: 'CANNOT_LOCK_SELF', message: 'You cannot lock your own account' });
    const target = await this.prisma.user.findFirst({ where: { id, deletedAt: null, role: { not: UserRole.GUEST } } });
    if (!target) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'Account was not found' });
    if (target.role === UserRole.ADMIN) throw new ForbiddenException({ code: 'CANNOT_LOCK_ADMIN', message: 'Administrator accounts cannot be locked here' });
    return this.applyPatch(target, { status });
  }

  async adminDeleteUser(actor: AuthUser, id: string) {
    if (actor.userId === id) throw new BadRequestException({ code: 'CANNOT_DELETE_SELF', message: 'You cannot delete your own account' });
    const target = await this.prisma.user.findFirst({ where: { id, deletedAt: null } });
    if (!target) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'Account was not found' });
    if (target.role === UserRole.ADMIN) throw new ForbiddenException({ code: 'CANNOT_DELETE_ADMIN', message: 'Administrator accounts cannot be deleted here' });
    return this.removeUser(target);
  }

}
