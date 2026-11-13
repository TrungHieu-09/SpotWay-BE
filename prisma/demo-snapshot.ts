/**
 * Demo data you can put back with one command.
 *
 *   npm run demo:export            writes prisma/demo-data.json from the building in DEMO_BUILDING_ID (default: the demo mall)
 *   npm run demo:restore           upserts that snapshot into the database (idempotent) and (re)creates the demo accounts + QR codes
 *   npm run demo:restore -- --dry  only prints what would be written
 *
 * Accounts are never exported (no password hashes in git): restore creates the four seed accounts with the seed password
 * when they do not exist yet, and never changes the password of an existing one.
 * Floor-plan images stay where they are (URLs); restore does not upload anything.
 */
import { PrismaClient, UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const prisma = new PrismaClient();
const FILE = join(__dirname, 'demo-data.json');
const BUILDING_ID = process.env.DEMO_BUILDING_ID ?? '48ea6235-ff4a-428b-b75f-a6d7a998d10a';
const PASSWORD = 'ChangeMe123!';

/** Tables in dependency order. */
const TABLES = ['tenant', 'building', 'floor', 'node', 'edge', 'poi', 'store', 'promotion', 'elevatorLink', 'connector', 'connectorStop'] as const;
type Table = (typeof TABLES)[number];
type Row = Record<string, unknown> & { id: string };
type Snapshot = { exportedAt: string; buildingId: string; rows: Record<Table, Row[]> };

/** Fixed QR tokens so a printed code keeps working after a restore. Label -> token. */
const DEMO_QR: { token: string; label: string; pick: (nodes: Row[], floors: Row[]) => Row | undefined }[] = [
  { token: 'spotway-demo-lobby-0001', label: 'Sảnh chính', pick: (nodes, floors) => lowestFloorNode(nodes, floors, ['DOOR', 'EXIT', 'EMERGENCY_EXIT', 'NORMAL']) },
  { token: 'spotway-demo-upper-0002', label: 'Tầng trên', pick: (nodes, floors) => highestFloorNode(nodes, floors, ['ELEVATOR', 'STAIR', 'NORMAL']) },
];

function floorOrder(floors: Row[]) {
  return [...floors].sort((a, b) => Number(a.floorNumber) - Number(b.floorNumber));
}
function lowestFloorNode(nodes: Row[], floors: Row[], types: string[]) {
  const ordered = floorOrder(floors);
  for (const floor of ordered) for (const type of types) { const found = nodes.find((n) => n.floorId === floor.id && n.type === type); if (found) return found; }
  return undefined;
}
function highestFloorNode(nodes: Row[], floors: Row[], types: string[]) {
  for (const floor of [...floorOrder(floors)].reverse()) for (const type of types) { const found = nodes.find((n) => n.floorId === floor.id && n.type === type); if (found) return found; }
  return undefined;
}

const DATE_KEYS = new Set(['createdAt', 'updatedAt', 'deletedAt', 'startAt', 'endAt']);
const revive = (row: Row): Row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, DATE_KEYS.has(key) && typeof value === 'string' ? new Date(value) : value])) as Row;

// Prisma delegates are typed per model; the snapshot code is generic on purpose.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any;

async function exportSnapshot() {
  const building = await db.building.findFirst({ where: { id: BUILDING_ID, deletedAt: null } });
  if (!building) throw new Error(`Building ${BUILDING_ID} not found`);
  const floors: Row[] = await db.floor.findMany({ where: { buildingId: BUILDING_ID, deletedAt: null }, orderBy: { floorNumber: 'asc' } });
  const floorIds = floors.map((f) => f.id);
  const [tenant, nodes, edges, pois, stores, elevatorLinks, connectors] = await Promise.all([
    db.tenant.findUnique({ where: { id: building.tenantId } }),
    db.node.findMany({ where: { floorId: { in: floorIds }, deletedAt: null } }),
    db.edge.findMany({ where: { floorId: { in: floorIds }, deletedAt: null } }),
    db.poi.findMany({ where: { floorId: { in: floorIds }, deletedAt: null } }),
    db.store.findMany({ where: { floorId: { in: floorIds }, deletedAt: null } }),
    db.elevatorLink.findMany({ where: { buildingId: BUILDING_ID, deletedAt: null } }).catch(() => []),
    db.connector.findMany({ where: { buildingId: BUILDING_ID, deletedAt: null }, include: { stops: true } }),
  ]);
  const promotions = await db.promotion.findMany({ where: { storeId: { in: stores.map((s: Row) => s.id) }, deletedAt: null } });
  const connectorRows = connectors.map(({ stops: _stops, ...rest }: Row & { stops: Row[] }) => rest);
  const stopRows = connectors.flatMap((c: { stops: Row[] }) => c.stops);
  // Stores are re-assigned to the demo store owner on restore, so the real owner ids are dropped.
  const snapshot: Snapshot = {
    exportedAt: new Date().toISOString(),
    buildingId: BUILDING_ID,
    rows: { tenant: [tenant], building: [building], floor: floors, node: nodes, edge: edges, poi: pois, store: stores.map((s: Row) => ({ ...s, ownerId: null })), promotion: promotions, elevatorLink: elevatorLinks, connector: connectorRows, connectorStop: stopRows },
  };
  writeFileSync(FILE, JSON.stringify(snapshot, null, 2));
  console.log(`Exported to ${FILE}`);
  for (const table of TABLES) console.log(`  ${table.padEnd(14)} ${snapshot.rows[table].length}`);
}

async function restoreSnapshot(dry: boolean) {
  if (!existsSync(FILE)) throw new Error('prisma/demo-data.json not found: run npm run demo:export first');
  const snapshot = JSON.parse(readFileSync(FILE, 'utf-8')) as Snapshot;
  for (const table of TABLES) {
    const rows = snapshot.rows[table] ?? [];
    console.log(`${dry ? '[dry] ' : ''}${table.padEnd(14)} ${rows.length}`);
    if (dry) continue;
    for (const raw of rows) {
      const row = revive(raw);
      const { id, ...update } = row;
      // The composite relation columns are plain scalars in the unchecked input.
      await db[table].upsert({ where: { id }, create: row, update });
    }
  }
  if (dry) return;

  const tenantId = snapshot.rows.tenant[0].id;
  const hash = await bcrypt.hash(PASSWORD, 12);
  const account = (email: string, role: UserRole, withTenant: boolean) =>
    prisma.user.upsert({ where: { email }, update: { role, tenantId: withTenant ? tenantId : null, deletedAt: null, status: 'ACTIVE' }, create: { email, passwordHash: hash, role, tenantId: withTenant ? tenantId : null } });
  await account('admin@spotway.local', UserRole.ADMIN, false);
  await account('owner@demo-mall.local', UserRole.BUILDING_OWNER, true);
  const manager = await account('manager@demo-mall.local', UserRole.BUILDING_MANAGER, true);
  const storeOwner = await account('store-owner@demo-mall.local', UserRole.STORE_OWNER, true);
  await prisma.staffAssignment.upsert({ where: { userId_buildingId: { userId: manager.id, buildingId: snapshot.buildingId } }, update: {}, create: { userId: manager.id, buildingId: snapshot.buildingId } });
  const firstStore = snapshot.rows.store.find((s) => s.status === 'ACTIVE') ?? snapshot.rows.store[0];
  if (firstStore) await db.store.update({ where: { id: firstStore.id }, data: { ownerId: storeOwner.id } });

  await restoreDemoStores(snapshot, tenantId, storeOwner.id);

  console.log('\nQR codes (scan with the app, or type the token):');
  for (const qr of DEMO_QR) {
    const node = qr.pick(snapshot.rows.node, snapshot.rows.floor);
    if (!node) continue;
    const tokenHash = createHash('sha256').update(qr.token).digest('hex');
    await prisma.qrAnchor.upsert({
      where: { tokenHash },
      update: { deletedAt: null, nodeId: node.id as string, floorId: node.floorId as string, label: qr.label },
      create: { tenantId, buildingId: snapshot.buildingId, floorId: node.floorId as string, nodeId: node.id as string, tokenHash, label: qr.label },
    });
    console.log(`  ${qr.label.padEnd(12)} token: ${qr.token}   link: http://localhost:5173/navigate/${snapshot.buildingId}?qr=${qr.token}`);
  }
  console.log(`\nAccounts (password ${PASSWORD}): admin@spotway.local, owner@demo-mall.local, manager@demo-mall.local, store-owner@demo-mall.local`);
}

/** Fixed demo stores (and a running promotion each) so the guest app has something to search and show. Only when the snapshot has none. */
const DEMO_STORES = [
  { n: 1, name: 'Highlands Coffee', description: 'Cà phê và bánh ngọt, không gian thoáng cho nhóm bạn.', promo: 'Mua 1 tặng 1 sau 18h' },
  { n: 2, name: 'Zara', description: 'Thời trang nam nữ, bộ sưu tập mới mỗi tuần.', promo: 'Giảm 30% bộ sưu tập thu' },
  { n: 3, name: 'Nhà sách Phương Nam', description: 'Sách, văn phòng phẩm và quà tặng.', promo: 'Tặng bookmark khi mua từ 200K' },
  { n: 4, name: 'Guardian', description: 'Sức khỏe và làm đẹp.', promo: 'Giảm 20% mỹ phẩm chăm sóc da' },
  { n: 5, name: 'CGV Cinemas', description: 'Rạp chiếu phim, phòng chiếu IMAX.', promo: 'Combo bắp nước chỉ 59K' },
  { n: 6, name: 'Thế Giới Di Động', description: 'Điện thoại, máy tính bảng và phụ kiện.', promo: 'Trả góp 0% kèm quà tặng' },
];

async function restoreDemoStores(snapshot: Snapshot, tenantId: string, storeOwnerId: string) {
  if (snapshot.rows.store.length >= DEMO_STORES.length) return;
  const floors = floorOrder(snapshot.rows.floor);
  const pool = floors.flatMap((floor) => snapshot.rows.node.filter((n) => n.floorId === floor.id && n.type === 'NORMAL'));
  if (!pool.length) return;
  const step = Math.max(1, Math.floor(pool.length / DEMO_STORES.length));
  // A store owner may run only one store: give them the first demo store unless they already have one.
  const ownerFree = !(await db.store.findFirst({ where: { ownerId: storeOwnerId, deletedAt: null, id: { not: '00000000-0000-4000-8000-00000000d001' } } }));
  const now = Date.now();
  for (const [index, demo] of DEMO_STORES.entries()) {
    const node = pool[Math.min(pool.length - 1, index * step)];
    const id = `00000000-0000-4000-8000-00000000d${String(demo.n).padStart(3, '0')}`;
    const data = { tenantId, floorId: node.floorId as string, nodeId: node.id, name: demo.name, description: demo.description, status: 'ACTIVE', images: [], ownerId: index === 0 && ownerFree ? storeOwnerId : null, deletedAt: null };
    await db.store.upsert({ where: { id }, create: { id, ...data }, update: data });
    const promoId = `00000000-0000-4000-8000-00000000e${String(demo.n).padStart(3, '0')}`;
    const promo = { tenantId, storeId: id, title: demo.promo, description: 'Áp dụng trong thời gian có hạn tại cửa hàng.', status: 'ACTIVE', startAt: new Date(now - 86_400_000), endAt: new Date(now + 30 * 86_400_000), deletedAt: null };
    await db.promotion.upsert({ where: { id: promoId }, create: { id: promoId, ...promo }, update: promo });
  }
  console.log(`Demo stores: ${DEMO_STORES.length} (with running promotions)`);
}

async function main() {
  const [command, flag] = process.argv.slice(2);
  if (command === 'export') await exportSnapshot();
  else if (command === 'restore') await restoreSnapshot(flag === '--dry');
  else throw new Error('Usage: ts-node prisma/demo-snapshot.ts export|restore [--dry]');
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
