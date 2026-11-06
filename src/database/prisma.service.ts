import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Prisma opens `cpus * 2 + 1` connections by default (33 on a 16-core machine) while the Supabase session pooler only
 * allows 15 clients in total, so a single backend could exhaust it and every other process (a second backend, a
 * migration, a script) failed with EMAXCONNSESSION. Cap the pool unless the URL already sets `connection_limit`.
 */
export function withPoolLimit(url: string | undefined, poolSize = Number(process.env.DB_POOL_SIZE ?? 5)) {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has('connection_limit')) parsed.searchParams.set('connection_limit', String(poolSize));
    return parsed.toString();
  } catch {
    return url;
  }
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  /**
   * Interactive transactions default to a 5 s timeout, too short for a remote database where each statement can take
   * hundreds of milliseconds (deleting a floor or several nodes returned HTTP 500). Individual calls may still override.
   */
  constructor() {
    super({
      datasourceUrl: withPoolLimit(process.env.DATABASE_URL),
      transactionOptions: {
        timeout: Number(process.env.PRISMA_TX_TIMEOUT_MS ?? 30_000),
        maxWait: Number(process.env.PRISMA_TX_MAX_WAIT_MS ?? 10_000),
      },
    });
  }

  async onModuleInit() { await this.$connect(); }
  async onModuleDestroy() { await this.$disconnect(); }
}
