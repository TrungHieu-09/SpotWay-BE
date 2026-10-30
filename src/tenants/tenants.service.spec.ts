import { NotFoundException } from '@nestjs/common';
import { TenantStatus } from '@prisma/client';
import { TenantsService } from './tenants.service';

function build(tenant: object | null) {
  const prisma = { tenant: { findFirst: jest.fn().mockResolvedValue(tenant), update: jest.fn().mockResolvedValue({}) } } as any;
  return { prisma, service: new TenantsService(prisma) };
}

describe('TenantsService', () => {
  it('returns one active tenant and answers 404 for a missing or deleted one', async () => {
    await expect(build({ id: 't1' }).service.find('t1')).resolves.toEqual({ id: 't1' });
    const { prisma, service } = build(null);
    await expect(service.find('t1')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.tenant.findFirst).toHaveBeenCalledWith({ where: { id: 't1', deletedAt: null } });
  });

  it('soft-deletes a tenant and suspends it so the tenant guard locks its users out', async () => {
    const { prisma, service } = build({ id: 't1' });
    await expect(service.remove('t1')).resolves.toEqual({ id: 't1', deleted: true });
    expect(prisma.tenant.update).toHaveBeenCalledWith({ where: { id: 't1' }, data: { deletedAt: expect.any(Date), archived: true, status: TenantStatus.SUSPENDED } });
  });

  it('does not delete a tenant that does not exist', async () => {
    const { prisma, service } = build(null);
    await expect(service.remove('t1')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });
});
