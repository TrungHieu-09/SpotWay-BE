import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { AuthUser } from '../common/auth.types';
import { CurrentUser } from '../common/current-user.decorator';
import { Roles } from '../common/roles.decorator';
import { ApiEnvelopeResponse, ApiStandardErrors } from '../common/swagger';
import { ConnectorService } from './application/connector.service';
import { ConnectorResponse, CreateConnectorDto, UpdateConnectorDto } from './dto/connector.dto';

const graphRoles = [UserRole.ADMIN, UserRole.BUILDING_OWNER, UserRole.BUILDING_MANAGER];

@ApiTags('Map Editor')
@ApiBearerAuth('bearerAuth')
@ApiExtraModels(ConnectorResponse)
@Controller()
export class ConnectorsController {
  constructor(private readonly connectors: ConnectorService) {}

  @Get('buildings/:buildingId/connectors') @ApiOperation({ summary: 'List vertical connectors (elevators, stairs, escalators) in a building' }) @ApiParam({ name: 'buildingId', format: 'uuid' }) @ApiEnvelopeResponse(200, 'Connectors returned successfully', { type: 'array', items: { $ref: '#/components/schemas/ConnectorResponse' } }) @ApiStandardErrors() @Roles(...graphRoles)
  list(@CurrentUser() user: AuthUser, @Param('buildingId') buildingId: string) { return this.connectors.list(user, buildingId); }
  @Post('buildings/:buildingId/connectors') @ApiOperation({ summary: 'Create a connector serving two or more floors' }) @ApiParam({ name: 'buildingId', format: 'uuid' }) @ApiEnvelopeResponse(201, 'Connector created successfully', { $ref: '#/components/schemas/ConnectorResponse' }) @ApiStandardErrors() @Roles(...graphRoles)
  create(@CurrentUser() user: AuthUser, @Param('buildingId') buildingId: string, @Body() dto: CreateConnectorDto) { return this.connectors.create(user, buildingId, dto); }
  @Patch('connectors/:id') @ApiOperation({ summary: 'Rename a connector, toggle accessibility or replace its stops' }) @ApiParam({ name: 'id', format: 'uuid' }) @ApiEnvelopeResponse(200, 'Connector updated successfully', { $ref: '#/components/schemas/ConnectorResponse' }) @ApiStandardErrors() @Roles(...graphRoles)
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateConnectorDto) { return this.connectors.update(user, id, dto); }
  @Delete('connectors/:id') @HttpCode(200) @ApiOperation({ summary: 'Delete a connector and its stops' }) @ApiParam({ name: 'id', format: 'uuid' }) @ApiEnvelopeResponse(200, 'Connector deleted successfully') @ApiStandardErrors() @Roles(...graphRoles)
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) { return this.connectors.remove(user, id); }
}
