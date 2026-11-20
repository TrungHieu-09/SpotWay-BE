import { ContractAccessService, dayBefore, vietnamToday } from './contract-access.service';

const row = (over: Record<string, unknown> = {}) => ({ contract_code: 'HD-1', end_date: '2999-12-31', terminated_at: null, termination_reason: null, ...over });

const build = (rows: unknown[] | Error) => {
  const prisma = {
    $executeRawUnsafe: jest.fn().mockResolvedValue(0),
    $queryRaw: jest.fn(() => (rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows))),
  } as any;
  return { service: new ContractAccessService(prisma), prisma };
};

describe('vietnamToday / dayBefore', () => {
  it('uses the Vietnam calendar day (UTC+7)', () => {
    expect(vietnamToday(Date.parse('2026-11-20T16:59:00Z'))).toBe('2026-11-20');
    expect(vietnamToday(Date.parse('2026-11-20T17:00:00Z'))).toBe('2026-11-21');
  });

  it('steps back one calendar day, across months and years', () => {
    expect(dayBefore('2026-11-20')).toBe('2026-11-19');
    expect(dayBefore('2026-03-01')).toBe('2026-02-28');
    expect(dayBefore('2027-01-01')).toBe('2026-12-31');
  });
});

describe('ContractAccessService', () => {
  const past = '2000-01-01';
  const today = vietnamToday();

  it('reports a workspace whose last contract ended', async () => {
    const { service } = build([row({ end_date: past })]);
    await expect(service.expiredContract('t1')).resolves.toEqual({ contractCode: 'HD-1', endDate: past, terminatedAt: null, terminationReason: null });
  });

  it('is fine while the contract runs, including its last day', async () => {
    await expect(build([row()]).service.expiredContract('t1')).resolves.toBeNull();
    await expect(build([row({ end_date: today })]).service.expiredContract('t1')).resolves.toBeNull();
  });

  it('leaves a workspace without any contract alone', async () => {
    await expect(build([]).service.expiredContract('t1')).resolves.toBeNull();
  });

  it('locks from the termination date and keeps the reason', async () => {
    const { service } = build([row({ terminated_at: past, termination_reason: 'Vi phạm điều khoản' })]);
    await expect(service.expiredContract('t1')).resolves.toEqual({ contractCode: 'HD-1', endDate: '2999-12-31', terminatedAt: past, terminationReason: 'Vi phạm điều khoản' });
  });

  it('a contract ended from today is already locked (service stops the day it is terminated)', async () => {
    await expect(build([row({ terminated_at: today })]).service.expiredContract('t1')).resolves.toMatchObject({ terminatedAt: today });
  });

  it('a termination that starts tomorrow still lets people work today', async () => {
    const tomorrow = new Date(Date.now() + 7 * 3600e3 + 864e5).toISOString().slice(0, 10);
    await expect(build([row({ terminated_at: tomorrow })]).service.expiredContract('t1')).resolves.toBeNull();
  });

  it('another running contract keeps the workspace open', async () => {
    const { service } = build([row({ contract_code: 'OLD', terminated_at: past }), row({ contract_code: 'NEW' })]);
    await expect(service.expiredContract('t1')).resolves.toBeNull();
  });

  it('plain expiry is not reported as a termination when the end date comes first', async () => {
    const { service } = build([row({ end_date: past, terminated_at: '2999-01-01', termination_reason: 'x' })]);
    await expect(service.expiredContract('t1')).resolves.toMatchObject({ terminatedAt: null, terminationReason: null });
  });

  it('never locks anyone out when the check itself fails (for example the table does not exist yet)', async () => {
    const { service } = build(new Error('relation "contracts" does not exist'));
    await expect(service.expiredContract('t1')).resolves.toBeNull();
  });

  it('caches an answer until a contract changes', async () => {
    const { service, prisma } = build([row({ end_date: past })]);
    await service.expiredContract('t1');
    await service.expiredContract('t1');
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    service.invalidate();
    await service.expiredContract('t1');
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });
});
