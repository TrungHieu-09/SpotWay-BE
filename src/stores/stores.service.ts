import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { AuthUser } from '../common/auth.types';
import { PrismaService } from '../database/prisma.service';
import { StorageService } from '../floors/storage.service';
import type { CreateStoreDto, UpdateStoreDto } from './stores.controller';
import { STORE_WITH_BUILDING, serializeStore } from './store-serializer';
import { assertManagerFloor } from '../common/manager-scope';
import { ActivityService } from '../analytics/activity.service';
import { bumpGraphVersion } from '../graph/application/graph-support';

@Injectable()
export class StoresService {
  constructor(private readonly prisma: PrismaService, private readonly storage: StorageService, @Optional() private readonly activity?: ActivityService) {}

  async create(user: AuthUser, dto: CreateStoreDto) {
    const floor = await this.prisma.floor.findFirst({
      where: { id: dto.floorId, deletedAt: null },
      select: { id: true, tenantId: true },
    });
    if (!floor) throw new NotFoundException({ code: 'FLOOR_NOT_FOUND', message: 'Floor was not found' });
    await assertManagerFloor(this.prisma, user, dto.floorId);
    if (user.role !== UserRole.ADMIN && floor.tenantId !== user.tenantId) {
      throw new ForbiddenException({ code: 'TENANT_ACCESS_DENIED', message: 'Cross-tenant store creation is denied' });
    }

    if (dto.nodeId) {
      const node = await this.prisma.node.findFirst({
        where: { id: dto.nodeId, deletedAt: null },
        select: { floorId: true, tenantId: true },
      });
      if (!node) throw new NotFoundException({ code: 'STORE_NODE_NOT_FOUND', message: 'Store node was not found' });
      if (node.floorId !== floor.id || node.tenantId !== floor.tenantId) {
        throw new BadRequestException({ code: 'STORE_NODE_FLOOR_MISMATCH', message: 'Store node must belong to the selected floor' });
      }
    }

    if (dto.ownerId) {
      const owner = await this.prisma.user.findFirst({
        where: { id: dto.ownerId, deletedAt: null },
        select: { id: true, role: true, tenantId: true },
      });
      if (!owner || owner.role !== UserRole.STORE_OWNER || owner.tenantId !== floor.tenantId) {
        throw new BadRequestException({ code: 'INVALID_STORE_OWNER', message: 'Owner must be an active Store Owner in this tenant' });
      }
      const assignedStore = await this.prisma.store.findFirst({ where: { ownerId: owner.id, deletedAt: null }, select: { id: true } });
      if (assignedStore) throw new ConflictException({ code: 'STORE_OWNER_ALREADY_ASSIGNED', message: 'Store Owner already manages an active store' });
    }

    try {
      const created = serializeStore(await this.prisma.store.create({
        include: STORE_WITH_BUILDING,
        data: {
          tenantId: floor.tenantId,
          floorId: floor.id,
          nodeId: dto.nodeId,
          ownerId: dto.ownerId,
          name: dto.name.trim(),
          description: dto.description,
          images: dto.images ?? [],
        },
      }));
      void this.activity?.record(user, created.buildingId, 'STORE_CREATED', `Thêm gian hàng "${created.name}"`, { storeId: created.id });
      return created;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException({ code: 'STORE_OWNER_ALREADY_ASSIGNED', message: 'Store Owner already manages an active store' });
      }
      throw error;
    }
  }

  /** Patch a store. Store Owners may only touch the descriptive fields of their own store. */
  async update(user: AuthUser, id: string, dto: UpdateStoreDto) {
    const store = await this.prisma.store.findFirst({ where: { id, deletedAt: null } });
    if (!store) throw new NotFoundException({ code: 'STORE_NOT_FOUND', message: 'Store was not found' });
    if (user.role !== UserRole.ADMIN && (store.tenantId !== user.tenantId || (user.role === UserRole.STORE_OWNER && store.ownerId !== user.userId))) {
      throw new ForbiddenException({ code: 'STORE_ACCESS_DENIED', message: 'Store access is denied' });
    }
    await assertManagerFloor(this.prisma, user, store.floorId);
    const managerFields = dto.ownerId !== undefined || dto.nodeId !== undefined || dto.status !== undefined;
    if (user.role === UserRole.STORE_OWNER && managerFields) {
      throw new ForbiddenException({ code: 'STORE_FIELD_FORBIDDEN', message: 'Only the building staff can change owner, node or status' });
    }
    if (dto.nodeId) {
      const node = await this.prisma.node.findFirst({ where: { id: dto.nodeId, deletedAt: null }, select: { floorId: true, tenantId: true } });
      if (!node) throw new NotFoundException({ code: 'STORE_NODE_NOT_FOUND', message: 'Store node was not found' });
      if (node.floorId !== store.floorId || node.tenantId !== store.tenantId) throw new BadRequestException({ code: 'STORE_NODE_FLOOR_MISMATCH', message: 'Store node must belong to the store floor' });
    }
    if (dto.ownerId) {
      const owner = await this.prisma.user.findFirst({ where: { id: dto.ownerId, deletedAt: null }, select: { id: true, role: true, tenantId: true } });
      if (!owner || owner.role !== UserRole.STORE_OWNER || owner.tenantId !== store.tenantId) throw new BadRequestException({ code: 'INVALID_STORE_OWNER', message: 'Owner must be an active Store Owner in this tenant' });
      const assigned = await this.prisma.store.findFirst({ where: { ownerId: owner.id, deletedAt: null, id: { not: id } }, select: { id: true } });
      if (assigned) throw new ConflictException({ code: 'STORE_OWNER_ALREADY_ASSIGNED', message: 'Store Owner already manages an active store' });
    }
    const data: Prisma.StoreUncheckedUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.images !== undefined) data.images = dto.images;
    if (dto.logoUrl !== undefined) data.logoUrl = dto.logoUrl;
    if (dto.ownerId !== undefined) data.ownerId = dto.ownerId;
    if (dto.nodeId !== undefined) data.nodeId = dto.nodeId;
    try {
      const updated = serializeStore(await this.prisma.$transaction(async (tx) => {
        const result = await tx.store.update({ where: { id }, data, include: STORE_WITH_BUILDING });
        if (store.poiId && dto.name !== undefined) {
          const changed = await tx.poi.updateMany({ where: { id: store.poiId, deletedAt: null }, data: { name: dto.name.trim() } });
          if (changed.count) await bumpGraphVersion(tx, store.floorId);
        }
        return result;
      }));
      const what = dto.status !== undefined ? (dto.status === 'ACTIVE' ? 'mở bán' : 'đóng') : 'cập nhật';
      void this.activity?.record(user, updated.buildingId, 'STORE_UPDATED', `Gian hàng "${updated.name}": ${what}`, { storeId: id });
      return updated;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException({ code: 'STORE_OWNER_ALREADY_ASSIGNED', message: 'Store Owner already manages an active store' });
      throw error;
    }
  }

  /** Signed URL to upload a logo / gallery image of a store; the client then saves the returned publicUrl on the store. */
  async createUploadUrl(user: AuthUser, id: string, filename: string) {
    const store = await this.prisma.store.findFirst({ where: { id, deletedAt: null }, select: { id: true, tenantId: true, ownerId: true, floorId: true } });
    if (!store) throw new NotFoundException({ code: 'STORE_NOT_FOUND', message: 'Store was not found' });
    if (user.role !== UserRole.ADMIN && (store.tenantId !== user.tenantId || (user.role === UserRole.STORE_OWNER && store.ownerId !== user.userId))) {
      throw new ForbiddenException({ code: 'STORE_ACCESS_DENIED', message: 'Store access is denied' });
    }
    await assertManagerFloor(this.prisma, user, store.floorId);
    const clean = filename.replace(/[^a-zA-Z0-9.-]/g, '_').slice(-80);
    return this.storage.createSignedUploadUrl(`stores/${store.id}/${Date.now()}-${clean}`);
  }
}
