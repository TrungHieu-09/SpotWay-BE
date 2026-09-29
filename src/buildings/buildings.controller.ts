import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../common/current-user.decorator';
import { AuthUser } from '../common/auth.types';
import { Roles } from '../common/roles.decorator';
import { BuildingsService } from './buildings.service';
import { BuildingResponse, CreateBuildingDto, UpdateBuildingDto } from './dto';
import { PaginationQuery } from '../common/pagination';
import { ApiEnvelopeResponse, ApiPagedEnvelopeResponse, ApiStandardErrors } from '../common/swagger';
@ApiTags('Buildings') @ApiExtraModels(BuildingResponse) @ApiBearerAuth('bearerAuth') @Controller('buildings')
export class BuildingsController {
  constructor(private readonly buildings: BuildingsService) {}
  @Get() @ApiOperation({ summary: 'List accessible buildings' }) @ApiQuery({ name: 'page', required: false, example: 1 }) @ApiQuery({ name: 'limit', required: false, example: 20 }) @ApiPagedEnvelopeResponse(BuildingResponse) @ApiStandardErrors() @Roles(UserRole.ADMIN, UserRole.BUILDING_OWNER, UserRole.BUILDING_MANAGER) list(@CurrentUser() user: AuthUser, @Query() query: PaginationQuery) { return this.buildings.list(user, query.page, query.limit); }
  @Post() @ApiOperation({ summary: 'Create a building' }) @ApiEnvelopeResponse(201, 'Building created successfully', { $ref: '#/components/schemas/BuildingResponse' }) @ApiStandardErrors() @Roles(UserRole.ADMIN, UserRole.BUILDING_OWNER) create(@CurrentUser() user: AuthUser, @Body() dto: CreateBuildingDto) { return this.buildings.create(user, dto); }
  @Get(':id') @ApiOperation({ summary: 'Get a building by ID' }) @ApiParam({ name: 'id', format: 'uuid' }) @ApiEnvelopeResponse(200, 'Building found', { $ref: '#/components/schemas/BuildingResponse' }) @ApiStandardErrors() @Roles(UserRole.ADMIN, UserRole.BUILDING_OWNER, UserRole.BUILDING_MANAGER) find(@CurrentUser() user: AuthUser, @Param('id') id: string) { return this.buildings.find(user, id); }
  @Patch(':id') @ApiOperation({ summary: 'Update a building' }) @ApiParam({ name: 'id', format: 'uuid' }) @ApiEnvelopeResponse(200, 'Building updated successfully', { $ref: '#/components/schemas/BuildingResponse' }) @ApiStandardErrors() @Roles(UserRole.ADMIN, UserRole.BUILDING_OWNER, UserRole.BUILDING_MANAGER) update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateBuildingDto) { return this.buildings.update(user, id, dto); }
  @Delete(':id') @ApiOperation({ summary: 'Soft-delete a building' }) @ApiParam({ name: 'id', format: 'uuid' }) @ApiEnvelopeResponse(200, 'Building deleted successfully', { $ref: '#/components/schemas/BuildingResponse' }) @ApiStandardErrors() @Roles(UserRole.ADMIN, UserRole.BUILDING_OWNER) remove(@CurrentUser() user: AuthUser, @Param('id') id: string) { return this.buildings.remove(user, id); }
  @Post(':id/managers/:userId') @ApiOperation({ summary: 'Assign a Building Manager' }) @ApiParam({ name: 'id', format: 'uuid' }) @ApiParam({ name: 'userId', format: 'uuid' }) @ApiEnvelopeResponse(201, 'Manager assigned successfully') @ApiStandardErrors() @Roles(UserRole.ADMIN, UserRole.BUILDING_OWNER) assign(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('userId') userId: string) { return this.buildings.assignManager(user, id, userId); }
  @Delete(':id/managers/:userId') @ApiOperation({ summary: 'Revoke a Building Manager assignment' }) @ApiParam({ name: 'id', format: 'uuid' }) @ApiParam({ name: 'userId', format: 'uuid' }) @ApiEnvelopeResponse(200, 'Manager assignment revoked successfully') @ApiStandardErrors() @Roles(UserRole.ADMIN, UserRole.BUILDING_OWNER) revoke(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('userId') userId: string) { return this.buildings.revokeManager(user, id, userId); }
}
