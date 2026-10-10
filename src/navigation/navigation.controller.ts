import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBody, ApiExtraModels, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Public } from '../common/public.decorator';
import { ApiEnvelopeResponse, ApiStandardErrors } from '../common/swagger';
import { CreateRouteDto, PublicSearchQuery, PublicSearchResult, RouteResponse, RouteStepResponse } from './navigation.dto';
import { NavigationService } from './navigation.service';

@ApiTags('Public Navigation') @ApiExtraModels(PublicSearchResult, RouteResponse, RouteStepResponse) @Public() @Controller('public')
export class NavigationController {
  constructor(private readonly navigation: NavigationService) {}
  @Get('buildings/:buildingId/floors') @ApiOperation({ summary: 'List published floors for Guest map viewing' }) @ApiParam({ name: 'buildingId', format: 'uuid' }) @ApiEnvelopeResponse(200, 'Published floors returned successfully') @ApiStandardErrors()
  listFloors(@Param('buildingId') buildingId: string) { return this.navigation.listFloors(buildingId); }
  @Get('floors/:floorId/map') @ApiOperation({ summary: 'Get published map graph, POIs, and active stores for a floor' }) @ApiParam({ name: 'floorId', format: 'uuid' }) @ApiEnvelopeResponse(200, 'Published map returned successfully') @ApiStandardErrors()
  map(@Param('floorId') floorId: string) { return this.navigation.map(floorId); }
  @Get('buildings/:buildingId/search') @ApiOperation({ summary: 'Search active stores and POIs in published floors' }) @ApiParam({ name: 'buildingId', format: 'uuid' }) @ApiQuery({ name: 'q', required: false }) @ApiQuery({ name: 'type', required: false, enum: ['STORE', 'POI'] }) @ApiQuery({ name: 'page', required: false }) @ApiQuery({ name: 'limit', required: false }) @ApiEnvelopeResponse(200, 'Search results returned successfully') @ApiStandardErrors()
  search(@Param('buildingId') buildingId: string, @Query() query: PublicSearchQuery) { return this.navigation.search(buildingId, query); }
  @Post('routes') @ApiOperation({ summary: 'Calculate the shortest published indoor route to an active store' }) @ApiBody({ type: CreateRouteDto }) @ApiEnvelopeResponse(201, 'Route calculated successfully', { $ref: '#/components/schemas/RouteResponse' }) @ApiStandardErrors()
  route(@Body() dto: CreateRouteDto) { return this.navigation.route(dto); }
}
