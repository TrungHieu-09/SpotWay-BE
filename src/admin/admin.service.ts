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
  private contractsTableReady = false;

  constructor(private readonly prisma: PrismaService) {}

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
    } catch {
      // ignore if concurrent
    }
  }

  async listContracts() {
    await this.ensureContractsTable();
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT * FROM "contracts" ORDER BY "created_at" DESC`,
    );
    return rows.map((r) => this.serializeContractRow(r));
  }

  async createContract(payload: any) {
    await this.ensureContractsTable();
    const id = payload.id || `cnt_${randomBytes(6).toString('hex')}`;
    const code = (payload.contractCode || `HD-2026-${randomInt(100, 999)}`).trim();
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
    const scanFileName = payload.scanFileName || `${code}-scan.pdf`;
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

  async updateContract(id: string, payload: any) {
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

  async deleteContract(id: string) {
    await this.ensureContractsTable();
    await this.prisma.$executeRaw`
      DELETE FROM "contracts" WHERE "id" = ${id}
    `;
    return { id, deleted: true };
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
