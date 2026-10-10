import { dijkstra } from './navigation.service';

describe('dijkstra', () => {
  it('selects the lowest total weight path', () => {
    const graph = new Map([
      ['a', [{ to: 'b', weight: 10, kind: 'WALK' as const }, { to: 'c', weight: 2, kind: 'WALK' as const }]],
      ['b', [{ to: 'd', weight: 1, kind: 'WALK' as const }]],
      ['c', [{ to: 'b', weight: 2, kind: 'WALK' as const }, { to: 'd', weight: 20, kind: 'WALK' as const }]],
      ['d', []],
    ]);
    expect(dijkstra(graph, 'a', 'd')).toEqual({ distance: 5, nodeIds: ['a', 'c', 'b', 'd'], edges: [{ to: 'c', weight: 2, kind: 'WALK' }, { to: 'b', weight: 2, kind: 'WALK' }, { to: 'd', weight: 1, kind: 'WALK' }] });
  });

  it('returns null when no path exists', () => {
    const graph = new Map([['a', []], ['b', []]]);
    expect(dijkstra(graph, 'a', 'b')).toBeNull();
  });
});
