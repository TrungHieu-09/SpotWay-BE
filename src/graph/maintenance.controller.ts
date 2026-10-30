import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { AuthUser } from '../common/auth.types';
import { CurrentUser } from '../common/current-user.decorator';
import { Roles } from '../common/roles.decorator';
import { ApiEnvelopeResponse, ApiStandardErrors } from '../common/swagger';
import { MaintenanceService } from './application/maintenance.service';
import { MaintenanceReport, MaintenanceSelectionDto } from './dto/maintenance.dto';

const graphRoles = [UserRole.ADMIN, UserRole.BUILDING_OWNER, UserRole.BUILDING_MANAGER];
const report = { $ref: '#/components/schemas/MaintenanceReport' };

@ApiTags('Map Editor')
@ApiBearerAuth('bearerAuth')
@ApiExtraModels(MaintenanceReport)
@Controller()
export class MaintenanceController {
  constructor(private readonly maintenance: MaintenanceService) {}

  @Get('floors/:floorId/maintenance') @ApiOperation({ summary: 'List the edges and nodes currently blocked for maintenance' }) @ApiParam({ name: 'floorId', format: 'uuid' }) @ApiEnvelopeResponse(200, 'Maintenance state returned successfully', report) @ApiStandardErrors() @Roles(...graphRoles)
  state(@CurrentUser() user: AuthUser, @Param('floorId') floorId: string) { return this.maintenance.report(user, floorId); }
  @Post('floors/:floorId/maintenance/block') @HttpCode(200) @ApiOperation({ summary: 'Block edges, or every edge around given nodes, so routing avoids them' }) @ApiParam({ name: 'floorId', format: 'uuid' }) @ApiEnvelopeResponse(200, 'Edges blocked successfully', report) @ApiStandardErrors() @Roles(...graphRoles)
  block(@CurrentUser() user: AuthUser, @Param('floorId') floorId: string, @Body() dto: MaintenanceSelectionDto) { return this.maintenance.block(user, floorId, dto); }
  @Post('floors/:floorId/maintenance/unblock') @HttpCode(200) @ApiOperation({ summary: 'Re-open edges, or every edge around given nodes' }) @ApiParam({ name: 'floorId', format: 'uuid' }) @ApiEnvelopeResponse(200, 'Edges re-opened successfully', report) @ApiStandardErrors() @Roles(...graphRoles)
  unblock(@CurrentUser() user: AuthUser, @Param('floorId') floorId: string, @Body() dto: MaintenanceSelectionDto) { return this.maintenance.unblock(user, floorId, dto); }
}
