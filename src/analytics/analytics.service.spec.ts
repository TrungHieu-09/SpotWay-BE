import { AnalyticsService } from './analytics.service';

describe('AnalyticsService', () => {
  beforeEach(() => { process.env.MONGODB_EVENTS_TTL_DAYS = '90'; });

  it('persists a privacy-safe navigation event to the Postgres outbox', async () => {
    const prisma = { outboxEvent: { create: jest.fn().mockResolvedValue({ id: 'event-1' }) } } as any;
    const service = new AnalyticsService(prisma, {} as any);
    await service.enqueue({ eventType: 'SEARCH_PERFORMED', tenantId: 'tenant-1', buildingId: 'building-1', context: { query: 'coffee' } });
    expect(prisma.outboxEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ topic: 'navigation.event.v1' }) }));
  });

  it('does not fail when MongoDB is intentionally unavailable', async () => {
    const service = new AnalyticsService({} as any, { events: jest.fn().mockResolvedValue(undefined) } as any);
    await expect(service.processPending()).resolves.toBe(0);
  });

  it('uses the outbox UUID as Mongo _id for idempotent delivery', async () => {
    const updateOne = jest.fn().mockResolvedValue({});
    const prisma = {
      outboxEvent: {
        findMany: jest.fn().mockResolvedValue([{ id: 'event-1', payload: { eventType: 'ROUTE_RESOLVED' } }]),
        update: jest.fn().mockResolvedValue({}),
      },
    } as any;
    const service = new AnalyticsService(prisma, { events: jest.fn().mockResolvedValue({ updateOne }) } as any);
    await expect(service.processPending()).resolves.toBe(1);
    expect(updateOne).toHaveBeenCalledWith({ _id: 'event-1' }, expect.any(Object), { upsert: true });
  });
});
