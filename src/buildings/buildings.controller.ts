import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../common/current-user.decorator';
import { AuthUser } from '../common/auth.types';
import { Roles } from '../common/roles.decorator';
import { BuildingsService } from './buildings.service';
import { CreateBuildingDto, UpdateBuildingDto } from './dto';
import { PaginationQuery } from '../common/pagination';
@ApiTags('Buildings') @ApiBearerAuth() @Controller('buildings')
export class BuildingsController {
  constructor(private readonly buildings: BuildingsService) {}
  @Get() @Roles(UserRole.ADMIN, UserRole.BUILDING_OWNER, UserRole.BUILDING_MANAGER) list(@CurrentUser() user: AuthUser, @Query() query: PaginationQuery) { return this.buildings.list(user, query.page, query.limit); }
  @Post() @Roles(UserRole.ADMIN, UserRole.BUILDING_OWNER) create(@CurrentUser() user: AuthUser, @Body() dto: CreateBuildingDto) { return this.buildings.create(user, dto); }
  @Get(':id') @Roles(UserRole.ADMIN, UserRole.BUILDING_OWNER, UserRole.BUILDING_MANAGER) find(@CurrentUser() user: AuthUser, @Param('id') id: string) { return this.buildings.find(user, id); }
  @Patch(':id') @Roles(UserRole.ADMIN, UserRole.BUILDING_OWNER, UserRole.BUILDING_MANAGER) update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateBuildingDto) { return this.buildings.update(user, id, dto); }
  @Delete(':id') @Roles(UserRole.ADMIN, UserRole.BUILDING_OWNER) remove(@CurrentUser() user: AuthUser, @Param('id') id: string) { return this.buildings.remove(user, id); }
  @Post(':id/managers/:userId') @Roles(UserRole.ADMIN, UserRole.BUILDING_OWNER) assign(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('userId') userId: string) { return this.buildings.assignManager(user, id, userId); }
  @Delete(':id/managers/:userId') @Roles(UserRole.ADMIN, UserRole.BUILDING_OWNER) revoke(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('userId') userId: string) { return this.buildings.revokeManager(user, id, userId); }
}
