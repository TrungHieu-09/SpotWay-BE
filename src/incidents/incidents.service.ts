import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { BuildingStatus, TenantStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { AuthUser } from '../common/auth.types';
import { TenantAccessService } from '../common/tenant-access.service';
import { PrismaService } from '../database/prisma.service';

type ActiveIncident = { active: true; id: string; type: 'FIRE'; nodeIds: string[]; floorIds: string[]; message: string | null; startedAt: string };
export type IncidentState = { active: false } | ActiveIncident;

/**
 * The live emergency of a building. It is deliberately kept in memory: an incident is short-lived and a backend restart
 * must never bring an old alarm back onto the phones of guests. Single instance only.
 */
@Injectable()
export class IncidentsService {
  private readonly incidents = new Map<string, ActiveIncident>();
  constructor(private readonly prisma: PrismaService, private readonly access: TenantAccessService) {}

  private read(buildingId: string): IncidentState {
    return this.incidents.get(buildingId) ?? { active: false };
  }

  async start(user: AuthUser, buildingId: string, nodeIds: string[], message?: string) {
    await this.access.building(user, buildingId);
    const unique = [...new Set(nodeIds)];
    const nodes = await this.prisma.node.findMany({ where: { id: { in: unique }, deletedAt: null, floor: { buildingId, deletedAt: null } }, select: { id: true, floorId: true } });
    if (nodes.length !== unique.length) throw new BadRequestException({ code: 'INCIDENT_NODE_INVALID', message: 'Every node must belong to this building' });
    const incident: ActiveIncident = {
      active: true,
      id: randomUUID(),
      type: 'FIRE',
      nodeIds: unique,
      floorIds: [...new Set(nodes.map((node) => node.floorId))],
      message: message?.trim() || null,
      startedAt: new Date().toISOString(),
    };
    this.incidents.set(buildingId, incident);
    return incident;
  }

  async clear(user: AuthUser, buildingId: string) {
    await this.access.building(user, buildingId);
    this.incidents.delete(buildingId);
    return { active: false as const };
  }

  async state(user: AuthUser, buildingId: string) {
    await this.access.building(user, buildingId);
    return this.read(buildingId);
  }

  /** What the guest app polls: only for a building that is publicly available. */
  async publicState(buildingId: string) {
    const building = await this.prisma.building.findFirst({
      where: { id: buildingId, status: BuildingStatus.ACTIVE, deletedAt: null, tenant: { is: { status: TenantStatus.ACTIVE, archived: false, deletedAt: null } } },
      select: { id: true },
    });
    if (!building) throw new NotFoundException({ code: 'PUBLIC_BUILDING_NOT_FOUND', message: 'Published building not found' });
    return this.read(buildingId);
  }
}
