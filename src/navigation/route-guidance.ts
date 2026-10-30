import { ConnectorKind } from '@prisma/client';
import { TRANSITION_PROFILES } from '../graph/domain/transition-costs';

export type GuidanceLang = 'en' | 'vi';

export type GuidanceManeuver =
  | 'START' | 'STRAIGHT' | 'SLIGHT_LEFT' | 'SLIGHT_RIGHT' | 'TURN_LEFT' | 'TURN_RIGHT' | 'U_TURN_LEFT' | 'U_TURN_RIGHT'
  | ConnectorKind | 'ARRIVE' | 'ARRIVE_AT_SAFE_EXIT';

export type GuidanceNode = { id: string; x: number; y: number; floorId: string };
export type GuidanceLeg = { toNodeId: string; kind: 'WALK' | ConnectorKind; walkMeters: number };

export type GuidanceStep = {
  nodeId: string;
  floorId: string;
  x: number;
  y: number;
  /** Degrees on the map: 0 = up, increasing clockwise (same convention as the web map). null when not walking. */
  bearing: number | null;
  instruction: string;
  maneuver: GuidanceManeuver;
  /** Walking distance of the leg that starts at this step. */
  distanceMeters?: number;
  /** Time spent waiting for the car (elevators only). */
  waitSeconds?: number;
  transition?: ConnectorKind;
  targetFloorId?: string;
};

const STRAIGHT_BELOW = 15;
const SLIGHT_BELOW = 45;
const TURN_BELOW = 135;

/** 0° = up, clockwise; y grows downwards on the map image. */
export const mapBearing = (from: { x: number; y: number }, to: { x: number; y: number }) =>
  (((Math.atan2(to.x - from.x, -(to.y - from.y)) * 180) / Math.PI) + 360) % 360;

/** In [-180, 180): positive = turning right. */
export const deltaBearing = (incoming: number, outgoing: number) => ((outgoing - incoming + 540) % 360) - 180;

export function classifyManeuver(delta: number): GuidanceManeuver {
  const magnitude = Math.abs(delta);
  const right = delta >= 0;
  if (magnitude < STRAIGHT_BELOW) return 'STRAIGHT';
  if (magnitude < SLIGHT_BELOW) return right ? 'SLIGHT_RIGHT' : 'SLIGHT_LEFT';
  if (magnitude < TURN_BELOW) return right ? 'TURN_RIGHT' : 'TURN_LEFT';
  return right ? 'U_TURN_RIGHT' : 'U_TURN_LEFT';
}

const VI_TURN: Partial<Record<GuidanceManeuver, string>> = {
  START: 'Xuất phát, đi thẳng',
  STRAIGHT: 'Tiếp tục đi thẳng',
  SLIGHT_LEFT: 'Chếch trái rồi đi',
  SLIGHT_RIGHT: 'Chếch phải rồi đi',
  TURN_LEFT: 'Rẽ trái rồi đi',
  TURN_RIGHT: 'Rẽ phải rồi đi',
  U_TURN_LEFT: 'Quay đầu (bên trái) rồi đi',
  U_TURN_RIGHT: 'Quay đầu (bên phải) rồi đi',
};
const VI_RIDE: Record<ConnectorKind, string> = { ELEVATOR: 'thang máy', STAIR: 'thang bộ', ESCALATOR: 'thang cuốn' };

const meters = (value: number) => `${value < 10 ? value.toFixed(1) : Math.round(value)} m`;

type Input = {
  nodeIds: readonly string[];
  legs: readonly GuidanceLeg[];
  node: (id: string) => GuidanceNode;
  floorNumber: (floorId: string) => number;
  evacuation: boolean;
  lang: GuidanceLang;
};

/**
 * Turn-by-turn steps for a planned route. `instruction` keeps the original English wording unless `lang` is 'vi',
 * so existing clients are unaffected; `maneuver`, `distanceMeters` and `waitSeconds` are always added.
 */
export function buildGuidance({ nodeIds, legs, node, floorNumber, evacuation, lang }: Input): GuidanceStep[] {
  let incomingBearing: number | null = null;
  return nodeIds.map((nodeId, index) => {
    const here = node(nodeId);
    const leg = legs[index];
    const next = leg ? node(leg.toNodeId) : undefined;
    const base = { nodeId, floorId: here.floorId, x: here.x, y: here.y };

    if (!leg || !next) {
      const maneuver: GuidanceManeuver = evacuation ? 'ARRIVE_AT_SAFE_EXIT' : 'ARRIVE';
      const instruction = lang === 'vi'
        ? (evacuation ? 'Đã tới lối thoát an toàn' : 'Đã đến điểm đến')
        : (evacuation ? 'You have reached a safe exit' : 'You have arrived');
      return { ...base, bearing: null, instruction, maneuver };
    }

    if (leg.kind !== 'WALK') {
      incomingBearing = null;
      const target = floorNumber(next.floorId);
      const direction = target < floorNumber(here.floorId) ? 'xuống' : 'lên';
      const waitSeconds = leg.kind === ConnectorKind.ELEVATOR ? TRANSITION_PROFILES.ELEVATOR.boardingSeconds : undefined;
      const wait = waitSeconds ? ` (chờ ~${waitSeconds} s)` : '';
      const instruction = lang === 'vi'
        ? `Đi ${VI_RIDE[leg.kind]} ${direction} Tầng ${target}${wait}`
        : `Take the ${leg.kind.toLowerCase()} to floor ${target}`;
      return {
        ...base,
        bearing: null,
        instruction,
        maneuver: leg.kind,
        ...(waitSeconds ? { waitSeconds } : {}),
        transition: leg.kind,
        targetFloorId: next.floorId,
      };
    }

    const bearing = mapBearing(here, next);
    const maneuver: GuidanceManeuver = index === 0
      ? 'START'
      : incomingBearing === null
        ? 'STRAIGHT'
        : classifyManeuver(deltaBearing(incomingBearing, bearing));
    incomingBearing = bearing;
    const distance = Math.round(leg.walkMeters * 100) / 100;
    const instruction = lang === 'vi'
      ? `${VI_TURN[maneuver] ?? 'Tiếp tục đi thẳng'} ${meters(distance)}`
      : 'Continue to the next point';
    return { ...base, bearing, instruction, maneuver, distanceMeters: distance };
  });
}
