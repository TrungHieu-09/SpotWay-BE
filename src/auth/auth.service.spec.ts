import { TenantStatus, UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';

function build(user: Record<string, unknown> | null) {
  process.env.JWT_ACCESS_SECRET = 'access-test-secret';
  process.env.JWT_REFRESH_SECRET = 'refresh-test-secret';
  const prisma: any = {
    user: { findFirst: jest.fn().mockResolvedValue(user) },
    refreshSession: { create: jest.fn().mockResolvedValue({}) },
  };
  const jwt: any = { signAsync: jest.fn().mockResolvedValueOnce('access').mockResolvedValueOnce('refresh') };
  return { service: new AuthService(prisma, jwt), prisma };
}

describe('AuthService login', () => {
  it('issues a token pair for the account an admin created, matching the email case-insensitively', async () => {
    const passwordHash = await bcrypt.hash('Password123!', 4);
    const { service, prisma } = build({ id: 'user-1', role: UserRole.BUILDING_OWNER, tenantId: 't-1', passwordHash, tenant: { status: TenantStatus.ACTIVE } });
    const result = await service.login(' Owner@Example.com ', 'Password123!');
    expect(prisma.user.findFirst.mock.calls[0][0].where.email).toBe('owner@example.com');
    expect(result).toMatchObject({ accessToken: 'access', refreshToken: 'refresh', tokenType: 'Bearer' });
  });

  it('rejects a wrong password, an unknown email and an account without a password the same way', async () => {
    const passwordHash = await bcrypt.hash('Password123!', 4);
    const wrongPassword = build({ id: 'user-1', passwordHash, tenant: null });
    await expect(wrongPassword.service.login('a@example.com', 'nope')).rejects.toMatchObject({ response: { code: 'INVALID_CREDENTIALS' } });
    const unknown = build(null);
    await expect(unknown.service.login('x@example.com', 'Password123!')).rejects.toMatchObject({ response: { code: 'INVALID_CREDENTIALS' } });
    const noPassword = build({ id: 'user-2', passwordHash: null, tenant: null });
    await expect(noPassword.service.login('g@example.com', 'Password123!')).rejects.toMatchObject({ response: { code: 'INVALID_CREDENTIALS' } });
  });

  it('Google sign-in never creates an account: it only links an email an admin already provisioned', async () => {
    const profile = { googleId: 'g-1', email: ' Owner@Example.com ', emailVerified: true };
    const unknown = build(null);
    unknown.prisma.user.create = jest.fn();
    unknown.prisma.user.upsert = jest.fn();
    await expect(unknown.service.googleLogin(profile)).rejects.toMatchObject({ response: { code: 'ACCOUNT_NOT_PROVISIONED' } });
    expect(unknown.prisma.user.create).not.toHaveBeenCalled();
    expect(unknown.prisma.user.upsert).not.toHaveBeenCalled();

    const known = build({ id: 'user-1', tenant: null });
    known.prisma.user.update = jest.fn().mockResolvedValue({ id: 'user-1', tenant: null });
    known.prisma.oAuthCode = { create: jest.fn().mockResolvedValue({}) };
    const code = await known.service.googleLogin(profile);
    expect(known.prisma.user.findFirst.mock.calls[0][0].where).toMatchObject({ email: 'owner@example.com', deletedAt: null });
    expect(known.prisma.user.update.mock.calls[0][0].data).toEqual({ googleId: 'g-1' });
    expect(typeof code).toBe('string');
  });

  it('Google sign-in rejects an unverified Google email', async () => {
    const { service } = build({ id: 'user-1' });
    await expect(service.googleLogin({ googleId: 'g-1', email: 'a@example.com', emailVerified: false })).rejects.toMatchObject({ response: { code: 'GOOGLE_EMAIL_UNVERIFIED' } });
  });

  it('blocks users of a suspended workspace', async () => {
    const passwordHash = await bcrypt.hash('Password123!', 4);
    const { service } = build({ id: 'user-1', passwordHash, tenant: { status: TenantStatus.SUSPENDED } });
    await expect(service.login('a@example.com', 'Password123!')).rejects.toMatchObject({ response: { code: 'TENANT_SUSPENDED' } });
  });
});
