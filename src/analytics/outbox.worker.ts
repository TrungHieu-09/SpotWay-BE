import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';

@Injectable()
export class OutboxWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  constructor(private readonly analytics: AnalyticsService) {}
  onModuleInit() {
    if (!process.env.MONGODB_URI) return;
    const interval = Math.max(1000, Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? 5000));
    const run = () => void this.analytics.processPending().catch(() => undefined);
    run(); this.timer = setInterval(run, interval); this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
}
