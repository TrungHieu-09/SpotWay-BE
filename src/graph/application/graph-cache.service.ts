import { Injectable } from '@nestjs/common';
import { GraphSnapshot } from '../domain/graph.types';
import { snapshotKey } from '../domain/snapshot-assembler';
import { GraphSnapshotBuilder } from './graph-snapshot.builder';

const DEFAULT_MAX_BUILDINGS = 50;

/**
 * In-memory snapshot cache keyed by buildingId and validated by graphVersion.
 * Every request pays one small query (published floors + versions); the full graph is loaded only when that key changed.
 * Each instance validates against the database itself, so no cross-instance invalidation message is needed.
 */
@Injectable()
export class GraphCacheService {
  private readonly snapshots = new Map<string, GraphSnapshot>();
  private readonly loading = new Map<string, Promise<GraphSnapshot>>();

  constructor(private readonly builder: GraphSnapshotBuilder) {}

  private get maxBuildings() {
    const configured = Number(process.env.GRAPH_CACHE_MAX_BUILDINGS);
    return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_BUILDINGS;
  }

  async get(buildingId: string): Promise<GraphSnapshot> {
    const floors = await this.builder.publishedFloors(buildingId);
    const key = snapshotKey(floors);
    const cached = this.snapshots.get(buildingId);
    if (cached?.key === key) { this.snapshots.delete(buildingId); this.snapshots.set(buildingId, cached); return cached; } // refresh LRU position

    const flightKey = `${buildingId}|${key}`;
    let flight = this.loading.get(flightKey);
    if (!flight) {
      flight = this.builder.build(buildingId, floors).then((snapshot) => { this.store(snapshot); return snapshot; }).finally(() => this.loading.delete(flightKey));
      this.loading.set(flightKey, flight);
    }
    return flight;
  }

  invalidate(buildingId?: string) { if (buildingId) this.snapshots.delete(buildingId); else this.snapshots.clear(); }

  get size() { return this.snapshots.size; }

  private store(snapshot: GraphSnapshot) {
    this.snapshots.delete(snapshot.buildingId);
    this.snapshots.set(snapshot.buildingId, snapshot);
    while (this.snapshots.size > this.maxBuildings) this.snapshots.delete(this.snapshots.keys().next().value as string);
  }
}
