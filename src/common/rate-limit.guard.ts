import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';

export const RATE_LIMIT_KEY = 'rateLimit';
export type RateLimitOptions = { limit: number; windowMs: number };
/** Fixed-window limit per client IP and route. Kept in memory: fine for a single instance. */
export const RateLimit = (limit: number, windowMs = 60_000) => SetMetadata(RATE_LIMIT_KEY, { limit, windowMs } satisfies RateLimitOptions);

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const options = this.reflector.getAllAndOverride<RateLimitOptions | undefined>(RATE_LIMIT_KEY, [context.getHandler(), context.getClass()]);
    if (!options) return true;
    const request = context.switchToHttp().getRequest<Request>();
    const key = `${request.ip ?? 'unknown'}|${request.method}|${request.route?.path ?? request.path}`;
    const now = Date.now();
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + options.windowMs });
      return true;
    }
    entry.count += 1;
    if (entry.count > options.limit) {
      throw new HttpException({ code: 'RATE_LIMITED', message: 'Too many requests, please try again later', retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000) }, HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }
}
