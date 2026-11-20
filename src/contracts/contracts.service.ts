import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { randomBytes, randomInt } from 'crypto';
import { AuthUser } from '../common/auth.types';
import { PrismaService } from '../database/prisma.service';
import { ContractScanPageDto, CreateContractDto, MAX_SCAN_TOTAL_CHARS, UpdateContractDto } from './contracts.dto';

interface ContractRow {
  id: string;
  contract_code: string;
  owner_id: string | null;
  tenant_id: string | null;
  customer_name: string;
  owner_email: string;
  representative: string;
  workspace_domain: string;
  start_date: string;
  end_date: string;
  annual_value: unknown;
  currency: string | null;
  billing_label: string | null;
  payment_status: string | null;
  max_buildings: number | null;
  max_floors: number | null;
  page_count: number | null;
  scan_file_name: string | null;
  scan_data_url?: string | null;
  scan_pages?: string | null;
  has_scan?: boolean;
  notes: string | null;
  renewal_requested: boolean | null;
  renewal_note: string | null;
  created_at: Date | null;
  updated_at: Date | null;
}

type ScanPage = Pick<ContractScanPageDto, 'fileName' | 'sizeText' | 'mime' | 'dataUrl'>;

/** Columns for the list views: everything except the (very large) scan payload. */
const LIST_COLUMNS = Prisma.sql`
  "id", "contract_code", "owner_id", "tenant_id", "customer_name", "owner_email", "representative",
  "workspace_domain", "start_date", "end_date", "annual_value", "currency", "billing_label", "payment_status",
  "max_buildings", "max_floors", "page_count", "scan_file_name", "notes", "renewal_requested", "renewal_note",
  "created_at", "updated_at",
  (COALESCE("scan_pages", '') NOT IN ('', '[]') OR "scan_data_url" IS NOT NULL) AS "has_scan"`;

const isRealDay = (day: string) => !Number.isNaN(new Date(`${day}T00:00:00Z`).getTime()) && new Date(`${day}T00:00:00Z`).toISOString().startsWith(day);

/**
 * Service contracts signed offline between the platform Admin and a Building Owner.
 * The signed scan is stored with the contract; list endpoints leave it out and the detail endpoints return it.
 */
@Injectable()
export class ContractsService {
  private readonly logger = new Logger(ContractsService.name);
  private tableReady: Promise<void> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /** The table predates Prisma models in this project, so it is created on first use (idempotent). */
  private ensureTable() {
    this.tableReady ??= (async () => {
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
          "annual_value" NUMERIC NOT NULL DEFAULT 0,
          "currency" TEXT NOT NULL DEFAULT 'USD',
          "billing_label" TEXT,
          "payment_status" TEXT NOT NULL DEFAULT 'pending',
          "max_buildings" INTEGER NOT NULL DEFAULT 3,
          "max_floors" INTEGER NOT NULL DEFAULT 15,
          "page_count" INTEGER NOT NULL DEFAULT 0,
          "scan_file_name" TEXT,
          "scan_data_url" TEXT,
          "scan_pages" TEXT,
          "notes" TEXT,
          "renewal_requested" BOOLEAN NOT NULL DEFAULT FALSE,
          "renewal_note" TEXT,
          "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
      await this.prisma.$executeRawUnsafe('ALTER TABLE "contracts" ADD COLUMN IF NOT EXISTS "scan_pages" TEXT');
      // Demo rows that earlier builds seeded automatically: only contracts uploaded by an Admin are real.
      await this.prisma.$executeRawUnsafe(`DELETE FROM "contracts" WHERE "id" IN ('cnt-2026-001','cnt-2025-089','cnt-2024-042','cnt-2025-110','cnt-2025-078')`);
    })().catch((error) => {
      this.tableReady = null;
      this.logger.error('Could not prepare the contracts table', error instanceof Error ? error.stack : String(error));
      throw error;
    });
    return this.tableReady;
  }

  // ---- serialization --------------------------------------------------------------------------

  private parsePages(row: ContractRow): ScanPage[] {
    let pages: ScanPage[] = [];
    if (row.scan_pages) {
      try {
        const parsed: unknown = JSON.parse(row.scan_pages);
        if (Array.isArray(parsed)) pages = parsed as ScanPage[];
      } catch {
        pages = [];
      }
    }
    // Older builds stored a single scan in `scan_data_url`.
    if (pages.length === 0 && row.scan_data_url?.startsWith('data:')) {
      const mime = row.scan_data_url.slice(5, row.scan_data_url.indexOf(';')) || 'application/octet-stream';
      const bytes = Math.floor(((row.scan_data_url.length - row.scan_data_url.indexOf(',') - 1) * 3) / 4);
      pages = [{ fileName: row.scan_file_name ?? `${row.contract_code}-scan`, sizeText: `${(bytes / (1024 * 1024)).toFixed(2)} MB`, mime, dataUrl: row.scan_data_url }];
    }
    return pages;
  }

  private serialize(row: ContractRow, withScans: boolean) {
    const pages = withScans ? this.parsePages(row) : [];
    return {
      id: row.id,
      contractCode: row.contract_code,
      ownerId: row.owner_id,
      tenantId: row.tenant_id,
      customerName: row.customer_name,
      ownerEmail: row.owner_email,
      representative: row.representative,
      workspaceDomain: row.workspace_domain,
      startDate: row.start_date,
      endDate: row.end_date,
      annualValue: Number(row.annual_value ?? 0),
      currency: row.currency || 'USD',
      billingLabel: row.billing_label || null,
      paymentStatus: row.payment_status || 'pending',
      maxBuildings: Number(row.max_buildings ?? 0),
      maxFloors: Number(row.max_floors ?? 0),
      pageCount: withScans ? pages.length : Number(row.page_count ?? 0),
      hasScan: withScans ? pages.length > 0 : Boolean(row.has_scan),
      scanFileName: row.scan_file_name || null,
      scanPages: pages,
      notes: row.notes || '',
      renewalRequested: Boolean(row.renewal_requested),
      renewalNote: row.renewal_note || null,
      createdAt: (row.created_at ?? new Date()).toISOString(),
      updatedAt: (row.updated_at ?? new Date()).toISOString(),
    };
  }

  // ---- validation helpers ----------------------------------------------------------------------

  private checkPages(pages: ContractScanPageDto[]) {
    if (pages.length === 0) {
      throw new BadRequestException({ code: 'SCAN_REQUIRED', message: 'Hợp đồng cần ít nhất 1 tệp scan (PDF / JPG / PNG).' });
    }
    let total = 0;
    for (const page of pages) {
      if (!page.dataUrl.startsWith(`data:${page.mime};base64,`)) {
        throw new BadRequestException({ code: 'SCAN_INVALID', message: `Tệp "${page.fileName}" không hợp lệ hoặc sai định dạng.` });
      }
      total += page.dataUrl.length;
    }
    if (total > MAX_SCAN_TOTAL_CHARS) {
      throw new BadRequestException({ code: 'SCAN_TOO_LARGE', message: 'Tổng dung lượng các tệp scan quá lớn (tối đa khoảng 26 MB).' });
    }
  }

  private checkDates(startDate: string, endDate: string) {
    if (!isRealDay(startDate) || !isRealDay(endDate)) {
      throw new BadRequestException({ code: 'INVALID_DATES', message: 'Ngày bắt đầu hoặc kết thúc không hợp lệ.' });
    }
    if (endDate < startDate) {
      throw new BadRequestException({ code: 'INVALID_DATES', message: 'Ngày kết thúc phải sau ngày bắt đầu.' });
    }
  }

  private async owner(ownerId: string) {
    const owner = await this.prisma.user.findFirst({ where: { id: ownerId, role: UserRole.BUILDING_OWNER, deletedAt: null } });
    if (!owner) throw new NotFoundException({ code: 'OWNER_NOT_FOUND', message: 'Không tìm thấy tài khoản Chủ tòa nhà.' });
    return owner;
  }

  private async assertCodeFree(code: string, exceptId?: string) {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`SELECT "id" FROM "contracts" WHERE LOWER("contract_code") = LOWER(${code}) LIMIT 1`;
    if (rows[0] && rows[0].id !== exceptId) {
      throw new ConflictException({ code: 'CONTRACT_CODE_EXISTS', message: `Số hợp đồng ${code} đã tồn tại.` });
    }
  }

  private async generateCode() {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const code = `HD-${new Date().getFullYear()}-${randomInt(100, 1000)}`;
      const rows = await this.prisma.$queryRaw<{ id: string }[]>`SELECT "id" FROM "contracts" WHERE "contract_code" = ${code} LIMIT 1`;
      if (!rows[0]) return code;
    }
    throw new ConflictException({ code: 'CONTRACT_CODE_EXISTS', message: 'Không tạo được số hợp đồng tự động, hãy nhập số hợp đồng.' });
  }

  private async findRow(id: string) {
    const rows = await this.prisma.$queryRaw<ContractRow[]>`SELECT * FROM "contracts" WHERE "id" = ${id} LIMIT 1`;
    if (!rows[0]) throw new NotFoundException({ code: 'CONTRACT_NOT_FOUND', message: 'Không tìm thấy hợp đồng.' });
    return rows[0];
  }

  // ---- Admin -----------------------------------------------------------------------------------

  async adminList() {
    await this.ensureTable();
    const rows = await this.prisma.$queryRaw<ContractRow[]>(Prisma.sql`SELECT ${LIST_COLUMNS} FROM "contracts" ORDER BY "created_at" DESC`);
    return rows.map((row) => this.serialize(row, false));
  }

  async adminGet(id: string) {
    await this.ensureTable();
    return this.serialize(await this.findRow(id), true);
  }

  async create(dto: CreateContractDto) {
    await this.ensureTable();
    this.checkDates(dto.startDate, dto.endDate);
    this.checkPages(dto.scanPages);
    const owner = await this.owner(dto.ownerId);
    const code = dto.contractCode?.trim() || (await this.generateCode());
    await this.assertCodeFree(code);

    const id = `cnt_${randomBytes(6).toString('hex')}`;
    const pages = JSON.stringify(dto.scanPages);
    await this.prisma.$executeRaw`
      INSERT INTO "contracts" (
        "id", "contract_code", "owner_id", "tenant_id", "customer_name", "owner_email", "representative",
        "workspace_domain", "start_date", "end_date", "annual_value", "currency", "billing_label", "payment_status",
        "max_buildings", "max_floors", "page_count", "scan_file_name", "scan_pages", "notes", "updated_at"
      ) VALUES (
        ${id}, ${code}, ${owner.id}, ${owner.tenantId}, ${dto.customerName.trim()}, ${owner.email}, ${dto.representative.trim()},
        ${dto.workspaceDomain?.trim() ?? ''}, ${dto.startDate}, ${dto.endDate}, ${dto.annualValue}, ${dto.currency},
        ${dto.billingLabel?.trim() || null}, ${dto.paymentStatus}, ${dto.maxBuildings}, ${dto.maxFloors},
        ${dto.scanPages.length}, ${dto.scanPages[0].fileName}, ${pages}, ${dto.notes?.trim() ?? ''}, NOW()
      )`;
    return this.serialize(await this.findRow(id), true);
  }

  async update(id: string, dto: UpdateContractDto) {
    await this.ensureTable();
    const cur = await this.findRow(id);
    const startDate = dto.startDate ?? cur.start_date;
    const endDate = dto.endDate ?? cur.end_date;
    this.checkDates(startDate, endDate);

    let ownerId = cur.owner_id;
    let tenantId = cur.tenant_id;
    let ownerEmail = cur.owner_email;
    if (dto.ownerId && dto.ownerId !== cur.owner_id) {
      const owner = await this.owner(dto.ownerId);
      ownerId = owner.id;
      tenantId = owner.tenantId;
      ownerEmail = owner.email;
    }
    const code = dto.contractCode?.trim() || cur.contract_code;
    if (code.toLowerCase() !== cur.contract_code.toLowerCase()) await this.assertCodeFree(code, id);

    let scanPages = cur.scan_pages ?? null;
    let pageCount = Number(cur.page_count ?? 0);
    let scanFileName = cur.scan_file_name;
    if (dto.scanPages !== undefined) {
      this.checkPages(dto.scanPages);
      scanPages = JSON.stringify(dto.scanPages);
      pageCount = dto.scanPages.length;
      scanFileName = dto.scanPages[0].fileName;
    }

    await this.prisma.$executeRaw`
      UPDATE "contracts" SET
        "contract_code" = ${code}, "owner_id" = ${ownerId}, "tenant_id" = ${tenantId}, "owner_email" = ${ownerEmail},
        "customer_name" = ${dto.customerName?.trim() ?? cur.customer_name},
        "representative" = ${dto.representative?.trim() ?? cur.representative},
        "workspace_domain" = ${dto.workspaceDomain?.trim() ?? cur.workspace_domain},
        "start_date" = ${startDate}, "end_date" = ${endDate},
        "annual_value" = ${dto.annualValue ?? Number(cur.annual_value ?? 0)},
        "currency" = ${dto.currency ?? cur.currency},
        "billing_label" = ${dto.billingLabel !== undefined ? dto.billingLabel?.trim() || null : cur.billing_label},
        "payment_status" = ${dto.paymentStatus ?? cur.payment_status},
        "max_buildings" = ${dto.maxBuildings ?? cur.max_buildings},
        "max_floors" = ${dto.maxFloors ?? cur.max_floors},
        "page_count" = ${pageCount}, "scan_file_name" = ${scanFileName}, "scan_pages" = ${scanPages},
        "notes" = ${dto.notes !== undefined ? dto.notes.trim() : cur.notes},
        "renewal_requested" = ${dto.renewalRequested ?? Boolean(cur.renewal_requested)},
        "renewal_note" = ${dto.renewalNote !== undefined ? dto.renewalNote?.trim() || null : cur.renewal_note},
        "updated_at" = NOW()
      WHERE "id" = ${id}`;
    return this.serialize(await this.findRow(id), true);
  }

  async remove(id: string) {
    await this.ensureTable();
    const deleted = await this.prisma.$executeRaw`DELETE FROM "contracts" WHERE "id" = ${id}`;
    if (deleted === 0) throw new NotFoundException({ code: 'CONTRACT_NOT_FOUND', message: 'Không tìm thấy hợp đồng.' });
    return { id, deleted: true };
  }

  // ---- Building Owner (own contracts only) -----------------------------------------------------

  /** A contract belongs to an owner by account id, by workspace, or by the email it was signed with. */
  private async ownerScope(user: AuthUser) {
    const account = await this.prisma.user.findUnique({ where: { id: user.userId }, select: { email: true } });
    return Prisma.sql`("owner_id" = ${user.userId}
      OR (${user.tenantId}::text IS NOT NULL AND "tenant_id" = ${user.tenantId})
      OR LOWER("owner_email") = LOWER(${account?.email ?? ''}))`;
  }

  async ownerList(user: AuthUser) {
    await this.ensureTable();
    const scope = await this.ownerScope(user);
    const rows = await this.prisma.$queryRaw<ContractRow[]>(Prisma.sql`SELECT ${LIST_COLUMNS} FROM "contracts" WHERE ${scope} ORDER BY "created_at" DESC`);
    return rows.map((row) => this.serialize(row, false));
  }

  async ownerGet(user: AuthUser, id: string) {
    await this.ensureTable();
    const scope = await this.ownerScope(user);
    const rows = await this.prisma.$queryRaw<ContractRow[]>(Prisma.sql`SELECT * FROM "contracts" WHERE "id" = ${id} AND ${scope} LIMIT 1`);
    if (!rows[0]) throw new NotFoundException({ code: 'CONTRACT_NOT_FOUND', message: 'Không tìm thấy hợp đồng.' });
    return this.serialize(rows[0], true);
  }

  async requestRenewal(user: AuthUser, id: string, note?: string) {
    await this.ensureTable();
    const scope = await this.ownerScope(user);
    const text = note?.trim() || 'Chủ tòa nhà yêu cầu gia hạn hợp đồng.';
    const rows = await this.prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      UPDATE "contracts" SET "renewal_requested" = TRUE, "renewal_note" = ${text}, "updated_at" = NOW()
      WHERE "id" = ${id} AND ${scope} RETURNING "id"`);
    if (!rows[0]) throw new NotFoundException({ code: 'CONTRACT_NOT_FOUND', message: 'Không tìm thấy hợp đồng.' });
    return { id, renewalRequested: true, renewalNote: text };
  }
}
