import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { AuthUser } from '../common/auth.types';
import { PrismaService } from '../database/prisma.service';
import type { CreateStoreDto } from './stores.controller';

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
}
