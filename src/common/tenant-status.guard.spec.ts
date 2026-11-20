import { ForbiddenException } from '@nestjs/common';
import { TenantStatus, UserRole } from '@prisma/client';
import { ALLOW_EXPIRED_CONTRACT_KEY } from './allow-expired-contract.decorator';
import { TenantStatusGuard } from './tenant-status.guard';

describe('TenantStatusGuard', () => {
  const owner = { userId: 'owner', role: UserRole.BUILDING_OWNER, tenantId: 'tenant-1' };
  const active = { status: TenantStatus.ACTIVE, archived: false, deletedAt: null };
  const context = (user: any) => ({ getHandler: () => undefined, getClass: () => undefined, switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as any;
  const build = (opts: { tenant?: any; expired?: any; allowExpired?: boolean } = {}) => {
    const reflector = { getAllAndOverride: jest.fn((key: string) => (key === ALLOW_EXPIRED_CONTRACT_KEY ? Boolean(opts.allowExpired) : false)) } as any;
    const prisma = { tenant: { findUnique: jest.fn().mockResolvedValue(opts.tenant ?? active) } } as any;
    const contracts = { expiredContract: jest.fn().mockResolvedValue(opts.expired ?? null) } as any;
    return { guard: new TenantStatusGuard(reflector, prisma, contracts), prisma, contracts };
  };

  it('allows Admin without a tenant', async () => {
    const { guard, prisma, contracts } = build();
    await expect(guard.canActivate(context({ userId: 'admin', role: UserRole.ADMIN, tenantId: null }))).resolves.toBe(true);
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
    expect(contracts.expiredContract).not.toHaveBeenCalled();
  });

  it('rejects a suspended tenant', async () => {
    const { guard } = build({ tenant: { ...active, status: TenantStatus.SUSPENDED } });
    await expect(guard.canActivate(context(owner))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets a workspace with a running contract (or none) through', async () => {
    await expect(build().guard.canActivate(context(owner))).resolves.toBe(true);
  });

  it('locks every user of a workspace whose contract has ended', async () => {
    const expired = { contractCode: 'HD-2026-001', endDate: '2026-11-01' };
    for (const role of [UserRole.BUILDING_OWNER, UserRole.BUILDING_MANAGER, UserRole.STORE_OWNER]) {
      const { guard } = build({ expired });
      await expect(guard.canActivate(context({ ...owner, role }))).rejects.toMatchObject({
        response: { code: 'CONTRACT_EXPIRED', message: expect.stringContaining('01/11/2026') },
      });
    }
  });

  it('still allows the routes marked for an expired contract (see the contract, ask for a renewal, own account)', async () => {
    const { guard, contracts } = build({ expired: { contractCode: 'HD-2026-001', endDate: '2026-11-01' }, allowExpired: true });
    await expect(guard.canActivate(context(owner))).resolves.toBe(true);
    expect(contracts.expiredContract).not.toHaveBeenCalled();
  });
});
