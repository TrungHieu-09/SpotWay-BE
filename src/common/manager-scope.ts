import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AuthUser } from './auth.types';
import { PrismaService } from '../database/prisma.service';

/** A building manager may only act on the buildings the owner assigned to them; every other role passes through (their tenant checks live elsewhere). */
export async function assertManagerBuilding(prisma: PrismaService, user: AuthUser, buildingId: string) {
  if (user.role !== UserRole.BUILDING_MANAGER) return;
  const assigned = await prisma.staffAssignment.findUnique({ where: { userId_buildingId: { userId: user.userId, buildingId } } });
  if (!assigned) throw new ForbiddenException({ code: 'BUILDING_ACCESS_DENIED', message: 'Manager is not assigned to this building' });
}

export async function assertManagerFloor(prisma: PrismaService, user: AuthUser, floorId: string) {
  if (user.role !== UserRole.BUILDING_MANAGER) return;
  const floor = await prisma.floor.findFirst({ where: { id: floorId, deletedAt: null }, select: { buildingId: true } });
  if (!floor) throw new NotFoundException({ code: 'FLOOR_NOT_FOUND', message: 'Floor was not found' });
  await assertManagerBuilding(prisma, user, floor.buildingId);
}

/** Ids of the buildings a manager is assigned to (undefined for other roles = no building filter). */
export async function assignedBuildingIds(prisma: PrismaService, user: AuthUser): Promise<string[] | undefined> {
  if (user.role !== UserRole.BUILDING_MANAGER) return undefined;
  return (await prisma.staffAssignment.findMany({ where: { userId: user.userId }, select: { buildingId: true } })).map((a) => a.buildingId);
}
