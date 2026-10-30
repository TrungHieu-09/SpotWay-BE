import { ConnectorKind } from '@prisma/client';
import { buildGuidance, classifyManeuver, deltaBearing, GuidanceLeg, GuidanceNode, mapBearing } from './route-guidance';

const nodes: Record<string, GuidanceNode> = {
  a: { id: 'a', x: 0, y: 100, floorId: 'f1' },
  b: { id: 'b', x: 0, y: 0, floorId: 'f1' }, // lên (y giảm)
  c: { id: 'c', x: 100, y: 0, floorId: 'f1' }, // rồi sang phải
  lift1: { id: 'lift1', x: 100, y: 0, floorId: 'f1' },
  lift3: { id: 'lift3', x: 100, y: 0, floorId: 'f3' },
  d: { id: 'd', x: 100, y: -50, floorId: 'f3' },
};
const floors: Record<string, number> = { f1: 1, f3: 3 };
const walk = (toNodeId: string, walkMeters: number): GuidanceLeg => ({ toNodeId, kind: 'WALK', walkMeters });
const run = (nodeIds: string[], legs: GuidanceLeg[], extra: { evacuation?: boolean; lang?: 'en' | 'vi' } = {}) =>
  buildGuidance({ nodeIds, legs, node: (id) => nodes[id], floorNumber: (id) => floors[id], evacuation: false, lang: 'en', ...extra });

describe('bearing', () => {
  it('0° là hướng lên, tăng theo chiều kim đồng hồ (y của ảnh hướng xuống)', () => {
    expect(mapBearing({ x: 0, y: 10 }, { x: 0, y: 0 })).toBeCloseTo(0);
    expect(mapBearing({ x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(90);
    expect(mapBearing({ x: 0, y: 0 }, { x: 0, y: 10 })).toBeCloseTo(180);
    expect(mapBearing({ x: 0, y: 0 }, { x: -10, y: 0 })).toBeCloseTo(270);
  });

  it('delta dương là rẽ phải, âm là rẽ trái, qua mốc 0°/360°', () => {
    expect(deltaBearing(350, 10)).toBe(20);
    expect(deltaBearing(10, 350)).toBe(-20);
    expect(classifyManeuver(10)).toBe('STRAIGHT');
    expect(classifyManeuver(30)).toBe('SLIGHT_RIGHT');
    expect(classifyManeuver(-30)).toBe('SLIGHT_LEFT');
    expect(classifyManeuver(90)).toBe('TURN_RIGHT');
    expect(classifyManeuver(-90)).toBe('TURN_LEFT');
    expect(classifyManeuver(170)).toBe('U_TURN_RIGHT');
  });
});

describe('buildGuidance', () => {
  it('giữ nguyên chữ tiếng Anh mặc định và thêm maneuver/khoảng cách', () => {
    const steps = run(['a', 'b', 'c'], [walk('b', 10), walk('c', 12)]);
    expect(steps.map((s) => s.instruction)).toEqual(['Continue to the next point', 'Continue to the next point', 'You have arrived']);
    expect(steps.map((s) => s.maneuver)).toEqual(['START', 'TURN_RIGHT', 'ARRIVE']);
    expect(steps.map((s) => s.distanceMeters)).toEqual([10, 12, undefined]);
    expect(steps[0].bearing).toBeCloseTo(0);
    expect(steps[1].bearing).toBeCloseTo(90);
    expect(steps[2].bearing).toBeNull();
  });

  it('lang=vi: chỉ dẫn tiếng Việt kèm số mét', () => {
    const steps = run(['a', 'b', 'c'], [walk('b', 31), walk('c', 6.8)], { lang: 'vi' });
    expect(steps.map((s) => s.instruction)).toEqual(['Xuất phát, đi thẳng 31 m', 'Rẽ phải rồi đi 6.8 m', 'Đã đến điểm đến']);
  });

  it('thang máy: có transition, tầng đích, thời gian chờ và hướng lên/xuống', () => {
    const legs: GuidanceLeg[] = [walk('lift1', 5), { toNodeId: 'lift3', kind: ConnectorKind.ELEVATOR, walkMeters: 0 }, walk('d', 8)];
    const steps = run(['c', 'lift1', 'lift3', 'd'].slice(0, 4), [walk('lift1', 0), ...legs.slice(1)], { lang: 'vi' });
    const ride = steps[1];
    expect(ride).toMatchObject({ transition: 'ELEVATOR', targetFloorId: 'f3', maneuver: 'ELEVATOR', waitSeconds: 30, bearing: null });
    expect(ride.instruction).toBe('Đi thang máy lên Tầng 3 (chờ ~30 s)');
    expect(steps[2].maneuver).toBe('STRAIGHT'); // vừa ra khỏi thang, chưa có hướng tới
    expect(run(['lift3', 'a'], [{ toNodeId: 'a', kind: ConnectorKind.STAIR, walkMeters: 0 }], { lang: 'vi' })[0].instruction).toBe('Đi thang bộ xuống Tầng 1');
    expect(run(['lift3', 'a'], [{ toNodeId: 'a', kind: ConnectorKind.STAIR, walkMeters: 0 }])[0].instruction).toBe('Take the stair to floor 1');
  });

  it('sơ tán: điểm cuối là lối thoát an toàn', () => {
    const steps = run(['a', 'b'], [walk('b', 10)], { evacuation: true });
    expect(steps[1]).toMatchObject({ maneuver: 'ARRIVE_AT_SAFE_EXIT', instruction: 'You have reached a safe exit' });
    expect(run(['a', 'b'], [walk('b', 10)], { evacuation: true, lang: 'vi' })[1].instruction).toBe('Đã tới lối thoát an toàn');
  });
});
