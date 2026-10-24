import { ForbiddenException } from '@nestjs/common';
import { TenantStatus, UserRole } from '@prisma/client';
import { TenantStatusGuard } from './tenant-status.guard';

describe('TenantStatusGuard', () => {
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) } as any;
  const context = (user: any) => ({ getHandler: () => undefined, getClass: () => undefined, switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as any;

  it('allows Admin without a tenant', async () => {
    const prisma = { tenant: { findUnique: jest.fn() } } as any;
    await expect(new TenantStatusGuard(reflector, prisma).canActivate(context({ userId: 'admin', role: UserRole.ADMIN, tenantId: null }))).resolves.toBe(true);
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a suspended tenant', async () => {
    const prisma = { tenant: { findUnique: jest.fn().mockResolvedValue({ status: TenantStatus.SUSPENDED, archived: false, deletedAt: null }) } } as any;
    await expect(new TenantStatusGuard(reflector, prisma).canActivate(context({ userId: 'owner', role: UserRole.BUILDING_OWNER, tenantId: 'tenant-1' }))).rejects.toBeInstanceOf(ForbiddenException);
  });
});
