import { ContractAccessService, vietnamToday } from './contract-access.service';

const build = (rows: unknown[] | Error) => {
  const prisma = { $queryRaw: jest.fn(() => (rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows))) } as any;
  return { service: new ContractAccessService(prisma), prisma };
};

describe('vietnamToday', () => {
  it('uses the Vietnam calendar day (UTC+7)', () => {
    expect(vietnamToday(Date.parse('2026-11-20T16:59:00Z'))).toBe('2026-11-20');
    expect(vietnamToday(Date.parse('2026-11-20T17:00:00Z'))).toBe('2026-11-21');
  });
});

describe('ContractAccessService', () => {
  const past = '2000-01-01';
  const future = '2999-12-31';

  it('reports a workspace whose last contract ended', async () => {
    const { service } = build([{ contract_code: 'HD-1', end_date: past }]);
    await expect(service.expiredContract('t1')).resolves.toEqual({ contractCode: 'HD-1', endDate: past });
  });

  it('is fine while the contract runs, including its last day', async () => {
    await expect(build([{ contract_code: 'HD-1', end_date: future }]).service.expiredContract('t1')).resolves.toBeNull();
    await expect(build([{ contract_code: 'HD-1', end_date: vietnamToday() }]).service.expiredContract('t1')).resolves.toBeNull();
  });

  it('leaves a workspace without any contract alone', async () => {
    await expect(build([]).service.expiredContract('t1')).resolves.toBeNull();
  });

  it('never locks anyone out when the check itself fails (for example the table does not exist yet)', async () => {
    const { service } = build(new Error('relation "contracts" does not exist'));
    await expect(service.expiredContract('t1')).resolves.toBeNull();
  });

  it('caches an answer until a contract changes', async () => {
    const { service, prisma } = build([{ contract_code: 'HD-1', end_date: past }]);
    await service.expiredContract('t1');
    await service.expiredContract('t1');
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    service.invalidate();
    await service.expiredContract('t1');
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });
});
