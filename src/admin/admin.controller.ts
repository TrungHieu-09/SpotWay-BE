import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { AuthUser } from '../common/auth.types';
import { CurrentUser } from '../common/current-user.decorator';
import { Roles } from '../common/roles.decorator';
import { ApiEnvelopeResponse, ApiStandardErrors } from '../common/swagger';
import { CreateAdminUserDto, ResetAdminPasswordDto } from './admin.dto';
import { AdminService } from './admin.service';

@ApiTags('Admin')
@ApiBearerAuth('bearerAuth')
@Controller('admin')
@Roles(UserRole.ADMIN)
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('overview')
  @ApiOperation({ summary: 'Platform totals: accounts per role and buildings' })
  @ApiEnvelopeResponse(200, 'Overview returned successfully')
  @ApiStandardErrors()
  overview() {
    return this.admin.overview();
  }

  @Get('users')
  @ApiOperation({ summary: 'List every account on the platform' })
  @ApiEnvelopeResponse(200, 'Accounts returned successfully')
  @ApiStandardErrors()
  list() {
    return this.admin.listUsers();
  }

  @Post('users')
  @ApiOperation({ summary: 'Create an account with an email, password and role (a Building Owner gets a workspace automatically)' })
  @ApiEnvelopeResponse(201, 'Account created successfully')
  @ApiStandardErrors()
  create(@Body() dto: CreateAdminUserDto) {
    return this.admin.createUser(dto);
  }

  @Post('users/:id/reset-password')
  @ApiOperation({ summary: 'Set a new password (or generate a temporary one) and sign the account out everywhere' })
  @ApiEnvelopeResponse(201, 'Password reset successfully')
  @ApiStandardErrors()
  resetPassword(@Param('id') id: string, @Body() dto: ResetAdminPasswordDto) {
    return this.admin.resetPassword(id, dto);
  }

  @Delete('users/:id')
  @ApiOperation({ summary: 'Delete an account (soft delete) and sign it out' })
  @ApiEnvelopeResponse(200, 'Account deleted successfully')
  @ApiStandardErrors()
  remove(@CurrentUser() actor: AuthUser, @Param('id') id: string) {
    return this.admin.deleteUser(id, actor.userId);
  }
}
