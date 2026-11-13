import { ClientEventsController } from './client-events';

function setup(building: unknown) {
  const prisma = { building: { findFirst: jest.fn().mockResolvedValue(building) } };
  const analytics = { enqueue: jest.fn().mockResolvedValue({}) };
  return { prisma, analytics, controller: new ClientEventsController(prisma as never, analytics as never) };
}

describe('ClientEventsController', () => {
  it('records the event under the building tenant with a normalised query', async () => {
    const { controller, analytics } = setup({ id: 'b1', tenantId: 't1' });
    const result = await controller.record({ eventType: 'SEARCH_PERFORMED', buildingId: 'b1', query: '  Zara ', resultCount: 3 });
    expect(result).toEqual({ accepted: true });
    expect(analytics.enqueue).toHaveBeenCalledWith({
      eventType: 'SEARCH_PERFORMED', tenantId: 't1', buildingId: 'b1', floorId: null,
      context: { source: 'mobile', query: 'zara', resultCount: 3 },
    });
  });

  it('maps the target to toStoreId so destination rankings include mobile routes', async () => {
    const { controller, analytics } = setup({ id: 'b1', tenantId: 't1' });
    await controller.record({ eventType: 'ROUTE_STARTED', buildingId: 'b1', targetId: 's1' });
    expect(analytics.enqueue.mock.calls[0][0].context).toMatchObject({ toStoreId: 's1' });
  });

  it('ignores events for an unknown building without revealing it', async () => {
    const { controller, analytics } = setup(null);
    expect(await controller.record({ eventType: 'STORE_VIEWED', buildingId: 'nope' })).toEqual({ accepted: false });
    expect(analytics.enqueue).not.toHaveBeenCalled();
  });

  it('never fails the request when the outbox write fails', async () => {
    const { controller, analytics } = setup({ id: 'b1', tenantId: 't1' });
    analytics.enqueue.mockRejectedValue(new Error('db down'));
    await expect(controller.record({ eventType: 'ROUTE_COMPLETED', buildingId: 'b1', durationSeconds: 60 })).resolves.toEqual({ accepted: true });
  });

  it('records help requests with the kind and the node, and safe arrivals', async () => {
    const { controller, analytics } = setup({ id: 'b1', tenantId: 't1' });
    await controller.record({ eventType: 'HELP_REQUESTED', buildingId: 'b1', helpKind: 'WHEELCHAIR', nodeId: 'n1' });
    expect(analytics.enqueue.mock.calls[0][0]).toMatchObject({ eventType: 'HELP_REQUESTED', context: { helpKind: 'WHEELCHAIR', nodeId: 'n1' } });
    await controller.record({ eventType: 'SAFE_REACHED', buildingId: 'b1' });
    expect(analytics.enqueue.mock.calls[1][0].eventType).toBe('SAFE_REACHED');
  });
});
