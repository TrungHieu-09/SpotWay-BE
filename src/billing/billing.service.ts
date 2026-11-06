import { ConflictException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { OrderKind, OrderStatus, PlanOrder, ServicePackage } from '@prisma/client';
import { randomUUID } from 'crypto';
import { AuthUser } from '../common/auth.types';
import { PrismaService } from '../database/prisma.service';
import { CreateRenewalOrderDto } from './billing.dto';
import { PLANS, PURCHASABLE_PLANS, addMonths, orderAmountVnd } from './plans';

/** Without a real payment provider only the mock gateway can confirm payments, and never in production. */
function mockGatewayEnabled() {
  const provider = process.env.PAYMENT_PROVIDER;
  return provider === 'mock' || (provider === undefined && process.env.NODE_ENV !== 'production');
}

/** Workspaces are created by an admin (POST /tenants); the only thing bought online is a renewal/upgrade of an existing one. */
@Injectable()
export class BillingService {
  constructor(private readonly prisma: PrismaService) {}

  listPlans() {
    return PURCHASABLE_PLANS;
  }

  serialize(order: PlanOrder) {
    return {
      id: order.id,
      kind: order.kind,
      planId: order.plan,
      planName: PLANS[order.plan].name,
      months: order.months,
      amountVnd: order.amountVnd,
      status: order.status,
      createdAt: order.createdAt.toISOString(),
      paidAt: order.paidAt?.toISOString() ?? null,
    };
  }

  private purchasablePlan(planId: ServicePackage) {
    const plan = PLANS[planId];
    if (!plan.purchasable) {
      throw new ConflictException({ code: 'PLAN_NOT_PURCHASABLE', message: 'Gói này không thể mua trực tuyến. Vui lòng liên hệ SpotWay.' });
    }
    return plan;
  }

  async createRenewalOrder(user: AuthUser, dto: CreateRenewalOrderDto) {
    const plan = this.purchasablePlan(dto.planId);
    if (!user.tenantId) throw new NotFoundException({ code: 'NO_TENANT', message: 'Tài khoản chưa thuộc không gian làm việc nào' });
    const tenant = await this.prisma.tenant.findFirst({ where: { id: user.tenantId, deletedAt: null }, select: { id: true } });
    if (!tenant) throw new NotFoundException({ code: 'TENANT_NOT_FOUND', message: 'Không gian làm việc không tồn tại hoặc đã bị đóng' });
    const order = await this.prisma.$transaction(async (tx) => {
      await tx.planOrder.updateMany({ where: { tenantId: tenant.id, kind: OrderKind.RENEWAL, status: OrderStatus.PENDING }, data: { status: OrderStatus.CANCELLED } });
      return tx.planOrder.create({
        data: { userId: user.userId, tenantId: tenant.id, kind: OrderKind.RENEWAL, plan: plan.id, months: dto.months, amountVnd: orderAmountVnd(plan, dto.months) },
      });
    });
    return this.serialize(order);
  }

  private async owned(user: AuthUser, id: string) {
    const order = await this.prisma.planOrder.findFirst({ where: { id, userId: user.userId } });
    if (!order) throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Không tìm thấy đơn hàng' });
    return order;
  }

  async getOrder(user: AuthUser, id: string) {
    return this.serialize(await this.owned(user, id));
  }

  async cancelOrder(user: AuthUser, id: string) {
    const order = await this.owned(user, id);
    if (order.status === OrderStatus.PAID) throw new ConflictException({ code: 'ORDER_NOT_PAYABLE', message: 'Đơn hàng đã được thanh toán.' });
    await this.prisma.planOrder.updateMany({ where: { id, status: OrderStatus.PENDING }, data: { status: OrderStatus.CANCELLED } });
    return this.serialize(await this.owned(user, id));
  }

  /** Mock checkout used until a real provider is wired up; a provider webhook should call completeOrder directly. */
  async pay(user: AuthUser, id: string) {
    const order = await this.owned(user, id);
    if (order.status === OrderStatus.PAID) return this.result(order);
    if (order.status !== OrderStatus.PENDING) throw new ConflictException({ code: 'ORDER_NOT_PAYABLE', message: 'Đơn hàng đã bị hủy.' });
    if (order.kind !== OrderKind.RENEWAL) throw new ConflictException({ code: 'ORDER_NOT_PAYABLE', message: 'Loại đơn hàng này không còn được hỗ trợ. Vui lòng liên hệ quản trị viên.' });
    if (order.amountVnd > 0 && !mockGatewayEnabled()) {
      throw new HttpException({ code: 'PAYMENT_PROVIDER_NOT_CONFIGURED', message: 'Cổng thanh toán chưa được cấu hình.' }, HttpStatus.NOT_IMPLEMENTED);
    }
    return this.completeOrder(order.id, `MOCK-${randomUUID()}`);
  }

  /** Single place that turns a paid renewal order into an extended subscription. */
  async completeOrder(orderId: string, paymentRef: string) {
    const paid = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.planOrder.updateMany({ where: { id: orderId, status: OrderStatus.PENDING }, data: { status: OrderStatus.PAID, paidAt: new Date(), paymentRef } });
      if (claimed.count !== 1) throw new ConflictException({ code: 'ORDER_NOT_PAYABLE', message: 'Đơn hàng không còn ở trạng thái chờ thanh toán.' });
      const order = await tx.planOrder.findUniqueOrThrow({ where: { id: orderId } });
      // Rolls the claim back: orders for creating a workspace were removed, and an old one must never be fulfilled.
      if (order.kind !== OrderKind.RENEWAL || !order.tenantId) throw new ConflictException({ code: 'ORDER_NOT_PAYABLE', message: 'Loại đơn hàng này không còn được hỗ trợ.' });
      const now = new Date();
      const tenant = await tx.tenant.findFirst({ where: { id: order.tenantId, deletedAt: null } });
      if (!tenant) throw new NotFoundException({ code: 'TENANT_NOT_FOUND', message: 'Không gian làm việc không tồn tại hoặc đã bị đóng' });
      const base = tenant.planExpiresAt && tenant.planExpiresAt > now ? tenant.planExpiresAt : now;
      await tx.tenant.update({ where: { id: tenant.id }, data: { servicePackage: order.plan, planExpiresAt: addMonths(base, order.months) } });
      return order;
    });
    return this.result(paid);
  }

  private result(order: PlanOrder) {
    return { order: this.serialize(order) };
  }

  async listInvoices(tenantId: string | null) {
    if (!tenantId) return [];
    const orders = await this.prisma.planOrder.findMany({ where: { tenantId, status: OrderStatus.PAID }, orderBy: { paidAt: 'desc' } });
    return orders.map((order) => ({
      id: order.id,
      tenantId,
      planId: order.plan,
      amountVnd: order.amountVnd,
      months: order.months,
      paidAt: (order.paidAt ?? order.createdAt).toISOString(),
      status: 'paid' as const,
    }));
  }
}
