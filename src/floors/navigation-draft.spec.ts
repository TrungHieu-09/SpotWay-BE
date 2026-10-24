import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { parseNavigationAnalysis } from './navigation-draft';

const floor = { mapWidth: 2000, mapHeight: 1000 };
const limits = { maxNodes: 5, maxEdges: 5 };

const node = (id: string, x: number, y: number, extra: Record<string, unknown> = {}) => ({
  id, x, y, name: null, type: 'NORMAL', accessible: true, confidence: 0.85, requiresConfirmation: true, ...extra,
});
const edge = (id: string, fromNodeId: string, toNodeId: string, extra: Record<string, unknown> = {}) => ({
  id, fromNodeId, toNodeId, weight: 10, accessible: true, confidence: 0.85, requiresConfirmation: true, ...extra,
});
const body = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  coordinateSpace: 'PERCENT_0_100',
  image: { width: 800, height: 400 },
  nodes: [node('a', 10, 20), node('b', 50, 60, { type: 'JUNCTION', source: 'SKELETON_JUNCTION' })],
  edges: [edge('e1', 'a', 'b')],
  warnings: ['DISCONNECTED_WALKABLE_AREAS: x'],
  diagnostics: { algorithm: 'medial-axis-v1' },
  ...overrides,
});

const code = (fn: () => unknown) => {
  try { fn(); } catch (error) { return (error as { getResponse(): { code: string } }).getResponse().code; }
  return undefined;
};

describe('parseNavigationAnalysis', () => {
  it('converts percent to map pixels exactly once and marks the space as PIXEL', () => {
    const draft = parseNavigationAnalysis(body(), floor, limits);
    expect(draft.coordinateSpace).toBe('PIXEL');
    expect(draft.image).toEqual({ width: 2000, height: 1000 });
    expect(draft.nodes[0]).toMatchObject({ id: 'a', x: 200, y: 200, name: null });
    expect(draft.nodes[1]).toMatchObject({ x: 1000, y: 600, type: 'JUNCTION', source: 'SKELETON_JUNCTION' });
    expect(draft.edges[0].weight).toBeCloseTo(Math.hypot(800, 400), 2);
    expect(draft.warnings).toEqual(['DISCONNECTED_WALKABLE_AREAS: x']);
    expect(draft.diagnostics).toEqual({ algorithm: 'medial-axis-v1' });
  });

  it('forces names to null and keeps requiresConfirmation default true', () => {
    const draft = parseNavigationAnalysis(body({ nodes: [node('a', 1, 1, { name: 'Zara', requiresConfirmation: undefined })], edges: [] }), floor, limits);
    expect(draft.nodes[0].name).toBeNull();
    expect(draft.nodes[0].requiresConfirmation).toBe(true);
  });

  it('accepts an empty graph with warnings', () => {
    const draft = parseNavigationAnalysis(body({ nodes: [], edges: [], warnings: ['NO_WALKABLE_AREA'] }), floor, limits);
    expect(draft.nodes).toEqual([]);
    expect(draft.warnings).toEqual(['NO_WALKABLE_AREA']);
  });

  it('requires floor map dimensions instead of silently falling back', () => {
    expect(code(() => parseNavigationAnalysis(body(), { mapWidth: null, mapHeight: 100 }, limits))).toBe('FLOOR_MAP_DIMENSIONS_REQUIRED');
    expect(() => parseNavigationAnalysis(body(), { mapWidth: 0, mapHeight: 100 }, limits)).toThrow(BadRequestException);
  });

  it.each<[string, Record<string, unknown>]>([
    ['wrong schema version', { schemaVersion: 2 }],
    ['wrong coordinate space', { coordinateSpace: 'PIXEL' }],
    ['non-array nodes', { nodes: 'x' }],
    ['percent above 100', { nodes: [node('a', 101, 0)] }],
    ['negative percent', { nodes: [node('a', 0, -1)] }],
    ['NaN coordinate', { nodes: [node('a', Number.NaN, 0)] }],
    ['Infinity coordinate', { nodes: [node('a', 0, Number.POSITIVE_INFINITY)] }],
    ['string coordinate', { nodes: [node('a', '5' as unknown as number, 0)] }],
    ['confidence above 1', { nodes: [node('a', 1, 1, { confidence: 1.2 })] }],
    ['confidence NaN', { nodes: [node('a', 1, 1, { confidence: Number.NaN })] }],
    ['unknown node type', { nodes: [node('a', 1, 1, { type: 'PORTAL' })] }],
    ['accessible not boolean', { nodes: [node('a', 1, 1, { accessible: 'yes' })] }],
    ['empty id', { nodes: [node('', 1, 1)] }],
    ['duplicate node ids', { nodes: [node('a', 1, 1), node('a', 2, 2)], edges: [] }],
    ['edge to unknown node', { edges: [edge('e1', 'a', 'zzz')] }],
    ['self-loop edge', { edges: [edge('e1', 'a', 'a')] }],
    ['duplicate undirected edge', { edges: [edge('e1', 'a', 'b'), edge('e2', 'b', 'a')] }],
    ['duplicate edge ids', { nodes: [node('a', 1, 1), node('b', 2, 2), node('c', 3, 3)], edges: [edge('e1', 'a', 'b'), edge('e1', 'b', 'c')] }],
    ['too many nodes', { nodes: Array.from({ length: 6 }, (_, i) => node(`n${i}`, i, i)), edges: [] }],
    ['too many edges', { edges: Array.from({ length: 6 }, (_, i) => edge(`e${i}`, 'a', 'b')) }],
    ['missing image', { image: undefined }],
    ['non-positive image size', { image: { width: 0, height: 10 } }],
    ['name too long', { nodes: [node('a', 1, 1, { name: 'x'.repeat(101) })] }],
  ])('rejects %s with a generic NAVIGATION_ANALYSIS_INVALID', (_label, overrides) => {
    const run = () => parseNavigationAnalysis(body(overrides), floor, limits);
    expect(run).toThrow(BadGatewayException);
    expect(code(run)).toBe('NAVIGATION_ANALYSIS_INVALID');
  });

  it('rejects non-object bodies and never echoes upstream detail', () => {
    for (const bad of [undefined, null, 'oops', [], 42]) expect(code(() => parseNavigationAnalysis(bad, floor, limits))).toBe('NAVIGATION_ANALYSIS_INVALID');
    try { parseNavigationAnalysis({ detail: 'secret stack trace' }, floor, limits); } catch (error) {
      expect(JSON.stringify((error as BadGatewayException).getResponse())).not.toContain('secret');
    }
  });

  it('drops oversized diagnostics and truncates warnings', () => {
    const draft = parseNavigationAnalysis(body({ diagnostics: { blob: 'x'.repeat(5000) }, warnings: Array.from({ length: 50 }, () => 'w'.repeat(500)) }), floor, limits);
    expect(draft.diagnostics).toBeUndefined();
    expect(draft.warnings).toHaveLength(20);
    expect(draft.warnings[0]).toHaveLength(300);
  });
});
