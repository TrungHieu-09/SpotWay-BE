import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Adds connection timeouts to a Postgres URL unless it already sets them. Prisma's default `connect_timeout` is 5 s,
 * which a remote pooler (Supabase from another region) can exceed, giving "P1001 Can't reach database server".
 */
export function withConnectionTimeouts(url: string, env: NodeJS.ProcessEnv = process.env): string {
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has('connect_timeout')) parsed.searchParams.set('connect_timeout', env.DB_CONNECT_TIMEOUT_S ?? '30');
    if (!parsed.searchParams.has('pool_timeout')) parsed.searchParams.set('pool_timeout', env.DB_POOL_TIMEOUT_S ?? '30');
    return parsed.toString();
  } catch {
    return url;
  }
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  /**
   * Interactive transactions default to a 5 s timeout, too short for a remote database where each statement can take
   * hundreds of milliseconds (deleting a floor or several nodes returned HTTP 500). Individual calls may still override.
   */
  constructor() {
    const url = process.env.DATABASE_URL;
    super({
      ...(url ? { datasourceUrl: withConnectionTimeouts(url) } : {}),
      transactionOptions: {
        timeout: Number(process.env.PRISMA_TX_TIMEOUT_MS ?? 30_000),
        maxWait: Number(process.env.PRISMA_TX_MAX_WAIT_MS ?? 10_000),
      },
    });
  }

  /** A slow or briefly unreachable database should not crash the server at boot: retry a few times first. */
  async onModuleInit() {
    const attempts = Number(process.env.DB_CONNECT_ATTEMPTS ?? 4);
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.$connect();
        return;
      } catch (error) {
        if (attempt >= attempts) throw error;
        const delayMs = attempt * 2_000;
        this.logger.warn(`Database connection failed (attempt ${attempt}/${attempts}): ${(error as Error).message.split('\n')[0]}. Retrying in ${delayMs / 1000}s`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  async onModuleDestroy() { await this.$disconnect(); }
}
