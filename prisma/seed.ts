import { NodeType, PrismaClient, StoreStatus, UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
const prisma = new PrismaClient();
async function main() {
  const passwordHash = await bcrypt.hash('ChangeMe123!', 12);
  const tenant = await prisma.tenant.upsert({ where: { subdomain: 'demo-mall' }, update: {}, create: { name: 'Demo Mall', subdomain: 'demo-mall' } });
  const admin = await prisma.user.upsert({ where: { email: 'admin@spotway.local' }, update: {}, create: { email: 'admin@spotway.local', passwordHash, role: UserRole.ADMIN } });
  const owner = await prisma.user.upsert({ where: { email: 'owner@demo-mall.local' }, update: {}, create: { email: 'owner@demo-mall.local', passwordHash, role: UserRole.BUILDING_OWNER, tenantId: tenant.id } });
  const manager = await prisma.user.upsert({ where: { email: 'manager@demo-mall.local' }, update: {}, create: { email: 'manager@demo-mall.local', passwordHash, role: UserRole.BUILDING_MANAGER, tenantId: tenant.id } });
  const storeOwner = await prisma.user.upsert({ where: { email: 'store-owner@demo-mall.local' }, update: {}, create: { email: 'store-owner@demo-mall.local', passwordHash, role: UserRole.STORE_OWNER, tenantId: tenant.id } });
  const building = await prisma.building.upsert({ where: { id: '00000000-0000-4000-8000-000000000001' }, update: {}, create: { id: '00000000-0000-4000-8000-000000000001', tenantId: tenant.id, name: 'Demo Mall Building', address: 'Demo Address' } });
  await prisma.staffAssignment.upsert({ where: { userId_buildingId: { userId: manager.id, buildingId: building.id } }, update: {}, create: { userId: manager.id, buildingId: building.id } });
  const ensureFloor = async (floorNumber: number, name: string) => {
    const existing = await prisma.floor.findFirst({ where: { buildingId: building.id, floorNumber, deletedAt: null } });
    return existing ?? prisma.floor.create({ data: { tenantId: tenant.id, buildingId: building.id, floorNumber, name } });
  };
  const ground = await ensureFloor(1, 'Ground Floor');
  const first = await ensureFloor(2, 'First Floor');
  const nodeData = [
    ['00000000-0000-4000-8000-000000000101', ground.id, 100, 100, NodeType.NORMAL],
    ['00000000-0000-4000-8000-000000000102', ground.id, 300, 100, NodeType.ELEVATOR],
    ['00000000-0000-4000-8000-000000000201', first.id, 100, 100, NodeType.NORMAL],
    ['00000000-0000-4000-8000-000000000202', first.id, 300, 100, NodeType.ELEVATOR],
  ] as const;
  for (const [id, floorId, x, y, type] of nodeData) await prisma.node.upsert({ where: { id }, update: {}, create: { id, tenantId: tenant.id, floorId, x, y, type } });
  await prisma.edge.upsert({ where: { id: '00000000-0000-4000-8000-000000000301' }, update: {}, create: { id: '00000000-0000-4000-8000-000000000301', tenantId: tenant.id, floorId: ground.id, fromNodeId: nodeData[0][0], toNodeId: nodeData[1][0], nodeLowId: nodeData[0][0], nodeHighId: nodeData[1][0], weight: 200 } });
  await prisma.edge.upsert({ where: { id: '00000000-0000-4000-8000-000000000302' }, update: {}, create: { id: '00000000-0000-4000-8000-000000000302', tenantId: tenant.id, floorId: first.id, fromNodeId: nodeData[2][0], toNodeId: nodeData[3][0], nodeLowId: nodeData[2][0], nodeHighId: nodeData[3][0], weight: 200 } });
  await prisma.elevatorLink.upsert({ where: { id: '00000000-0000-4000-8000-000000000401' }, update: {}, create: { id: '00000000-0000-4000-8000-000000000401', tenantId: tenant.id, buildingId: building.id, nodeIdFrom: nodeData[1][0], nodeIdTo: nodeData[3][0], nodeLowId: nodeData[1][0], nodeHighId: nodeData[3][0] } });
  await prisma.store.upsert({ where: { id: '00000000-0000-4000-8000-000000000501' }, update: {}, create: { id: '00000000-0000-4000-8000-000000000501', tenantId: tenant.id, floorId: ground.id, nodeId: nodeData[0][0], ownerId: storeOwner.id, name: 'Demo Store', images: [], status: StoreStatus.ACTIVE } });
  console.log({ admin: admin.email, owner: owner.email, manager: manager.email, storeOwner: storeOwner.email, password: 'ChangeMe123!' });
}
main().finally(() => prisma.$disconnect());
