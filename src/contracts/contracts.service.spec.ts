import { ValidationPipe } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CreateContractDto, RenewalRequestDto, UpdateContractDto } from './contracts.dto';
import { ContractsService } from './contracts.service';

const png = 'data:image/png;base64,iVBORw0KGgo=';
const page = { fileName: 'scan-1.png', sizeText: '0.01 MB', mime: 'image/png', dataUrl: png };
const OWNER_ID = '8f14e45f-ceea-4e6b-9d6f-0f1d2a3b4c5d';

const base = {
  ownerId: OWNER_ID,
  customerName: 'Demo Mall',
  representative: 'Nguyen Van A',
  workspaceDomain: 'demo-mall.spotway.app',
  startDate: '2026-01-01',
  endDate: '2026-12-31',
  annualValue: 24000,
  currency: 'USD' as const,
  paymentStatus: 'paid' as const,
  maxBuildings: 3,
  maxFloors: 15,
  scanPages: [page],
};

const row = (over: Record<string, unknown> = {}) => ({
  id: 'cnt_1', contract_code: 'HD-2026-001', owner_id: OWNER_ID, tenant_id: 't1', customer_name: 'Demo Mall', owner_email: 'owner@demo.vn',
  representative: 'A', workspace_domain: 'd.spotway.app', start_date: '2026-01-01', end_date: '2026-12-31', annual_value: '24000',
  currency: 'USD', billing_label: null, payment_status: 'paid', max_buildings: 3, max_floors: 15, page_count: 1, scan_file_name: 'scan-1.png',
  scan_pages: JSON.stringify([page]), has_scan: true, notes: '', renewal_requested: false, renewal_note: null,
  created_at: new Date('2026-01-02T00:00:00Z'), updated_at: new Date('2026-01-02T00:00:00Z'), ...over,
});

function build(opts: { owner?: object | null; queryRaw?: jest.Mock; executeRaw?: jest.Mock } = {}) {
  const prisma = {
    $executeRawUnsafe: jest.fn().mockResolvedValue(0),
    $executeRaw: opts.executeRaw ?? jest.fn().mockResolvedValue(1),
    $queryRaw: opts.queryRaw ?? jest.fn().mockResolvedValue([]),
    user: {
      findFirst: jest.fn().mockResolvedValue(opts.owner === undefined ? { id: OWNER_ID, email: 'owner@demo.vn', tenantId: 't1', role: UserRole.BUILDING_OWNER } : opts.owner),
      findUnique: jest.fn().mockResolvedValue({ email: 'owner@demo.vn' }),
    },
    tenant: { findUnique: jest.fn().mockResolvedValue({ name: 'Demo Mall' }) },
  };
  return { service: new ContractsService(prisma as never, { invalidate: jest.fn() } as never), prisma };
}

const owner = { userId: OWNER_ID, role: UserRole.BUILDING_OWNER, tenantId: 't1' };

describe('ContractsService.create', () => {
  it('rejects an end date before the start date and dates that do not exist', async () => {
    const { service, prisma } = build();
    await expect(service.create({ ...base, endDate: '2025-12-31' })).rejects.toMatchObject({ response: { code: 'INVALID_DATES' } });
    await expect(service.create({ ...base, startDate: '2026-02-31' })).rejects.toMatchObject({ response: { code: 'INVALID_DATES' } });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('needs at least one scan, a matching data URL and a bounded total size', async () => {
    const { service } = build();
    await expect(service.create({ ...base, scanPages: [] })).rejects.toMatchObject({ response: { code: 'SCAN_REQUIRED' } });
    await expect(service.create({ ...base, scanPages: [{ ...page, mime: 'application/pdf' }] })).rejects.toMatchObject({ response: { code: 'SCAN_INVALID' } });
    const big = { ...page, dataUrl: `data:image/png;base64,${'A'.repeat(13_000_000)}` };
    await expect(service.create({ ...base, scanPages: [big, big, big] })).rejects.toMatchObject({ response: { code: 'SCAN_TOO_LARGE' } });
  });

  it('refuses an owner that does not exist and a contract number already in use', async () => {
    await expect(build({ owner: null }).service.create(base)).rejects.toMatchObject({ response: { code: 'OWNER_NOT_FOUND' } });
    const dup = build({ queryRaw: jest.fn().mockResolvedValue([{ id: 'other' }]) });
    await expect(dup.service.create({ ...base, contractCode: 'HD-2026-001' })).rejects.toMatchObject({ response: { code: 'CONTRACT_CODE_EXISTS' } });
  });

  it('needs only the contract facts: the customer name comes from the owner workspace and quotas default to 0', async () => {
    const queryRaw = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([row()]);
    const { service, prisma } = build({ queryRaw });
    const { customerName: _c, representative: _r, workspaceDomain: _w, maxBuildings: _b, maxFloors: _f, ...minimal } = base;
    await service.create({ ...minimal, contractCode: 'HD-2026-002' });
    const values = prisma.$executeRaw.mock.calls[0].slice(1);
    expect(values).toEqual(expect.arrayContaining(['Demo Mall', 0]));
    expect(values).not.toContain(undefined);
  });

  it('links the contract to the owner account (tenant and email come from the account) and returns the stored scan', async () => {
    const queryRaw = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([row()]);
    const { service, prisma } = build({ queryRaw });
    const saved = await service.create({ ...base, contractCode: 'HD-2026-001' });
    const values = prisma.$executeRaw.mock.calls[0].slice(1);
    expect(values).toEqual(expect.arrayContaining([OWNER_ID, 't1', 'owner@demo.vn', 1]));
    expect(saved).toMatchObject({ contractCode: 'HD-2026-001', pageCount: 1, hasScan: true, annualValue: 24000 });
    expect(saved.scanPages[0].dataUrl).toBe(png);
  });
});

describe('ContractsService reads and writes', () => {
  it('lists without the scanned files and says whether a scan exists', async () => {
    const { service } = build({ queryRaw: jest.fn().mockResolvedValue([row({ scan_pages: undefined, has_scan: true })]) });
    const [item] = await service.adminList();
    expect(item.scanPages).toEqual([]);
    expect(item).toMatchObject({ hasScan: true, pageCount: 1 });
    expect(JSON.stringify(item)).not.toContain('base64');
  });

  it('shows an old single-file scan (scan_data_url) as one page', async () => {
    const { service } = build({ queryRaw: jest.fn().mockResolvedValue([row({ scan_pages: null, scan_data_url: png })]) });
    const detail = await service.adminGet('cnt_1');
    expect(detail.scanPages).toHaveLength(1);
    expect(detail.scanPages[0]).toMatchObject({ mime: 'image/png', dataUrl: png });
  });

  it('refuses to replace the scan with nothing, and reports missing contracts', async () => {
    const found = build({ queryRaw: jest.fn().mockResolvedValue([row()]) });
    await expect(found.service.update('cnt_1', { scanPages: [] })).rejects.toMatchObject({ response: { code: 'SCAN_REQUIRED' } });
    await expect(build().service.update('missing', { notes: 'x' })).rejects.toMatchObject({ response: { code: 'CONTRACT_NOT_FOUND' } });
    await expect(build({ executeRaw: jest.fn().mockResolvedValue(0) }).service.remove('missing')).rejects.toMatchObject({ response: { code: 'CONTRACT_NOT_FOUND' } });
  });

  it('only lets an owner open or renew a contract that is theirs', async () => {
    const none = build({ queryRaw: jest.fn().mockResolvedValue([]) });
    await expect(none.service.ownerGet(owner, 'cnt_other')).rejects.toMatchObject({ response: { code: 'CONTRACT_NOT_FOUND' } });
    await expect(none.service.requestRenewal(owner, 'cnt_other', 6, 'month', 'please')).rejects.toMatchObject({ response: { code: 'CONTRACT_NOT_FOUND' } });

    const mine = build({ queryRaw: jest.fn().mockResolvedValue([{ id: 'cnt_1' }]) });
    await expect(mine.service.requestRenewal(owner, 'cnt_1', 45, 'day', '  Cần thêm hạn mức  ')).resolves.toEqual({ id: 'cnt_1', renewalRequested: true, renewalAmount: 45, renewalUnit: 'day', renewalNote: 'Cần thêm hạn mức' });
    const sql = mine.prisma.$queryRaw.mock.calls[0][0].sql as string;
    expect(sql).toMatch(/"owner_id" =/);
    expect(sql).toMatch(/RETURNING "id"/);
  });
});

describe('contract DTO validation', () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
  const check = (metatype: new () => object, value: object) => pipe.transform(value, { type: 'body', metatype });

  it('accepts a complete payload', async () => {
    await expect(check(CreateContractDto, base)).resolves.toBeInstanceOf(CreateContractDto);
  });

  it.each([
    ['unknown field', { ...base, tenantId: 'x' }],
    ['bad currency', { ...base, currency: 'EUR' }],
    ['bad date shape', { ...base, startDate: '01/01/2026' }],
    ['negative value', { ...base, annualValue: -1 }],
    ['negative quota', { ...base, maxBuildings: -1 }],
    ['owner is not a uuid', { ...base, ownerId: 'abc' }],
    ['file type not allowed', { ...base, scanPages: [{ ...page, mime: 'application/zip' }] }],
    ['too many pages', { ...base, scanPages: Array.from({ length: 11 }, () => page) }],
  ])('rejects %s', async (_label, payload) => {
    await expect(check(CreateContractDto, payload)).rejects.toMatchObject({ status: 400 });
  });

  it.each([
    ['nothing', {}],
    ['no unit', { amount: 3 }],
    ['an unknown unit', { amount: 3, unit: 'year' }],
    ['zero', { amount: 0, unit: 'day' }],
    ['more than 3650', { amount: 3651, unit: 'day' }],
    ['a fraction', { amount: 1.5, unit: 'month' }],
  ])('rejects a renewal request with %s', async (_label, payload) => {
    await expect(check(RenewalRequestDto, payload)).rejects.toMatchObject({ status: 400 });
  });

  it('accepts a renewal request in days or months, with an optional note', async () => {
    await expect(check(RenewalRequestDto, { amount: 45, unit: 'day' })).resolves.toBeInstanceOf(RenewalRequestDto);
    await expect(check(RenewalRequestDto, { amount: 6, unit: 'month', note: 'Cần thêm hạn mức' })).resolves.toBeInstanceOf(RenewalRequestDto);
  });

  it('refuses more than 60 months', async () => {
    const { service } = build();
    await expect(service.requestRenewal(owner, 'cnt_1', 61, 'month')).rejects.toMatchObject({ response: { code: 'INVALID_RENEWAL' } });
  });

  it('allows a partial update and clearing the renewal note', async () => {
    await expect(check(UpdateContractDto, { endDate: '2027-12-31', renewalRequested: false, renewalNote: null })).resolves.toBeInstanceOf(UpdateContractDto);
  });
});
