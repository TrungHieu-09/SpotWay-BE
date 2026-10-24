import { UserRole } from '@prisma/client';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  it('registers a Guest and applies JWT TTL values from env', async () => {
    process.env.JWT_ACCESS_SECRET = 'access-test-secret';
    process.env.JWT_REFRESH_SECRET = 'refresh-test-secret';
    process.env.JWT_ACCESS_TTL = '1m';
    process.env.JWT_REFRESH_TTL = '2m';
    const prisma = {
      user: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'user-1', email: 'new@example.com', role: UserRole.GUEST, tenantId: null }),
      },
      refreshSession: { create: jest.fn().mockResolvedValue({}) },
    } as any;
    const jwt = { signAsync: jest.fn().mockResolvedValueOnce('access').mockResolvedValueOnce('refresh') } as any;
    const result = await new AuthService(prisma, jwt).register(' NEW@EXAMPLE.COM ', 'password123');
    expect(result.accessToken).toBe('access');
    expect(prisma.user.create.mock.calls[0][0].data.role).toBe(UserRole.GUEST);
    expect(jwt.signAsync.mock.calls[0][1].expiresIn).toBe(60);
    expect(jwt.signAsync.mock.calls[1][1].expiresIn).toBe(120);
  });
});
