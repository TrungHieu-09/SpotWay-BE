import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { BuildingStatus, TenantStatus } from '@prisma/client';
import { AuthUser } from '../common/auth.types';
import { TenantAccessService } from '../common/tenant-access.service';
import { PrismaService } from '../database/prisma.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { ActivityService } from '../analytics/activity.service';

export type Announcement = { id: number; text: string; at: string };
export type Zone = { nodeId: string; name: string };
export type OperationsState = { elevator: boolean; power: boolean; zone: Zone | null; announcement: Announcement | null; updatedAt: string | null };
export type OperationsPatch = { elevator?: boolean; power?: boolean; zoneNodeId?: string | null; zoneName?: string; announcement?: string | null };

const EMPTY: OperationsState = { elevator: false, power: false, zone: null, announcement: null, updatedAt: null };

/**
 * What the manager of a building has declared right now: lifts out of order, power cut, a closed zone, a notice for the guests.
 * Kept per building and in memory on purpose, like an incident: it is a live situation, and a restart must never bring an old closure back.
 * The guest app of that building polls it; nothing here is shared between buildings.
 */
@Injectable()
export class OperationsService {
  private readonly states = new Map<string, OperationsState>();
  private seq = 0;
  constructor(private readonly prisma: PrismaService, private readonly access: TenantAccessService, private readonly analytics: AnalyticsService, @Optional() private readonly activity?: ActivityService) {}

  private read(buildingId: string): OperationsState {
    return this.states.get(buildingId) ?? EMPTY;
  }

  async state(user: AuthUser, buildingId: string) {
    await this.access.building(user, buildingId);
    return this.read(buildingId);
  }

  async update(user: AuthUser, buildingId: string, patch: OperationsPatch) {
    await this.access.building(user, buildingId);
    const before = this.read(buildingId);
    const next: OperationsState = { ...before };
    if (patch.elevator !== undefined) next.elevator = patch.elevator;
    if (patch.power !== undefined) next.power = patch.power;
    if (patch.zoneNodeId !== undefined) {
      if (patch.zoneNodeId === null) next.zone = null;
      else {
        const node = await this.prisma.node.findFirst({ where: { id: patch.zoneNodeId, deletedAt: null, floor: { is: { buildingId, deletedAt: null } } }, select: { id: true, name: true } });
        if (!node) throw new BadRequestException({ code: 'NODE_NOT_IN_BUILDING', message: 'The chosen place does not belong to this building' });
        next.zone = { nodeId: node.id, name: (patch.zoneName?.trim() || node.name || 'Khu vực').slice(0, 80) };
      }
    }
    if (patch.announcement !== undefined) {
      const text = patch.announcement?.trim();
      next.announcement = text ? { id: ++this.seq, text: text.slice(0, 300), at: new Date().toISOString() } : null;
    }
    next.updatedAt = new Date().toISOString();
    const notes: string[] = [];
    if (next.elevator !== before.elevator) notes.push(next.elevator ? 'báo thang máy ngừng hoạt động' : 'thang máy hoạt động lại');
    if (next.power !== before.power) notes.push(next.power ? 'báo cúp điện' : 'có điện trở lại');
    if (next.zone?.nodeId !== before.zone?.nodeId) notes.push(next.zone ? `đóng khu vực ${next.zone.name}` : `mở lại khu vực ${before.zone?.name ?? ''}`.trim());
    if (next.announcement?.text !== before.announcement?.text) notes.push(next.announcement ? `thông báo: ${next.announcement.text}` : 'gỡ thông báo');
    if (notes.length) void this.activity?.record(user, buildingId, 'OPERATIONS_CHANGED', notes.join('; ').replace(/^./, (c) => c.toUpperCase()));
    const quiet = !next.elevator && !next.power && !next.zone && !next.announcement;
    if (quiet) this.states.delete(buildingId);
    else this.states.set(buildingId, next);
    return quiet ? { ...EMPTY, updatedAt: next.updatedAt } : next;
  }

  async clear(user: AuthUser, buildingId: string) {
    await this.access.building(user, buildingId);
    const had = this.states.delete(buildingId);
    if (had) void this.activity?.record(user, buildingId, 'OPERATIONS_CLEARED', 'Đưa tòa nhà về trạng thái bình thường');
    return EMPTY;
  }

  /** What a guest of a publicly available building gets. An unavailable building has nothing to announce. */
  async publicState(buildingId: string) {
    const building = await this.prisma.building.findFirst({ where: { id: buildingId, deletedAt: null, status: BuildingStatus.ACTIVE, tenant: { is: { deletedAt: null, archived: false, status: TenantStatus.ACTIVE } } }, select: { id: true } });
    return building ? this.read(buildingId) : EMPTY;
  }

  /** The who-did-what log of the building (newest first); `prefix` keeps one family such as INCIDENT. */
  async activityLog(user: AuthUser, buildingId: string, limit = 50, prefix?: string) {
    await this.access.building(user, buildingId);
    return this.activity ? this.activity.list(buildingId, limit, prefix) : [];
  }

  /** Help requests sent from the guest app in the last `minutes`, newest first, with where the guest stood. */
  async helpRequests(user: AuthUser, buildingId: string, minutes = 30) {
    await this.access.building(user, buildingId);
    const rows = await this.analytics.recentHelp(buildingId, minutes);
    const ids = [...new Set(rows.map((r) => r.nodeId).filter((id): id is string => !!id))];
    const nodes = ids.length ? await this.prisma.node.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, floor: { select: { name: true } } } }) : [];
    const where = new Map(nodes.map((n) => [n.id, `${n.name ?? 'Vị trí'}${n.floor?.name ? ` · ${n.floor.name}` : ''}`]));
    return rows.map((r) => ({ id: r.id, kind: r.kind, at: r.at, place: r.nodeId ? where.get(r.nodeId) ?? null : null }));
  }
}
