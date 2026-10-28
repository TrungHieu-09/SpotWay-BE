import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthUser } from '../../common/auth.types';
import { TenantAccessService } from '../../common/tenant-access.service';
import { PrismaService } from '../../database/prisma.service';
import { GRAPH_ERROR_CODES } from '../domain/graph.types';

export type Tx = Prisma.TransactionClient;
export type MapBounds = { mapWidth: number | null; mapHeight: number | null };

/** Floor the user may edit, or a 404/403. */
export async function loadFloor(prisma: PrismaService, access: TenantAccessService, user: AuthUser, floorId: string) {
  const floor = await prisma.floor.findFirst({ where: { id: floorId, deletedAt: null } });
  if (!floor) throw new NotFoundException({ code: 'FLOOR_NOT_FOUND', message: 'Floor not found' });
  await access.building(user, floor.buildingId);
  return floor;
}

export function assertInsideMap(floor: MapBounds, x: number, y: number) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || (floor.mapWidth !== null && x > floor.mapWidth) || (floor.mapHeight !== null && y > floor.mapHeight)) throw new BadRequestException({ code: 'INVALID_NODE_COORDINATES', message: 'Node coordinates are outside the floor map bounds' });
}

export function versionConflict(floorId: string, expected: number, actual: number) {
  return new ConflictException({ code: GRAPH_ERROR_CODES.GRAPH_VERSION_CONFLICT, message: 'The floor graph changed since it was loaded; reload and retry', floorId, expectedGraphVersion: expected, graphVersion: actual });
}

/** Locks the floor row for the rest of the transaction and returns its current graph version. Serialises concurrent graph writers. */
export async function lockFloor(tx: Tx, floorId: string): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ graph_version: number }>>`SELECT "graph_version" FROM "floors" WHERE "id" = ${floorId} FOR UPDATE`;
  if (!rows.length) throw new NotFoundException({ code: 'FLOOR_NOT_FOUND', message: 'Floor not found' });
  return rows[0].graph_version;
}

/**
 * Increments Floor.graphVersion; with `expected` it only succeeds when the version still matches (optimistic concurrency).
 * Returns the new version. Call it in the same transaction as the mutation so caches never see a half-applied change.
 */
export async function bumpGraphVersion(tx: Tx, floorId: string, expected?: number): Promise<number> {
  if (expected === undefined) return (await tx.floor.update({ where: { id: floorId }, data: { graphVersion: { increment: 1 } }, select: { graphVersion: true } })).graphVersion;
  const result = await tx.floor.updateMany({ where: { id: floorId, graphVersion: expected }, data: { graphVersion: { increment: 1 } } });
  if (result.count !== 1) {
    const current = await tx.floor.findUnique({ where: { id: floorId }, select: { graphVersion: true } });
    throw versionConflict(floorId, expected, current?.graphVersion ?? -1);
  }
  return expected + 1;
}

/**
 * Recomputes weight (pixels, legacy) and weight_meters (null while the floor is uncalibrated) of every live edge on the floor,
 * or only of the edges touching `nodeId`. One statement, so a moved node can never leave a stale weight behind.
 */
export async function recomputeEdgeWeights(tx: Tx, floorId: string, metersPerPixel: number | null, nodeId?: string): Promise<number> {
  const scope = nodeId ? Prisma.sql`AND (e."from_node_id" = ${nodeId} OR e."to_node_id" = ${nodeId})` : Prisma.empty;
  return tx.$executeRaw`
    UPDATE "edges" e
    SET "weight" = sqrt(power(f."x" - t."x", 2) + power(f."y" - t."y", 2)),
        "weight_meters" = CASE WHEN ${metersPerPixel}::double precision IS NULL THEN NULL ELSE sqrt(power(f."x" - t."x", 2) + power(f."y" - t."y", 2)) * ${metersPerPixel}::double precision END,
        "updated_at" = now()
    FROM "nodes" f, "nodes" t
    WHERE e."from_node_id" = f."id" AND e."to_node_id" = t."id"
      AND e."floor_id" = ${floorId} AND e."deleted_at" IS NULL ${scope}`;
}

/** Live things that still point at a node; any non-zero count blocks deleting it. */
export async function nodeDependencyCounts(tx: Tx | PrismaService, nodeIds: string[]) {
  const [pois, stores, qrAnchors, connectorStops] = await Promise.all([
    tx.poi.count({ where: { nodeId: { in: nodeIds }, deletedAt: null } }),
    tx.store.count({ where: { nodeId: { in: nodeIds }, deletedAt: null } }),
    tx.qrAnchor.count({ where: { nodeId: { in: nodeIds }, deletedAt: null } }),
    tx.connectorStop.count({ where: { nodeId: { in: nodeIds } } }),
  ]);
  return { pois, stores, qrAnchors, connectorStops, total: pois + stores + qrAnchors + connectorStops };
}

export function dependencyConflict(counts: { pois: number; stores: number; qrAnchors: number; connectorStops: number }) {
  const { pois, stores, qrAnchors, connectorStops } = counts;
  return new ConflictException({ code: GRAPH_ERROR_CODES.NODE_HAS_DEPENDENCIES, message: 'Remove attached POIs, stores, QR anchors and connector stops before deleting this node', dependencies: { pois, stores, qrAnchors, connectorStops } });
}

export function scaled(pixels: number, metersPerPixel: number | null): number | null {
  return metersPerPixel === null ? null : pixels * metersPerPixel;
}
