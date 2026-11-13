import { BadRequestException, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AuthUser } from '../common/auth.types';
import { IncidentsService } from './incidents.service';

const user: AuthUser = { userId: 'u', role: UserRole.BUILDING_MANAGER, tenantId: 't' };

function setup(nodes: { id: string; floorId: string }[] = [], building: unknown = { id: 'b' }) {
  const prisma = { node: { findMany: jest.fn().mockResolvedValue(nodes), count: jest.fn().mockResolvedValue(1) }, building: { findFirst: jest.fn().mockResolvedValue(building) } };
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

  describe('exit claims', () => {
    it('ignores claims while there is no incident', async () => {
      const { service } = setup([{ id: 'n1', floorId: 'f1' }]);
      expect(await service.claim('b', 'd1', 'x1')).toEqual({ active: false, loads: {} });
    });

    it('counts other phones per exit and leaves the caller out', async () => {
      const { service } = setup([{ id: 'n1', floorId: 'f1' }]);
      await service.start(user, 'b', ['n1']);
      await service.claim('b', 'd1', 'x1');
      await service.claim('b', 'd2', 'x1');
      const third = await service.claim('b', 'd3', 'x2');
      expect(third.loads).toEqual({ x1: 2 });
      expect((await service.publicLoads('b', 'd1')).loads).toEqual({ x1: 1, x2: 1 });
      expect(service.evacuees('b')).toBe(3);
    });

    it('a phone that changes exit moves its claim', async () => {
      const { service } = setup([{ id: 'n1', floorId: 'f1' }]);
      await service.start(user, 'b', ['n1']);
      await service.claim('b', 'd1', 'x1');
      await service.claim('b', 'd1', 'x2');
      expect(service.loads('b')).toEqual({ x2: 1 });
    });

    it('claims expire when a phone stops reporting, and ending the incident clears them', async () => {
      const { service } = setup([{ id: 'n1', floorId: 'f1' }]);
      jest.useFakeTimers().setSystemTime(0);
      await service.start(user, 'b', ['n1']);
      await service.claim('b', 'd1', 'x1');
      jest.setSystemTime(IncidentsService.CLAIM_TTL_MS + 1);
      expect(service.evacuees('b')).toBe(0);
      await service.claim('b', 'd2', 'x1');
      await service.clear(user, 'b');
      expect(service.evacuees('b')).toBe(0);
      jest.useRealTimers();
    });

    it('rejects an exit that is not in the building', async () => {
      const { service, prisma } = setup([{ id: 'n1', floorId: 'f1' }]);
      await service.start(user, 'b', ['n1']);
      prisma.node.count.mockResolvedValue(0);
      await expect(service.claim('b', 'd1', 'nope')).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
