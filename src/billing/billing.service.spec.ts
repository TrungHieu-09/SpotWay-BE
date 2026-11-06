import { OrderKind, OrderStatus, ServicePackage, UserRole } from '@prisma/client';
import { BillingService } from './billing.service';
import { PLANS, orderAmountVnd } from './plans';

const user = { userId: 'user-1', role: UserRole.BUILDING_OWNER, tenantId: 'tenant-1' };
const renewal = {
  id: 'order-1', userId: 'user-1', tenantId: 'tenant-1', kind: OrderKind.RENEWAL, plan: ServicePackage.PRO, months: 12,
  amountVnd: 23_880_000, status: OrderStatus.PENDING, workspaceName: null, subdomain: null, paymentRef: null, paidAt: null,
  createdAt: new Date('2026-11-06T00:00:00Z'), updatedAt: new Date('2026-11-06T00:00:00Z'),
};

function build(order: Record<string, unknown> = renewal) {
  const tx: any = {
    planOrder: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest.fn().mockResolvedValue(renewal),
      findUniqueOrThrow: jest.fn().mockResolvedValue(order),
    },
    tenant: { findFirst: jest.fn().mockResolvedValue({ id: 'tenant-1', planExpiresAt: null }), update: jest.fn().mockResolvedValue({}) },
  };
  const prisma: any = {
    tenant: { findFirst: jest.fn().mockResolvedValue({ id: 'tenant-1' }) },
    planOrder: { findFirst: jest.fn().mockResolvedValue(order), findMany: jest.fn(), updateMany: jest.fn() },
    $transaction: jest.fn((fn: (t: unknown) => unknown) => fn(tx)),
  };
  return { service: new BillingService(prisma), prisma, tx };
}

describe('BillingService', () => {
  afterEach(() => { delete process.env.PAYMENT_PROVIDER; process.env.NODE_ENV = 'test'; });

  it('prices yearly commitments per month at the yearly rate', () => {
    expect(orderAmountVnd(PLANS.STARTER, 12)).toBe(23_880_000);
    expect(orderAmountVnd(PLANS.STARTER, 1)).toBe(2_490_000);
  });

  it('creates a pending renewal order for the caller\'s own workspace and cancels the previous pending one', async () => {
    const { service, tx } = build();
    const order = await service.createRenewalOrder(user, { planId: ServicePackage.PRO, months: 12 });
    expect(order.status).toBe(OrderStatus.PENDING);
    expect(tx.planOrder.updateMany.mock.calls[0][0]).toMatchObject({ where: { tenantId: 'tenant-1', kind: OrderKind.RENEWAL, status: OrderStatus.PENDING } });
    expect(tx.planOrder.create.mock.calls[0][0].data).toMatchObject({ tenantId: 'tenant-1', kind: OrderKind.RENEWAL });
  });

  it('rejects plans that cannot be bought online and users without a workspace', async () => {
    const { service } = build();
    await expect(service.createRenewalOrder(user, { planId: ServicePackage.ENTERPRISE, months: 12 })).rejects.toMatchObject({ response: { code: 'PLAN_NOT_PURCHASABLE' } });
    await expect(service.createRenewalOrder({ ...user, tenantId: null }, { planId: ServicePackage.PRO, months: 12 })).rejects.toMatchObject({ response: { code: 'NO_TENANT' } });
  });

  it('extends from the current expiry when paying a renewal', async () => {
    const future = new Date(Date.now() + 30 * 86_400_000);
    const { service, tx } = build();
    tx.tenant.findFirst.mockResolvedValue({ id: 'tenant-1', planExpiresAt: future });
    const result = await service.pay(user, 'order-1');
    const data = tx.tenant.update.mock.calls[0][0].data;
    expect(data.servicePackage).toBe(ServicePackage.PRO);
    expect(data.planExpiresAt.getTime()).toBeGreaterThan(future.getTime() + 360 * 86_400_000);
    expect(result.order.id).toBe('order-1');
  });

  it('never fulfils an old order that would have created a workspace', async () => {
    const legacy = { ...renewal, kind: OrderKind.NEW_WORKSPACE, tenantId: null, workspaceName: 'Mall', subdomain: 'mall' };
    const { service, tx } = build(legacy);
    await expect(service.pay(user, 'order-1')).rejects.toMatchObject({ response: { code: 'ORDER_NOT_PAYABLE' } });
    // The webhook path claims the order first, so it must reject (and roll back) inside the transaction.
    await expect(service.completeOrder('order-1', 'ref')).rejects.toMatchObject({ response: { code: 'ORDER_NOT_PAYABLE' } });
    expect(tx.tenant.update).not.toHaveBeenCalled();
  });

  it('does not extend twice when the order was already claimed', async () => {
    const { service, tx } = build();
    tx.planOrder.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.completeOrder('order-1', 'ref')).rejects.toMatchObject({ response: { code: 'ORDER_NOT_PAYABLE' } });
    expect(tx.tenant.update).not.toHaveBeenCalled();
  });

  it('refuses to confirm paid orders in production without a payment provider', async () => {
    process.env.NODE_ENV = 'production';
    const { service, tx } = build();
    await expect(service.pay(user, 'order-1')).rejects.toMatchObject({ response: { code: 'PAYMENT_PROVIDER_NOT_CONFIGURED' } });
    expect(tx.tenant.update).not.toHaveBeenCalled();
  });
});
