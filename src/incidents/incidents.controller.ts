import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { AuthUser } from '../common/auth.types';
import { CurrentUser } from '../common/current-user.decorator';
import { Public } from '../common/public.decorator';
import { RateLimit } from '../common/rate-limit.guard';
import { Roles } from '../common/roles.decorator';
import { ApiEnvelopeResponse, ApiStandardErrors } from '../common/swagger';
import { StartIncidentDto } from './incidents.dto';
import { IncidentsService } from './incidents.service';

const staff = [UserRole.ADMIN, UserRole.BUILDING_OWNER, UserRole.BUILDING_MANAGER];

@ApiTags('Map Editor') @ApiBearerAuth('bearerAuth') @Controller('buildings/:buildingId/incident')
export class IncidentsController {
  constructor(private readonly incidents: IncidentsService) {}
  @Get() @Roles(...staff) @ApiOperation({ summary: 'Current emergency of the building' }) @ApiParam({ name: 'buildingId', format: 'uuid' }) @ApiEnvelopeResponse(200, 'Incident state returned') @ApiStandardErrors()
  state(@CurrentUser() user: AuthUser, @Param('buildingId', ParseUUIDPipe) buildingId: string) { return this.incidents.state(user, buildingId); }
  @Post() @HttpCode(200) @Roles(...staff) @ApiOperation({ summary: 'Raise a fire alarm: guests are told to evacuate and routing avoids the nodes' }) @ApiParam({ name: 'buildingId', format: 'uuid' }) @ApiEnvelopeResponse(200, 'Incident started') @ApiStandardErrors()
  start(@CurrentUser() user: AuthUser, @Param('buildingId', ParseUUIDPipe) buildingId: string, @Body() dto: StartIncidentDto) { return this.incidents.start(user, buildingId, dto.nodeIds, dto.message); }
  @Delete() @Roles(...staff) @ApiOperation({ summary: 'End the emergency' }) @ApiParam({ name: 'buildingId', format: 'uuid' }) @ApiEnvelopeResponse(200, 'Incident cleared') @ApiStandardErrors()
  clear(@CurrentUser() user: AuthUser, @Param('buildingId', ParseUUIDPipe) buildingId: string) { return this.incidents.clear(user, buildingId); }
}

@ApiTags('Public Navigation') @Public() @Controller('public/buildings/:buildingId/incident')
export class PublicIncidentController {
  constructor(private readonly incidents: IncidentsService) {}
  @Get() @RateLimit(240, 60_000) @ApiOperation({ summary: 'Is there an emergency in this building? Polled by the guest app' }) @ApiParam({ name: 'buildingId', format: 'uuid' }) @ApiEnvelopeResponse(200, 'Incident state returned') @ApiStandardErrors()
  state(@Param('buildingId', ParseUUIDPipe) buildingId: string) { return this.incidents.publicState(buildingId); }
}
