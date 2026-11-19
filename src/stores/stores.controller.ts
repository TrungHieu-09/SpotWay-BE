import { Body, Controller, Delete, ForbiddenException, Get, NotFoundException, ParseUUIDPipe, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiProperty, ApiPropertyOptional, ApiQuery, ApiTags } from '@nestjs/swagger';
import { StoreStatus, UserRole } from '@prisma/client';
import { ArrayMaxSize, IsArray, IsEnum, IsOptional, IsString, IsUUID, MaxLength, ValidateIf } from 'class-validator';
import { AuthUser } from '../common/auth.types';
import { assertManagerFloor, assignedBuildingIds } from '../common/manager-scope';
import { CurrentUser } from '../common/current-user.decorator';
import { Roles } from '../common/roles.decorator';
import { PrismaService } from '../database/prisma.service';
import { TenantAccessService } from '../common/tenant-access.service';
import { PaginationQuery, pageMeta } from '../common/pagination';
import { ApiEnvelopeResponse, ApiStandardErrors } from '../common/swagger';
import { StoresService } from './stores.service';
import { STORE_WITH_BUILDING, serializeStore } from './store-serializer';
export class CreateStoreDto { @ApiProperty({ format: 'uuid' }) @IsUUID() floorId!: string; @ApiProperty({ example: 'Demo Store', maxLength: 100 }) @IsString() @MaxLength(100) name!: string; @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() nodeId?: string; @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() ownerId?: string; @ApiPropertyOptional({ example: 'A demo store', maxLength: 1000 }) @IsOptional() @IsString() @MaxLength(1000) description?: string; @ApiPropertyOptional({ type: [String], example: ['https://cdn.example.com/store.jpg'] }) @IsOptional() @IsArray() images?: string[]; }
export class StoreUploadUrlDto { @ApiProperty({ example: 'logo.png', maxLength: 120 }) @IsString() @MaxLength(120) filename!: string; }
export class UpdateStoreDto {
  @ApiPropertyOptional({ example: 'Updated Store', maxLength: 100 }) @IsOptional() @IsString() @MaxLength(100) name?: string;
  @ApiPropertyOptional({ example: 'Updated description', maxLength: 1000 }) @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @ApiPropertyOptional({ enum: StoreStatus, example: StoreStatus.ACTIVE }) @IsOptional() @IsEnum(StoreStatus) status?: StoreStatus;
  @ApiPropertyOptional({ type: [String], maxItems: 5 }) @IsOptional() @IsArray() @ArrayMaxSize(5) @IsString({ each: true }) images?: string[];
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString() @MaxLength(2048) logoUrl?: string | null;
  @ApiPropertyOptional({ format: 'uuid', nullable: true, description: 'Assign a Store Owner; null unassigns' }) @ValidateIf((_, value) => value !== null) @IsOptional() @IsUUID() ownerId?: string | null;
  @ApiPropertyOptional({ format: 'uuid', nullable: true, description: 'Anchor node of the store; null detaches' }) @ValidateIf((_, value) => value !== null) @IsOptional() @IsUUID() nodeId?: string | null;
}
@ApiTags('Stores') @ApiBearerAuth('bearerAuth') @Controller('stores')
export class StoresController {
  constructor(private readonly prisma: PrismaService, private readonly storesService: StoresService) {}
  @Get() @ApiOperation({ summary: 'List accessible stores' }) @ApiQuery({ name: 'page', required: false, example: 1 }) @ApiQuery({ name: 'limit', required: false, example: 20 }) @ApiEnvelopeResponse(200, 'Stores returned successfully') @ApiStandardErrors() @Roles(UserRole.ADMIN, UserRole.BUILDING_OWNER, UserRole.BUILDING_MANAGER, UserRole.STORE_OWNER) async list(@CurrentUser() user: AuthUser, @Query() query: PaginationQuery) { const mine = await assignedBuildingIds(this.prisma, user); const where = { deletedAt: null, ...(mine ? { floor: { is: { buildingId: { in: mine } } } } : {}), ...(user.role === UserRole.ADMIN ? {} : { tenantId: user.tenantId! }), ...(user.role === UserRole.STORE_OWNER ? { ownerId: user.userId } : {}) }; const [items, total] = await this.prisma.$transaction([this.prisma.store.findMany({ where, include: STORE_WITH_BUILDING, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.limit, take: query.limit }), this.prisma.store.count({ where })]); return { items: items.map(serializeStore), pagination: pageMeta(query.page, query.limit, total) }; }
  @Post() @ApiOperation({ summary: 'Create a store' }) @ApiEnvelopeResponse(201, 'Store created successfully') @ApiStandardErrors() @Roles(UserRole.ADMIN, UserRole.BUILDING_OWNER, UserRole.BUILDING_MANAGER) async create(@CurrentUser() user: AuthUser, @Body() dto: CreateStoreDto) { return this.storesService.create(user, dto); }
  @Get(':id') @ApiOperation({ summary: 'Get a store by ID' }) @ApiParam({ name: 'id', format: 'uuid' }) @ApiEnvelopeResponse(200, 'Store found') @ApiStandardErrors() @Roles(UserRole.ADMIN, UserRole.BUILDING_OWNER, UserRole.BUILDING_MANAGER, UserRole.STORE_OWNER) async find(@CurrentUser() user: AuthUser, @Param('id') id: string) { const store = await this.prisma.store.findFirst({ where: { id, deletedAt: null }, include: STORE_WITH_BUILDING }); if (!store) throw new NotFoundException({ code: 'STORE_NOT_FOUND', message: 'Store was not found' }); this.assertAccess(user, store); await assertManagerFloor(this.prisma, user, store.floorId); return serializeStore(store); }
  @Patch(':id') @ApiOperation({ summary: 'Update a store' }) @ApiParam({ name: 'id', format: 'uuid' }) @ApiEnvelopeResponse(200, 'Store updated successfully') @ApiStandardErrors() @Roles(UserRole.ADMIN, UserRole.BUILDING_OWNER, UserRole.BUILDING_MANAGER, UserRole.STORE_OWNER) async update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateStoreDto) { return this.storesService.update(user, id, dto); }
  @Post(':id/upload-url') @ApiOperation({ summary: 'Signed URL to upload a store logo or gallery image' }) @ApiParam({ name: 'id', format: 'uuid' }) @ApiEnvelopeResponse(201, 'Signed upload URL created') @ApiStandardErrors() @Roles(UserRole.ADMIN, UserRole.BUILDING_OWNER, UserRole.BUILDING_MANAGER, UserRole.STORE_OWNER) uploadUrl(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: StoreUploadUrlDto) { return this.storesService.createUploadUrl(user, id, dto.filename); }
  @Delete(':id') @ApiOperation({ summary: 'Soft-delete a store' }) @ApiParam({ name: 'id', format: 'uuid' }) @ApiEnvelopeResponse(200, 'Store deleted successfully') @ApiStandardErrors() @Roles(UserRole.ADMIN, UserRole.BUILDING_OWNER, UserRole.BUILDING_MANAGER) async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) { const store = await this.prisma.store.findFirstOrThrow({ where: { id, deletedAt: null } }); this.assertAccess(user, store); await assertManagerFloor(this.prisma, user, store.floorId); return this.prisma.store.update({ where: { id }, data: { deletedAt: new Date() } }); }
  private assertAccess(user: AuthUser, store: { tenantId: string; ownerId: string | null }) { if (user.role !== UserRole.ADMIN && (store.tenantId !== user.tenantId || (user.role === UserRole.STORE_OWNER && store.ownerId !== user.userId))) throw new ForbiddenException({ code: 'STORE_ACCESS_DENIED', message: 'Store access is denied' }); }
}

@ApiTags('Stores') @ApiBearerAuth('bearerAuth') @Controller('floors')
export class FloorStoresController {
  constructor(private readonly prisma: PrismaService, private readonly access: TenantAccessService) {}
  @Get(':floorId/stores') @ApiOperation({ summary: 'List the stores of a floor' }) @ApiParam({ name: 'floorId', format: 'uuid' }) @ApiEnvelopeResponse(200, 'Stores returned successfully') @ApiStandardErrors() @Roles(UserRole.ADMIN, UserRole.BUILDING_OWNER, UserRole.BUILDING_MANAGER, UserRole.STORE_OWNER)
  async list(@CurrentUser() user: AuthUser, @Param('floorId', ParseUUIDPipe) floorId: string) {
    const floor = await this.prisma.floor.findFirst({ where: { id: floorId, deletedAt: null }, select: { id: true, buildingId: true, tenantId: true } });
    if (!floor) throw new NotFoundException({ code: 'FLOOR_NOT_FOUND', message: 'Floor was not found' });
    if (user.role === UserRole.STORE_OWNER) {
      if (floor.tenantId !== user.tenantId) throw new ForbiddenException({ code: 'TENANT_ACCESS_DENIED', message: 'Cross-tenant access is denied' });
      return (await this.prisma.store.findMany({ where: { floorId, deletedAt: null, ownerId: user.userId }, include: STORE_WITH_BUILDING, orderBy: { name: 'asc' } })).map(serializeStore);
    }
    await this.access.building(user, floor.buildingId);
    return (await this.prisma.store.findMany({ where: { floorId, deletedAt: null }, include: STORE_WITH_BUILDING, orderBy: { name: 'asc' } })).map(serializeStore);
  }
}
