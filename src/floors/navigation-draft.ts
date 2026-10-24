import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { NodeType } from '@prisma/client';

export const NAVIGATION_DRAFT_SCHEMA_VERSION = 1;

export type NavigationDraftNodeView = {
  id: string;
  x: number;
  y: number;
  name: string | null;
  type: NodeType;
  accessible: boolean;
  confidence: number;
  requiresConfirmation: boolean;
  source?: string;
};

export type NavigationDraftEdgeView = {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  weight: number;
  accessible: boolean;
  confidence: number;
  requiresConfirmation: boolean;
  source?: string;
};

export type NavigationDraftView = {
  schemaVersion: 1;
  coordinateSpace: 'PIXEL';
  image: { width: number; height: number };
  nodes: NavigationDraftNodeView[];
  edges: NavigationDraftEdgeView[];
  warnings: string[];
  diagnostics?: Record<string, unknown>;
};

export type NavigationDraftLimits = { maxNodes: number; maxEdges: number };

const MAX_WARNINGS = 20;
const MAX_TEXT = 300;
const MAX_ID = 100;
const MAX_DIAGNOSTICS_BYTES = 4096;

export function navigationDraftLimits(): NavigationDraftLimits {
  const read = (name: string, fallback: number) => {
    const value = Number(process.env[name]);
    return Number.isInteger(value) && value > 0 ? value : fallback;
  };
  return { maxNodes: read('NAVIGATION_DRAFT_MAX_NODES', 300), maxEdges: read('NAVIGATION_DRAFT_MAX_EDGES', 500) };
}

class InvalidAnalysis extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const round2 = (value: number) => Math.round(value * 100) / 100;

function ensure(condition: boolean): asserts condition {
  if (!condition) throw new InvalidAnalysis();
}

function toNode(raw: unknown, width: number, height: number): NavigationDraftNodeView {
  ensure(isRecord(raw));
  ensure(text(raw.id, MAX_ID));
  ensure(finite(raw.x) && raw.x >= 0 && raw.x <= 100);
  ensure(finite(raw.y) && raw.y >= 0 && raw.y <= 100);
  ensure(typeof raw.type === 'string' && (Object.values(NodeType) as string[]).includes(raw.type));
  ensure(typeof raw.accessible === 'boolean');
  ensure(finite(raw.confidence) && raw.confidence >= 0 && raw.confidence <= 1);
  ensure(raw.name === undefined || raw.name === null || (typeof raw.name === 'string' && raw.name.length <= 100));
  ensure(raw.source === undefined || text(raw.source, 50));
  return {
    id: raw.id,
    // The only percent -> pixel conversion in the system happens here.
    x: round2((raw.x / 100) * width),
    y: round2((raw.y / 100) * height),
    // AI cannot read shop names from a stripped drawing; naming belongs to the Manager.
    name: null,
    type: raw.type as NodeType,
    accessible: raw.accessible,
    confidence: raw.confidence,
    requiresConfirmation: raw.requiresConfirmation !== false,
    ...(raw.source ? { source: raw.source as string } : {}),
  };
}

/**
 * Validate the AI service response (percent space) and convert it to map pixels.
 * Throws a generic NAVIGATION_ANALYSIS_INVALID: upstream detail is never echoed to clients.
 */
export function parseNavigationAnalysis(
  body: unknown,
  floor: { mapWidth: number | null; mapHeight: number | null },
  limits: NavigationDraftLimits = navigationDraftLimits(),
): NavigationDraftView {
  const width = floor.mapWidth;
  const height = floor.mapHeight;
  if (!width || !height || !(width > 0) || !(height > 0)) {
    throw new BadRequestException({ code: 'FLOOR_MAP_DIMENSIONS_REQUIRED', message: 'Set the floor map width and height before requesting navigation analysis' });
  }
  try {
    ensure(isRecord(body));
    ensure(body.schemaVersion === NAVIGATION_DRAFT_SCHEMA_VERSION);
    ensure(body.coordinateSpace === 'PERCENT_0_100');
    ensure(Array.isArray(body.nodes) && Array.isArray(body.edges));
    ensure(body.nodes.length <= limits.maxNodes && body.edges.length <= limits.maxEdges);
    ensure(isRecord(body.image) && finite(body.image.width) && finite(body.image.height) && body.image.width > 0 && body.image.height > 0);

    const nodes = body.nodes.map((raw) => toNode(raw, width, height));
    const byId = new Map(nodes.map((node) => [node.id, node]));
    ensure(byId.size === nodes.length);

    const pairs = new Set<string>();
    const edges = body.edges.map((raw): NavigationDraftEdgeView => {
      ensure(isRecord(raw));
      ensure(text(raw.id, MAX_ID) && text(raw.fromNodeId, MAX_ID) && text(raw.toNodeId, MAX_ID));
      const from = byId.get(raw.fromNodeId);
      const to = byId.get(raw.toNodeId);
      ensure(from !== undefined && to !== undefined && from.id !== to.id);
      ensure(typeof raw.accessible === 'boolean');
      ensure(finite(raw.confidence) && raw.confidence >= 0 && raw.confidence <= 1);
      ensure(raw.source === undefined || text(raw.source, 50));
      const pair = [from.id, to.id].sort().join('\u0000');
      ensure(!pairs.has(pair));
      pairs.add(pair);
      return {
        id: raw.id,
        fromNodeId: from.id,
        toNodeId: to.id,
        // informational only; apply recomputes the weight from node coordinates
        weight: round2(Math.hypot(from.x - to.x, from.y - to.y)),
        accessible: raw.accessible,
        confidence: raw.confidence,
        requiresConfirmation: raw.requiresConfirmation !== false,
        ...(raw.source ? { source: raw.source as string } : {}),
      };
    });
    ensure(new Set(edges.map((edge) => edge.id)).size === edges.length);

    const warnings = Array.isArray(body.warnings)
      ? body.warnings.filter((item): item is string => typeof item === 'string').slice(0, MAX_WARNINGS).map((item) => item.slice(0, MAX_TEXT))
      : [];
    const diagnostics = isRecord(body.diagnostics) && JSON.stringify(body.diagnostics).length <= MAX_DIAGNOSTICS_BYTES ? body.diagnostics : undefined;
    return {
      schemaVersion: 1,
      coordinateSpace: 'PIXEL',
      image: { width, height },
      nodes,
      edges,
      warnings,
      ...(diagnostics ? { diagnostics } : {}),
    };
  } catch (error) {
    if (error instanceof InvalidAnalysis) {
      throw new BadGatewayException({ code: 'NAVIGATION_ANALYSIS_INVALID', message: 'Navigation analysis returned an invalid draft' });
    }
    throw error;
  }
}
