import { ForbiddenException } from '@nestjs/common';
import { TenantStatus, UserAccountStatus, UserRole } from '@prisma/client';
import { ALLOW_EXPIRED_CONTRACT_KEY } from './allow-expired-contract.decorator';
import { TenantStatusGuard } from './tenant-status.guard';

describe('TenantStatusGuard', () => {
  const owner = { userId: 'owner', role: UserRole.BUILDING_OWNER, tenantId: 'tenant-1' };
  const active = { status: TenantStatus.ACTIVE, archived: false, deletedAt: null };
  const context = (user: any) => ({ getHandler: () => undefined, getClass: () => undefined, switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as any;
  const build = (opts: { tenant?: any; expired?: any; allowExpired?: boolean; account?: any } = {}) => {
    const reflector = { getAllAndOverride: jest.fn((key: string) => (key === ALLOW_EXPIRED_CONTRACT_KEY ? Boolean(opts.allowExpired) : false)) } as any;
    const prisma = {
      tenant: { findUnique: jest.fn().mockResolvedValue(opts.tenant ?? active) },
      user: { findUnique: jest.fn().mockResolvedValue('account' in opts ? opts.account : { status: UserAccountStatus.ACTIVE, deletedAt: null }) },
    } as any;
    const contracts = { expiredContract: jest.fn().mockResolvedValue(opts.expired ?? null) } as any;
    return { guard: new TenantStatusGuard(reflector, prisma, contracts), prisma, contracts };
  };

  it('allows Admin without a tenant', async () => {
    const { guard, prisma, contracts } = build();
    await expect(guard.canActivate(context({ userId: 'admin', role: UserRole.ADMIN, tenantId: null }))).resolves.toBe(true);
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
    expect(contracts.expiredContract).not.toHaveBeenCalled();
  });

  it('stops a locked account even though its access token is still valid', async () => {
    const { guard, prisma } = build({ account: { status: UserAccountStatus.LOCKED, deletedAt: null } });
    await expect(guard.canActivate(context(owner))).rejects.toMatchObject({ response: { code: 'ACCOUNT_LOCKED' } });
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
  });

  it('stops an account that was deleted', async () => {
    const { guard } = build({ account: { status: UserAccountStatus.ACTIVE, deletedAt: new Date() } });
    await expect(guard.canActivate(context(owner))).rejects.toMatchObject({ status: 401 });
    await expect(build({ account: null }).guard.canActivate(context(owner))).rejects.toMatchObject({ status: 401 });
  });

  it('rejects a suspended tenant', async () => {
    const { guard } = build({ tenant: { ...active, status: TenantStatus.SUSPENDED } });
    await expect(guard.canActivate(context(owner))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets a workspace with a running contract (or none) through', async () => {
    await expect(build().guard.canActivate(context(owner))).resolves.toBe(true);
  });

  it('locks every user of a workspace whose contract has ended', async () => {
    const expired = { contractCode: 'HD-2026-001', endDate: '2026-11-01', terminatedAt: null, terminationReason: null };
    for (const role of [UserRole.BUILDING_OWNER, UserRole.BUILDING_MANAGER, UserRole.STORE_OWNER]) {
      const { guard } = build({ expired });
      await expect(guard.canActivate(context({ ...owner, role }))).rejects.toMatchObject({
        response: { code: 'CONTRACT_EXPIRED', message: expect.stringContaining('01/11/2026') },
      });
    }
  });

  it('says so when the contract was ended early, with the reason', async () => {
    const { guard } = build({ expired: { contractCode: 'HD-2026-001', endDate: '2027-01-01', terminatedAt: '2026-11-25', terminationReason: 'Vi phạm điều khoản' } });
    await expect(guard.canActivate(context(owner))).rejects.toMatchObject({
      response: { code: 'CONTRACT_TERMINATED', message: expect.stringContaining('Lý do: Vi phạm điều khoản') },
    });
  });

  it('still allows the routes marked for an expired contract (see the contract, ask for a renewal, own account)', async () => {
    const { guard, contracts } = build({ expired: { contractCode: 'HD-2026-001', endDate: '2026-11-01', terminatedAt: null, terminationReason: null }, allowExpired: true });
    await expect(guard.canActivate(context(owner))).resolves.toBe(true);
    expect(contracts.expiredContract).not.toHaveBeenCalled();
  });
});
