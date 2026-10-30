import { GraphSnapshot } from '../domain/graph.types';
import { GraphCacheService } from './graph-cache.service';
import { GraphSnapshotBuilder } from './graph-snapshot.builder';

const floors = (version: number) => [{ id: 'f1', floorNumber: 1, metersPerPixel: 1, graphVersion: version }];
const snapshotFor = (buildingId: string, key: string) => ({ buildingId, key }) as unknown as GraphSnapshot;

function build(initial: Record<string, ReturnType<typeof floors>>) {
  const current = { ...initial };
  const builder = {
    publishedFloors: jest.fn(async (buildingId: string) => current[buildingId]),
    build: jest.fn(async (buildingId: string, f: ReturnType<typeof floors>) => snapshotFor(buildingId, f.map((x) => `${x.id}:${x.graphVersion}`).join(','))),
  };
  return { builder, current, cache: new GraphCacheService(builder as unknown as GraphSnapshotBuilder) };
}

describe('GraphCacheService', () => {
  afterEach(() => { delete process.env.GRAPH_CACHE_MAX_BUILDINGS; });

  it('serves a repeated request from memory while the graphVersion is unchanged', async () => {
    const { cache, builder } = build({ b1: floors(1) });
    const first = await cache.get('b1');
    expect(await cache.get('b1')).toBe(first);
    expect(builder.build).toHaveBeenCalledTimes(1);
    expect(builder.publishedFloors).toHaveBeenCalledTimes(2);
  });

  it('rebuilds when a floor version changes, a floor is published, or one is removed', async () => {
    const { cache, builder, current } = build({ b1: floors(1) });
    await cache.get('b1');
    current.b1 = floors(2);
    expect((await cache.get('b1')).key).toBe('f1:2');
    current.b1 = [...floors(2), { id: 'f2', floorNumber: 2, metersPerPixel: 1, graphVersion: 0 }];
    await cache.get('b1');
    current.b1 = [];
    await cache.get('b1');
    expect(builder.build).toHaveBeenCalledTimes(4);
  });

  it('keeps buildings independent', async () => {
    const { cache, builder } = build({ b1: floors(1), b2: floors(1) });
    await cache.get('b1'); await cache.get('b2'); await cache.get('b1');
    expect(builder.build).toHaveBeenCalledTimes(2);
  });

  it('shares one load between concurrent requests for the same version', async () => {
    const { cache, builder } = build({ b1: floors(1) });
    const [a, b, c] = await Promise.all([cache.get('b1'), cache.get('b1'), cache.get('b1')]);
    expect(a).toBe(b); expect(b).toBe(c);
    expect(builder.build).toHaveBeenCalledTimes(1);
  });

  it('evicts the least recently used building beyond the limit', async () => {
    process.env.GRAPH_CACHE_MAX_BUILDINGS = '2';
    const { cache, builder } = build({ b1: floors(1), b2: floors(1), b3: floors(1) });
    await cache.get('b1'); await cache.get('b2'); await cache.get('b1'); await cache.get('b3');
    expect(cache.size).toBe(2);
    await cache.get('b1'); // still cached (recently used)
    expect(builder.build).toHaveBeenCalledTimes(3);
    await cache.get('b2'); // evicted
    expect(builder.build).toHaveBeenCalledTimes(4);
  });

  it('does not cache a failed load', async () => {
    const { cache, builder } = build({ b1: floors(1) });
    builder.build.mockRejectedValueOnce(new Error('db down'));
    await expect(cache.get('b1')).rejects.toThrow('db down');
    expect((await cache.get('b1')).buildingId).toBe('b1');
  });
});
