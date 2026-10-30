import { BadRequestException, Injectable } from '@nestjs/common';
import { EdgeStatus } from '@prisma/client';
import { AuthUser } from '../../common/auth.types';
import { TenantAccessService } from '../../common/tenant-access.service';
import { PrismaService } from '../../database/prisma.service';
import { MaintenanceReport, MaintenanceSelectionDto } from '../dto/maintenance.dto';
import { bumpGraphVersion, loadFloor, lockFloor } from './graph-support';

const invalid = (message: string) => new BadRequestException({ code: 'INVALID_MAINTENANCE_SELECTION', message });

/**
 * Maintenance zones: blocking edges (or every edge around a node) makes routing avoid them. The route engine only walks ACTIVE
 * edges, and the floor's graphVersion is bumped so cached snapshots are rebuilt on the next request.
 */
@Injectable()
export class MaintenanceService {
  constructor(private readonly prisma: PrismaService, private readonly access: TenantAccessService) {}

  async report(user: AuthUser, floorId: string): Promise<MaintenanceReport> {
    const floor = await loadFloor(this.prisma, this.access, user, floorId);
    return this.build(floorId, floor.graphVersion);
  }

  block(user: AuthUser, floorId: string, dto: MaintenanceSelectionDto) { return this.setStatus(user, floorId, dto, EdgeStatus.BLOCKED); }
  unblock(user: AuthUser, floorId: string, dto: MaintenanceSelectionDto) { return this.setStatus(user, floorId, dto, EdgeStatus.ACTIVE); }

  private async setStatus(user: AuthUser, floorId: string, dto: MaintenanceSelectionDto, status: EdgeStatus): Promise<MaintenanceReport> {
    await loadFloor(this.prisma, this.access, user, floorId);
    const nodeIds = [...new Set(dto.nodeIds ?? [])];
    const edgeIds = [...new Set(dto.edgeIds ?? [])];
    if (!nodeIds.length && !edgeIds.length) throw invalid('Provide at least one node id or edge id');
    return this.prisma.$transaction(async (tx) => {
      await lockFloor(tx, floorId);
      if (nodeIds.length && (await tx.node.count({ where: { id: { in: nodeIds }, floorId, deletedAt: null } })) !== nodeIds.length) throw invalid('Every node must exist on this floor');
      if (edgeIds.length && (await tx.edge.count({ where: { id: { in: edgeIds }, floorId, deletedAt: null } })) !== edgeIds.length) throw invalid('Every edge must exist on this floor');
      const graphVersion = await bumpGraphVersion(tx, floorId, dto.expectedGraphVersion);
      const touching = [...(edgeIds.length ? [{ id: { in: edgeIds } }] : []), ...(nodeIds.length ? [{ fromNodeId: { in: nodeIds } }, { toNodeId: { in: nodeIds } }] : [])];
      const changed = await tx.edge.updateMany({ where: { floorId, deletedAt: null, status: { not: status }, OR: touching }, data: { status } });
      return { ...(await this.build(floorId, graphVersion, tx)), changedEdges: changed.count };
    });
  }

  private async build(floorId: string, graphVersion: number, db: Pick<PrismaService, 'edge'> = this.prisma): Promise<MaintenanceReport> {
    const edges = await db.edge.findMany({ where: { floorId, deletedAt: null }, select: { id: true, fromNodeId: true, toNodeId: true, status: true } });
    const open = new Set<string>();
    const touched = new Set<string>();
    for (const edge of edges) {
      for (const id of [edge.fromNodeId, edge.toNodeId]) { touched.add(id); if (edge.status === EdgeStatus.ACTIVE) open.add(id); }
    }
    return {
      floorId, graphVersion,
      blockedEdges: edges.filter((edge) => edge.status === EdgeStatus.BLOCKED).map(({ id, fromNodeId, toNodeId }) => ({ id, fromNodeId, toNodeId })),
      blockedNodeIds: [...touched].filter((id) => !open.has(id)),
    };
  }
}
