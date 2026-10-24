import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Collection, Db, MongoClient } from 'mongodb';

export type NavigationEventDocument = { _id: string; [key: string]: unknown };

@Injectable()
export class MongoService implements OnModuleDestroy {
  private readonly logger = new Logger(MongoService.name);
  private client?: MongoClient;
  private database?: Db;
  private connecting?: Promise<Db | undefined>;

  async db(): Promise<Db | undefined> {
    if (this.database) return this.database;
    if (!process.env.MONGODB_URI) return undefined;
    if (!this.connecting) this.connecting = this.connect();
    return this.connecting;
  }

  async events(): Promise<Collection<NavigationEventDocument> | undefined> {
    const db = await this.db();
    if (!db) return undefined;
    const collection = db.collection<NavigationEventDocument>('navigation_events');
    await Promise.all([
      collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      collection.createIndex({ tenantId: 1, occurredAt: -1 }),
      collection.createIndex({ buildingId: 1, eventType: 1, occurredAt: -1 }),
      collection.createIndex({ 'context.toStoreId': 1, occurredAt: -1 }),
    ]);
    return collection;
  }

  private async connect() {
    try {
      this.client = new MongoClient(process.env.MONGODB_URI!);
      await this.client.connect();
      this.database = this.client.db(process.env.MONGODB_DB || 'spotway_analytics');
      this.logger.log('MongoDB analytics connected');
      return this.database;
    } catch (error) {
      this.logger.error('MongoDB analytics unavailable; outbox events will retry', error instanceof Error ? error.message : error);
      await this.client?.close().catch(() => undefined);
      this.client = undefined;
      this.connecting = undefined;
      return undefined;
    }
  }

  async onModuleDestroy() { await this.client?.close(); }
}
