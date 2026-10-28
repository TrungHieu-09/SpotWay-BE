import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AuthUser } from '../../common/auth.types';
import { TenantAccessService } from '../../common/tenant-access.service';
import { PrismaService } from '../../database/prisma.service';
import { pixelDistance } from '../domain/coordinate-transform';
import { ApplyNavigationDraftV2Dto, NavigationDraftApplyV2Response } from '../dto/draft-apply-v2.dto';
import { assertInsideMap, bumpGraphVersion, dependencyConflict, loadFloor, lockFloor, nodeDependencyCounts, scaled, versionConflict } from './graph-support';

type StoredResult = Omit<NavigationDraftApplyV2Response, 'replayed'>;
const bad = (code: string, message: string, extra: Record<string, unknown> = {}) => new BadRequestException({ code, message, ...extra });

@Injectable()
export class DraftApplyService {
  constructor(private readonly prisma: PrismaService, private readonly access: TenantAccessService) {}

  /**
   * Applies the manager-confirmed subgraph with two bulk inserts. The floor row is locked first, so concurrent applies of the
   * same draft serialise and the loser replays the stored result. Weights are always recomputed from node coordinates.
   */
  async apply(user: AuthUser, floorId: string, dto: ApplyNavigationDraftV2Dto): Promise<NavigationDraftApplyV2Response> {
    const floor = await loadFloor(this.prisma, this.access, user, floorId);
    const mode = dto.mode ?? 'APPEND';
    const replay = await this.stored(floorId, dto.draftId);
    if (replay) return replay;
    const { nodes, edges } = this.validate(floor, dto);

    return this.prisma.$transaction(async (tx) => {
      const current = await lockFloor(tx, floorId);
      const raced = await tx.graphDraftApplication.findUnique({ where: { floorId_draftId: { floorId, draftId: dto.draftId } } });
      if (raced) return { ...(raced.result as StoredResult), replayed: true };
      if (dto.expectedGraphVersion !== undefined && dto.expectedGraphVersion !== current) throw versionConflict(floorId, dto.expectedGraphVersion, current);

      let nodesRemoved = 0;
      if (mode === 'REPLACE') {
        const existing = (await tx.node.findMany({ where: { floorId, deletedAt: null }, select: { id: true } })).map(({ id }) => id);
        if (existing.length) {
          const counts = await nodeDependencyCounts(tx, existing);
          if (counts.total) throw dependencyConflict(counts);
          const now = new Date();
          await tx.edge.updateMany({ where: { floorId, deletedAt: null }, data: { deletedAt: now } });
          await tx.elevatorLink.updateMany({ where: { deletedAt: null, OR: [{ nodeIdFrom: { in: existing } }, { nodeIdTo: { in: existing } }] }, data: { deletedAt: now } });
          nodesRemoved = (await tx.node.updateMany({ where: { floorId, deletedAt: null }, data: { deletedAt: now } })).count;
        }
      }

      const { metersPerPixel } = await tx.floor.findUniqueOrThrow({ where: { id: floorId }, select: { metersPerPixel: true } });
      const nodeIds: Record<string, string> = {};
      const byDraftId = new Map(nodes.map((node) => [node.id, node]));
      for (const node of nodes) nodeIds[node.id] = randomUUID();
      await tx.node.createMany({ data: nodes.map((node) => ({ id: nodeIds[node.id], floorId, tenantId: floor.tenantId, x: node.x, y: node.y, name: node.name?.trim() || null, type: node.type, accessible: node.accessible ?? true })) });

      const edgeIds: Record<string, string> = {};
      const edgeRows = edges.map((edge) => {
        const weight = pixelDistance(byDraftId.get(edge.fromNodeId)!, byDraftId.get(edge.toNodeId)!);
        const fromNodeId = nodeIds[edge.fromNodeId];
        const toNodeId = nodeIds[edge.toNodeId];
        edgeIds[edge.id] = randomUUID();
        return { id: edgeIds[edge.id], tenantId: floor.tenantId, floorId, fromNodeId, toNodeId, nodeLowId: fromNodeId < toNodeId ? fromNodeId : toNodeId, nodeHighId: fromNodeId < toNodeId ? toNodeId : fromNodeId, weight, weightMeters: scaled(weight, metersPerPixel), accessible: edge.accessible ?? true };
      });
      if (edgeRows.length) await tx.edge.createMany({ data: edgeRows });

      const graphVersion = await bumpGraphVersion(tx, floorId);
      const result: StoredResult = { nodesCreated: nodes.length, edgesCreated: edgeRows.length, nodesRemoved, nodeIds, edgeIds, graphVersion };
      await tx.graphDraftApplication.create({ data: { floorId, draftId: dto.draftId, result } });
      return { ...result, replayed: false };
    }, { timeout: 20_000 });
  }

  private async stored(floorId: string, draftId: string): Promise<NavigationDraftApplyV2Response | null> {
    const found = await this.prisma.graphDraftApplication.findUnique({ where: { floorId_draftId: { floorId, draftId } } });
    return found ? { ...(found.result as StoredResult), replayed: true } : null;
  }

  /** Rejects instead of silently skipping so UI bugs stay visible. */
  private validate(floor: { mapWidth: number | null; mapHeight: number | null }, dto: ApplyNavigationDraftV2Dto) {
    const nodes = dto.nodes.filter((node) => node.confirmed !== false);
    if (!nodes.length) throw bad('NAVIGATION_DRAFT_EMPTY', 'Confirm at least one suggested node before applying the draft');
    if (new Set(nodes.map((node) => node.id)).size !== nodes.length) throw bad('DRAFT_DUPLICATE_NODE', 'Draft node ids must be unique');
    nodes.forEach((node) => assertInsideMap(floor, node.x, node.y));
    const accepted = new Set(nodes.map((node) => node.id));
    const edges = dto.edges.filter((edge) => edge.confirmed !== false);
    const seenIds = new Set<string>();
    const seenPairs = new Set<string>();
    for (const edge of edges) {
      if (!accepted.has(edge.fromNodeId) || !accepted.has(edge.toNodeId)) throw bad('DRAFT_EDGE_ENDPOINT_MISSING', 'Every applied edge must connect two confirmed nodes', { edgeId: edge.id });
      if (edge.fromNodeId === edge.toNodeId) throw bad('DRAFT_EDGE_SELF_LOOP', 'An edge cannot connect a node to itself', { edgeId: edge.id });
      const pair = [edge.fromNodeId, edge.toNodeId].sort().join('\u0000');
      if (seenIds.has(edge.id) || seenPairs.has(pair)) throw bad('DRAFT_DUPLICATE_EDGE', 'Draft edges must be unique', { edgeId: edge.id });
      seenIds.add(edge.id);
      seenPairs.add(pair);
    }
    return { nodes, edges };
  }
}
