import { UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { ASSIGNABLE_ROLES } from './admin.dto';
import { AdminService } from './admin.service';

const now = new Date('2026-11-06T00:00:00Z');

function build(overrides: { existing?: any; owner?: any; target?: any; members?: number } = {}) {
  const tx: any = {
    tenant: { create: jest.fn().mockResolvedValue({ id: 'tenant-new' }) },
    user: {
      findFirst: jest.fn().mockResolvedValue(overrides.owner ?? null),
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'user-new', createdAt: now, tenant: null, ...data })),
      update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: overrides.existing?.id ?? 'user-1', email: 'a@b.co', role: UserRole.STORE_OWNER, tenantId: null, createdAt: now, tenant: null, ...data })),
    },
  };
  const prisma: any = {
    user: {
      findUnique: jest.fn().mockResolvedValue(overrides.existing ?? null),
      findFirst: jest.fn().mockResolvedValue(overrides.target ?? null),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(overrides.members ?? 0),
      update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'user-1', email: 'a@b.co', role: UserRole.STORE_OWNER, tenantId: null, createdAt: now, tenant: null, ...data })),
      groupBy: jest.fn(),
    },
    refreshSession: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    building: { count: jest.fn() },
    $transaction: jest.fn((arg: unknown) => (typeof arg === 'function' ? (arg as (t: unknown) => unknown)(tx) : Promise.all(arg as unknown[]))),
  };
  return { service: new AdminService(prisma), prisma, tx };
}

describe('AdminService.createUser', () => {
  const base = { email: ' New@Example.com ', password: 'Password123!' };

  it('creates a Building Owner with a login password and a workspace nobody has to name', async () => {
    const { service, tx } = build();
    const result = await service.createUser({ ...base, role: 'building_owner' });
    const tenant = tx.tenant.create.mock.calls[0][0].data;
    expect(tenant).toMatchObject({ name: 'new' });
    expect(tenant.subdomain).toMatch(/^new-[0-9a-f]{6}$/);
    const user = tx.user.create.mock.calls[0][0].data;
    expect(user).toMatchObject({ email: 'new@example.com', role: UserRole.BUILDING_OWNER, tenantId: 'tenant-new' });
    expect(user.passwordHash).not.toBe('Password123!');
    expect(await bcrypt.compare('Password123!', user.passwordHash)).toBe(true);
    expect(result).toMatchObject({ email: 'new@example.com', role: 'building_owner', tenantId: 'tenant-new' });
  });

  it('does not hand out admin or guest roles', () => {
    expect(ASSIGNABLE_ROLES).toEqual(['building_owner', 'building_manager', 'store_owner']);
  });

  it('puts a manager / store owner into the tenant of the owner they are assigned to', async () => {
    const { service, tx } = build({ owner: { id: 'owner-1', tenantId: 'tenant-7' } });
    await service.createUser({ ...base, role: 'building_manager', ownerId: 'owner-1' });
    expect(tx.user.findFirst.mock.calls[0][0].where).toMatchObject({ id: 'owner-1', role: UserRole.BUILDING_OWNER, deletedAt: null });
    expect(tx.user.create.mock.calls[0][0].data).toMatchObject({ role: UserRole.BUILDING_MANAGER, tenantId: 'tenant-7' });
    expect(tx.tenant.create).not.toHaveBeenCalled();
  });

  it('asks for an owner when creating a manager, and rejects an owner that does not exist', async () => {
    const missing = build();
    await expect(missing.service.createUser({ ...base, role: 'store_owner' })).rejects.toMatchObject({ response: { code: 'OWNER_REQUIRED' } });
    await expect(missing.service.createUser({ ...base, role: 'store_owner', ownerId: 'nope' })).rejects.toMatchObject({ response: { code: 'OWNER_NOT_FOUND' } });
    expect(missing.tx.user.create).not.toHaveBeenCalled();
  });

  it('refuses an email that already has an account', async () => {
    const { service, tx } = build({ existing: { id: 'user-1', deletedAt: null } });
    await expect(service.createUser({ ...base, role: 'building_owner' })).rejects.toMatchObject({ response: { code: 'EMAIL_EXISTS' } });
    expect(tx.user.create).not.toHaveBeenCalled();
  });

  it('brings back a deleted account with the new role and password instead of failing on the unique email', async () => {
    const { service, tx } = build({ existing: { id: 'user-1', deletedAt: new Date() } });
    await service.createUser({ ...base, role: 'building_owner' });
    expect(tx.user.create).not.toHaveBeenCalled();
    expect(tx.user.update.mock.calls[0][0]).toMatchObject({ where: { id: 'user-1' }, data: { role: UserRole.BUILDING_OWNER, deletedAt: null } });
  });
});

describe('AdminService.deleteUser / resetPassword', () => {
  it('does not let an admin delete themself', async () => {
    const { service, prisma } = build();
    await expect(service.deleteUser('me', 'me')).rejects.toMatchObject({ response: { code: 'CANNOT_DELETE_SELF' } });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('refuses to delete an owner who still has managers or store owners', async () => {
    const { service, prisma } = build({ target: { id: 'owner-1', role: UserRole.BUILDING_OWNER, tenantId: 't1' }, members: 2 });
    await expect(service.deleteUser('owner-1', 'admin-1')).rejects.toMatchObject({ response: { code: 'OWNER_HAS_MEMBERS' } });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('soft-deletes an account and signs it out of every session', async () => {
    const { service, prisma } = build({ target: { id: 'user-1', role: UserRole.STORE_OWNER, tenantId: 't1' } });
    await expect(service.deleteUser('user-1', 'admin-1')).resolves.toEqual({ id: 'user-1', deleted: true });
    expect(prisma.user.update.mock.calls[0][0].data.deletedAt).toBeInstanceOf(Date);
    expect(prisma.refreshSession.updateMany.mock.calls[0][0].where).toMatchObject({ userId: 'user-1', revokedAt: null });
  });

  it('answers 404 for an unknown account', async () => {
    const { service } = build();
    await expect(service.deleteUser('x', 'admin-1')).rejects.toMatchObject({ response: { code: 'USER_NOT_FOUND' } });
    await expect(service.resetPassword('x', {})).rejects.toMatchObject({ response: { code: 'USER_NOT_FOUND' } });
  });

  it('generates a temporary password when none is given, hashes it and revokes sessions', async () => {
    const { service, prisma } = build({ target: { id: 'user-1' } });
    const result = await service.resetPassword('user-1', {});
    expect(result.temporaryPassword).toMatch(/^SpotWay@\d{6}$/);
    const { passwordHash } = prisma.user.update.mock.calls[0][0].data;
    expect(await bcrypt.compare(result.temporaryPassword!, passwordHash)).toBe(true);
    expect(prisma.refreshSession.updateMany).toHaveBeenCalled();
  });

  it('uses the password the admin typed and does not echo it back', async () => {
    const { service, prisma } = build({ target: { id: 'user-1' } });
    const result = await service.resetPassword('user-1', { newPassword: 'Chosen#12345' });
    expect(result).not.toHaveProperty('temporaryPassword');
    expect(await bcrypt.compare('Chosen#12345', prisma.user.update.mock.calls[0][0].data.passwordHash)).toBe(true);
  });
});

describe('AdminService read models', () => {
  it('lists accounts with the owner workspace name as "belongs to"', async () => {
    const { service, prisma } = build();
    prisma.user.findMany.mockResolvedValue([{ id: 'u1', email: 'mgr@x.co', role: UserRole.BUILDING_MANAGER, tenantId: 't1', createdAt: now, tenant: { name: 'owner', deletedAt: null } }]);
    expect(await service.listUsers()).toEqual([expect.objectContaining({ name: 'mgr', role: 'building_manager', tenantName: 'owner', status: 'active' })]);
    expect(prisma.user.findMany.mock.calls[0][0].where).toEqual({ deletedAt: null, role: { not: UserRole.GUEST } });
  });

  it('counts accounts per role and buildings', async () => {
    const { service, prisma } = build();
    prisma.user.groupBy.mockResolvedValue([{ role: UserRole.ADMIN, _count: { _all: 1 } }, { role: UserRole.BUILDING_OWNER, _count: { _all: 2 } }]);
    prisma.building.count.mockResolvedValue(5);
    expect(await service.overview()).toMatchObject({
      users: { total: 3, admin: 1, buildingOwner: 2, buildingManager: 0, storeOwner: 0 },
      buildings: 5,
    });
  });
});
