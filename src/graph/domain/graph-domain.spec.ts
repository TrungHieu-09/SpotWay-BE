import { distanceMeters, pixelDistance, scaleFromReference } from './coordinate-transform';
import { findNearestNode } from './nearest-node';

describe('coordinate-transform', () => {
  it('measures pixel distance and converts to metres', () => {
    expect(pixelDistance({ x: 0, y: 0 }, { x: 300, y: 400 })).toBe(500);
    expect(distanceMeters({ x: 0, y: 0 }, { x: 300, y: 400 }, 0.05)).toBe(25);
  });

  it('returns null metres for an uncalibrated floor instead of guessing', () => {
    expect(distanceMeters({ x: 0, y: 0 }, { x: 3, y: 4 }, null)).toBeNull();
  });

  it('derives a scale from a reference segment and rejects unusable input', () => {
    expect(scaleFromReference({ x: 0, y: 0 }, { x: 100, y: 0 }, 5)).toBe(0.05);
    expect(scaleFromReference({ x: 1, y: 1 }, { x: 1, y: 1 }, 5)).toBeNull();
    expect(scaleFromReference({ x: 0, y: 0 }, { x: 10, y: 0 }, 0)).toBeNull();
    expect(scaleFromReference({ x: 0, y: 0 }, { x: Number.NaN, y: 0 }, 3)).toBeNull();
  });
});

describe('findNearestNode', () => {
  const nodes = [{ id: 'b', x: 100, y: 0 }, { id: 'a', x: 0, y: 100 }, { id: 'far', x: 1000, y: 1000 }];

  it('snaps to the nearest node within the limit and reports metres', () => {
    const { match } = findNearestNode(nodes, { x: 90, y: 0 }, 0.1, 5);
    expect(match).toEqual({ nodeId: 'b', distanceMeters: 1 });
  });

  it('refuses a node beyond the limit but still reports the nearest one', () => {
    const { match, nearest } = findNearestNode(nodes, { x: 500, y: 0 }, 0.1, 5);
    expect(match).toBeNull();
    expect(nearest?.nodeId).toBe('b');
  });

  it('breaks ties by id and handles an empty floor', () => {
    expect(findNearestNode(nodes, { x: 50, y: 50 }, 1, 100).match?.nodeId).toBe('a');
    expect(findNearestNode([], { x: 0, y: 0 }, 1, 100)).toEqual({ match: null, nearest: null });
  });
});
