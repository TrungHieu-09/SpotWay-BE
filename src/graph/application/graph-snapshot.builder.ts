import { Injectable } from '@nestjs/common';
import { EdgeStatus, FloorPublishStatus, PoiCategory } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { GraphSnapshot, SnapshotFloor } from '../domain/graph.types';
import { assembleSnapshot } from '../domain/snapshot-assembler';

@Injectable()
export class GraphSnapshotBuilder {
  constructor(private readonly prisma: PrismaService) {}

  /** The published floors of a building with their graph versions: the cheap probe that tells whether a cached snapshot is current. */
  async publishedFloors(buildingId: string): Promise<SnapshotFloor[]> {
    const rows = await this.prisma.floor.findMany({ where: { buildingId, publishStatus: FloorPublishStatus.PUBLISHED, deletedAt: null }, select: { id: true, floorNumber: true, metersPerPixel: true, graphVersion: true } });
    return rows;
  }

  /** Loads the whole building graph in one batch of queries. `floors` must come from publishedFloors() read just before, so the data is at least as new as its key. */
  async build(buildingId: string, floors: SnapshotFloor[]): Promise<GraphSnapshot> {
    const floorIds = floors.map((floor) => floor.id);
    if (!floorIds.length) return assembleSnapshot({ buildingId, floors, nodes: [], edges: [], connectors: [], legacyLinks: [], exitPoiNodeIds: [] });
    const [nodes, edges, connectors, legacyLinks, exitPois] = await this.prisma.$transaction([
      this.prisma.node.findMany({ where: { floorId: { in: floorIds }, deletedAt: null }, select: { id: true, floorId: true, x: true, y: true, type: true } }),
      this.prisma.edge.findMany({ where: { floorId: { in: floorIds }, deletedAt: null, status: EdgeStatus.ACTIVE }, select: { fromNodeId: true, toNodeId: true, weightMeters: true, accessible: true } }),
      this.prisma.connector.findMany({ where: { buildingId, deletedAt: null }, select: { id: true, kind: true, accessible: true, stops: { select: { floorId: true, nodeId: true } } } }),
      this.prisma.elevatorLink.findMany({ where: { buildingId, deletedAt: null }, select: { nodeIdFrom: true, nodeIdTo: true } }),
      this.prisma.poi.findMany({ where: { floorId: { in: floorIds }, deletedAt: null, category: PoiCategory.EXIT }, select: { nodeId: true } }),
    ]);
    return assembleSnapshot({ buildingId, floors, nodes, edges, connectors, legacyLinks, exitPoiNodeIds: exitPois.map((poi) => poi.nodeId) });
  }
}
