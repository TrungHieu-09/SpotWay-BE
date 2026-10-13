import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { AuthUser } from '../common/auth.types'; import { CurrentUser } from '../common/current-user.decorator'; import { Public } from '../common/public.decorator'; import { Roles } from '../common/roles.decorator'; import { ApiEnvelopeResponse, ApiStandardErrors } from '../common/swagger';
import { CreatePromotionDto, UpdatePromotionDto } from './promotions.dto'; import { PromotionsService } from './promotions.service';
@ApiTags('Promotions') @Controller()
export class PromotionsController {
  constructor(private readonly promotions: PromotionsService) {}
  @Get('public/stores/:storeId/promotions') @Public() @ApiOperation({ summary: 'List currently valid public promotions' }) @ApiEnvelopeResponse(200, 'Promotions returned successfully') @ApiStandardErrors() publicList(@Param('storeId') storeId: string) { return this.promotions.publicList(storeId); }
  @Get('stores/:storeId/promotions') @ApiBearerAuth('bearerAuth') @Roles(UserRole.ADMIN, UserRole.BUILDING_OWNER, UserRole.STORE_OWNER) @ApiOperation({ summary: 'List store promotions' }) @ApiEnvelopeResponse(200, 'Promotions returned successfully') @ApiStandardErrors() list(@CurrentUser() user: AuthUser, @Param('storeId') storeId: string) { return this.promotions.list(user, storeId); }
  @Post('stores/:storeId/promotions') @ApiBearerAuth('bearerAuth') @Roles(UserRole.ADMIN, UserRole.BUILDING_OWNER, UserRole.STORE_OWNER) @ApiOperation({ summary: 'Create a store promotion' }) @ApiEnvelopeResponse(201, 'Promotion created successfully') @ApiStandardErrors() create(@CurrentUser() user: AuthUser, @Param('storeId') storeId: string, @Body() dto: CreatePromotionDto) { return this.promotions.create(user, storeId, dto); }
  @Patch('promotions/:id') @ApiBearerAuth('bearerAuth') @Roles(UserRole.ADMIN, UserRole.BUILDING_OWNER, UserRole.STORE_OWNER) @ApiOperation({ summary: 'Update a promotion' }) @ApiEnvelopeResponse(200, 'Promotion updated successfully') @ApiStandardErrors() update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdatePromotionDto) { return this.promotions.update(user, id, dto); }
  @Delete('promotions/:id') @ApiBearerAuth('bearerAuth') @Roles(UserRole.ADMIN, UserRole.BUILDING_OWNER, UserRole.STORE_OWNER) @ApiOperation({ summary: 'Soft-delete a promotion' }) @ApiEnvelopeResponse(200, 'Promotion deleted successfully') @ApiStandardErrors() remove(@CurrentUser() user: AuthUser, @Param('id') id: string) { return this.promotions.remove(user, id); }
}
