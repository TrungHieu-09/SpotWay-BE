import { OrderKind, OrderStatus, ServicePackage, UserRole } from '@prisma/client';
import { BillingService } from './billing.service';
import { PLANS, orderAmountVnd } from './plans';

const user = { userId: 'user-1', role: UserRole.GUEST, tenantId: null };
const baseOrder = {
  id: 'order-1', userId: 'user-1', tenantId: null, kind: OrderKind.NEW_WORKSPACE, plan: ServicePackage.STARTER, months: 12,
  amountVnd: 23_880_000, status: OrderStatus.PENDING, workspaceName: 'Mall', subdomain: 'mall', paymentRef: null, paidAt: null,
  createdAt: new Date('2026-11-06T00:00:00Z'), updatedAt: new Date('2026-11-06T00:00:00Z'),
};

function build(overrides: Record<string, any> = {}) {
  const tx: any = {
    planOrder: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest.fn().mockResolvedValue(baseOrder),
      findUniqueOrThrow: jest.fn().mockResolvedValue(baseOrder),
      update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...baseOrder, status: OrderStatus.PAID, ...data })),
    },
    user: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'user-1', role: UserRole.GUEST, tenantId: null }), update: jest.fn().mockResolvedValue({}) },
    tenant: { create: jest.fn().mockResolvedValue({ id: 'tenant-1' }), findFirst: jest.fn().mockResolvedValue(null), update: jest.fn() },
  };
  const prisma: any = {
    user: { findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'user-1', tenantId: null, tenant: null }) },
    tenant: { findUnique: jest.fn().mockResolvedValue(null), findFirst: jest.fn() },
    planOrder: { findFirst: jest.fn().mockResolvedValue(baseOrder), findMany: jest.fn(), updateMany: jest.fn() },
    $transaction: jest.fn((fn: (t: unknown) => unknown) => fn(tx)),
    ...overrides,
  };
  const auth: any = { issueSession: jest.fn().mockResolvedValue({ accessToken: 'token' }) };
  return { service: new BillingService(prisma, auth), prisma, tx, auth };
}

describe('BillingService', () => {
  const dto = { planId: ServicePackage.STARTER, months: 12, workspaceName: ' Mall ', subdomain: 'mall' };
  afterEach(() => { delete process.env.PAYMENT_PROVIDER; process.env.NODE_ENV = 'test'; });

  it('prices yearly commitments per month at the yearly rate', () => {
    expect(orderAmountVnd(PLANS.STARTER, 12)).toBe(23_880_000);
    expect(orderAmountVnd(PLANS.STARTER, 1)).toBe(2_490_000);
  });

  it('creates a pending order without provisioning a tenant', async () => {
    const { service, tx } = build();
    const order = await service.createWorkspaceOrder(user, dto);
    expect(order.status).toBe(OrderStatus.PENDING);
    expect(tx.planOrder.create.mock.calls[0][0].data).toMatchObject({ workspaceName: 'Mall', amountVnd: 23_880_000 });
    expect(tx.tenant.create).not.toHaveBeenCalled();
  });

  it('rejects plans that cannot be bought online', async () => {
    const { service } = build();
    await expect(service.createWorkspaceOrder(user, { ...dto, planId: ServicePackage.ENTERPRISE })).rejects.toMatchObject({ response: { code: 'PLAN_NOT_PURCHASABLE' } });
  });

  it('rejects a taken subdomain and users that already own a workspace', async () => {
    const taken = build({ tenant: { findUnique: jest.fn().mockResolvedValue({ id: 'other' }) } });
    await expect(taken.service.createWorkspaceOrder(user, dto)).rejects.toMatchObject({ response: { code: 'SUBDOMAIN_EXISTS' } });
    const owner = build({ user: { findUniqueOrThrow: jest.fn().mockResolvedValue({ tenantId: 't', tenant: { deletedAt: null } }) } });
    await expect(owner.service.createWorkspaceOrder(user, dto)).rejects.toMatchObject({ response: { code: 'ALREADY_HAS_WORKSPACE' } });
  });

  it('provisions the workspace, promotes the user and returns a session when the order is paid', async () => {
    const { service, tx, auth } = build();
    const result = await service.pay(user, 'order-1');
    expect(tx.tenant.create.mock.calls[0][0].data).toMatchObject({ name: 'Mall', subdomain: 'mall', servicePackage: ServicePackage.STARTER });
    expect(tx.user.update.mock.calls[0][0].data).toMatchObject({ tenantId: 'tenant-1', role: UserRole.BUILDING_OWNER });
    expect(result.order.status).toBe(OrderStatus.PAID);
    expect(auth.issueSession).toHaveBeenCalledWith('user-1');
  });

  it('does not provision twice when the order was already claimed', async () => {
    const { service, tx } = build();
    tx.planOrder.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.completeOrder('order-1', 'ref')).rejects.toMatchObject({ response: { code: 'ORDER_NOT_PAYABLE' } });
    expect(tx.tenant.create).not.toHaveBeenCalled();
  });

  it('refuses to confirm paid orders in production without a payment provider', async () => {
    process.env.NODE_ENV = 'production';
    const { service, tx } = build();
    await expect(service.pay(user, 'order-1')).rejects.toMatchObject({ response: { code: 'PAYMENT_PROVIDER_NOT_CONFIGURED' } });
    expect(tx.tenant.create).not.toHaveBeenCalled();
  });

  it('extends from the current expiry when renewing', async () => {
    const future = new Date(Date.now() + 30 * 86_400_000);
    const renewal = { ...baseOrder, kind: OrderKind.RENEWAL, tenantId: 'tenant-1', plan: ServicePackage.PRO, months: 12 };
    const { service, tx, prisma } = build();
    prisma.planOrder.findFirst.mockResolvedValue(renewal);
    tx.planOrder.findUniqueOrThrow.mockResolvedValue(renewal);
    tx.tenant.findFirst.mockResolvedValue({ id: 'tenant-1', planExpiresAt: future });
    await service.pay({ ...user, tenantId: 'tenant-1' }, 'order-1');
    const data = tx.tenant.update.mock.calls[0][0].data;
    expect(data.servicePackage).toBe(ServicePackage.PRO);
    expect(data.planExpiresAt.getTime()).toBeGreaterThan(future.getTime() + 360 * 86_400_000);
  });
});
