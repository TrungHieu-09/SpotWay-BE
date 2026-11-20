import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

export interface ExpiredContract {
  contractCode: string;
  /** YYYY-MM-DD, the last day written in the contract */
  endDate: string;
  /** First day without service when the admin ended the contract early, otherwise null */
  terminatedAt: string | null;
  terminationReason: string | null;
}

const CACHE_MS = 30_000;
const VIETNAM_OFFSET_MS = 7 * 60 * 60 * 1000;

/** Today in Vietnam as YYYY-MM-DD: a contract is usable through its last day and locks the day after. */
export function vietnamToday(now = Date.now()) {
  return new Date(now + VIETNAM_OFFSET_MS).toISOString().slice(0, 10);
}

export function dayBefore(day: string) {
  const date = new Date(day + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

interface Row {
  contract_code: string;
  end_date: string;
  terminated_at: string | null;
  termination_reason: string | null;
}

/**
 * A workspace may be used while its service contract runs. It is locked once it has contracts and every one
 * of them is over: either its end date passed or the admin ended it early (from "terminated_at" on).
 * A workspace with no contract at all stays usable (demo and legacy accounts).
 */
@Injectable()
export class ContractAccessService {
  private readonly logger = new Logger(ContractAccessService.name);
  private readonly cache = new Map<string, { at: number; expired: ExpiredContract | null }>();
  private columnsReady = false;

  constructor(private readonly prisma: PrismaService) {}

  /** Forget cached answers so a created, renewed, ended or deleted contract takes effect immediately. */
  invalidate() {
    this.cache.clear();
  }

  /** The guard can run before any contract endpoint did, so it makes sure the termination columns exist. */
  private async ensureColumns() {
    if (this.columnsReady) return;
    await this.prisma.$executeRawUnsafe('ALTER TABLE "contracts" ADD COLUMN IF NOT EXISTS "terminated_at" TEXT');
    await this.prisma.$executeRawUnsafe('ALTER TABLE "contracts" ADD COLUMN IF NOT EXISTS "termination_reason" TEXT');
    this.columnsReady = true;
  }

  async expiredContract(tenantId: string): Promise<ExpiredContract | null> {
    const hit = this.cache.get(tenantId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.expired;

    let expired: ExpiredContract | null = null;
    try {
      await this.ensureColumns();
      const rows = await this.prisma.$queryRaw<Row[]>`
        SELECT "contract_code", "end_date", "terminated_at", "termination_reason" FROM "contracts" WHERE "tenant_id" = ${tenantId}`;
      let best: { lastDay: string; row: Row } | null = null;
      for (const row of rows) {
        const lastDay = row.terminated_at && dayBefore(row.terminated_at) < row.end_date ? dayBefore(row.terminated_at) : row.end_date;
        if (!best || lastDay > best.lastDay) best = { lastDay, row };
      }
      if (best && best.lastDay < vietnamToday()) {
        const endedEarly = Boolean(best.row.terminated_at) && dayBefore(best.row.terminated_at as string) < best.row.end_date;
        expired = {
          contractCode: best.row.contract_code,
          endDate: best.row.end_date,
          terminatedAt: endedEarly ? best.row.terminated_at : null,
          terminationReason: endedEarly ? best.row.termination_reason : null,
        };
      }
    } catch (error) {
      // The table is created on first use: until then nothing can be expired. Never lock people out because of a failed check.
      this.logger.warn(`Contract check skipped: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    this.cache.set(tenantId, { at: Date.now(), expired });
    return expired;
  }
}
