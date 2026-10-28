import { Adjacency, AdjacencyEntry } from '../graph.types';
import { dijkstra } from './dijkstra';
import { MinHeap } from './min-heap';

const walk = (to: string, cost: number, accessible = true): AdjacencyEntry => ({ to, cost, kind: 'WALK', accessible });
const graph = (entries: Record<string, AdjacencyEntry[]>): Adjacency => new Map(Object.entries(entries));

describe('MinHeap', () => {
  it('pops in priority order and keeps insertion order for equal priorities', () => {
    const heap = new MinHeap<string>();
    [['c', 3], ['a', 1], ['b2', 2], ['b1', 2], ['d', 9]].forEach(([value, priority]) => heap.push(value as string, priority as number));
    expect(heap.peek()).toBe('a');
    const order: string[] = [];
    while (heap.size) order.push(heap.pop()!.value);
    expect(order).toEqual(['a', 'b2', 'b1', 'c', 'd']);
    expect(heap.pop()).toBeUndefined();
  });

  it('sorts a large shuffled input', () => {
    const heap = new MinHeap<number>();
    const values = Array.from({ length: 2000 }, (_, i) => (i * 7919) % 2003);
    values.forEach((value) => heap.push(value, value));
    const out: number[] = [];
    while (heap.size) out.push(heap.pop()!.priority);
    expect(out).toEqual([...values].sort((a, b) => a - b));
  });
});

describe('dijkstra', () => {
  it('selects the lowest total cost path', () => {
    const g = graph({ a: [walk('b', 10), walk('c', 2)], b: [walk('d', 1)], c: [walk('b', 2), walk('d', 20)], d: [] });
    expect(dijkstra(g, 'a', 'd')).toEqual({ cost: 5, nodeIds: ['a', 'c', 'b', 'd'], entries: [walk('c', 2), walk('b', 2), walk('d', 1)] });
  });

  it('returns null without a path, for a blocked source, and for an empty target set', () => {
    expect(dijkstra(graph({ a: [], b: [] }), 'a', 'b')).toBeNull();
    expect(dijkstra(graph({ a: [walk('b', 1)], b: [] }), 'a', 'b', { blockedNodeIds: new Set(['a']) })).toBeNull();
    expect(dijkstra(graph({ a: [walk('b', 1)], b: [] }), 'a', new Set())).toBeNull();
  });

  it('finds the nearest target while skipping blocked nodes, excluded kinds and inaccessible entries', () => {
    const g = graph({
      start: [walk('fire', 1), walk('safe', 4), { to: 'lift', cost: 1, kind: 'ELEVATOR', accessible: true }, walk('steep', 1, false)],
      fire: [walk('exit-near', 1)], safe: [walk('exit-safe', 1)], lift: [walk('exit-lift', 1)], steep: [walk('exit-steep', 1)],
      'exit-near': [], 'exit-safe': [], 'exit-lift': [], 'exit-steep': [],
    });
    const exits = new Set(['exit-near', 'exit-safe', 'exit-lift', 'exit-steep']);
    expect(dijkstra(g, 'start', exits, { blockedNodeIds: new Set(['fire']), excludedKinds: new Set(['ELEVATOR']), requireAccessible: true })?.nodeIds).toEqual(['start', 'safe', 'exit-safe']);
    expect(dijkstra(g, 'start', exits, { blockedNodeIds: new Set(['fire']) })?.nodeIds).toEqual(['start', 'lift', 'exit-lift']);
  });

  it('returns the source alone when it is already a target', () => {
    expect(dijkstra(graph({ a: [walk('b', 1)], b: [] }), 'a', new Set(['a']))).toEqual({ cost: 0, nodeIds: ['a'], entries: [] });
  });

  it('matches a brute-force Bellman-Ford on a random graph', () => {
    let seed = 42;
    const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const n = 120;
    const entries: Record<string, AdjacencyEntry[]> = Object.fromEntries(Array.from({ length: n }, (_, i) => [`n${i}`, [] as AdjacencyEntry[]]));
    const edges: Array<[number, number, number]> = [];
    for (let i = 0; i < 400; i++) {
      const a = Math.floor(rand() * n); const b = Math.floor(rand() * n); const w = 1 + Math.floor(rand() * 20);
      if (a === b) continue;
      entries[`n${a}`].push(walk(`n${b}`, w)); entries[`n${b}`].push(walk(`n${a}`, w)); edges.push([a, b, w]);
    }
    const dist = Array(n).fill(Infinity); dist[0] = 0;
    for (let round = 0; round < n; round++) for (const [a, b, w] of edges) { if (dist[a] + w < dist[b]) dist[b] = dist[a] + w; if (dist[b] + w < dist[a]) dist[a] = dist[b] + w; }
    const g = graph(entries);
    for (let target = 1; target < n; target += 7) expect(dijkstra(g, 'n0', `n${target}`)?.cost ?? Infinity).toBe(dist[target]);
  });

  it('stays fast on a 20k-node grid (heap, not a sort per step)', () => {
    const side = 140;
    const id = (x: number, y: number) => `${x},${y}`;
    const entries = new Map<string, AdjacencyEntry[]>();
    for (let x = 0; x < side; x++) for (let y = 0; y < side; y++) {
      const list: AdjacencyEntry[] = [];
      if (x + 1 < side) list.push(walk(id(x + 1, y), 1)); if (x > 0) list.push(walk(id(x - 1, y), 1));
      if (y + 1 < side) list.push(walk(id(x, y + 1), 1)); if (y > 0) list.push(walk(id(x, y - 1), 1));
      entries.set(id(x, y), list);
    }
    const started = Date.now();
    const result = dijkstra(entries, id(0, 0), id(side - 1, side - 1));
    expect(result?.cost).toBe(2 * (side - 1));
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
