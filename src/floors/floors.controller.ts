import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { FloorPublishStatus, UserRole } from '@prisma/client';
import { IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentUser } from '../common/current-user.decorator';
import { AuthUser } from '../common/auth.types';
import { Roles } from '../common/roles.decorator';
import { PrismaService } from '../database/prisma.service';
import { TenantAccessService } from '../common/tenant-access.service';
import { PaginationQuery, pageMeta } from '../common/pagination';
class CreateFloorDto { @IsInt() floorNumber!: number; @IsString() @MaxLength(100) name!: string; @IsOptional() @IsString() mapImageUrl?: string; }
class UpdateFloorDto { @IsOptional() @IsString() @MaxLength(100) name?: string; @IsOptional() @IsString() mapImageUrl?: string; }
@ApiTags('Floors') @ApiBearerAuth() @Controller()
export class FloorsController {
  constructor(private readonly prisma: PrismaService, private readonly access: TenantAccessService) {}
  @Get('buildings/:buildingId/floors') @Roles(UserRole.ADMIN, UserRole.BUILDING_OWNER, UserRole.BUILDING_MANAGER) async list(@CurrentUser() user: AuthUser, @Param('buildingId') buildingId: string, @Query() query: PaginationQuery) { await this.access.building(user, buildingId); const where = { buildingId, deletedAt: null }; const [items, total] = await this.prisma.$transaction([this.prisma.floor.findMany({ where, orderBy: { floorNumber: 'asc' }, skip: (query.page - 1) * query.limit, take: query.limit }), this.prisma.floor.count({ where })]); return { items, pagination: pageMeta(query.page, query.limit, total) }; }
  @Post('buildings/:buildingId/floors') @Roles(UserRole.ADMIN, UserRole.BUILDING_OWNER, UserRole.BUILDING_MANAGER) async create(@CurrentUser() user: AuthUser, @Param('buildingId') buildingId: string, @Body() dto: CreateFloorDto) { const building = await this.access.building(user, buildingId); return this.prisma.floor.create({ data: { buildingId, tenantId: building.tenantId, floorNumber: dto.floorNumber, name: dto.name.trim(), mapImageUrl: dto.mapImageUrl } }); }
  @Get('floors/:id') @Roles(UserRole.ADMIN, UserRole.BUILDING_OWNER, UserRole.BUILDING_MANAGER) async find(@CurrentUser() user: AuthUser, @Param('id') id: string) { const floor = await this.prisma.floor.findFirstOrThrow({ where: { id, deletedAt: null } }); await this.access.building(user, floor.buildingId); return floor; }
  @Patch('floors/:id') @Roles(UserRole.ADMIN, UserRole.BUILDING_OWNER, UserRole.BUILDING_MANAGER) async update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateFloorDto) { const floor = await this.prisma.floor.findFirstOrThrow({ where: { id, deletedAt: null } }); await this.access.building(user, floor.buildingId); return this.prisma.floor.update({ where: { id }, data: dto }); }
  @Delete('floors/:id') @Roles(UserRole.ADMIN, UserRole.BUILDING_OWNER) async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) { const floor = await this.prisma.floor.findFirstOrThrow({ where: { id, deletedAt: null } }); await this.access.building(user, floor.buildingId); return this.prisma.floor.update({ where: { id }, data: { deletedAt: new Date() } }); }
  @Post('floors/:id/publish') @Roles(UserRole.ADMIN, UserRole.BUILDING_OWNER, UserRole.BUILDING_MANAGER) async publish(@CurrentUser() user: AuthUser, @Param('id') id: string) { return this.setStatus(user, id, FloorPublishStatus.PUBLISHED); }
  @Post('floors/:id/unpublish') @Roles(UserRole.ADMIN, UserRole.BUILDING_OWNER, UserRole.BUILDING_MANAGER) async unpublish(@CurrentUser() user: AuthUser, @Param('id') id: string) { return this.setStatus(user, id, FloorPublishStatus.DRAFT); }
  private async setStatus(user: AuthUser, id: string, publishStatus: FloorPublishStatus) { const floor = await this.prisma.floor.findFirstOrThrow({ where: { id, deletedAt: null } }); await this.access.building(user, floor.buildingId); return this.prisma.floor.update({ where: { id }, data: { publishStatus } }); }
}
