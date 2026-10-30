import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { AuthUser } from '../common/auth.types';
import { CurrentUser } from '../common/current-user.decorator';
import { Roles } from '../common/roles.decorator';
import { ApiEnvelopeResponse, ApiStandardErrors } from '../common/swagger';
import { DraftApplyService } from './application/draft-apply.service';
import { GraphValidatorService } from './application/graph-validator.service';
import { FloorCalibrationService } from './application/floor-calibration.service';
import { PoiService } from './application/poi.service';
import { CalibrateFloorDto, CalibrationResponse } from './dto/calibration.dto';
import { ApplyNavigationDraftV2Dto, NavigationDraftApplyV2Response } from './dto/draft-apply-v2.dto';
import { GraphValidationReport } from './dto/graph-validation.dto';
import { CreatePoiV2Dto, PoiV2Response, SnapPoiQuery, SnapResultResponse, UpdatePoiV2Dto } from './dto/poi-v2.dto';
import { CreateEdgeDto, CreateElevatorLinkDto, CreateNodeDto, EdgeResponse, ElevatorLinkResponse, NodeResponse, UpdateEdgeDto, UpdateNodeDto } from './graph.dto';
import { GraphService } from './graph.service';

const graphRoles = [UserRole.ADMIN, UserRole.BUILDING_OWNER, UserRole.BUILDING_MANAGER];

@ApiTags('Map Editor')
@ApiBearerAuth('bearerAuth')
@ApiExtraModels(NodeResponse, EdgeResponse, PoiV2Response, ElevatorLinkResponse, NavigationDraftApplyV2Response, CalibrationResponse, SnapResultResponse, GraphValidationReport)
@Controller()
export class GraphController {
  constructor(private readonly graph: GraphService, private readonly pois: PoiService, private readonly drafts: DraftApplyService, private readonly calibration: FloorCalibrationService, private readonly validator: GraphValidatorService) {}

  @Get('floors/:floorId/nodes') @ApiOperation({ summary: 'List nodes in a floor' }) @ApiParam({ name: 'floorId', format: 'uuid' }) @ApiEnvelopeResponse(200, 'Nodes returned successfully', { type: 'array', items: { $ref: '#/components/schemas/NodeResponse' } }) @ApiStandardErrors() @Roles(...graphRoles)
  listNodes(@CurrentUser() user: AuthUser, @Param('floorId') floorId: string) { return this.graph.listNodes(user, floorId); }
  @Post('floors/:floorId/nodes') @ApiOperation({ summary: 'Create a map node' }) @ApiParam({ name: 'floorId', format: 'uuid' }) @ApiEnvelopeResponse(201, 'Node created successfully', { $ref: '#/components/schemas/NodeResponse' }) @ApiStandardErrors() @Roles(...graphRoles)
  createNode(@CurrentUser() user: AuthUser, @Param('floorId') floorId: string, @Body() dto: CreateNodeDto) { return this.graph.createNode(user, floorId, dto); }
  @Post('floors/:floorId/navigation-draft/apply') @ApiOperation({ summary: 'Apply manager-confirmed navigation draft nodes and edges in bulk; draftId makes retries idempotent' }) @ApiParam({ name: 'floorId', format: 'uuid' }) @ApiEnvelopeResponse(201, 'Navigation draft applied; returns draft-id to persisted-id mappings', { $ref: '#/components/schemas/NavigationDraftApplyV2Response' }) @ApiStandardErrors() @Roles(UserRole.ADMIN, UserRole.BUILDING_MANAGER)
  applyNavigationDraft(@CurrentUser() user: AuthUser, @Param('floorId') floorId: string, @Body() dto: ApplyNavigationDraftV2Dto) { return this.drafts.apply(user, floorId, dto); }
  @Get('nodes/:id') @ApiOperation({ summary: 'Get a map node' }) @ApiParam({ name: 'id', format: 'uuid' }) @ApiEnvelopeResponse(200, 'Node found', { $ref: '#/components/schemas/NodeResponse' }) @ApiStandardErrors() @Roles(...graphRoles)
  getNode(@CurrentUser() user: AuthUser, @Param('id') id: string) { return this.graph.getNode(user, id); }
  @Patch('nodes/:id') @ApiOperation({ summary: 'Update a map node' }) @ApiParam({ name: 'id', format: 'uuid' }) @ApiEnvelopeResponse(200, 'Node updated successfully', { $ref: '#/components/schemas/NodeResponse' }) @ApiStandardErrors() @Roles(...graphRoles)
  updateNode(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateNodeDto) { return this.graph.updateNode(user, id, dto); }
  @Delete('nodes/:id') @ApiOperation({ summary: 'Soft-delete a node and its adjacent edges' }) @ApiParam({ name: 'id', format: 'uuid' }) @ApiEnvelopeResponse(200, 'Node deleted successfully') @ApiStandardErrors() @Roles(...graphRoles)
  deleteNode(@CurrentUser() user: AuthUser, @Param('id') id: string) { return this.graph.deleteNode(user, id); }

  @Delete('floors/:floorId/graph') @ApiOperation({ summary: 'Delete every node and edge of a floor (and its POIs and connectors) in one transaction' }) @ApiParam({ name: 'floorId', format: 'uuid' }) @ApiEnvelopeResponse(200, 'Floor graph cleared') @ApiStandardErrors() @Roles(...graphRoles)
  clearFloorGraph(@CurrentUser() user: AuthUser, @Param('floorId') floorId: string) { return this.graph.clearFloorGraph(user, floorId); }

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

  @Get('floors/:floorId/pois') @ApiOperation({ summary: 'List POIs in a floor' }) @ApiParam({ name: 'floorId', format: 'uuid' }) @ApiEnvelopeResponse(200, 'POIs returned successfully', { type: 'array', items: { $ref: '#/components/schemas/PoiV2Response' } }) @ApiStandardErrors() @Roles(...graphRoles)
  listPois(@CurrentUser() user: AuthUser, @Param('floorId') floorId: string) { return this.pois.list(user, floorId); }
  @Get('floors/:floorId/pois/snap') @ApiOperation({ summary: 'Preview which node a POI at (x, y) would snap to; writes nothing' }) @ApiParam({ name: 'floorId', format: 'uuid' }) @ApiEnvelopeResponse(200, 'Nearest node returned', { $ref: '#/components/schemas/SnapResultResponse' }) @ApiStandardErrors() @Roles(...graphRoles)
  snapPoi(@CurrentUser() user: AuthUser, @Param('floorId') floorId: string, @Query() query: SnapPoiQuery) { return this.pois.snap(user, floorId, query.x, query.y, query.maxSnapMeters); }
  @Post('floors/:floorId/pois') @ApiOperation({ summary: 'Create a POI at (x, y); it snaps to the nearest node unless nodeId is given' }) @ApiParam({ name: 'floorId', format: 'uuid' }) @ApiEnvelopeResponse(201, 'POI created successfully', { $ref: '#/components/schemas/PoiV2Response' }) @ApiStandardErrors() @Roles(...graphRoles)
  createPoi(@CurrentUser() user: AuthUser, @Param('floorId') floorId: string, @Body() dto: CreatePoiV2Dto) { return this.pois.create(user, floorId, dto); }
  @Delete('floors/:floorId/pois') @ApiOperation({ summary: 'Soft-delete every POI of a floor in one transaction' }) @ApiParam({ name: 'floorId', format: 'uuid' }) @ApiEnvelopeResponse(200, 'Floor POIs deleted') @ApiStandardErrors() @Roles(...graphRoles)
  deleteFloorPois(@CurrentUser() user: AuthUser, @Param('floorId') floorId: string) { return this.pois.removeAllOnFloor(user, floorId); }
  @Get('pois/:id') @ApiOperation({ summary: 'Get a POI' }) @ApiParam({ name: 'id', format: 'uuid' }) @ApiEnvelopeResponse(200, 'POI found', { $ref: '#/components/schemas/PoiV2Response' }) @ApiStandardErrors() @Roles(...graphRoles)
  getPoi(@CurrentUser() user: AuthUser, @Param('id') id: string) { return this.pois.get(user, id); }
  @Patch('pois/:id') @ApiOperation({ summary: 'Update a POI; changing its position re-snaps it' }) @ApiParam({ name: 'id', format: 'uuid' }) @ApiEnvelopeResponse(200, 'POI updated successfully', { $ref: '#/components/schemas/PoiV2Response' }) @ApiStandardErrors() @Roles(...graphRoles)
  updatePoi(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdatePoiV2Dto) { return this.pois.update(user, id, dto); }
  @Delete('pois/:id') @ApiOperation({ summary: 'Soft-delete a POI' }) @ApiParam({ name: 'id', format: 'uuid' }) @ApiEnvelopeResponse(200, 'POI deleted successfully') @ApiStandardErrors() @Roles(...graphRoles)
  deletePoi(@CurrentUser() user: AuthUser, @Param('id') id: string) { return this.pois.remove(user, id); }

  @Patch('floors/:floorId/calibration') @ApiOperation({ summary: 'Set the floor scale (metres per pixel) and recompute all edge lengths' }) @ApiParam({ name: 'floorId', format: 'uuid' }) @ApiEnvelopeResponse(200, 'Floor calibrated', { $ref: '#/components/schemas/CalibrationResponse' }) @ApiStandardErrors() @Roles(...graphRoles)
  calibrateFloor(@CurrentUser() user: AuthUser, @Param('floorId') floorId: string, @Body() dto: CalibrateFloorDto) { return this.calibration.calibrate(user, floorId, dto); }

  @Post('floors/:floorId/graph/validate') @HttpCode(200) @ApiOperation({ summary: 'Check whether the floor graph is ready to publish; writes nothing' }) @ApiParam({ name: 'floorId', format: 'uuid' }) @ApiEnvelopeResponse(200, 'Validation report returned', { $ref: '#/components/schemas/GraphValidationReport' }) @ApiStandardErrors() @Roles(...graphRoles)
  validateFloor(@CurrentUser() user: AuthUser, @Param('floorId') floorId: string) { return this.validator.validate(user, floorId); }

  @Get('buildings/:buildingId/elevator-links') @ApiOperation({ summary: 'List vertical elevator links in a building' }) @ApiParam({ name: 'buildingId', format: 'uuid' }) @ApiEnvelopeResponse(200, 'Elevator links returned successfully', { type: 'array', items: { $ref: '#/components/schemas/ElevatorLinkResponse' } }) @ApiStandardErrors() @Roles(...graphRoles)
  listElevatorLinks(@CurrentUser() user: AuthUser, @Param('buildingId') buildingId: string) { return this.graph.listElevatorLinks(user, buildingId); }
  @Post('buildings/:buildingId/elevator-links') @ApiOperation({ summary: 'Link two elevator nodes on different floors' }) @ApiParam({ name: 'buildingId', format: 'uuid' }) @ApiEnvelopeResponse(201, 'Elevator link created successfully', { $ref: '#/components/schemas/ElevatorLinkResponse' }) @ApiStandardErrors() @Roles(...graphRoles)
  createElevatorLink(@CurrentUser() user: AuthUser, @Param('buildingId') buildingId: string, @Body() dto: CreateElevatorLinkDto) { return this.graph.createElevatorLink(user, buildingId, dto); }
  @Delete('elevator-links/:id') @HttpCode(200) @ApiOperation({ summary: 'Soft-delete an elevator link' }) @ApiParam({ name: 'id', format: 'uuid' }) @ApiEnvelopeResponse(200, 'Elevator link deleted successfully') @ApiStandardErrors() @Roles(...graphRoles)
  deleteElevatorLink(@CurrentUser() user: AuthUser, @Param('id') id: string) { return this.graph.deleteElevatorLink(user, id); }
}
