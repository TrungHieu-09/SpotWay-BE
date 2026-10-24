import { BadRequestException, ConflictException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { StoresService } from './stores.service';

const user = { userId: 'owner-1', role: UserRole.BUILDING_OWNER, tenantId: 'tenant-1' };
const floor = { id: 'floor-1', tenantId: 'tenant-1' };

describe('StoresService', () => {
  it('rejects a node from another floor', async () => {
    const prisma = {
      floor: { findFirst: jest.fn().mockResolvedValue(floor) },
      node: { findFirst: jest.fn().mockResolvedValue({ floorId: 'floor-2', tenantId: 'tenant-1' }) },
    } as any;
    const service = new StoresService(prisma);
    await expect(service.create(user, { floorId: floor.id, nodeId: '00000000-0000-4000-8000-000000000001', name: 'Test Store' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an owner who is not a Store Owner in the floor tenant', async () => {
    const prisma = {
      floor: { findFirst: jest.fn().mockResolvedValue(floor) },
      user: { findFirst: jest.fn().mockResolvedValue({ id: 'user-2', role: UserRole.BUILDING_MANAGER, tenantId: 'tenant-1' }) },
    } as any;
    const service = new StoresService(prisma);
    await expect(service.create(user, { floorId: floor.id, ownerId: '00000000-0000-4000-8000-000000000002', name: 'Test Store' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a Store Owner who already manages an active store', async () => {
    const prisma = {
      floor: { findFirst: jest.fn().mockResolvedValue(floor) },
      user: { findFirst: jest.fn().mockResolvedValue({ id: 'user-2', role: UserRole.STORE_OWNER, tenantId: 'tenant-1' }) },
      store: { findFirst: jest.fn().mockResolvedValue({ id: 'store-1' }) },
    } as any;
    const service = new StoresService(prisma);
    await expect(service.create(user, { floorId: floor.id, ownerId: '00000000-0000-4000-8000-000000000002', name: 'Test Store' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('creates a store only after node and owner validation', async () => {
    const prisma = {
      floor: { findFirst: jest.fn().mockResolvedValue(floor) },
      node: { findFirst: jest.fn().mockResolvedValue({ floorId: floor.id, tenantId: floor.tenantId }) },
      user: { findFirst: jest.fn().mockResolvedValue({ id: 'user-2', role: UserRole.STORE_OWNER, tenantId: floor.tenantId }) },
      store: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'store-2' }) },
    } as any;
    const service = new StoresService(prisma);
    await expect(service.create(user, { floorId: floor.id, nodeId: '00000000-0000-4000-8000-000000000003', ownerId: '00000000-0000-4000-8000-000000000002', name: ' Test Store ' })).resolves.toEqual({ id: 'store-2' });
    expect(prisma.store.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ name: 'Test Store', tenantId: floor.tenantId }) }));
  });
});
