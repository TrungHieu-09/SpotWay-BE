import { Adjacency, AdjacencyEntry, PathResult, RouteOptions } from '../graph.types';
import { MinHeap } from './min-heap';

/**
 * Cheapest path from `source` to the nearest of `targets`, O((V + E) log V) with a binary heap and lazy deletion.
 * Blocked nodes can be neither entered nor used as the source; excluded kinds and (optionally) inaccessible entries are skipped.
 */
export function dijkstra(graph: Adjacency, source: string, targets: string | ReadonlySet<string>, options: RouteOptions = {}): PathResult {
  const goals = typeof targets === 'string' ? new Set([targets]) : targets;
  if (!goals.size || options.blockedNodeIds?.has(source)) return null;

  const best = new Map<string, number>([[source, 0]]);
  const previous = new Map<string, { nodeId: string; entry: AdjacencyEntry }>();
  const queue = new MinHeap<string>();
  queue.push(source, 0);

  let reached: string | undefined;
  while (queue.size) {
    const { value: nodeId, priority: cost } = queue.pop()!;
    if (cost > (best.get(nodeId) ?? Infinity)) continue; // stale heap entry
    if (goals.has(nodeId)) { reached = nodeId; break; }
    for (const entry of graph.get(nodeId) ?? []) {
      if (options.blockedNodeIds?.has(entry.to) || options.excludedKinds?.has(entry.kind) || (options.requireAccessible && !entry.accessible)) continue;
      const candidate = cost + entry.cost;
      if (candidate < (best.get(entry.to) ?? Infinity)) {
        best.set(entry.to, candidate);
        previous.set(entry.to, { nodeId, entry });
        queue.push(entry.to, candidate);
      }
    }
  }
  if (reached === undefined) return null;

  const nodeIds = [reached];
  const entries: AdjacencyEntry[] = [];
  while (nodeIds[0] !== source) {
    const step = previous.get(nodeIds[0]);
    if (!step) return null;
    entries.unshift(step.entry);
    nodeIds.unshift(step.nodeId);
  }
  return { cost: best.get(reached)!, nodeIds, entries };
}
