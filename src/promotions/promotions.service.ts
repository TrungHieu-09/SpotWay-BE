import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PromotionStatus, UserRole } from '@prisma/client';
import { AuthUser } from '../common/auth.types';
import { PrismaService } from '../database/prisma.service';
import { CreatePromotionDto, UpdatePromotionDto } from './promotions.dto';

@Injectable()
export class PromotionsService {
  constructor(private readonly prisma: PrismaService) {}
  private async store(user: AuthUser, storeId: string) {
    const store = await this.prisma.store.findFirst({ where: { id: storeId, deletedAt: null } });
    if (!store) throw new NotFoundException({ code: 'STORE_NOT_FOUND', message: 'Store was not found' });
    if (user.role !== UserRole.ADMIN && (store.tenantId !== user.tenantId || (user.role === UserRole.STORE_OWNER && store.ownerId !== user.userId))) throw new ForbiddenException({ code: 'STORE_ACCESS_DENIED', message: 'Store access is denied' });
    const allowedRoles: UserRole[] = [UserRole.ADMIN, UserRole.BUILDING_OWNER, UserRole.STORE_OWNER];
    if (!allowedRoles.includes(user.role)) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Promotion access is denied' });
    return store;
  }
  private dates(dto: { startAt?: string; endAt?: string }, current?: { startAt: Date; endAt: Date }) {
    const startAt = dto.startAt ? new Date(dto.startAt) : current?.startAt; const endAt = dto.endAt ? new Date(dto.endAt) : current?.endAt;
    if (!startAt || !endAt || endAt <= startAt) throw new BadRequestException({ code: 'INVALID_PROMOTION_WINDOW', message: 'Promotion end time must be after start time' });
    return { startAt, endAt };
  }
  async list(user: AuthUser, storeId: string) { await this.store(user, storeId); return this.prisma.promotion.findMany({ where: { storeId, deletedAt: null }, orderBy: { startAt: 'desc' } }); }
  async create(user: AuthUser, storeId: string, dto: CreatePromotionDto) { const store = await this.store(user, storeId); const dates = this.dates(dto); return this.prisma.promotion.create({ data: { tenantId: store.tenantId, storeId, title: dto.title.trim(), description: dto.description?.trim(), status: dto.status ?? PromotionStatus.ACTIVE, ...dates } }); }
  async update(user: AuthUser, id: string, dto: UpdatePromotionDto) { const promotion = await this.prisma.promotion.findFirst({ where: { id, deletedAt: null } }); if (!promotion) throw new NotFoundException({ code: 'PROMOTION_NOT_FOUND', message: 'Promotion was not found' }); await this.store(user, promotion.storeId); const dates = this.dates(dto, promotion); return this.prisma.promotion.update({ where: { id }, data: { ...dto, ...dates, title: dto.title?.trim(), description: dto.description?.trim() } }); }
  async remove(user: AuthUser, id: string) { const promotion = await this.prisma.promotion.findFirst({ where: { id, deletedAt: null } }); if (!promotion) throw new NotFoundException({ code: 'PROMOTION_NOT_FOUND', message: 'Promotion was not found' }); await this.store(user, promotion.storeId); return this.prisma.promotion.update({ where: { id }, data: { deletedAt: new Date() } }); }
  async publicList(storeId: string) {
    const now = new Date();
    return this.prisma.promotion.findMany({
      where: {
        storeId, deletedAt: null, status: PromotionStatus.ACTIVE, startAt: { lte: now }, endAt: { gt: now },
        store: {
          is: {
            deletedAt: null,
            status: 'ACTIVE',
            floor: {
              is: {
                deletedAt: null,
                publishStatus: 'PUBLISHED',
                building: {
                  is: {
                    deletedAt: null,
                    status: 'ACTIVE',
                    tenant: { is: { deletedAt: null, archived: false, status: 'ACTIVE' } },
                  },
                },
              },
            },
          },
        },
      },
      orderBy: { endAt: 'asc' },
    });
  }
}
