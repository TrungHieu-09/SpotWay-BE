import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { AuthUser } from '../common/auth.types';
import { CurrentUser } from '../common/current-user.decorator';
import { Roles } from '../common/roles.decorator';
import { ApiEnvelopeResponse, ApiStandardErrors } from '../common/swagger';
import { CreateEdgeDto, CreateElevatorLinkDto, CreateNodeDto, CreatePoiDto, EdgeResponse, ElevatorLinkResponse, NodeResponse, PoiResponse, UpdateEdgeDto, UpdateNodeDto, UpdatePoiDto } from './graph.dto';
import { GraphService } from './graph.service';

const graphRoles = [UserRole.ADMIN, UserRole.BUILDING_OWNER, UserRole.BUILDING_MANAGER];

@ApiTags('Map Editor')
@ApiBearerAuth('bearerAuth')
@ApiExtraModels(NodeResponse, EdgeResponse, PoiResponse, ElevatorLinkResponse)
@Controller()
export class GraphController {
  constructor(private readonly graph: GraphService) {}

  @Get('floors/:floorId/nodes') @ApiOperation({ summary: 'List nodes in a floor' }) @ApiParam({ name: 'floorId', format: 'uuid' }) @ApiEnvelopeResponse(200, 'Nodes returned successfully', { type: 'array', items: { $ref: '#/components/schemas/NodeResponse' } }) @ApiStandardErrors() @Roles(...graphRoles)
  listNodes(@CurrentUser() user: AuthUser, @Param('floorId') floorId: string) { return this.graph.listNodes(user, floorId); }
  @Post('floors/:floorId/nodes') @ApiOperation({ summary: 'Create a map node' }) @ApiParam({ name: 'floorId', format: 'uuid' }) @ApiEnvelopeResponse(201, 'Node created successfully', { $ref: '#/components/schemas/NodeResponse' }) @ApiStandardErrors() @Roles(...graphRoles)
  createNode(@CurrentUser() user: AuthUser, @Param('floorId') floorId: string, @Body() dto: CreateNodeDto) { return this.graph.createNode(user, floorId, dto); }
  @Get('nodes/:id') @ApiOperation({ summary: 'Get a map node' }) @ApiParam({ name: 'id', format: 'uuid' }) @ApiEnvelopeResponse(200, 'Node found', { $ref: '#/components/schemas/NodeResponse' }) @ApiStandardErrors() @Roles(...graphRoles)
  getNode(@CurrentUser() user: AuthUser, @Param('id') id: string) { return this.graph.getNode(user, id); }
  @Patch('nodes/:id') @ApiOperation({ summary: 'Update a map node' }) @ApiParam({ name: 'id', format: 'uuid' }) @ApiEnvelopeResponse(200, 'Node updated successfully', { $ref: '#/components/schemas/NodeResponse' }) @ApiStandardErrors() @Roles(...graphRoles)
  updateNode(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateNodeDto) { return this.graph.updateNode(user, id, dto); }
  @Delete('nodes/:id') @ApiOperation({ summary: 'Soft-delete a node and its adjacent edges' }) @ApiParam({ name: 'id', format: 'uuid' }) @ApiEnvelopeResponse(200, 'Node deleted successfully') @ApiStandardErrors() @Roles(...graphRoles)
  deleteNode(@CurrentUser() user: AuthUser, @Param('id') id: string) { return this.graph.deleteNode(user, id); }

  @Get('floors/:floorId/edges') @ApiOperation({ summary: 'List edges in a floor' }) @ApiParam({ name: 'floorId', format: 'uuid' }) @ApiEnvelopeResponse(200, 'Edges returned successfully', { type: 'array', items: { $ref: '#/components/schemas/EdgeResponse' } }) @ApiStandardErrors() @Roles(...graphRoles)
  listEdges(@CurrentUser() user: AuthUser, @Param('floorId') floorId: string) { return this.graph.listEdges(user, floorId); }
  @Post('floors/:floorId/edges') @ApiOperation({ summary: 'Create an undirected edge; weight is calculated from node coordinates' }) @ApiParam({ name: 'floorId', format: 'uuid' }) @ApiEnvelopeResponse(201, 'Edge created successfully', { $ref: '#/components/schemas/EdgeResponse' }) @ApiStandardErrors() @Roles(...graphRoles)
  createEdge(@CurrentUser() user: AuthUser, @Param('floorId') floorId: string, @Body() dto: CreateEdgeDto) { return this.graph.createEdge(user, floorId, dto); }
  @Get('edges/:id') @ApiOperation({ summary: 'Get a map edge' }) @ApiParam({ name: 'id', format: 'uuid' }) @ApiEnvelopeResponse(200, 'Edge found', { $ref: '#/components/schemas/EdgeResponse' }) @ApiStandardErrors() @Roles(...graphRoles)
  getEdge(@CurrentUser() user: AuthUser, @Param('id') id: string) { return this.graph.getEdge(user, id); }
  @Patch('edges/:id') @ApiOperation({ summary: 'Update edge accessibility or maintenance status' }) @ApiParam({ name: 'id', format: 'uuid' }) @ApiEnvelopeResponse(200, 'Edge updated successfully', { $ref: '#/components/schemas/EdgeResponse' }) @ApiStandardErrors() @Roles(...graphRoles)
  updateEdge(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateEdgeDto) { return this.graph.updateEdge(user, id, dto); }
  @Delete('edges/:id') @ApiOperation({ summary: 'Soft-delete an edge' }) @ApiParam({ name: 'id', format: 'uuid' }) @ApiEnvelopeResponse(200, 'Edge deleted successfully') @ApiStandardErrors() @Roles(...graphRoles)
  deleteEdge(@CurrentUser() user: AuthUser, @Param('id') id: string) { return this.graph.deleteEdge(user, id); }

  @Get('floors/:floorId/pois') @ApiOperation({ summary: 'List POIs in a floor' }) @ApiParam({ name: 'floorId', format: 'uuid' }) @ApiEnvelopeResponse(200, 'POIs returned successfully', { type: 'array', items: { $ref: '#/components/schemas/PoiResponse' } }) @ApiStandardErrors() @Roles(...graphRoles)
  listPois(@CurrentUser() user: AuthUser, @Param('floorId') floorId: string) { return this.graph.listPois(user, floorId); }
  @Post('floors/:floorId/pois') @ApiOperation({ summary: 'Create a POI attached to a node' }) @ApiParam({ name: 'floorId', format: 'uuid' }) @ApiEnvelopeResponse(201, 'POI created successfully', { $ref: '#/components/schemas/PoiResponse' }) @ApiStandardErrors() @Roles(...graphRoles)
  createPoi(@CurrentUser() user: AuthUser, @Param('floorId') floorId: string, @Body() dto: CreatePoiDto) { return this.graph.createPoi(user, floorId, dto); }
  @Get('pois/:id') @ApiOperation({ summary: 'Get a POI' }) @ApiParam({ name: 'id', format: 'uuid' }) @ApiEnvelopeResponse(200, 'POI found', { $ref: '#/components/schemas/PoiResponse' }) @ApiStandardErrors() @Roles(...graphRoles)
  getPoi(@CurrentUser() user: AuthUser, @Param('id') id: string) { return this.graph.getPoi(user, id); }
  @Patch('pois/:id') @ApiOperation({ summary: 'Update a POI' }) @ApiParam({ name: 'id', format: 'uuid' }) @ApiEnvelopeResponse(200, 'POI updated successfully', { $ref: '#/components/schemas/PoiResponse' }) @ApiStandardErrors() @Roles(...graphRoles)
  updatePoi(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdatePoiDto) { return this.graph.updatePoi(user, id, dto); }
  @Delete('pois/:id') @ApiOperation({ summary: 'Soft-delete a POI' }) @ApiParam({ name: 'id', format: 'uuid' }) @ApiEnvelopeResponse(200, 'POI deleted successfully') @ApiStandardErrors() @Roles(...graphRoles)
  deletePoi(@CurrentUser() user: AuthUser, @Param('id') id: string) { return this.graph.deletePoi(user, id); }

  @Get('buildings/:buildingId/elevator-links') @ApiOperation({ summary: 'List vertical elevator links in a building' }) @ApiParam({ name: 'buildingId', format: 'uuid' }) @ApiEnvelopeResponse(200, 'Elevator links returned successfully', { type: 'array', items: { $ref: '#/components/schemas/ElevatorLinkResponse' } }) @ApiStandardErrors() @Roles(...graphRoles)
  listElevatorLinks(@CurrentUser() user: AuthUser, @Param('buildingId') buildingId: string) { return this.graph.listElevatorLinks(user, buildingId); }
  @Post('buildings/:buildingId/elevator-links') @ApiOperation({ summary: 'Link two elevator nodes on different floors' }) @ApiParam({ name: 'buildingId', format: 'uuid' }) @ApiEnvelopeResponse(201, 'Elevator link created successfully', { $ref: '#/components/schemas/ElevatorLinkResponse' }) @ApiStandardErrors() @Roles(...graphRoles)
  createElevatorLink(@CurrentUser() user: AuthUser, @Param('buildingId') buildingId: string, @Body() dto: CreateElevatorLinkDto) { return this.graph.createElevatorLink(user, buildingId, dto); }
  @Delete('elevator-links/:id') @HttpCode(200) @ApiOperation({ summary: 'Soft-delete an elevator link' }) @ApiParam({ name: 'id', format: 'uuid' }) @ApiEnvelopeResponse(200, 'Elevator link deleted successfully') @ApiStandardErrors() @Roles(...graphRoles)
  deleteElevatorLink(@CurrentUser() user: AuthUser, @Param('id') id: string) { return this.graph.deleteElevatorLink(user, id); }
}
