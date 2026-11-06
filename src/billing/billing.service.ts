import { ConflictException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { OrderKind, OrderStatus, PlanOrder, Prisma, ServicePackage, UserRole } from '@prisma/client';
import { randomUUID } from 'crypto';
import { AuthService } from '../auth/auth.service';
import { AuthUser } from '../common/auth.types';
import { PrismaService } from '../database/prisma.service';
import { CreateRenewalOrderDto, CreateWorkspaceOrderDto } from './billing.dto';
import { PLANS, PURCHASABLE_PLANS, addMonths, orderAmountVnd } from './plans';

/** Without a real payment provider only the mock gateway can confirm payments, and never in production. */
function mockGatewayEnabled() {
  const provider = process.env.PAYMENT_PROVIDER;
  return provider === 'mock' || (provider === undefined && process.env.NODE_ENV !== 'production');
}

@Injectable()
export class BillingService {
  constructor(private readonly prisma: PrismaService, private readonly auth: AuthService) {}

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
      workspaceName: order.workspaceName,
      subdomain: order.subdomain,
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

  /** Step 1 of onboarding: the Owner picks a plan and the workspace identity; nothing is provisioned until payment. */
  async createWorkspaceOrder(user: AuthUser, dto: CreateWorkspaceOrderDto) {
    const plan = this.purchasablePlan(dto.planId);
    const current = await this.prisma.user.findUniqueOrThrow({ where: { id: user.userId }, include: { tenant: true } });
    if (current.tenantId && current.tenant && !current.tenant.deletedAt) {
      throw new ConflictException({ code: 'ALREADY_HAS_WORKSPACE', message: 'Tài khoản đã thuộc một workspace.' });
    }
    // The column is unique across soft-deleted tenants too, so do not filter on deletedAt.
    if (await this.prisma.tenant.findUnique({ where: { subdomain: dto.subdomain }, select: { id: true } })) {
      throw new ConflictException({ code: 'SUBDOMAIN_EXISTS', message: `Tên miền "${dto.subdomain}.spotway.app" đã được sử dụng. Vui lòng chọn tên khác.` });
    }
    const order = await this.prisma.$transaction(async (tx) => {
      await tx.planOrder.updateMany({ where: { userId: user.userId, kind: OrderKind.NEW_WORKSPACE, status: OrderStatus.PENDING }, data: { status: OrderStatus.CANCELLED } });
      return tx.planOrder.create({
        data: { userId: user.userId, kind: OrderKind.NEW_WORKSPACE, plan: plan.id, months: dto.months, amountVnd: orderAmountVnd(plan, dto.months), workspaceName: dto.workspaceName.trim(), subdomain: dto.subdomain },
      });
    });
    return this.serialize(order);
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
    if (order.amountVnd > 0 && !mockGatewayEnabled()) {
      throw new HttpException({ code: 'PAYMENT_PROVIDER_NOT_CONFIGURED', message: 'Cổng thanh toán chưa được cấu hình.' }, HttpStatus.NOT_IMPLEMENTED);
    }
    return this.completeOrder(order.id, `MOCK-${randomUUID()}`);
  }

  /** Single place that turns a paid order into a workspace or an extended subscription. */
  async completeOrder(orderId: string, paymentRef: string) {
    let paid: PlanOrder;
    try {
      paid = await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.planOrder.updateMany({ where: { id: orderId, status: OrderStatus.PENDING }, data: { status: OrderStatus.PAID, paidAt: new Date(), paymentRef } });
        if (claimed.count !== 1) throw new ConflictException({ code: 'ORDER_NOT_PAYABLE', message: 'Đơn hàng không còn ở trạng thái chờ thanh toán.' });
        const order = await tx.planOrder.findUniqueOrThrow({ where: { id: orderId } });
        const now = new Date();
        if (order.kind === OrderKind.NEW_WORKSPACE) {
          const owner = await tx.user.findUniqueOrThrow({ where: { id: order.userId } });
          if (owner.tenantId && (await tx.tenant.findFirst({ where: { id: owner.tenantId, deletedAt: null }, select: { id: true } }))) {
            throw new ConflictException({ code: 'ALREADY_HAS_WORKSPACE', message: 'Tài khoản đã thuộc một workspace.' });
          }
          const tenant = await tx.tenant.create({ data: { name: order.workspaceName!, subdomain: order.subdomain!, servicePackage: order.plan, planExpiresAt: addMonths(now, order.months) } });
          await tx.user.update({ where: { id: owner.id }, data: { tenantId: tenant.id, role: owner.role === UserRole.ADMIN ? UserRole.ADMIN : UserRole.BUILDING_OWNER } });
          return tx.planOrder.update({ where: { id: order.id }, data: { tenantId: tenant.id } });
        }
        const tenant = await tx.tenant.findFirst({ where: { id: order.tenantId!, deletedAt: null } });
        if (!tenant) throw new NotFoundException({ code: 'TENANT_NOT_FOUND', message: 'Không gian làm việc không tồn tại hoặc đã bị đóng' });
        const base = tenant.planExpiresAt && tenant.planExpiresAt > now ? tenant.planExpiresAt : now;
        await tx.tenant.update({ where: { id: tenant.id }, data: { servicePackage: order.plan, planExpiresAt: addMonths(base, order.months) } });
        return order;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException({ code: 'SUBDOMAIN_EXISTS', message: 'Tên miền workspace vừa được người khác sử dụng. Vui lòng chọn tên khác.' });
      }
      throw error;
    }
    return this.result(paid);
  }

  private async result(order: PlanOrder) {
    const session = order.kind === OrderKind.NEW_WORKSPACE ? await this.auth.issueSession(order.userId) : null;
    return { order: this.serialize(order), session };
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
