import { BadRequestException, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AuthUser } from '../common/auth.types';
import { IncidentsService } from './incidents.service';

const user: AuthUser = { userId: 'u', role: UserRole.BUILDING_MANAGER, tenantId: 't' };

function setup(nodes: { id: string; floorId: string }[] = [], building: unknown = { id: 'b' }) {
  const prisma = { node: { findMany: jest.fn().mockResolvedValue(nodes) }, building: { findFirst: jest.fn().mockResolvedValue(building) } };
  const access = { building: jest.fn().mockResolvedValue({}) };
  return { prisma, access, service: new IncidentsService(prisma as never, access as never) };
}

describe('IncidentsService', () => {
  it('starts an incident, de-duplicates nodes and reports the floors', async () => {
    const { service, access } = setup([{ id: 'n1', floorId: 'f1' }, { id: 'n2', floorId: 'f1' }]);
    const incident = await service.start(user, 'b', ['n1', 'n1', 'n2'], '  Cháy  ');
    expect(access.building).toHaveBeenCalledWith(user, 'b');
    expect(incident).toMatchObject({ active: true, type: 'FIRE', nodeIds: ['n1', 'n2'], floorIds: ['f1'], message: 'Cháy' });
    expect(await service.publicState('b')).toMatchObject({ active: true, id: incident.id });
  });

  it('rejects nodes outside the building', async () => {
    const { service } = setup([{ id: 'n1', floorId: 'f1' }]);
    await expect(service.start(user, 'b', ['n1', 'x'])).rejects.toBeInstanceOf(BadRequestException);
    expect(await service.publicState('b')).toEqual({ active: false });
  });

  it('clearing ends the emergency', async () => {
    const { service } = setup([{ id: 'n1', floorId: 'f1' }]);
    await service.start(user, 'b', ['n1']);
    await service.clear(user, 'b');
    expect(await service.publicState('b')).toEqual({ active: false });
  });

  it('incidents are per building', async () => {
    const { service } = setup([{ id: 'n1', floorId: 'f1' }]);
    await service.start(user, 'b1', ['n1']);
    expect(await service.publicState('b2')).toEqual({ active: false });
  });

  it('public state of an unavailable building is a 404', async () => {
    const { service } = setup([], null);
    await expect(service.publicState('b')).rejects.toBeInstanceOf(NotFoundException);
  });
});
