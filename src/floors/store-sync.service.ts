import { Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma, PoiCategory, StoreStatus } from '@prisma/client';
import { ActivityService } from '../analytics/activity.service';
import { AuthUser } from '../common/auth.types';
import { PrismaService } from '../database/prisma.service';

export type StoreSyncResult = { created: number; renamed: number; adopted: number; closed: number };

/** POI nào được coi là gian hàng: loại "Gian hàng / điểm khác" (CUSTOM). Tiện ích (WC, thang, lối ra...) thì không. */
export const STORE_POI_CATEGORIES: PoiCategory[] = [PoiCategory.CUSTOM];

/**
 * Sau khi publish một tầng, danh sách gian hàng của tầng đó được cập nhật theo POI: mỗi POI loại gian hàng có đúng một
 * gian hàng (liên kết bằng `stores.poi_id`), tên và vị trí lấy từ POI. Chỉ đụng vào tên, node và trạng thái; mô tả, logo,
 * ảnh, chủ gian hàng và khuyến mãi do Manager nhập được giữ nguyên.
 */
@Injectable()
export class StoreSyncService {
  private readonly logger = new Logger(StoreSyncService.name);
  constructor(private readonly prisma: PrismaService, @Optional() private readonly activity?: ActivityService) {}

  async syncFromPois(user: AuthUser, floorId: string): Promise<StoreSyncResult> {
    const floor = await this.prisma.floor.findUniqueOrThrow({ where: { id: floorId }, select: { id: true, tenantId: true, buildingId: true, name: true } });
    const [pois, stores] = await Promise.all([
      this.prisma.poi.findMany({ where: { floorId, deletedAt: null, category: { in: STORE_POI_CATEGORIES } }, select: { id: true, nodeId: true, name: true } }),
      this.prisma.store.findMany({ where: { floorId }, select: { id: true, poiId: true, nodeId: true, name: true, status: true, deletedAt: true } }),
    ]);

    const wanted = pois.filter((poi) => poi.name.trim());
    const wantedIds = new Set(wanted.map((poi) => poi.id));
    const byPoi = new Map(stores.filter((store) => store.poiId).map((store) => [store.poiId as string, store]));
    // Gian hàng nhập tay trước đây (chưa gắn POI) trùng node và tên với POI thì nhận làm của POI đó, tránh tạo bản sao.
    const adoptable = stores.filter((store) => !store.poiId && !store.deletedAt);
    const result: StoreSyncResult = { created: 0, renamed: 0, adopted: 0, closed: 0 };
    const ops: Prisma.PrismaPromise<unknown>[] = [];

    for (const poi of wanted) {
      const name = poi.name.trim();
      const linked = byPoi.get(poi.id);
      if (linked) {
        if (linked.deletedAt) continue; // Manager đã xóa gian hàng này chủ động: không tạo lại.
        if (linked.name !== name || linked.nodeId !== poi.nodeId) {
          ops.push(this.prisma.store.update({ where: { id: linked.id }, data: { name, nodeId: poi.nodeId } }));
          result.renamed += 1;
        }
        continue;
      }
      const twin = adoptable.find((store) => store.nodeId === poi.nodeId && store.name.trim().toLowerCase() === name.toLowerCase());
      if (twin) {
        adoptable.splice(adoptable.indexOf(twin), 1);
        ops.push(this.prisma.store.update({ where: { id: twin.id }, data: { poiId: poi.id, name } }));
        result.adopted += 1;
        continue;
      }
      ops.push(this.prisma.store.create({ data: { tenantId: floor.tenantId, floorId, nodeId: poi.nodeId, poiId: poi.id, name, images: [], status: StoreStatus.ACTIVE } }));
      result.created += 1;
    }

    // POI đã bị xóa (hoặc đổi sang loại khác): đóng gian hàng sinh ra từ POI đó, giữ lại dữ liệu và khuyến mãi.
    for (const store of stores) {
      if (store.poiId && !wantedIds.has(store.poiId) && !store.deletedAt && store.status !== StoreStatus.CLOSED) {
        ops.push(this.prisma.store.update({ where: { id: store.id }, data: { status: StoreStatus.CLOSED } }));
        result.closed += 1;
      }
    }

    if (ops.length) await this.prisma.$transaction(ops);
    if (ops.length) {
      const parts = [result.created && `thêm ${result.created}`, result.renamed && `cập nhật ${result.renamed}`, result.adopted && `liên kết ${result.adopted}`, result.closed && `đóng ${result.closed}`].filter(Boolean).join(', ');
      this.logger.log(`Đồng bộ gian hàng từ POI (${floor.name}): ${parts}`);
      void this.activity?.record(user, floor.buildingId, 'STORE_SYNCED', `Đồng bộ gian hàng từ POI khi publish ${floor.name}: ${parts}`, { floorId, ...result });
    }
    return result;
  }
}
