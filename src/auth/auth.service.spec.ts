import { UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { createHash } from 'crypto';
import { AuthService } from './auth.service';

const OTP = '123456';
const otpHash = createHash('sha256').update(OTP).digest('hex');

function build(overrides: Record<string, any> = {}) {
  process.env.JWT_ACCESS_SECRET = 'access-test-secret';
  process.env.JWT_REFRESH_SECRET = 'refresh-test-secret';
  const prisma: any = {
    user: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'user-1', tenantId: null, ...data })),
    },
    emailOtp: {
      deleteMany: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    refreshSession: { create: jest.fn().mockResolvedValue({}) },
    ...overrides,
  };
  const jwt: any = { signAsync: jest.fn().mockResolvedValueOnce('access').mockResolvedValueOnce('refresh') };
  const mail: any = { sendOtp: jest.fn().mockResolvedValue(undefined) };
  return { service: new AuthService(prisma, jwt, mail), prisma, mail };
}

describe('AuthService registration', () => {
  it('never stores the registration password in plain text', async () => {
    const { service, prisma, mail } = build();
    await service.register(' NEW@EXAMPLE.COM ', 'Password123!', 'New User');
    const stored = prisma.emailOtp.create.mock.calls[0][0].data;
    expect(stored.email).toBe('new@example.com');
    expect(stored.password).not.toBe('Password123!');
    expect(await bcrypt.compare('Password123!', stored.password)).toBe(true);
    expect(mail.sendOtp).toHaveBeenCalled();
  });

  it('creates the Guest from the stored hash, so the registration password logs in, and clears the OTP password', async () => {
    const hash = await bcrypt.hash('Password123!', 4);
    const { service, prisma } = build();
    prisma.emailOtp.findFirst.mockResolvedValue({ id: 'otp-1', codeHash: otpHash, password: hash, expiresAt: new Date(Date.now() + 60_000) });
    const result = await service.verifyEmail('new@example.com', OTP);
    const created = prisma.user.create.mock.calls[0][0].data;
    expect(created.role).toBe(UserRole.GUEST);
    expect(created.passwordHash).toBe(hash);
    expect(await bcrypt.compare('Password123!', created.passwordHash)).toBe(true);
    expect(prisma.emailOtp.update.mock.calls[0][0].data).toMatchObject({ password: null });
    expect(result.accessToken).toBe('access');
  });

  it('still accepts OTP rows written before hashing (plain password) and hashes them on verify', async () => {
    const { service, prisma } = build();
    prisma.emailOtp.findFirst.mockResolvedValue({ id: 'otp-1', codeHash: otpHash, password: 'LegacyPass1!', expiresAt: new Date(Date.now() + 60_000) });
    await service.verifyEmail('legacy@example.com', OTP);
    const { passwordHash } = prisma.user.create.mock.calls[0][0].data;
    expect(passwordHash).not.toBe('LegacyPass1!');
    expect(await bcrypt.compare('LegacyPass1!', passwordHash)).toBe(true);
  });

  it('does not create an account with an empty-password hash when the OTP row has no password', async () => {
    const { service, prisma } = build();
    prisma.emailOtp.findFirst.mockResolvedValue({ id: 'otp-1', codeHash: otpHash, password: null, expiresAt: new Date(Date.now() + 60_000) });
    await service.verifyEmail('nopass@example.com', OTP);
    expect(await bcrypt.compare('', prisma.user.create.mock.calls[0][0].data.passwordHash)).toBe(false);
  });

  it('rejects a wrong code without creating the account', async () => {
    const { service, prisma } = build();
    prisma.emailOtp.findFirst.mockResolvedValue({ id: 'otp-1', codeHash: otpHash, password: 'x', expiresAt: new Date(Date.now() + 60_000) });
    await expect(service.verifyEmail('new@example.com', '000000')).rejects.toMatchObject({ response: { code: 'INVALID_CODE' } });
    expect(prisma.user.create).not.toHaveBeenCalled();
  });
});
