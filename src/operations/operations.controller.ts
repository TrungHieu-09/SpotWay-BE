import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { AuthUser } from '../common/auth.types';
import { CurrentUser } from '../common/current-user.decorator';
import { Public } from '../common/public.decorator';
import { RateLimit } from '../common/rate-limit.guard';
import { Roles } from '../common/roles.decorator';
import { ApiEnvelopeResponse, ApiStandardErrors } from '../common/swagger';
import { UpdateOperationsDto } from './operations.dto';
import { OperationsService } from './operations.service';

const staff = [UserRole.ADMIN, UserRole.BUILDING_OWNER, UserRole.BUILDING_MANAGER];

@ApiTags('Operations') @ApiBearerAuth('bearerAuth') @Controller('buildings/:buildingId/operations')
export class OperationsController {
  constructor(private readonly operations: OperationsService) {}
  @Get() @Roles(...staff) @ApiOperation({ summary: 'Closures and notice currently declared for the building' }) @ApiParam({ name: 'buildingId', format: 'uuid' }) @ApiEnvelopeResponse(200, 'Operations state returned') @ApiStandardErrors()
  state(@CurrentUser() user: AuthUser, @Param('buildingId', ParseUUIDPipe) buildingId: string) { return this.operations.state(user, buildingId); }
  @Put() @Roles(...staff) @ApiOperation({ summary: 'Declare or lift closures / publish a notice (only the given fields change)' }) @ApiParam({ name: 'buildingId', format: 'uuid' }) @ApiEnvelopeResponse(200, 'Operations state updated') @ApiStandardErrors()
  update(@CurrentUser() user: AuthUser, @Param('buildingId', ParseUUIDPipe) buildingId: string, @Body() dto: UpdateOperationsDto) { return this.operations.update(user, buildingId, dto); }
  @Delete() @Roles(...staff) @ApiOperation({ summary: 'Lift every closure and remove the notice' }) @ApiParam({ name: 'buildingId', format: 'uuid' }) @ApiEnvelopeResponse(200, 'Operations cleared') @ApiStandardErrors()
  clear(@CurrentUser() user: AuthUser, @Param('buildingId', ParseUUIDPipe) buildingId: string) { return this.operations.clear(user, buildingId); }
  @Get('help') @Roles(...staff) @ApiOperation({ summary: 'Help requests from guests of this building in the last 30 minutes' }) @ApiParam({ name: 'buildingId', format: 'uuid' }) @ApiEnvelopeResponse(200, 'Help requests returned') @ApiStandardErrors()
  help(@CurrentUser() user: AuthUser, @Param('buildingId', ParseUUIDPipe) buildingId: string) { return this.operations.helpRequests(user, buildingId); }
}

@ApiTags('Public Navigation') @Public() @Controller('public/buildings/:buildingId/operations')
export class PublicOperationsController {
  constructor(private readonly operations: OperationsService) {}
  @Get() @RateLimit(1200, 60_000) @ApiOperation({ summary: 'Closures and notice of the building, polled by the guest app' }) @ApiParam({ name: 'buildingId', format: 'uuid' }) @ApiEnvelopeResponse(200, 'Operations state returned') @ApiStandardErrors()
  state(@Param('buildingId', ParseUUIDPipe) buildingId: string) { return this.operations.publicState(buildingId); }
}
