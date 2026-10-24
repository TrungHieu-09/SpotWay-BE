import { ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { TenantAccessService } from './tenant-access.service';

describe('TenantAccessService', () => {
  it('rejects a non-admin user from another tenant', async () => {
    const prisma = { building: { findFirst: jest.fn().mockResolvedValue({ id: 'b-1', tenantId: 'tenant-a' }) } } as any;
    const service = new TenantAccessService(prisma);
    await expect(service.building({ userId: 'u-1', role: UserRole.BUILDING_OWNER, tenantId: 'tenant-b' }, 'b-1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows an Admin to access a building in any tenant', async () => {
    const building = { id: 'b-1', tenantId: 'tenant-a' };
    const service = new TenantAccessService({ building: { findFirst: jest.fn().mockResolvedValue(building) } } as any);
    await expect(service.building({ userId: 'admin', role: UserRole.ADMIN, tenantId: null }, 'b-1')).resolves.toEqual(building);
  });
});
