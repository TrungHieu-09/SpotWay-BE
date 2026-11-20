import { BadRequestException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { BuildingStatus, FloorPublishStatus, PromotionStatus, StoreStatus, TenantStatus, UserRole } from '@prisma/client';
import { AuthUser } from '../common/auth.types';
import { PrismaService } from '../database/prisma.service';
import { assertManagerFloor } from '../common/manager-scope';
import { ActivityService } from '../analytics/activity.service';
import { CreatePromotionDto, UpdatePromotionDto } from './promotions.dto';

@Injectable()
export class PromotionsService {
  constructor(private readonly prisma: PrismaService, @Optional() private readonly activity?: ActivityService) {}
  private async log(user: AuthUser, store: { floorId: string; name: string }, action: string, summary: string) {
    const floor = await this.prisma.floor.findUnique({ where: { id: store.floorId }, select: { buildingId: true } });
    await this.activity?.record(user, floor?.buildingId, action, `${summary} (${store.name})`);
  }
  private async store(user: AuthUser, storeId: string) {
    const store = await this.prisma.store.findFirst({ where: { id: storeId, deletedAt: null } });
    if (!store) throw new NotFoundException({ code: 'STORE_NOT_FOUND', message: 'Store was not found' });
    if (user.role !== UserRole.ADMIN && (store.tenantId !== user.tenantId || (user.role === UserRole.STORE_OWNER && store.ownerId !== user.userId))) throw new ForbiddenException({ code: 'STORE_ACCESS_DENIED', message: 'Store access is denied' });
    const allowedRoles: UserRole[] = [UserRole.ADMIN, UserRole.BUILDING_OWNER, UserRole.BUILDING_MANAGER, UserRole.STORE_OWNER];
    if (!allowedRoles.includes(user.role)) throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Promotion access is denied' });
    await assertManagerFloor(this.prisma, user, store.floorId);
    return store;
  }
  private dates(dto: { startAt?: string; endAt?: string }, current?: { startAt: Date; endAt: Date }) {
    const startAt = dto.startAt ? new Date(dto.startAt) : current?.startAt; const endAt = dto.endAt ? new Date(dto.endAt) : current?.endAt;
    if (!startAt || !endAt || endAt <= startAt) throw new BadRequestException({ code: 'INVALID_PROMOTION_WINDOW', message: 'Promotion end time must be after start time' });
    return { startAt, endAt };
  }
  async list(user: AuthUser, storeId: string) { await this.store(user, storeId); return this.prisma.promotion.findMany({ where: { storeId, deletedAt: null }, orderBy: { startAt: 'desc' } }); }
  async create(user: AuthUser, storeId: string, dto: CreatePromotionDto) { const store = await this.store(user, storeId); const dates = this.dates(dto); const promotion = await this.prisma.promotion.create({ data: { tenantId: store.tenantId, storeId, title: dto.title.trim(), description: dto.description?.trim(), status: dto.status ?? PromotionStatus.ACTIVE, ...dates } }); void this.log(user, store, 'PROMOTION_CREATED', `Đăng khuyến mãi "${promotion.title}"`); return promotion; }
  async update(user: AuthUser, id: string, dto: UpdatePromotionDto) { const promotion = await this.prisma.promotion.findFirst({ where: { id, deletedAt: null } }); if (!promotion) throw new NotFoundException({ code: 'PROMOTION_NOT_FOUND', message: 'Promotion was not found' }); const store = await this.store(user, promotion.storeId); const dates = this.dates(dto, promotion); const updated = await this.prisma.promotion.update({ where: { id }, data: { ...dto, ...dates, title: dto.title?.trim(), description: dto.description?.trim() } }); void this.log(user, store, 'PROMOTION_UPDATED', `Sửa khuyến mãi "${updated.title}"`); return updated; }
  async remove(user: AuthUser, id: string) { const promotion = await this.prisma.promotion.findFirst({ where: { id, deletedAt: null } }); if (!promotion) throw new NotFoundException({ code: 'PROMOTION_NOT_FOUND', message: 'Promotion was not found' }); const store = await this.store(user, promotion.storeId); const removed = await this.prisma.promotion.update({ where: { id }, data: { deletedAt: new Date() } }); void this.log(user, store, 'PROMOTION_DELETED', `Xóa khuyến mãi "${promotion.title}"`); return removed; }
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

  /** Every promotion running now in a publicly available building, with the store it belongs to (one call for the guest app). */
  async publicByBuilding(buildingId: string) {
    const now = new Date();
    const promotions = await this.prisma.promotion.findMany({
      where: {
        deletedAt: null, status: PromotionStatus.ACTIVE, startAt: { lte: now }, endAt: { gt: now },
        store: {
          is: {
            deletedAt: null, status: StoreStatus.ACTIVE, nodeId: { not: null },
            floor: { is: { deletedAt: null, publishStatus: FloorPublishStatus.PUBLISHED, buildingId, building: { is: { deletedAt: null, status: BuildingStatus.ACTIVE, tenant: { is: { deletedAt: null, archived: false, status: TenantStatus.ACTIVE } } } } } },
          },
        },
      },
      include: { store: { select: { id: true, name: true, floorId: true, nodeId: true } } },
      orderBy: { endAt: 'asc' },
      take: 200,
    });
    return promotions.map((promotion) => ({
      id: promotion.id, title: promotion.title, description: promotion.description, startAt: promotion.startAt, endAt: promotion.endAt,
      storeId: promotion.store.id, storeName: promotion.store.name, floorId: promotion.store.floorId, nodeId: promotion.store.nodeId,
    }));
  }
}
