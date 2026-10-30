import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  /**
   * Interactive transactions default to a 5 s timeout, too short for a remote database where each statement can take
   * hundreds of milliseconds (deleting a floor or several nodes returned HTTP 500). Individual calls may still override.
   */
  constructor() {
    super({
      transactionOptions: {
        timeout: Number(process.env.PRISMA_TX_TIMEOUT_MS ?? 30_000),
        maxWait: Number(process.env.PRISMA_TX_MAX_WAIT_MS ?? 10_000),
      },
    });
  }

  async onModuleInit() { await this.$connect(); }
  async onModuleDestroy() { await this.$disconnect(); }
}
