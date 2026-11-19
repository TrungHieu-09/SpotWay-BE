/**
 * Builds a whole building from one hand-written JSON file.
 *
 *   npm run demo:import -- prisma/samples/spotway-tower.json --dry   check the file, write nothing
 *   npm run demo:import -- prisma/samples/spotway-tower.json         create (or update) the building
 *
 * Running it again needs --replace: the building with that name (in that workspace) is emptied and rebuilt from the file.
 * Nodes are written by a short key ("lobby"), edges and POIs refer to those keys, so no UUID is ever typed by hand.
 * Floors are created PUBLISHED when "publish" is true, so the guest app can load them straight after scanning the QR.
 */
import { PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { readFileSync } from 'fs';

const prisma = new PrismaClient();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any;

type NodeIn = { key: string; name?: string; x: number; y: number; type?: string };
type FloorIn = {
  number: number;
  name: string;
  mapImageUrl?: string;
  mapWidth?: number;
  mapHeight?: number;
  metersPerPixel: number;
  nodes: NodeIn[];
  edges: [string, string][];
  pois?: { node: string; name: string; category: string }[];
  stores?: { node: string; name: string; description?: string; promo?: string }[];
};
type Input = {
  tenant: string; // owner e-mail of the workspace
  building: { name: string; address?: string };
  publish?: boolean;
  copyImagesFrom?: string; // name of a building whose floor images are reused (matched by floor number)
  floors: FloorIn[];
  connectors?: { kind: 'ELEVATOR' | 'STAIR' | 'ESCALATOR'; name: string; stops: { floor: number; node: string }[] }[];
  qr?: { token: string; label: string; floor: number; node: string }[];
};

const fail = (msg: string): never => {
  throw new Error(msg);
};

function validate(input: Input) {
  const errors: string[] = [];
  if (!input.tenant) errors.push('thiếu "tenant" (email owner)');
  if (!input.building?.name) errors.push('thiếu building.name');
  if (!input.floors?.length) errors.push('thiếu "floors"');
  const numbers = new Set<number>();
  for (const f of input.floors ?? []) {
    if (numbers.has(f.number)) errors.push(`tầng ${f.number} bị trùng`);
    numbers.add(f.number);
    if (!(f.metersPerPixel > 0)) errors.push(`tầng ${f.number}: metersPerPixel phải > 0`);
    const keys = new Set<string>();
    for (const n of f.nodes ?? []) {
      if (keys.has(n.key)) errors.push(`tầng ${f.number}: node "${n.key}" bị trùng`);
      keys.add(n.key);
    }
    for (const [a, b] of f.edges ?? []) {
      if (!keys.has(a) || !keys.has(b)) errors.push(`tầng ${f.number}: cạnh ${a}-${b} dùng node không tồn tại`);
      if (a === b) errors.push(`tầng ${f.number}: cạnh ${a}-${b} nối node với chính nó`);
    }
    for (const p of f.pois ?? []) if (!keys.has(p.node)) errors.push(`tầng ${f.number}: POI "${p.name}" dùng node "${p.node}" không tồn tại`);
    for (const s of f.stores ?? []) if (!keys.has(s.node)) errors.push(`tầng ${f.number}: cửa hàng "${s.name}" dùng node "${s.node}" không tồn tại`);
  }
  const has = (floor: number, node: string) => input.floors.find((f) => f.number === floor)?.nodes.some((n) => n.key === node);
  for (const c of input.connectors ?? []) for (const s of c.stops) if (!has(s.floor, s.node)) errors.push(`${c.name}: điểm dừng tầng ${s.floor} node "${s.node}" không tồn tại`);
  for (const q of input.qr ?? []) {
    if (!has(q.floor, q.node)) errors.push(`QR "${q.label}": tầng ${q.floor} node "${q.node}" không tồn tại`);
    if (!/^[\w.~-]{8,}$/.test(q.token)) errors.push(`QR "${q.label}": token phải dài từ 8 ký tự, chỉ gồm chữ, số, - _ . ~`);
  }
  if (errors.length) fail('File chưa hợp lệ:\n  - ' + errors.join('\n  - '));
}

async function run(file: string, dry: boolean, replace: boolean) {
  const input = JSON.parse(readFileSync(file, 'utf-8')) as Input;
  validate(input);
  const summary = input.floors.map((f) => `tầng ${f.number}: ${f.nodes.length} node, ${f.edges.length} cạnh, ${f.pois?.length ?? 0} POI, ${f.stores?.length ?? 0} cửa hàng`);
  console.log(`${dry ? '[dry] ' : ''}Tòa "${input.building.name}"\n  ${summary.join('\n  ')}`);
  if (dry) return console.log('File hợp lệ. Chưa ghi gì vào database.');

  const owner = await db.user.findFirst({ where: { email: input.tenant, deletedAt: null } });
  if (!owner?.tenantId) fail(`Không tìm thấy owner "${input.tenant}" (hoặc tài khoản này chưa có workspace)`);
  const tenantId: string = owner.tenantId;
  const images = new Map<number, { mapImageUrl: string | null; mapWidth: number | null; mapHeight: number | null }>();
  if (input.copyImagesFrom) {
    const src = await db.building.findFirst({ where: { name: input.copyImagesFrom, deletedAt: null }, include: { floors: { where: { deletedAt: null } } } });
    for (const f of src?.floors ?? []) images.set(f.floorNumber, { mapImageUrl: f.mapImageUrl, mapWidth: f.mapWidth, mapHeight: f.mapHeight });
  }

  const existing = await db.building.findFirst({ where: { tenantId, name: input.building.name, deletedAt: null } });
  if (existing && !replace) fail(`Đã có tòa "${input.building.name}" trong workspace này. Thêm --replace nếu muốn XÓA nội dung bản đồ của tòa đó và nạp lại từ file (đổi tên tòa trong file nếu muốn tạo tòa mới).`);
  const building = existing
    ? await db.building.update({ where: { id: existing.id }, data: { address: input.building.address ?? existing.address } })
    : await db.building.create({ data: { tenantId, name: input.building.name, address: input.building.address ?? null } });

  console.log(`${existing ? 'Nạp lại' : 'Tạo'} tòa ${building.id}`);
  // Re-running with --replace replaces the building's map content, so the file stays the single source of truth.
  if (existing) await wipe(building.id);

  try {
  const nodeIds = new Map<string, string>(); // "floor:key" -> node id
  const floorIds = new Map<number, string>();
  for (const f of input.floors) {
    const img = images.get(f.number);
    const floor = await db.floor.create({
      data: {
        tenantId,
        buildingId: building.id,
        floorNumber: f.number,
        name: f.name,
        mapImageUrl: f.mapImageUrl ?? img?.mapImageUrl ?? null,
        mapWidth: f.mapWidth ?? img?.mapWidth ?? null,
        mapHeight: f.mapHeight ?? img?.mapHeight ?? null,
        metersPerPixel: f.metersPerPixel,
        publishStatus: input.publish === false ? 'DRAFT' : 'PUBLISHED',
      },
    });
    floorIds.set(f.number, floor.id);
    const byKey = new Map<string, { id: string; x: number; y: number }>();
    for (const n of f.nodes) {
      const id = randomUUID();
      await db.node.create({ data: { id, tenantId, floorId: floor.id, x: n.x, y: n.y, name: n.name ?? n.key, type: n.type ?? 'NORMAL' } });
      byKey.set(n.key, { id, x: n.x, y: n.y });
      nodeIds.set(`${f.number}:${n.key}`, id);
    }
    for (const [a, b] of f.edges) {
      const from = byKey.get(a)!;
      const to = byKey.get(b)!;
      const weight = Math.hypot(from.x - to.x, from.y - to.y);
      const [low, high] = [from.id, to.id].sort();
      await db.edge.create({ data: { tenantId, floorId: floor.id, fromNodeId: from.id, toNodeId: to.id, nodeLowId: low, nodeHighId: high, weight, weightMeters: weight * f.metersPerPixel } });
    }
    for (const p of f.pois ?? []) {
      const n = byKey.get(p.node)!;
      await db.poi.create({ data: { tenantId, floorId: floor.id, nodeId: n.id, name: p.name, category: p.category, x: n.x, y: n.y, snapDistanceMeters: 0 } });
    }
    for (const s of f.stores ?? []) {
      const n = byKey.get(s.node)!;
      const store = await db.store.create({ data: { tenantId, floorId: floor.id, nodeId: n.id, name: s.name, description: s.description ?? null, images: [], status: 'ACTIVE' } });
      if (s.promo) {
        const start = new Date();
        await db.promotion.create({ data: { tenantId, storeId: store.id, title: s.promo, startAt: start, endAt: new Date(start.getTime() + 365 * 86_400_000), status: 'ACTIVE' } });
      }
    }
  }
  for (const c of input.connectors ?? []) {
    const connector = await db.connector.create({ data: { tenantId, buildingId: building.id, kind: c.kind, name: c.name } });
    for (const s of c.stops) await db.connectorStop.create({ data: { connectorId: connector.id, floorId: floorIds.get(s.floor)!, nodeId: nodeIds.get(`${s.floor}:${s.node}`)! } });
  }
  for (const q of input.qr ?? []) {
    const tokenHash = createHash('sha256').update(q.token).digest('hex');
    const node = nodeIds.get(`${q.floor}:${q.node}`)!;
    await db.qrAnchor.upsert({
      where: { tokenHash },
      update: { deletedAt: null, buildingId: building.id, floorId: floorIds.get(q.floor)!, nodeId: node, label: q.label },
      create: { tenantId, buildingId: building.id, floorId: floorIds.get(q.floor)!, nodeId: node, tokenHash, label: q.label },
    });
    console.log(`  QR "${q.label}"  token: ${q.token}`);
  }
  console.log(`\nXong. Tòa "${building.name}" (${building.id}). Dán token QR vào ô nhập mã của app mobile để vào tòa này.`);
  } catch (e) {
    if (!existing) {
      await wipe(building.id).catch(() => undefined);
      await db.building.delete({ where: { id: building.id } }).catch(() => undefined);
      console.error('Lỗi giữa chừng: đã gỡ tòa vừa tạo dở, database không bị để lại dữ liệu thừa.');
    }
    throw e;
  }
}

async function wipe(buildingId: string) {
  const floors: { id: string }[] = await db.floor.findMany({ where: { buildingId }, select: { id: true } });
  const floorIds = floors.map((f) => f.id);
  const stores: { id: string }[] = await db.store.findMany({ where: { floorId: { in: floorIds } }, select: { id: true } });
  await db.qrAnchor.deleteMany({ where: { buildingId } });
  const connectors: { id: string }[] = await db.connector.findMany({ where: { buildingId }, select: { id: true } });
  await db.connectorStop.deleteMany({ where: { connectorId: { in: connectors.map((c) => c.id) } } });
  await db.connector.deleteMany({ where: { buildingId } });
  await db.elevatorLink.deleteMany({ where: { buildingId } });
  await db.promotion.deleteMany({ where: { storeId: { in: stores.map((s) => s.id) } } });
  await db.store.deleteMany({ where: { floorId: { in: floorIds } } });
  await db.poi.deleteMany({ where: { floorId: { in: floorIds } } });
  await db.edge.deleteMany({ where: { floorId: { in: floorIds } } });
  await db.node.deleteMany({ where: { floorId: { in: floorIds } } });
  await db.floorMapRevision.deleteMany({ where: { floorId: { in: floorIds } } });
  await db.graphDraftApplication.deleteMany({ where: { floorId: { in: floorIds } } });
  await db.floor.deleteMany({ where: { buildingId } });
}

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.log('Cách dùng: npm run demo:import -- <file.json> [--dry] [--replace]');
  process.exit(1);
}
run(file, args.includes('--dry'), args.includes('--replace'))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
