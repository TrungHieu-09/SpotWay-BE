import { BadGatewayException, BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Floor, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { parseNavigationAnalysis } from './navigation-draft';
import { StorageService } from './storage.service';

const MAX_UPSTREAM_BYTES = 2 * 1024 * 1024;

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
  private readonly logger = new Logger(FloorplanIntelligenceService.name);
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
    if (!floor.mapWidth || !floor.mapHeight || floor.mapWidth <= 0 || floor.mapHeight <= 0) {
      throw new BadRequestException({ code: 'FLOOR_MAP_DIMENSIONS_REQUIRED', message: 'Set the floor map width and height before requesting navigation analysis' });
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
    // Cap the upstream payload before parsing; detail from a failed upstream call is logged, never returned.
    const raw = await response.text().catch(() => '');
    if (raw.length > MAX_UPSTREAM_BYTES) {
      throw new BadGatewayException({ code: 'NAVIGATION_ANALYSIS_INVALID', message: 'Navigation analysis returned an invalid draft' });
    }
    let body: unknown;
    try { body = JSON.parse(raw); } catch { body = undefined; }
    if (!response.ok) {
      this.logger.warn(`navigation-analyze failed for floor ${floor.id}: HTTP ${response.status}`);
      throw new BadGatewayException({ code: 'NAVIGATION_ANALYSIS_FAILED', message: 'Navigation analysis failed' });
    }
    return parseNavigationAnalysis(body, floor);
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
