import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TenantStatus } from '@prisma/client';
import { Request } from 'express';
import { PrismaService } from '../database/prisma.service';
import { AuthUser } from './auth.types';
import { IS_PUBLIC_KEY } from './public.decorator';

@Injectable()
export class TenantStatusGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()])) return true;
    const user = context.switchToHttp().getRequest<Request & { user: AuthUser }>().user;
    if (!user.tenantId) return true;
    const tenant = await this.prisma.tenant.findUnique({ where: { id: user.tenantId }, select: { status: true, archived: true, deletedAt: true } });
    if (!tenant || tenant.archived || tenant.deletedAt || tenant.status !== TenantStatus.ACTIVE) throw new ForbiddenException({ code: 'TENANT_SUSPENDED', message: 'This tenant is suspended' });
    return true;
  }
}
