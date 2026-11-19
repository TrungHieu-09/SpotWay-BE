import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { BuildingStatus, TenantStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { AuthUser } from '../common/auth.types';
import { TenantAccessService } from '../common/tenant-access.service';
import { PrismaService } from '../database/prisma.service';
import { ActivityService } from '../analytics/activity.service';

type ActiveIncident = { active: true; id: string; type: 'FIRE'; nodeIds: string[]; floorIds: string[]; message: string | null; startedAt: string };
export type IncidentState = { active: false } | ActiveIncident;

/**
 * The live emergency of a building. It is deliberately kept in memory: an incident is short-lived and a backend restart
 * must never bring an old alarm back onto the phones of guests. Single instance only.
 */
@Injectable()
export class IncidentsService {
  private readonly incidents = new Map<string, ActiveIncident>();
  /** Which exit each evacuating phone currently heads for. Entries expire when a phone stops reporting. */
  private readonly claims = new Map<string, Map<string, { exitNodeId: string; at: number }>>();
  private readonly knownNodes = new Map<string, Set<string>>();
  static readonly CLAIM_TTL_MS = 20_000;
  constructor(private readonly prisma: PrismaService, private readonly access: TenantAccessService, @Optional() private readonly activity?: ActivityService) {}

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
    void this.activity?.record(user, buildingId, 'INCIDENT_STARTED', `Phát báo cháy (${incident.nodeIds.length} vị trí)${incident.message ? `: ${incident.message}` : ''}`, { nodeIds: incident.nodeIds, floorIds: incident.floorIds });
    return incident;
  }

  async clear(user: AuthUser, buildingId: string) {
    await this.access.building(user, buildingId);
    const was = this.incidents.get(buildingId);
    const evacuees = this.evacuees(buildingId);
    this.incidents.delete(buildingId);
    this.claims.delete(buildingId);
    if (was) {
      const seconds = Math.max(0, Math.round((Date.now() - new Date(was.startedAt).getTime()) / 1000));
      void this.activity?.record(user, buildingId, 'INCIDENT_ENDED', `Kết thúc báo cháy sau ${Math.floor(seconds / 60)} phút ${seconds % 60} giây`, { durationSeconds: seconds, evacuees, startedAt: was.startedAt });
    }
    return { active: false as const };
  }

  async state(user: AuthUser, buildingId: string) {
    await this.access.building(user, buildingId);
    const incident = this.read(buildingId);
    return incident.active ? { ...incident, evacuees: this.evacuees(buildingId), exits: this.loads(buildingId) } : incident;
  }

  private live(buildingId: string) {
    const map = this.claims.get(buildingId);
    if (!map) return [];
    const now = Date.now();
    for (const [device, claim] of map) if (now - claim.at > IncidentsService.CLAIM_TTL_MS) map.delete(device);
    return [...map.entries()];
  }

  /** Number of phones currently evacuating. */
  evacuees(buildingId: string) { return this.live(buildingId).length; }

  /** People per exit, not counting `exceptDevice` (a phone asks how crowded the exits are for everyone else). */
  loads(buildingId: string, exceptDevice?: string) {
    const loads: Record<string, number> = {};
    for (const [device, claim] of this.live(buildingId)) if (device !== exceptDevice) loads[claim.exitNodeId] = (loads[claim.exitNodeId] ?? 0) + 1;
    return loads;
  }

  async publicLoads(buildingId: string, deviceId?: string) {
    const state = await this.publicState(buildingId);
    return { active: state.active, loads: state.active ? this.loads(buildingId, deviceId) : {} };
  }

  /** A phone says which exit it is walking to; returns how crowded the other exits are. Ignored when there is no incident. */
  async claim(buildingId: string, deviceId: string, exitNodeId: string) {
    const state = await this.publicState(buildingId);
    if (!state.active) return { active: false as const, loads: {} };
    let known = this.knownNodes.get(buildingId);
    if (!known?.has(exitNodeId)) {
      const exists = await this.prisma.node.count({ where: { id: exitNodeId, deletedAt: null, floor: { buildingId, deletedAt: null } } });
      if (!exists) throw new BadRequestException({ code: 'EXIT_NODE_INVALID', message: 'Exit does not belong to this building' });
      known = known ?? new Set();
      known.add(exitNodeId);
      this.knownNodes.set(buildingId, known);
    }
    let map = this.claims.get(buildingId);
    if (!map) this.claims.set(buildingId, (map = new Map()));
    if (map.size >= 5000 && !map.has(deviceId)) this.live(buildingId);
    map.set(deviceId, { exitNodeId, at: Date.now() });
    return { active: true as const, loads: this.loads(buildingId, deviceId) };
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
