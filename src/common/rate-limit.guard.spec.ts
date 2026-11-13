import { ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RateLimitGuard } from './rate-limit.guard';

function ctx(ip: string, path = '/auth/login'): ExecutionContext {
  return { getHandler: () => ctx, getClass: () => RateLimitGuard, switchToHttp: () => ({ getRequest: () => ({ ip, method: 'POST', path }) }) } as unknown as ExecutionContext;
}

describe('RateLimitGuard', () => {
  it('lets handlers without a limit through', () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(undefined) } as unknown as Reflector;
    const guard = new RateLimitGuard(reflector);
    for (let i = 0; i < 100; i++) expect(guard.canActivate(ctx('1.1.1.1'))).toBe(true);
  });

  it('blocks after the limit, per client, and recovers after the window', () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue({ limit: 3, windowMs: 1000 }) } as unknown as Reflector;
    const guard = new RateLimitGuard(reflector);
    jest.useFakeTimers().setSystemTime(0);
    for (let i = 0; i < 3; i++) expect(guard.canActivate(ctx('1.1.1.1'))).toBe(true);
    expect(() => guard.canActivate(ctx('1.1.1.1'))).toThrow(HttpException);
    expect(guard.canActivate(ctx('2.2.2.2'))).toBe(true);
    jest.setSystemTime(1001);
    expect(guard.canActivate(ctx('1.1.1.1'))).toBe(true);
    jest.useRealTimers();
  });
});
