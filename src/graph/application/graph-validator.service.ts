import { BadRequestException, Injectable } from '@nestjs/common';
import { StoreStatus } from '@prisma/client';
import { AuthUser } from '../../common/auth.types';
import { TenantAccessService } from '../../common/tenant-access.service';
import { PrismaService } from '../../database/prisma.service';
import { validateFloorGraph } from '../domain/graph-validator';
import { GraphValidationReport } from '../dto/graph-validation.dto';
import { loadFloor } from './graph-support';

@Injectable()
export class GraphValidatorService {
  constructor(private readonly prisma: PrismaService, private readonly access: TenantAccessService) {}

  /** Read-only report for the editor ("is this floor ready to publish?"). */
  async validate(user: AuthUser, floorId: string): Promise<GraphValidationReport> {
    await loadFloor(this.prisma, this.access, user, floorId);
    return this.report(floorId);
  }

  /** Throws 400 listing every issue when the floor has an ERROR. The first error's code becomes the response code. */
  async assertFloorCanPublish(floorId: string): Promise<GraphValidationReport> {
    const report = await this.report(floorId);
    if (!report.valid) {
      const errors = report.issues.filter((issue) => issue.severity === 'ERROR');
      throw new BadRequestException({ code: errors[0].code, message: `The floor cannot be published: ${errors.map((issue) => issue.message).join('; ')}`, issues: report.issues, ...(errors[0].ids ? { nodeIds: errors[0].ids } : {}) });
    }
    return report;
  }

  async report(floorId: string): Promise<GraphValidationReport> {
    const floor = await this.prisma.floor.findFirstOrThrow({ where: { id: floorId, deletedAt: null }, select: { id: true, metersPerPixel: true, graphVersion: true } });
    const [nodes, edges, stores, pois, qrAnchors, connectors, links] = await this.prisma.$transaction([
      this.prisma.node.findMany({ where: { floorId, deletedAt: null }, select: { id: true, x: true, y: true, type: true } }),
      this.prisma.edge.findMany({ where: { floorId, deletedAt: null }, select: { id: true, fromNodeId: true, toNodeId: true, weightMeters: true } }),
      this.prisma.store.findMany({ where: { floorId, deletedAt: null, status: StoreStatus.ACTIVE }, select: { id: true, nodeId: true } }),
      this.prisma.poi.findMany({ where: { floorId, deletedAt: null }, select: { id: true, nodeId: true, category: true } }),
      this.prisma.qrAnchor.findMany({ where: { floorId, deletedAt: null }, select: { id: true, nodeId: true } }),
      this.prisma.connector.findMany({ where: { deletedAt: null, stops: { some: { floorId } } }, select: { id: true, kind: true, stops: { select: { floorId: true, nodeId: true } } } }),
      this.prisma.elevatorLink.findMany({ where: { deletedAt: null, OR: [{ fromNode: { floorId } }, { toNode: { floorId } }] }, select: { nodeIdFrom: true, nodeIdTo: true } }),
    ]);
    const issues = validateFloorGraph({
      metersPerPixel: floor.metersPerPixel,
      nodes, edges, stores, pois, qrAnchors,
      connectors: connectors.map((connector) => ({ id: connector.id, kind: connector.kind, stopFloorIds: connector.stops.map((stop) => stop.floorId), floorNodeIds: connector.stops.filter((stop) => stop.floorId === floorId).map((stop) => stop.nodeId) })),
      legacyLinkedNodeIds: links.flatMap((link) => [link.nodeIdFrom, link.nodeIdTo]),
    });
    return { floorId, graphVersion: floor.graphVersion, valid: !issues.some((issue) => issue.severity === 'ERROR'), issues };
  }
}
