import { ServicePackage } from '@prisma/client';

export interface PlanDefinition {
  id: ServicePackage;
  name: string;
  maxBuildings: number;
  maxManagers: number;
  maxStoreOwners: number;
  /** Per-month price when paying for 12 months or more. */
  priceVnd: number;
  /** Per-month price when paying for less than 12 months. */
  monthlyPriceVnd: number;
  durationMonths: number;
  /** Can be bought online. ENTERPRISE is sales-led (admin assigns it) and FREE is a legacy tier. */
  purchasable: boolean;
}

export const PLANS: Record<ServicePackage, PlanDefinition> = {
  FREE: { id: 'FREE', name: 'Gói Dùng Thử Miễn Phí', maxBuildings: 3, maxManagers: 2, maxStoreOwners: 10, priceVnd: 0, monthlyPriceVnd: 0, durationMonths: 12, purchasable: false },
  STARTER: { id: 'STARTER', name: 'Gói Khởi Đầu (Starter)', maxBuildings: 5, maxManagers: 3, maxStoreOwners: 30, priceVnd: 1_990_000, monthlyPriceVnd: 2_490_000, durationMonths: 12, purchasable: true },
  PRO: { id: 'PRO', name: 'Gói Chuyên Nghiệp (Pro)', maxBuildings: 1000, maxManagers: 100, maxStoreOwners: 1000, priceVnd: 4_990_000, monthlyPriceVnd: 6_290_000, durationMonths: 12, purchasable: true },
  ENTERPRISE: { id: 'ENTERPRISE', name: 'Gói Doanh Nghiệp (Enterprise)', maxBuildings: 10_000, maxManagers: 1000, maxStoreOwners: 10_000, priceVnd: 0, monthlyPriceVnd: 0, durationMonths: 12, purchasable: false },
};

export const PURCHASABLE_PLANS = Object.values(PLANS).filter((plan) => plan.purchasable);

export function orderAmountVnd(plan: PlanDefinition, months: number) {
  return (months >= 12 ? plan.priceVnd : plan.monthlyPriceVnd) * months;
}

export function addMonths(from: Date, months: number) {
  const next = new Date(from);
  next.setMonth(next.getMonth() + months);
  return next;
}
