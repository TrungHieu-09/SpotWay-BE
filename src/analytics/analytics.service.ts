import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MongoService } from './mongo.service';
import { PrismaService } from '../database/prisma.service';

export type NavigationEvent = {
  eventType: 'MAP_VIEWED' | 'SEARCH_PERFORMED' | 'ROUTE_REQUESTED' | 'ROUTE_RESOLVED' | 'ROUTE_NOT_FOUND' | 'QR_SCANNED';
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
  async summary(tenantId?: string) {
    const collection = await this.mongo.events();
    if (!collection) throw new ServiceUnavailableException({ code: 'ANALYTICS_UNAVAILABLE', message: 'MongoDB analytics is not configured or unavailable' });
    const match = tenantId ? { tenantId } : {};
    const [events, topSearches, topDestinations] = await Promise.all([
      collection.countDocuments(match),
      collection.aggregate([{ $match: { ...match, eventType: 'SEARCH_PERFORMED' } }, { $group: { _id: '$context.query', count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 10 }]).toArray(),
      collection.aggregate([{ $match: { ...match, eventType: 'ROUTE_RESOLVED' } }, { $group: { _id: '$context.toStoreId', count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 10 }]).toArray(),
    ]);
    return { events, topSearches: topSearches.map(({ _id, count }) => ({ query: _id, count })), topDestinations: topDestinations.map(({ _id, count }) => ({ storeId: _id, count })) };
  }
}
