import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { AuthUser } from './auth.types';
import { ROLES_KEY } from './roles.decorator';
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride(ROLES_KEY, [context.getHandler(), context.getClass()]);
    if (!roles) return true;
    const user = context.switchToHttp().getRequest<Request & { user: AuthUser }>().user;
    if (roles.includes(user.role)) return true;
    throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Insufficient role' });
  }
}
