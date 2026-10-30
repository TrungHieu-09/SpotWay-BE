import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsInt, IsOptional, IsUUID, Min } from 'class-validator';

export class MaintenanceSelectionDto {
  @ApiPropertyOptional({ type: [String], format: 'uuid', description: 'Every walkway touching these nodes is affected' })
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsUUID('all', { each: true }) nodeIds?: string[];
  @ApiPropertyOptional({ type: [String], format: 'uuid' })
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsUUID('all', { each: true }) edgeIds?: string[];
  @ApiPropertyOptional({ description: 'Reject with 409 GRAPH_VERSION_CONFLICT when the floor changed since this version' })
  @IsOptional() @IsInt() @Min(0) expectedGraphVersion?: number;
}

export class MaintenanceEdge {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) fromNodeId!: string;
  @ApiProperty({ format: 'uuid' }) toNodeId!: string;
}

export class MaintenanceReport {
  @ApiProperty({ format: 'uuid' }) floorId!: string;
  @ApiProperty() graphVersion!: number;
  @ApiProperty({ type: [MaintenanceEdge], description: 'Edges that routing currently avoids' }) blockedEdges!: MaintenanceEdge[];
  @ApiProperty({ type: [String], description: 'Nodes whose every edge is blocked, so they cannot be walked through' }) blockedNodeIds!: string[];
  @ApiPropertyOptional({ description: 'Edges changed by this call' }) changedEdges?: number;
}
