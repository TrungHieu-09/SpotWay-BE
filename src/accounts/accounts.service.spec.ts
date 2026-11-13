import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { UserAccountStatus, UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { AuthUser } from '../common/auth.types';
import { AccountsService } from './accounts.service';

const owner: AuthUser = { userId: 'owner-1', role: UserRole.BUILDING_OWNER, tenantId: 'tenant-1' };
const baseUser = (over: Record<string, unknown> = {}) => ({
  id: 'u1',
  email: 'staff@demo.local',
  name: null,
  role: UserRole.BUILDING_MANAGER,
  tenantId: 'tenant-1',
  status: UserAccountStatus.ACTIVE,
  mustChangePassword: false,
  passwordHash: null as string | null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

type Delegate = Record<string, jest.Mock>;
type PrismaMock = { user: Delegate; refreshSession: Delegate; staffAssignment: Delegate; store: Delegate; building: Delegate; $transaction: jest.Mock };

function setup() {
  const prisma: PrismaMock = {
    user: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), groupBy: jest.fn() },
    refreshSession: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    staffAssignment: { deleteMany: jest.fn() },
    store: { count: jest.fn().mockResolvedValue(0), groupBy: jest.fn().mockResolvedValue([]), findMany: jest.fn() },
    building: { count: jest.fn().mockResolvedValue(3) },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(async (ops: unknown): Promise<unknown> => (Array.isArray(ops) ? Promise.all(ops) : (ops as (tx: PrismaMock) => Promise<unknown>)(prisma)));
  return { prisma, service: new AccountsService(prisma as never) };
}

describe('AccountsService', () => {
  it('toDto falls back to the email local part and maps status', () => {
    const { service } = setup();
    expect(service.toDto(baseUser({ status: UserAccountStatus.LOCKED }) as never)).toMatchObject({ name: 'staff', status: 'locked', role: 'building_manager', areaIds: [] });
    expect(service.toDto(baseUser({ name: 'Linh' }) as never).name).toBe('Linh');
  });

  it('generatePassword is long enough and mixed', () => {
    const { service } = setup();
    for (let i = 0; i < 50; i++) {
      const pwd = service.generatePassword();
      expect(pwd.length).toBeGreaterThanOrEqual(12);
      expect(pwd).toMatch(/[A-Z]/);
      expect(pwd).toMatch(/[a-z]/);
      expect(pwd).toMatch(/\d/);
    }
  });

  describe('changePassword', () => {
    it('requires the current password for a normal account', async () => {
      const { prisma, service } = setup();
      prisma.user.findFirst.mockResolvedValue(baseUser({ passwordHash: await bcrypt.hash('Old-pass-1', 4) }));
      await expect(service.changePassword('u1', 'wrong', 'New-pass-12')).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.changePassword('u1', undefined, 'New-pass-12')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('lets a temporary password be replaced without typing it, clears the flag and ends sessions', async () => {
      const { prisma, service } = setup();
      prisma.user.findFirst
        .mockResolvedValueOnce(baseUser({ mustChangePassword: true, passwordHash: await bcrypt.hash('Temp-pass-1', 4) }))
        .mockResolvedValueOnce({ ...baseUser(), tenant: null });
      await service.changePassword('u1', undefined, 'New-pass-12');
      const data = prisma.user.update.mock.calls[0][0].data;
      expect(data.mustChangePassword).toBe(false);
      expect(await bcrypt.compare('New-pass-12', data.passwordHash)).toBe(true);
      expect(prisma.refreshSession.updateMany).toHaveBeenCalled();
    });

    it('rejects reusing the same password', async () => {
      const { prisma, service } = setup();
      prisma.user.findFirst.mockResolvedValue(baseUser({ passwordHash: await bcrypt.hash('Same-pass-1', 4) }));
      await expect(service.changePassword('u1', 'Same-pass-1', 'Same-pass-1')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('workspace isolation', () => {
    it('refuses an account without a workspace', async () => {
      const { service } = setup();
      await expect(service.tenantUsers({ ...owner, tenantId: null })).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('only looks up accounts inside the caller tenant', async () => {
      const { prisma, service } = setup();
      prisma.user.findFirst.mockResolvedValue(null);
      await expect(service.updateStaff(owner, 'u1', { status: 'locked' })).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.user.findFirst.mock.calls[0][0].where).toMatchObject({ tenantId: 'tenant-1', deletedAt: null });
    });
  });

  describe('staff lifecycle', () => {
    it('locking revokes sessions', async () => {
      const { prisma, service } = setup();
      prisma.user.findFirst.mockResolvedValue(baseUser());
      prisma.user.update.mockResolvedValue(baseUser({ status: UserAccountStatus.LOCKED }));
      const res = await service.updateStaff(owner, 'u1', { status: 'locked' });
      expect(res.status).toBe('locked');
      expect(prisma.refreshSession.updateMany).toHaveBeenCalled();
    });

    it('reset returns a temporary password and forces a change', async () => {
      const { prisma, service } = setup();
      prisma.user.findFirst.mockResolvedValue(baseUser());
      prisma.user.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => baseUser({ mustChangePassword: data.mustChangePassword }));
      const res = (await service.updateStaff(owner, 'u1', { resetPassword: true })) as { temporaryPassword?: string; mustChangePassword: boolean };
      expect(res.temporaryPassword).toBeTruthy();
      expect(res.mustChangePassword).toBe(true);
    });

    it('creating a duplicate email is a 409', async () => {
      const { prisma, service } = setup();
      const { Prisma } = await import('@prisma/client');
      prisma.user.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }));
      await expect(service.createStaff(owner, { name: 'A', email: 'a@b.co', role: 'building_manager' })).rejects.toBeInstanceOf(ConflictException);
    });

    it('a store owner that still has a store cannot be deleted', async () => {
      const { prisma, service } = setup();
      prisma.user.findFirst.mockResolvedValue(baseUser({ role: UserRole.STORE_OWNER }));
      prisma.store.count.mockResolvedValue(1);
      await expect(service.deleteStoreOwner(owner, 'u1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('delete frees the email and revokes sessions', async () => {
      const { prisma, service } = setup();
      prisma.user.findFirst.mockResolvedValue(baseUser());
      prisma.user.update.mockResolvedValue({});
      await service.deleteStaff(owner, 'u1');
      expect(prisma.user.update.mock.calls[0][0].data.email).toMatch(/^deleted\+u1@/);
      expect(prisma.refreshSession.updateMany).toHaveBeenCalled();
    });
  });

  describe('admin', () => {
    it('cannot delete itself or another admin', async () => {
      const { prisma, service } = setup();
      const admin: AuthUser = { userId: 'a1', role: UserRole.ADMIN, tenantId: null };
      await expect(service.adminDeleteUser(admin, 'a1')).rejects.toBeInstanceOf(BadRequestException);
      prisma.user.findFirst.mockResolvedValue(baseUser({ id: 'a2', role: UserRole.ADMIN }));
      await expect(service.adminDeleteUser(admin, 'a2')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('a manager account needs a Building Owner', async () => {
      const { service } = setup();
      await expect(service.adminCreateUser({ email: 'm@x.co', password: 'Password-12', role: 'building_manager' })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('overview totals the roles', async () => {
      const { prisma, service } = setup();
      prisma.user.groupBy.mockResolvedValue([
        { role: UserRole.ADMIN, _count: { _all: 1 } },
        { role: UserRole.BUILDING_OWNER, _count: { _all: 2 } },
        { role: UserRole.GUEST, _count: { _all: 50 } },
      ]);
      expect(await service.adminOverview()).toEqual({ users: { total: 3, admin: 1, buildingOwner: 2, buildingManager: 0, storeOwner: 0 }, buildings: 3 });
    });
  });
});
