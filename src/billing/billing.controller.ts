import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthUser } from '../common/auth.types';
import { CurrentUser } from '../common/current-user.decorator';
import { Public } from '../common/public.decorator';
import { ApiEnvelopeResponse, ApiStandardErrors } from '../common/swagger';
import { CreateWorkspaceOrderDto } from './billing.dto';
import { BillingService } from './billing.service';

@ApiTags('Billing')
@ApiBearerAuth('bearerAuth')
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Public()
  @Get('plans')
  @ApiOperation({ summary: 'Plans that can be bought online' })
  @ApiEnvelopeResponse(200, 'Plans returned successfully')
  plans() {
    return this.billing.listPlans();
  }

  @Post('orders')
  @ApiOperation({ summary: 'Start buying a plan for a new workspace; the workspace is created once the order is paid' })
  @ApiEnvelopeResponse(201, 'Order created successfully')
  @ApiStandardErrors()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateWorkspaceOrderDto) {
    return this.billing.createWorkspaceOrder(user, dto);
  }

  @Get('orders/:id')
  @ApiOperation({ summary: 'Get one of my orders' })
  @ApiEnvelopeResponse(200, 'Order returned successfully')
  @ApiStandardErrors()
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.billing.getOrder(user, id);
  }

  @Post('orders/:id/pay')
  @ApiOperation({ summary: 'Pay an order (mock gateway outside production) and provision the workspace / extend the plan' })
  @ApiEnvelopeResponse(201, 'Order paid successfully')
  @ApiStandardErrors()
  pay(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.billing.pay(user, id);
  }

  @Post('orders/:id/cancel')
  @ApiOperation({ summary: 'Cancel a pending order' })
  @ApiEnvelopeResponse(201, 'Order cancelled successfully')
  @ApiStandardErrors()
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.billing.cancelOrder(user, id);
  }
}
