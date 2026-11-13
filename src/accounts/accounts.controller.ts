import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { AuthUser } from '../common/auth.types';
import { CurrentUser } from '../common/current-user.decorator';
import { Roles } from '../common/roles.decorator';
import { ApiEnvelopeResponse, ApiStandardErrors } from '../common/swagger';
import { AccountsService } from './accounts.service';
import { ChangePasswordDto, CreateAdminUserDto, CreateStaffDto, CreateStoreOwnerDto, ResetPasswordDto, UpdateProfileDto, UpdateStaffDto, UpdateStoreOwnerDto } from './accounts.dto';

const OWNER = UserRole.BUILDING_OWNER;
const MANAGER = UserRole.BUILDING_MANAGER;

@ApiTags('Authentication') @ApiBearerAuth('bearerAuth') @Controller('auth')
export class ProfileController {
  constructor(private readonly accounts: AccountsService) {}
  @Get('me') @ApiOperation({ summary: 'Get the authenticated user profile with its workspace' }) @ApiEnvelopeResponse(200, 'Profile returned') @ApiStandardErrors()
  me(@CurrentUser() user: AuthUser) { return this.accounts.me(user.userId); }
  @Patch('profile') @ApiOperation({ summary: 'Update the display name' }) @ApiEnvelopeResponse(200, 'Profile updated') @ApiStandardErrors()
  profile(@CurrentUser() user: AuthUser, @Body() dto: UpdateProfileDto) { return this.accounts.updateProfile(user.userId, dto.name); }
  @Post('change-password') @HttpCode(200) @ApiOperation({ summary: 'Change the password and end all other sessions' }) @ApiEnvelopeResponse(200, 'Password changed') @ApiStandardErrors()
  changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto) { return this.accounts.changePassword(user.userId, dto.currentPassword, dto.newPassword); }
}

@ApiTags('Tenants') @ApiBearerAuth('bearerAuth') @Controller('tenant') @Roles(OWNER)
export class TenantWorkspaceController {
  constructor(private readonly accounts: AccountsService) {}
  @Get('overview') @ApiOperation({ summary: 'Workspace summary of the Building Owner' }) @ApiEnvelopeResponse(200, 'Overview returned') @ApiStandardErrors()
  overview(@CurrentUser() user: AuthUser) { return this.accounts.tenantOverview(user); }
  @Get('areas') @ApiOperation({ summary: 'Areas = the buildings of the workspace a manager can be assigned to' }) @ApiEnvelopeResponse(200, 'Areas returned') @ApiStandardErrors()
  areas(@CurrentUser() user: AuthUser) { return this.accounts.tenantAreas(user); }
  @Get('users') @ApiOperation({ summary: 'Managers and store owners of the workspace' }) @ApiEnvelopeResponse(200, 'Users returned') @ApiStandardErrors()
  users(@CurrentUser() user: AuthUser) { return this.accounts.tenantUsers(user); }
  @Post('users') @ApiOperation({ summary: 'Create a manager or store owner (returns a temporary password)' }) @ApiEnvelopeResponse(201, 'Account created') @ApiStandardErrors()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateStaffDto) { return this.accounts.createStaff(user, dto); }
  @Patch('users/:id') @ApiOperation({ summary: 'Lock/unlock an account or reset its password' }) @ApiEnvelopeResponse(200, 'Account updated') @ApiStandardErrors()
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateStaffDto) { return this.accounts.updateStaff(user, id, dto); }
  @Delete('users/:id') @ApiOperation({ summary: 'Delete a manager or store owner' }) @ApiEnvelopeResponse(200, 'Account deleted') @ApiStandardErrors()
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.accounts.deleteStaff(user, id); }
}

@ApiTags('Tenants') @ApiBearerAuth('bearerAuth') @Controller('store-owners') @Roles(OWNER, MANAGER)
export class StoreOwnersController {
  constructor(private readonly accounts: AccountsService) {}
  @Get() @ApiOperation({ summary: 'Store owners of the workspace with their store count' }) @ApiEnvelopeResponse(200, 'Store owners returned') @ApiStandardErrors()
  list(@CurrentUser() user: AuthUser) { return this.accounts.storeOwners(user); }
  @Post() @ApiOperation({ summary: 'Create a store owner (returns a temporary password)' }) @ApiEnvelopeResponse(201, 'Store owner created') @ApiStandardErrors()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateStoreOwnerDto) { return this.accounts.createStoreOwner(user, dto.name, dto.email); }
  @Patch(':id') @ApiOperation({ summary: 'Lock or unlock a store owner' }) @ApiEnvelopeResponse(200, 'Store owner updated') @ApiStandardErrors()
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateStoreOwnerDto) { return this.accounts.patchStoreOwner(user, id, { status: dto.status }); }
  @Post(':id/reset-password') @HttpCode(200) @ApiOperation({ summary: 'Issue a new temporary password' }) @ApiEnvelopeResponse(200, 'Password reset') @ApiStandardErrors()
  reset(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.accounts.patchStoreOwner(user, id, { resetPassword: true }); }
  @Delete(':id') @ApiOperation({ summary: 'Delete a store owner without a store' }) @ApiEnvelopeResponse(200, 'Store owner deleted') @ApiStandardErrors()
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.accounts.deleteStoreOwner(user, id); }
}

@ApiTags('Stores') @ApiBearerAuth('bearerAuth') @Controller('owners')
export class OwnerStoresController {
  constructor(private readonly accounts: AccountsService) {}
  @Get(':ownerId/stores') @Roles(UserRole.ADMIN, OWNER, MANAGER, UserRole.STORE_OWNER) @ApiOperation({ summary: 'Stores assigned to a store owner' }) @ApiEnvelopeResponse(200, 'Stores returned') @ApiStandardErrors()
  stores(@CurrentUser() user: AuthUser, @Param('ownerId', ParseUUIDPipe) ownerId: string) { return this.accounts.storesOfOwner(user, ownerId); }
}

@ApiTags('Tenants') @ApiBearerAuth('bearerAuth') @Controller('admin') @Roles(UserRole.ADMIN)
export class AdminController {
  constructor(private readonly accounts: AccountsService) {}
  @Get('overview') @ApiOperation({ summary: 'Account and building totals' }) @ApiEnvelopeResponse(200, 'Overview returned') @ApiStandardErrors()
  overview() { return this.accounts.adminOverview(); }
  @Get('users') @ApiOperation({ summary: 'All staff accounts' }) @ApiEnvelopeResponse(200, 'Users returned') @ApiStandardErrors()
  users() { return this.accounts.adminUsers(); }
  @Post('users') @ApiOperation({ summary: 'Hand out an account (a Building Owner gets a new workspace)' }) @ApiEnvelopeResponse(201, 'Account created') @ApiStandardErrors()
  create(@Body() dto: CreateAdminUserDto) { return this.accounts.adminCreateUser(dto); }
  @Post('users/:id/reset-password') @HttpCode(200) @ApiOperation({ summary: 'Reset a password (temporary one is generated when none is given)' }) @ApiEnvelopeResponse(200, 'Password reset') @ApiStandardErrors()
  reset(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ResetPasswordDto) { return this.accounts.adminResetPassword(id, dto.newPassword); }
  @Delete('users/:id') @ApiOperation({ summary: 'Delete an account' }) @ApiEnvelopeResponse(200, 'Account deleted') @ApiStandardErrors()
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) { return this.accounts.adminDeleteUser(user, id); }
}
