import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { FloorplanIntelligenceService } from './floorplan-intelligence.service';

const floor = { id: 'floor-1', mapImageUrl: 'https://cdn/plan.png', mapWidth: 1000, mapHeight: 500 } as any;
const upstream = (status: number, payload: unknown) =>
  jest.fn().mockResolvedValue({ ok: status < 400, status, text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)) });

describe('FloorplanIntelligenceService.navigationDraft', () => {
  const service = new FloorplanIntelligenceService({} as any, { createAnalysisReadUrl: jest.fn().mockResolvedValue('https://signed/plan.png') } as any);
  const originalFetch = global.fetch;
  beforeEach(() => { process.env.FLOORPLAN_INTELLIGENCE_URL = 'http://ai.local/'; });
  afterEach(() => { global.fetch = originalFetch; });
  const codeOf = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { return (error as any).getResponse(); } };

  it('refuses to call the AI service when the floor has no map dimensions', async () => {
    global.fetch = jest.fn() as any;
    const response = await codeOf(service.navigationDraft({ ...floor, mapWidth: null }));
    expect(response.code).toBe('FLOOR_MAP_DIMENSIONS_REQUIRED');
    expect(global.fetch).not.toHaveBeenCalled();
    await expect(service.navigationDraft({ ...floor, mapHeight: 0 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns a validated pixel draft for a valid AI response', async () => {
    global.fetch = upstream(200, { schemaVersion: 1, coordinateSpace: 'PERCENT_0_100', image: { width: 10, height: 10 }, nodes: [{ id: 'n', x: 50, y: 50, type: 'NORMAL', accessible: true, confidence: 0.85 }], edges: [], warnings: [] }) as any;
    const draft = await service.navigationDraft(floor);
    expect(draft.nodes[0]).toMatchObject({ x: 500, y: 250 });
    expect(draft.coordinateSpace).toBe('PIXEL');
  });

  it('never leaks upstream error detail', async () => {
    global.fetch = upstream(500, { detail: 'Traceback: /srv/secret/path' }) as any;
    const response = await codeOf(service.navigationDraft(floor));
    expect(response.code).toBe('NAVIGATION_ANALYSIS_FAILED');
    expect(JSON.stringify(response)).not.toContain('secret');
  });

  it('maps malformed or oversized upstream bodies to NAVIGATION_ANALYSIS_INVALID', async () => {
    for (const payload of ['not json', 'x'.repeat(2 * 1024 * 1024 + 1), { nodes: [], edges: [] }]) {
      global.fetch = upstream(200, payload) as any;
      const error = await service.navigationDraft(floor).catch((reason) => reason);
      expect(error).toBeInstanceOf(BadGatewayException);
      expect(error.getResponse().code).toBe('NAVIGATION_ANALYSIS_INVALID');
    }
  });
});
