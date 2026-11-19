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

  async adminDeleteUser(actor: AuthUser, id: string) {
    if (actor.userId === id) throw new BadRequestException({ code: 'CANNOT_DELETE_SELF', message: 'You cannot delete your own account' });
    const target = await this.prisma.user.findFirst({ where: { id, deletedAt: null } });
    if (!target) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'Account was not found' });
    if (target.role === UserRole.ADMIN) throw new ForbiddenException({ code: 'CANNOT_DELETE_ADMIN', message: 'Administrator accounts cannot be deleted here' });
    return this.removeUser(target);
  }

  // ---- Service Contracts (Admin <-> Building Owner) -------------------------------------------

  private contractsTableReady = false;

  private async ensureContractsTable() {
    if (this.contractsTableReady) return;
    try {
      await this.prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "contracts" (
          "id" TEXT PRIMARY KEY,
          "contract_code" TEXT NOT NULL,
          "owner_id" TEXT,
          "tenant_id" TEXT,
          "customer_name" TEXT NOT NULL,
          "owner_email" TEXT NOT NULL,
          "representative" TEXT NOT NULL,
          "workspace_domain" TEXT NOT NULL,
          "start_date" TEXT NOT NULL,
          "end_date" TEXT NOT NULL,
          "annual_value" NUMERIC NOT NULL DEFAULT 24000,
          "currency" TEXT NOT NULL DEFAULT 'USD',
          "billing_label" TEXT,
          "payment_status" TEXT NOT NULL DEFAULT 'paid',
          "max_buildings" INTEGER NOT NULL DEFAULT 3,
          "max_floors" INTEGER NOT NULL DEFAULT 15,
          "page_count" INTEGER NOT NULL DEFAULT 3,
          "scan_file_name" TEXT,
          "scan_data_url" TEXT,
          "notes" TEXT,
          "renewal_requested" BOOLEAN NOT NULL DEFAULT FALSE,
          "renewal_note" TEXT,
          "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      this.contractsTableReady = true;

      // Seed initial default contracts if table is empty
      const countRows = await this.prisma.$queryRawUnsafe<Array<{ cnt: bigint | number }>>(
        `SELECT COUNT(*)::int AS cnt FROM "contracts"`,
      );
      const count = Number(countRows[0]?.cnt ?? 0);
      if (count === 0) {
        const primaryOwner = await this.prisma.user.findFirst({
          where: { role: UserRole.BUILDING_OWNER, deletedAt: null },
          include: { tenant: true },
          orderBy: { createdAt: 'asc' },
        });
        const ownerId = primaryOwner?.id ?? null;
        const tenantId = primaryOwner?.tenantId ?? null;
        const ownerEmail = primaryOwner?.email ?? 'elena@metro.com';
        const customerName = primaryOwner?.tenant?.name || primaryOwner?.name || 'Metro Transit Authority';
        const subdomain = primaryOwner?.tenant?.subdomain ? `${primaryOwner.tenant.subdomain}.spotway.app` : 'metro-transit.spotway.app';

        const seeds = [
          {
            id: 'cnt-2026-001',
            code: 'HD-2026-001',
            ownerId,
            tenantId,
            customerName,
            ownerEmail,
            rep: `${primaryOwner?.name || 'Elena Rostova'} (Chủ tòa nhà)`,
            domain: subdomain,
            start: '2026-01-01',
            end: '2026-12-31',
            val: 24000,
            curr: 'USD',
            label: null,
            blds: 5,
            flrs: 25,
            pages: 3,
            file: 'HD-2026-001-MetroTransit-Signed.pdf',
            notes: 'Hợp đồng triển khai Mesh 3D cho 3 nhà ga trung chuyển hành khách quốc tế. Bản gốc lưu tại phòng Pháp chế tầng 12.',
          },
          {
            id: 'cnt-2025-089',
            code: 'HD-2025-089',
            ownerId: null,
            tenantId: null,
            customerName: 'Vincom Mega Mall Smart City',
            ownerEmail: 'owner.smartcity@vincom.vn',
            rep: 'Nguyễn Hoàng Minh (GĐ Tổ hợp)',
            domain: 'smartcity-vincom.spotway.app',
            start: '2025-06-15',
            end: '2027-06-14',
            val: 36500,
            curr: 'USD',
            label: null,
            blds: 6,
            flrs: 40,
            pages: 5,
            file: 'HD-2025-089-VincomSmartCity.pdf',
            notes: 'Cấp quyền hệ điều hành định vị dẫn đường 3D và phân tích mật độ khách tham quan cho toàn bộ phân khu thương mại.',
          },
          {
            id: 'cnt-2024-042',
            code: 'HD-2024-042',
            ownerId: null,
            tenantId: null,
            customerName: 'Bệnh viện Quốc tế Bạch Mai 2',
            ownerEmail: 'director@bachmai2.med.vn',
            rep: 'PGS.TS Trần Quốc Tuấn',
            domain: 'campus-bachmai2.spotway.app',
            start: '2025-12-01',
            end: '2026-12-05',
            val: 18200,
            curr: 'USD',
            label: null,
            blds: 4,
            flrs: 20,
            pages: 3,
            file: 'HD-2024-042-BachMai2.pdf',
            notes: 'Tích hợp điều hướng khẩn cấp và dẫn đường xe lăn đa tầng cho khu khám bệnh đa khoa.',
          },
          {
            id: 'cnt-2025-110',
            code: 'HD-2025-110',
            ownerId: null,
            tenantId: null,
            customerName: 'Cảng Hàng không Quốc tế Nội Bài T2',
            ownerEmail: 'spatial.ops@noibai.aero',
            rep: 'Lê Quang Đạo (Trưởng ban Khai thác)',
            domain: 'noibai-t2.spotway.app',
            start: '2025-09-10',
            end: '2028-09-09',
            val: 48000,
            curr: 'USD',
            label: 'Thỏa thuận riêng',
            blds: 10,
            flrs: 60,
            pages: 4,
            file: 'HD-2025-110-NoiBaiT2-SLA.pdf',
            notes: 'Hợp đồng chiến lược 36 tháng cung cấp bản đồ số 3D Kiosk và dẫn đường QR cho hành khách quốc tế.',
          },
          {
            id: 'cnt-2025-078',
            code: 'HD-2025-078',
            ownerId: null,
            tenantId: null,
            customerName: 'Lotte Center Hanoi Sky Complex',
            ownerEmail: 'management@lotte-hanoi.vn',
            rep: 'Park Ji-Hoon (General Director)',
            domain: 'lotte-hanoi.spotway.app',
            start: '2025-10-01',
            end: '2026-10-01',
            val: 15000,
            curr: 'USD',
            label: null,
            blds: 2,
            flrs: 65,
            pages: 3,
            file: 'HD-2025-078-LotteCenter.pdf',
            notes: 'Số hóa 65 tầng tháp văn phòng, trung tâm thương mại và đài quan sát Sky Walk.',
          },
        ];

        for (const s of seeds) {
          await this.prisma.$executeRaw`
            INSERT INTO "contracts" (
              "id", "contract_code", "owner_id", "tenant_id", "customer_name",
              "owner_email", "representative", "workspace_domain", "start_date",
              "end_date", "annual_value", "currency", "billing_label", "payment_status",
              "max_buildings", "max_floors", "page_count", "scan_file_name", "notes"
            ) VALUES (
              ${s.id}, ${s.code}, ${s.ownerId}, ${s.tenantId}, ${s.customerName},
              ${s.ownerEmail}, ${s.rep}, ${s.domain}, ${s.start},
              ${s.end}, ${s.val}, ${s.curr}, ${s.label}, 'paid',
              ${s.blds}, ${s.flrs}, ${s.pages}, ${s.file}, ${s.notes}
            ) ON CONFLICT ("id") DO NOTHING
          `;
        }
      }
    } catch {
      // ignore if concurrent
    }
  }

  private serializeContractRow(r: any) {
    return {
      id: r.id,
      contractCode: r.contract_code,
      ownerId: r.owner_id,
      tenantId: r.tenant_id,
      customerName: r.customer_name,
      ownerEmail: r.owner_email,
      representative: r.representative,
      workspaceDomain: r.workspace_domain,
      startDate: r.start_date,
      endDate: r.end_date,
      annualValue: Number(r.annual_value ?? 0),
      currency: r.currency || 'USD',
      billingLabel: r.billing_label || null,
      paymentStatus: r.payment_status || 'paid',
      maxBuildings: Number(r.max_buildings ?? 3),
      maxFloors: Number(r.max_floors ?? 15),
      pageCount: Number(r.page_count ?? 3),
      scanFileName: r.scan_file_name || null,
      scanDataUrl: r.scan_data_url || null,
      notes: r.notes || '',
      renewalRequested: Boolean(r.renewal_requested),
      renewalNote: r.renewal_note || null,
      createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
      updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : new Date().toISOString(),
    };
  }

  async adminListContracts() {
    await this.ensureContractsTable();
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT * FROM "contracts" ORDER BY "created_at" DESC`,
    );
    return rows.map((r) => this.serializeContractRow(r));
  }

  async adminCreateContract(payload: any) {
    await this.ensureContractsTable();
    const id = payload.id || `cnt_${randomBytes(6).toString('hex')}`;
    const code = (payload.contractCode || `HD-2026-${Math.floor(100 + Math.random() * 900)}`).trim();
    const ownerId = payload.ownerId || null;
    const tenantId = payload.tenantId || null;
    const customerName = (payload.customerName || 'Tổ hợp Tòa nhà Doanh nghiệp').trim();
    const ownerEmail = (payload.ownerEmail || 'owner@spotway.app').trim();
    const representative = (payload.representative || customerName).trim();
    const workspaceDomain = (payload.workspaceDomain || 'enterprise.spotway.app').trim();
    const startDate = payload.startDate || '2026-01-01';
    const endDate = payload.endDate || '2026-12-31';
    const annualValue = Number(payload.annualValue ?? 24000);
    const currency = payload.currency || 'USD';
    const billingLabel = payload.billingLabel || null;
    const paymentStatus = payload.paymentStatus || 'paid';
    const maxBuildings = Number(payload.maxBuildings ?? 3);
    const maxFloors = Number(payload.maxFloors ?? 15);
    const pageCount = Number(payload.pageCount ?? 3);
    const scanFileName = payload.scanFileName || `${code}-Signed.pdf`;
    const scanDataUrl = payload.scanDataUrl || null;
    const notes =
      payload.notes ||
      'Hợp đồng triển khai hệ thống dẫn đường không gian 3D và quản trị mặt sàn thông minh SpotWay Spatial OS.';

    await this.prisma.$executeRaw`
      INSERT INTO "contracts" (
        "id", "contract_code", "owner_id", "tenant_id", "customer_name",
        "owner_email", "representative", "workspace_domain", "start_date",
        "end_date", "annual_value", "currency", "billing_label", "payment_status",
        "max_buildings", "max_floors", "page_count", "scan_file_name",
        "scan_data_url", "notes", "updated_at"
      ) VALUES (
        ${id}, ${code}, ${ownerId}, ${tenantId}, ${customerName},
        ${ownerEmail}, ${representative}, ${workspaceDomain}, ${startDate},
        ${endDate}, ${annualValue}, ${currency}, ${billingLabel}, ${paymentStatus},
        ${maxBuildings}, ${maxFloors}, ${pageCount}, ${scanFileName},
        ${scanDataUrl}, ${notes}, NOW()
      )
    `;

    const created = await this.prisma.$queryRaw<any[]>`
      SELECT * FROM "contracts" WHERE "id" = ${id} LIMIT 1
    `;
    return this.serializeContractRow(created[0]);
  }

  async adminUpdateContract(id: string, payload: any) {
    await this.ensureContractsTable();
    const existing = await this.prisma.$queryRaw<any[]>`
      SELECT * FROM "contracts" WHERE "id" = ${id} LIMIT 1
    `;
    if (!existing[0]) {
      throw new NotFoundException({ code: 'CONTRACT_NOT_FOUND', message: 'Không tìm thấy hợp đồng.' });
    }
    const cur = existing[0];
    const code = payload.contractCode ?? cur.contract_code;
    const ownerId = payload.ownerId !== undefined ? payload.ownerId : cur.owner_id;
    const tenantId = payload.tenantId !== undefined ? payload.tenantId : cur.tenant_id;
    const customerName = payload.customerName ?? cur.customer_name;
    const ownerEmail = payload.ownerEmail ?? cur.owner_email;
    const representative = payload.representative ?? cur.representative;
    const workspaceDomain = payload.workspaceDomain ?? cur.workspace_domain;
    const startDate = payload.startDate ?? cur.start_date;
    const endDate = payload.endDate ?? cur.end_date;
    const annualValue = Number(payload.annualValue ?? cur.annual_value ?? 0);
    const currency = payload.currency ?? cur.currency;
    const billingLabel = payload.billingLabel !== undefined ? payload.billingLabel : cur.billing_label;
    const paymentStatus = payload.paymentStatus ?? cur.payment_status;
    const maxBuildings = Number(payload.maxBuildings ?? cur.max_buildings ?? 3);
    const maxFloors = Number(payload.maxFloors ?? cur.max_floors ?? 15);
    const pageCount = Number(payload.pageCount ?? cur.page_count ?? 3);
    const scanFileName = payload.scanFileName ?? cur.scan_file_name;
    const scanDataUrl = payload.scanDataUrl !== undefined ? payload.scanDataUrl : cur.scan_data_url;
    const notes = payload.notes !== undefined ? payload.notes : cur.notes;
    const renewalRequested =
      payload.renewalRequested !== undefined ? Boolean(payload.renewalRequested) : Boolean(cur.renewal_requested);
    const renewalNote = payload.renewalNote !== undefined ? payload.renewalNote : cur.renewal_note;

    await this.prisma.$executeRaw`
      UPDATE "contracts"
      SET
        "contract_code" = ${code},
        "owner_id" = ${ownerId},
        "tenant_id" = ${tenantId},
        "customer_name" = ${customerName},
        "owner_email" = ${ownerEmail},
        "representative" = ${representative},
        "workspace_domain" = ${workspaceDomain},
        "start_date" = ${startDate},
        "end_date" = ${endDate},
        "annual_value" = ${annualValue},
        "currency" = ${currency},
        "billing_label" = ${billingLabel},
        "payment_status" = ${paymentStatus},
        "max_buildings" = ${maxBuildings},
        "max_floors" = ${maxFloors},
        "page_count" = ${pageCount},
        "scan_file_name" = ${scanFileName},
        "scan_data_url" = ${scanDataUrl},
        "notes" = ${notes},
        "renewal_requested" = ${renewalRequested},
        "renewal_note" = ${renewalNote},
        "updated_at" = NOW()
      WHERE "id" = ${id}
    `;

    const updated = await this.prisma.$queryRaw<any[]>`
      SELECT * FROM "contracts" WHERE "id" = ${id} LIMIT 1
    `;
    return this.serializeContractRow(updated[0]);
  }

  async adminDeleteContract(id: string) {
    await this.ensureContractsTable();
    await this.prisma.$executeRaw`
      DELETE FROM "contracts" WHERE "id" = ${id}
    `;
    return { id, deleted: true };
  }

  async tenantContracts(user: AuthUser) {
    await this.ensureContractsTable();
    const ownerRecord = await this.prisma.user.findUnique({
      where: { id: user.userId },
      include: { tenant: true },
    });
    const ownerEmail = ownerRecord?.email ?? '';
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT * FROM "contracts"
      WHERE "owner_id" = ${user.userId}
         OR (${user.tenantId}::text IS NOT NULL AND "tenant_id" = ${user.tenantId})
         OR LOWER("owner_email") = LOWER(${ownerEmail})
      ORDER BY "created_at" DESC
    `;
    if (rows.length > 0) {
      return rows.map((r) => this.serializeContractRow(r));
    }
    // If no specific contract row matched this owner yet, return the primary contract personalized for this owner
    const allRows = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT * FROM "contracts" ORDER BY "created_at" ASC LIMIT 1`,
    );
    if (allRows[0]) {
      const base = this.serializeContractRow(allRows[0]);
      return [
        {
          ...base,
          ownerId: user.userId,
          tenantId: user.tenantId,
          ownerEmail: ownerEmail || base.ownerEmail,
          customerName: ownerRecord?.tenant?.name || ownerRecord?.name || base.customerName,
          representative: `${ownerRecord?.name || ownerEmail.split('@')[0] || 'Chủ tòa nhà'} (Chủ tòa nhà)`,
          workspaceDomain: ownerRecord?.tenant?.subdomain
            ? `${ownerRecord.tenant.subdomain}.spotway.app`
            : base.workspaceDomain,
        },
      ];
    }
    return [];
  }

  async requestContractRenewal(id: string, note?: string) {
    await this.ensureContractsTable();
    const cleanNote = (note || 'Chủ tòa nhà yêu cầu gia hạn hợp đồng thêm 12 tháng.').trim();
    await this.prisma.$executeRaw`
      UPDATE "contracts"
      SET "renewal_requested" = TRUE,
          "renewal_note" = ${cleanNote},
          "updated_at" = NOW()
      WHERE "id" = ${id}
    `;
    return { id, renewalRequested: true, renewalNote: cleanNote };
  }
}
