import { StoreStatus } from '@prisma/client';
import { AuthUser } from '../common/auth.types';
import { StoreSyncService } from './store-sync.service';

const user = { userId: 'u1', role: 'BUILDING_MANAGER', tenantId: 't1' } as AuthUser;

function setup(pois: Array<{ id: string; nodeId: string; name: string }>, stores: Array<Record<string, unknown>>) {
  const calls: Array<{ kind: string; args: any }> = [];
  const prisma: any = {
    floor: { findUniqueOrThrow: async () => ({ id: 'f1', tenantId: 't1', buildingId: 'b1', name: 'Tầng 1' }) },
    poi: { findMany: async () => pois },
    store: {
      findMany: async () => stores,
      create: (args: unknown) => { calls.push({ kind: 'create', args }); return Promise.resolve(args); },
      update: (args: unknown) => { calls.push({ kind: 'update', args }); return Promise.resolve(args); },
    },
    $transaction: async (ops: unknown[]) => Promise.all(ops),
  };
  const recorded: string[] = [];
  const activity: any = { record: async (_u: unknown, _b: unknown, action: string) => { recorded.push(action); } };
  return { service: new StoreSyncService(prisma, activity), calls, recorded };
}

describe('StoreSyncService', () => {
  it('tạo gian hàng ACTIVE cho POI mới với tên và node của POI', async () => {
    const { service, calls, recorded } = setup([{ id: 'p1', nodeId: 'n1', name: ' Highlands ' }], []);
    const result = await service.syncFromPois(user, 'f1');
    expect(result).toEqual({ created: 1, renamed: 0, adopted: 0, closed: 0 });
    expect(calls[0].args.data).toMatchObject({ tenantId: 't1', floorId: 'f1', nodeId: 'n1', poiId: 'p1', name: 'Highlands', images: [], status: StoreStatus.ACTIVE });
    expect(recorded).toEqual(['STORE_SYNCED']);
  });

  it('đổi tên POI thì đổi tên gian hàng, không động tới trường khác', async () => {
    const { service, calls } = setup([{ id: 'p1', nodeId: 'n1', name: 'Phở 24' }], [{ id: 's1', poiId: 'p1', nodeId: 'n1', name: 'POI 1', status: 'ACTIVE', deletedAt: null }]);
    expect(await service.syncFromPois(user, 'f1')).toMatchObject({ renamed: 1, created: 0 });
    expect(calls[0].args).toEqual({ where: { id: 's1' }, data: { name: 'Phở 24', nodeId: 'n1' } });
  });

  it('không làm gì khi mọi thứ đã khớp (chạy lại không tạo trùng)', async () => {
    const { service, calls, recorded } = setup([{ id: 'p1', nodeId: 'n1', name: 'A' }], [{ id: 's1', poiId: 'p1', nodeId: 'n1', name: 'A', status: 'ACTIVE', deletedAt: null }]);
    expect(await service.syncFromPois(user, 'f1')).toEqual({ created: 0, renamed: 0, adopted: 0, closed: 0 });
    expect(calls).toHaveLength(0);
    expect(recorded).toHaveLength(0);
  });

  it('nhận gian hàng nhập tay trùng node và tên thay vì tạo bản sao', async () => {
    const { service, calls } = setup([{ id: 'p1', nodeId: 'n1', name: 'Zara' }], [{ id: 's9', poiId: null, nodeId: 'n1', name: 'zara', status: 'ACTIVE', deletedAt: null }]);
    expect(await service.syncFromPois(user, 'f1')).toMatchObject({ adopted: 1, created: 0 });
    expect(calls[0].args).toEqual({ where: { id: 's9' }, data: { poiId: 'p1', name: 'Zara' } });
  });

  it('đóng gian hàng của POI đã bị xóa, nhưng không tạo lại gian hàng Manager đã xóa', async () => {
    const { service, calls } = setup(
      [{ id: 'p2', nodeId: 'n2', name: 'B' }],
      [
        { id: 's1', poiId: 'p1', nodeId: 'n1', name: 'A', status: 'ACTIVE', deletedAt: null },
        { id: 's2', poiId: 'p2', nodeId: 'n2', name: 'B', status: 'ACTIVE', deletedAt: new Date() },
      ],
    );
    expect(await service.syncFromPois(user, 'f1')).toEqual({ created: 0, renamed: 0, adopted: 0, closed: 1 });
    expect(calls).toEqual([{ kind: 'update', args: { where: { id: 's1' }, data: { status: StoreStatus.CLOSED } } }]);
  });

  it('bỏ qua POI không có tên', async () => {
    const { service, calls } = setup([{ id: 'p1', nodeId: 'n1', name: '   ' }], []);
    expect(await service.syncFromPois(user, 'f1')).toMatchObject({ created: 0 });
    expect(calls).toHaveLength(0);
  });
});
