import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TenantStatus } from '@prisma/client';
import { Request } from 'express';
import { PrismaService } from '../database/prisma.service';
import { ALLOW_EXPIRED_CONTRACT_KEY } from './allow-expired-contract.decorator';
import { AuthUser } from './auth.types';
import { ContractAccessService } from './contract-access.service';
import { IS_PUBLIC_KEY } from './public.decorator';

const formatDay = (day: string) => day.split('-').reverse().join('/');

@Injectable()
export class TenantStatusGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly contracts: ContractAccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;
    const user = context.switchToHttp().getRequest<Request & { user: AuthUser }>().user;
    if (!user.tenantId) return true;
    const tenant = await this.prisma.tenant.findUnique({ where: { id: user.tenantId }, select: { status: true, archived: true, deletedAt: true } });
    if (!tenant || tenant.archived || tenant.deletedAt || tenant.status !== TenantStatus.ACTIVE) throw new ForbiddenException({ code: 'TENANT_SUSPENDED', message: 'This tenant is suspended' });

    // The service ends with the contract: owner, managers and store owners are all locked out of the app.
    if (!this.reflector.getAllAndOverride<boolean>(ALLOW_EXPIRED_CONTRACT_KEY, targets)) {
      const expired = await this.contracts.expiredContract(user.tenantId);
      if (expired) {
        throw new ForbiddenException({
          code: 'CONTRACT_EXPIRED',
          message: `Hợp đồng ${expired.contractCode} đã hết hạn ngày ${formatDay(expired.endDate)}. Vui lòng liên hệ quản trị viên để gia hạn.`,
        });
      }
    }
    return true;
  }
}
