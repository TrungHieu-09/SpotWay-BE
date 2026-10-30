import { ConnectorKind } from '@prisma/client';

export type PublicVerticalLink = {
  id: string;
  nodeIdFrom: string;
  nodeIdTo: string;
  kind: ConnectorKind;
  accessible?: boolean;
  direction?: 'BIDIRECTIONAL';
};

type LegacyLink = { id: string; nodeIdFrom: string; nodeIdTo: string };
type ConnectorWithStops = {
  id: string;
  kind: ConnectorKind;
  accessible: boolean;
  stops: Array<{ nodeId: string; floor: { floorNumber: number } }>;
};

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * Vertical links for the public overview. Legacy pairwise elevator links are kept exactly as before (kind ELEVATOR);
 * connector stops, ordered by floor, add one link per adjacent pair with the connector's real kind. A pair already
 * covered by a legacy link is not repeated (ELEVATOR connectors keep legacy links in sync).
 */
export function mergeVerticalLinks(legacy: readonly LegacyLink[], connectors: readonly ConnectorWithStops[]): PublicVerticalLink[] {
  const result: PublicVerticalLink[] = legacy.map((link) => ({ ...link, kind: ConnectorKind.ELEVATOR }));
  const seen = new Set(legacy.map((link) => pairKey(link.nodeIdFrom, link.nodeIdTo)));
  for (const connector of connectors) {
    const stops = [...connector.stops].sort((a, b) => a.floor.floorNumber - b.floor.floorNumber);
    stops.slice(1).forEach((stop, index) => {
      const from = stops[index].nodeId;
      const key = pairKey(from, stop.nodeId);
      if (seen.has(key)) return;
      seen.add(key);
      result.push({
        id: `${connector.id}:${index}`,
        nodeIdFrom: from,
        nodeIdTo: stop.nodeId,
        kind: connector.kind,
        accessible: connector.accessible,
        direction: 'BIDIRECTIONAL',
      });
    });
  }
  return result;
}
