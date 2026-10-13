import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { AuthUser } from '../common/auth.types';
import { CurrentUser } from '../common/current-user.decorator';
import { Roles } from '../common/roles.decorator';
import { ApiEnvelopeResponse, ApiStandardErrors } from '../common/swagger';
import { AnalyticsService } from './analytics.service';

@ApiTags('Analytics') @ApiBearerAuth('bearerAuth') @Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}
  @Get('navigation') @Roles(UserRole.ADMIN, UserRole.BUILDING_OWNER) @ApiOperation({ summary: 'Get tenant-scoped navigation analytics' }) @ApiEnvelopeResponse(200, 'Analytics returned successfully') @ApiStandardErrors()
  summary(@CurrentUser() user: AuthUser) { return this.analytics.summary(user.role === UserRole.ADMIN ? undefined : user.tenantId!); }
}
