import { ConnectorKind } from '@prisma/client';
import { mergeVerticalLinks } from './vertical-links';

const stop = (nodeId: string, floorNumber: number) => ({ nodeId, floor: { floorNumber } });

describe('mergeVerticalLinks', () => {
  it('giữ liên kết cũ (kind ELEVATOR) và không đổi gì khi chưa có connector', () => {
    expect(mergeVerticalLinks([{ id: 'l1', nodeIdFrom: 'a', nodeIdTo: 'b' }], [])).toEqual([
      { id: 'l1', nodeIdFrom: 'a', nodeIdTo: 'b', kind: ConnectorKind.ELEVATOR },
    ]);
  });

  it('thêm liên kết theo từng cặp tầng liền kề của connector với đúng loại và cờ xe lăn', () => {
    const result = mergeVerticalLinks([], [
      { id: 'c1', kind: ConnectorKind.STAIR, accessible: false, stops: [stop('s3', 3), stop('s1', 1), stop('s2', 2)] },
    ]);
    expect(result).toEqual([
      { id: 'c1:0', nodeIdFrom: 's1', nodeIdTo: 's2', kind: 'STAIR', accessible: false, direction: 'BIDIRECTIONAL' },
      { id: 'c1:1', nodeIdFrom: 's2', nodeIdTo: 's3', kind: 'STAIR', accessible: false, direction: 'BIDIRECTIONAL' },
    ]);
  });

  it('cặp đã có liên kết cũ (bất kể chiều) không bị lặp lại', () => {
    const result = mergeVerticalLinks([{ id: 'l1', nodeIdFrom: 'e2', nodeIdTo: 'e1' }], [
      { id: 'c1', kind: ConnectorKind.ELEVATOR, accessible: true, stops: [stop('e1', 1), stop('e2', 2), stop('e3', 3)] },
    ]);
    expect(result.map((link) => `${link.nodeIdFrom}>${link.nodeIdTo}`)).toEqual(['e2>e1', 'e2>e3']);
  });

  it('connector chỉ có một điểm dừng không sinh liên kết', () => {
    expect(mergeVerticalLinks([], [{ id: 'c1', kind: ConnectorKind.ESCALATOR, accessible: true, stops: [stop('x', 1)] }])).toEqual([]);
  });
});
