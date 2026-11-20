import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

export interface ExpiredContract {
  contractCode: string;
  /** YYYY-MM-DD, the last day the service could be used */
  endDate: string;
}

const CACHE_MS = 30_000;
const VIETNAM_OFFSET_MS = 7 * 60 * 60 * 1000;

/** Today in Vietnam as YYYY-MM-DD: a contract is usable through its end date and locks the day after. */
export function vietnamToday(now = Date.now()) {
  return new Date(now + VIETNAM_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * A workspace may be used while its service contract runs. It is locked once it has contracts and the one that
 * ends last is already over. A workspace with no contract at all stays usable (demo and legacy accounts).
 */
@Injectable()
export class ContractAccessService {
  private readonly logger = new Logger(ContractAccessService.name);
  private readonly cache = new Map<string, { at: number; expired: ExpiredContract | null }>();

  constructor(private readonly prisma: PrismaService) {}

  /** Forget cached answers so a created, renewed or deleted contract takes effect immediately. */
  invalidate() {
    this.cache.clear();
  }

  async expiredContract(tenantId: string): Promise<ExpiredContract | null> {
    const hit = this.cache.get(tenantId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.expired;

    let expired: ExpiredContract | null = null;
    try {
      const rows = await this.prisma.$queryRaw<{ contract_code: string; end_date: string }[]>`
        SELECT "contract_code", "end_date" FROM "contracts" WHERE "tenant_id" = ${tenantId} ORDER BY "end_date" DESC LIMIT 1`;
      if (rows[0] && rows[0].end_date < vietnamToday()) expired = { contractCode: rows[0].contract_code, endDate: rows[0].end_date };
    } catch (error) {
      // The table is created on first use: until then nothing can be expired. Never lock people out because of a failed check.
      this.logger.warn(`Contract check skipped: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    this.cache.set(tenantId, { at: Date.now(), expired });
    return expired;
  }
}
