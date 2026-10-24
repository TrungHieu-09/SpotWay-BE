import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NodeType } from '@prisma/client';

export class NavigationDraftNodeResponse {
  @ApiProperty({ example: 'draft-node-0' }) id!: string;
  @ApiProperty({ example: 540.25, description: 'Map pixels' }) x!: number;
  @ApiProperty({ example: 310.5, description: 'Map pixels' }) y!: number;
  @ApiProperty({ nullable: true, example: null }) name!: string | null;
  @ApiProperty({ enum: NodeType, description: 'Geometry only suggests NORMAL or JUNCTION; the Manager sets special types' }) type!: NodeType;
  @ApiProperty() accessible!: boolean;
  @ApiProperty({ minimum: 0, maximum: 1, description: 'Suggestion confidence, not a safety approval' }) confidence!: number;
  @ApiProperty() requiresConfirmation!: boolean;
  @ApiPropertyOptional({ example: 'SKELETON_JUNCTION' }) source?: string;
}

export class NavigationDraftEdgeResponse {
  @ApiProperty({ example: 'draft-edge-0' }) id!: string;
  @ApiProperty() fromNodeId!: string;
  @ApiProperty() toNodeId!: string;
  @ApiProperty({ description: 'Informational; recomputed from node coordinates on apply' }) weight!: number;
  @ApiProperty() accessible!: boolean;
  @ApiProperty({ minimum: 0, maximum: 1 }) confidence!: number;
  @ApiProperty() requiresConfirmation!: boolean;
  @ApiPropertyOptional({ example: 'SKELETON_CHAIN' }) source?: string;
}

export class NavigationDraftResponse {
  @ApiProperty({ enum: [1] }) schemaVersion!: 1;
  @ApiProperty({ enum: ['PIXEL'], description: 'x/y are map pixels, the same space as persisted nodes' }) coordinateSpace!: 'PIXEL';
  @ApiProperty({ example: { width: 1600, height: 1000 } }) image!: { width: number; height: number };
  @ApiProperty({ type: [NavigationDraftNodeResponse] }) nodes!: NavigationDraftNodeResponse[];
  @ApiProperty({ type: [NavigationDraftEdgeResponse] }) edges!: NavigationDraftEdgeResponse[];
  @ApiProperty({ type: [String], example: ['DISCONNECTED_WALKABLE_AREAS: ...'] }) warnings!: string[];
  @ApiPropertyOptional({ type: 'object', additionalProperties: true }) diagnostics?: Record<string, unknown>;
}
