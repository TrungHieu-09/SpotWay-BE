import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MongoService } from './mongo.service';
import { PrismaService } from '../database/prisma.service';

export type NavigationEvent = {
  eventType: 'MAP_VIEWED' | 'SEARCH_PERFORMED' | 'ROUTE_REQUESTED' | 'ROUTE_RESOLVED' | 'ROUTE_NOT_FOUND' | 'QR_SCANNED' | 'ROUTE_STARTED' | 'ROUTE_COMPLETED' | 'EVACUATION_STARTED' | 'STORE_VIEWED';
  tenantId: string; buildingId: string; floorId?: string | null;
  context?: Record<string, unknown>;
};

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService, private readonly mongo: MongoService) {}
  async enqueue(event: NavigationEvent) {
    const ttlDays = Math.max(1, Number(process.env.MONGODB_EVENTS_TTL_DAYS ?? 90));
    const occurredAt = new Date();
    const payload = { ...event, occurredAt: occurredAt.toISOString(), expiresAt: new Date(occurredAt.getTime() + ttlDays * 86400000).toISOString(), schemaVersion: 1 } as unknown as Prisma.InputJsonValue;
    return this.prisma.outboxEvent.create({ data: { topic: 'navigation.event.v1', payload } });
  }
  async processPending() {
    const collection = await this.mongo.events();
    if (!collection) return 0;
    const batch = Math.min(500, Math.max(1, Number(process.env.OUTBOX_BATCH_SIZE ?? 100)));
    const events = await this.prisma.outboxEvent.findMany({ where: { processedAt: null }, orderBy: { createdAt: 'asc' }, take: batch });
    let processed = 0;
    for (const event of events) {
      try {
        await collection.updateOne({ _id: event.id }, { $setOnInsert: { _id: event.id, ...(event.payload as Record<string, unknown>) } }, { upsert: true });
        await this.prisma.outboxEvent.update({ where: { id: event.id }, data: { processedAt: new Date(), lastError: null } });
        processed++;
      } catch (error) {
        await this.prisma.outboxEvent.update({ where: { id: event.id }, data: { attempts: { increment: 1 }, lastError: error instanceof Error ? error.message.slice(0, 1000) : 'Unknown Mongo error' } });
      }
    }
    return processed;
  }
  /** Usage of the last `days` days. Empty searches and anonymous targets are noise (the app lists everything on start), so they are left out. */
  async summary(tenantId?: string, days = 7) {
    const collection = await this.mongo.events();
    if (!collection) throw new ServiceUnavailableException({ code: 'ANALYTICS_UNAVAILABLE', message: 'MongoDB analytics is not configured or unavailable' });
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const match = { ...(tenantId ? { tenantId } : {}), occurredAt: { $gte: since } };
    const [byType, daily, topSearches, topTargets, completed] = await Promise.all([
      collection.aggregate([{ $match: match }, { $group: { _id: '$eventType', count: { $sum: 1 } } }]).toArray(),
      collection.aggregate([{ $match: match }, { $group: { _id: { $substr: ['$occurredAt', 0, 10] }, count: { $sum: 1 } } }, { $sort: { _id: 1 } }]).toArray(),
      collection.aggregate([{ $match: { ...match, eventType: 'SEARCH_PERFORMED', 'context.query': { $nin: [null, ''] } } }, { $group: { _id: '$context.query', count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 10 }]).toArray(),
      collection.aggregate([{ $match: { ...match, eventType: { $in: ['ROUTE_STARTED', 'ROUTE_RESOLVED'] }, 'context.toStoreId': { $nin: [null, ''] } } }, { $group: { _id: '$context.toStoreId', count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 10 }]).toArray(),
      collection.aggregate([{ $match: { ...match, eventType: 'ROUTE_COMPLETED' } }, { $group: { _id: null, count: { $sum: 1 }, avgDuration: { $avg: '$context.durationSeconds' } } }]).toArray(),
    ]);
    const counts: Record<string, number> = Object.fromEntries(byType.map(({ _id, count }) => [String(_id), count as number]));
    const ids = topTargets.map(({ _id }) => String(_id));
    const [stores, pois] = ids.length ? await Promise.all([
      this.prisma.store.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
      this.prisma.poi.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
    ]) : [[], []];
    const names = new Map([...pois, ...stores].map(({ id, name }) => [id, name]));
    const started = (counts.ROUTE_STARTED ?? 0) + (counts.ROUTE_RESOLVED ?? 0);
    return {
      days,
      since,
      events: Object.values(counts).reduce((sum, value) => sum + value, 0),
      byType: counts,
      daily: daily.map(({ _id, count }) => ({ date: String(_id), count: count as number })),
      topSearches: topSearches.map(({ _id, count }) => ({ query: _id, count })),
      topDestinations: topTargets.map(({ _id, count }) => ({ storeId: String(_id), name: names.get(String(_id)) ?? null, count })),
      routes: {
        started,
        completed: completed[0]?.count ?? 0,
        evacuations: counts.EVACUATION_STARTED ?? 0,
        avgDurationSeconds: completed[0]?.avgDuration ? Math.round(completed[0].avgDuration) : null,
      },
      qrScans: counts.QR_SCANNED ?? 0,
      storeViews: counts.STORE_VIEWED ?? 0,
    };
  }
}
