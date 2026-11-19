import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AuthUser } from '../common/auth.types';
import { PrismaService } from '../database/prisma.service';
import { MongoService } from './mongo.service';

export type ActivityEntry = {
  id: string;
  action: string;
  summary: string;
  at: string;
  actor: { id: string; role: string; email: string | null; name: string | null };
  extra?: Record<string, unknown>;
};

/**
 * Who did what in a building, and when: fire alarms (with how long they lasted), closures, notices, shop and promotion
 * changes, new QR codes. Written to MongoDB (like the analytics events) and kept for `ACTIVITY_TTL_DAYS` (default 180).
 * Recording is best-effort: it never makes the action it describes fail, and without MongoDB it is simply skipped.
 */
@Injectable()
export class ActivityService {
  private readonly logger = new Logger(ActivityService.name);
  constructor(private readonly prisma: PrismaService, private readonly mongo: MongoService) {}

  async record(user: AuthUser, buildingId: string | null | undefined, action: string, summary: string, extra?: Record<string, unknown>): Promise<void> {
    if (!buildingId) return;
    try {
      const collection = await this.mongo.activity();
      if (!collection) return;
      const actor = await this.prisma.user.findUnique({ where: { id: user.userId }, select: { email: true, name: true } });
      const ttlDays = Math.max(1, Number(process.env.ACTIVITY_TTL_DAYS ?? 180));
      const now = Date.now();
      await collection.insertOne({
        _id: randomUUID(),
        buildingId,
        tenantId: user.tenantId,
        action,
        summary,
        actor: { id: user.userId, role: user.role, email: actor?.email ?? null, name: actor?.name ?? null },
        ...(extra ? { extra } : {}),
        at: new Date(now).toISOString(),
        expiresAt: new Date(now + ttlDays * 86_400_000).toISOString(),
      });
    } catch (error) {
      this.logger.warn(`Activity not recorded: ${error instanceof Error ? error.message : error}`);
    }
  }

  /** Newest first. `prefix` keeps one family of actions, for example "INCIDENT". */
  async list(buildingId: string, limit = 50, prefix?: string): Promise<ActivityEntry[]> {
    const collection = await this.mongo.activity();
    if (!collection) return [];
    const filter: Record<string, unknown> = { buildingId };
    if (prefix) filter.action = { $regex: `^${prefix.replace(/[^A-Z_]/g, '')}` };
    const rows = await collection.find(filter).sort({ at: -1 }).limit(Math.min(200, Math.max(1, limit))).toArray();
    return rows.map((row) => ({
      id: String(row._id),
      action: String(row.action),
      summary: String(row.summary),
      at: String(row.at),
      actor: row.actor as ActivityEntry['actor'],
      extra: row.extra as Record<string, unknown> | undefined,
    }));
  }
}
