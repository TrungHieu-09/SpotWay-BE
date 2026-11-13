import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { AuthUser } from '../common/auth.types';
import { PrismaService } from '../database/prisma.service';
import type { CreateStoreDto, UpdateStoreDto } from './stores.controller';

@Injectable()
export class StoresService {
  constructor(private readonly prisma: PrismaService) {}

  async create(user: AuthUser, dto: CreateStoreDto) {
    const floor = await this.prisma.floor.findFirst({
      where: { id: dto.floorId, deletedAt: null },
      select: { id: true, tenantId: true },
    });
    if (!floor) throw new NotFoundException({ code: 'FLOOR_NOT_FOUND', message: 'Floor was not found' });
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
      return await this.prisma.store.create({
        data: {
          tenantId: floor.tenantId,
          floorId: floor.id,
          nodeId: dto.nodeId,
          ownerId: dto.ownerId,
          name: dto.name.trim(),
          description: dto.description,
          images: dto.images ?? [],
        },
      });
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
      return await this.prisma.store.update({ where: { id }, data });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new ConflictException({ code: 'STORE_OWNER_ALREADY_ASSIGNED', message: 'Store Owner already manages an active store' });
      throw error;
    }
  }
}
