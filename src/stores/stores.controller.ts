import { Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { StoreStatus, UserRole } from '@prisma/client';
import { IsArray, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { AuthUser } from '../common/auth.types';
import { CurrentUser } from '../common/current-user.decorator';
import { Roles } from '../common/roles.decorator';
import { PrismaService } from '../database/prisma.service';
import { PaginationQuery, pageMeta } from '../common/pagination';
class CreateStoreDto { @IsString() floorId!: string; @IsString() @MaxLength(100) name!: string; @IsOptional() @IsString() nodeId?: string; @IsOptional() @IsString() ownerId?: string; @IsOptional() @IsString() @MaxLength(1000) description?: string; @IsOptional() @IsArray() images?: string[]; }
class UpdateStoreDto { @IsOptional() @IsString() @MaxLength(100) name?: string; @IsOptional() @IsString() @MaxLength(1000) description?: string; @IsOptional() @IsEnum(StoreStatus) status?: StoreStatus; }
@ApiTags('Stores') @ApiBearerAuth() @Controller('stores')
export class StoresController {
  constructor(private readonly prisma: PrismaService) {}
  @Get() @Roles(UserRole.ADMIN, UserRole.BUILDING_OWNER, UserRole.BUILDING_MANAGER, UserRole.STORE_OWNER) async list(@CurrentUser() user: AuthUser, @Query() query: PaginationQuery) { const where = { deletedAt: null, ...(user.role === UserRole.ADMIN ? {} : { tenantId: user.tenantId! }), ...(user.role === UserRole.STORE_OWNER ? { ownerId: user.userId } : {}) }; const [items, total] = await this.prisma.$transaction([this.prisma.store.findMany({ where, skip: (query.page - 1) * query.limit, take: query.limit }), this.prisma.store.count({ where })]); return { items, pagination: pageMeta(query.page, query.limit, total) }; }
  @Post() @Roles(UserRole.ADMIN, UserRole.BUILDING_OWNER) async create(@CurrentUser() user: AuthUser, @Body() dto: CreateStoreDto) { const floor = await this.prisma.floor.findFirstOrThrow({ where: { id: dto.floorId, deletedAt: null } }); if (user.role !== UserRole.ADMIN && floor.tenantId !== user.tenantId) throw new ForbiddenException({ code: 'TENANT_ACCESS_DENIED', message: 'Cross-tenant store creation is denied' }); return this.prisma.store.create({ data: { tenantId: floor.tenantId, floorId: dto.floorId, nodeId: dto.nodeId, ownerId: dto.ownerId, name: dto.name.trim(), description: dto.description, images: dto.images ?? [] } }); }
  @Get(':id') @Roles(UserRole.ADMIN, UserRole.BUILDING_OWNER, UserRole.BUILDING_MANAGER, UserRole.STORE_OWNER) async find(@CurrentUser() user: AuthUser, @Param('id') id: string) { const store = await this.prisma.store.findFirstOrThrow({ where: { id, deletedAt: null } }); this.assertAccess(user, store); return store; }
  @Patch(':id') @Roles(UserRole.ADMIN, UserRole.BUILDING_OWNER, UserRole.STORE_OWNER) async update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateStoreDto) { const store = await this.prisma.store.findFirstOrThrow({ where: { id, deletedAt: null } }); this.assertAccess(user, store); return this.prisma.store.update({ where: { id }, data: dto }); }
  @Delete(':id') @Roles(UserRole.ADMIN, UserRole.BUILDING_OWNER) async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) { const store = await this.prisma.store.findFirstOrThrow({ where: { id, deletedAt: null } }); this.assertAccess(user, store); return this.prisma.store.update({ where: { id }, data: { deletedAt: new Date() } }); }
  private assertAccess(user: AuthUser, store: { tenantId: string; ownerId: string | null }) { if (user.role !== UserRole.ADMIN && (store.tenantId !== user.tenantId || (user.role === UserRole.STORE_OWNER && store.ownerId !== user.userId))) throw new ForbiddenException({ code: 'STORE_ACCESS_DENIED', message: 'Store access is denied' }); }
}
