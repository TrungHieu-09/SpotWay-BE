import { BadGatewayException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Floor, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { StorageService } from './storage.service';

type FloorPlanAnalysis = {
  engine: { name: string; model: string; version: string };
  image: { width: number; height: number };
  walls: unknown[];
  polygons?: Record<string, unknown>;
  openings: unknown[];
  labels: unknown[];
  symbols: unknown[];
  warnings: string[];
  needsReview: true;
};

@Injectable()
export class FloorplanIntelligenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async analyze(floor: Floor, createdById: string) {
    if (!floor.mapImageUrl) {
      throw new BadGatewayException({ code: 'FLOOR_PLAN_MISSING', message: 'Upload a floor-plan image before requesting analysis' });
    }
    const serviceUrl = process.env.FLOORPLAN_INTELLIGENCE_URL?.replace(/\/$/, '');
    if (!serviceUrl) {
      throw new ServiceUnavailableException({ code: 'FLOORPLAN_INTELLIGENCE_UNAVAILABLE', message: 'Floor-plan intelligence service is not configured' });
    }

    const imageUrl = await this.storage.createAnalysisReadUrl(floor.mapImageUrl);
    let response: Response;
    try {
      response = await fetch(`${serviceUrl}/v1/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ imageUrl, floorId: floor.id }),
        signal: AbortSignal.timeout(Number(process.env.FLOORPLAN_ANALYSIS_TIMEOUT_MS ?? 120000)),
      });
    } catch {
      throw new ServiceUnavailableException({ code: 'FLOORPLAN_INTELLIGENCE_UNAVAILABLE', message: 'Floor-plan intelligence service did not respond' });
    }

    const body = await response.json().catch(() => ({})) as { detail?: string } & Partial<FloorPlanAnalysis>;
    if (!response.ok) {
      throw new BadGatewayException({ code: 'FLOORPLAN_ANALYSIS_FAILED', message: body.detail || 'Floor-plan analysis failed' });
    }
    if ((!Array.isArray(body.walls) && !body.polygons) || !body.image?.width || !body.image?.height) {
      throw new BadGatewayException({ code: 'FLOORPLAN_ANALYSIS_INVALID', message: 'Floor-plan intelligence returned an invalid analysis draft' });
    }

    const latest = await this.prisma.floorMapRevision.findFirst({ where: { floorId: floor.id }, orderBy: { version: 'desc' }, select: { version: true } });
    return this.prisma.floorMapRevision.create({
      data: {
        floorId: floor.id,
        version: (latest?.version ?? 0) + 1,
        editorState: { ...body, needsReview: true } as Prisma.InputJsonValue,
        createdById,
      },
    });
  }

  async navigationDraft(floor: Floor) {
    if (!floor.mapImageUrl) {
      throw new BadGatewayException({ code: 'FLOOR_PLAN_MISSING', message: 'Upload a floor-plan image before requesting navigation analysis' });
    }
    const serviceUrl = process.env.FLOORPLAN_INTELLIGENCE_URL?.replace(/\/$/, '');
    if (!serviceUrl) {
      throw new ServiceUnavailableException({ code: 'FLOORPLAN_INTELLIGENCE_UNAVAILABLE', message: 'Floor-plan intelligence service is not configured' });
    }

    const imageUrl = await this.storage.createAnalysisReadUrl(floor.mapImageUrl);
    let response: Response;
    try {
      response = await fetch(`${serviceUrl}/v1/navigation-analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ imageUrl, floorId: floor.id }),
        signal: AbortSignal.timeout(Number(process.env.FLOORPLAN_ANALYSIS_TIMEOUT_MS ?? 120000)),
      });
    } catch {
      throw new ServiceUnavailableException({ code: 'FLOORPLAN_INTELLIGENCE_UNAVAILABLE', message: 'Navigation analysis service did not respond' });
    }
    const body = await response.json().catch(() => ({})) as { detail?: string; nodes?: unknown[]; edges?: unknown[] };
    if (!response.ok) {
      throw new BadGatewayException({ code: 'NAVIGATION_ANALYSIS_FAILED', message: body.detail || 'Navigation analysis failed' });
    }
    if (!Array.isArray(body.nodes) || !Array.isArray(body.edges)) {
      throw new BadGatewayException({ code: 'NAVIGATION_ANALYSIS_INVALID', message: 'Navigation analysis returned an invalid draft' });
    }
    const source = body as { image?: { width?: number; height?: number }; nodes: Array<Record<string, unknown>>; edges: unknown[] };
    const sourceWidth = source.image?.width || floor.mapWidth || 1;
    const sourceHeight = source.image?.height || floor.mapHeight || 1;
    const targetWidth = floor.mapWidth || sourceWidth;
    const targetHeight = floor.mapHeight || sourceHeight;
    // AI emits percentages so it is resolution-independent.  Map editor nodes
    // use map pixels; convert once at the boundary so draft and real nodes are
    // editable with exactly the same coordinate system.
    const nodes = source.nodes.map((node) => ({
      ...node,
      x: Number(node.x) / 100 * targetWidth,
      y: Number(node.y) / 100 * targetHeight,
      name: null,
    }));
    return { ...source, nodes, edges: source.edges };
  }

  latest(floorId: string) {
    return this.prisma.floorMapRevision.findFirst({ where: { floorId }, orderBy: { version: 'desc' } });
  }

  async saveRevision(floor: Floor, editorState: Prisma.InputJsonValue, createdById: string) {
    const latest = await this.prisma.floorMapRevision.findFirst({
      where: { floorId: floor.id },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    return this.prisma.floorMapRevision.create({
      data: {
        floorId: floor.id,
        version: (latest?.version ?? 0) + 1,
        editorState,
        createdById,
      },
    });
  }
}
