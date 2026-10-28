import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsUUID, Min, ValidateNested } from 'class-validator';
import { NavigationDraftEdgeDto, NavigationDraftNodeDto } from '../graph.dto';

export const DRAFT_APPLY_MODES = ['APPEND', 'REPLACE'] as const;
export type DraftApplyMode = (typeof DRAFT_APPLY_MODES)[number];

export class ApplyNavigationDraftV2Dto {
  @ApiProperty({ format: 'uuid', description: 'Required in v2: persisted idempotency key, unique per floor' }) @IsUUID() draftId!: string;
  @ApiPropertyOptional({ enum: DRAFT_APPLY_MODES, default: 'APPEND', description: 'REPLACE soft-deletes the floor graph first and is rejected while POIs, stores, QR anchors or connectors still reference its nodes' })
  @IsOptional() @IsIn([...DRAFT_APPLY_MODES]) mode?: DraftApplyMode;
  @ApiPropertyOptional({ description: 'Optimistic concurrency against Floor.graphVersion' }) @IsOptional() @IsInt() @Min(0) expectedGraphVersion?: number;
  @IsArray() @ArrayMaxSize(300) @ValidateNested({ each: true }) @Type(() => NavigationDraftNodeDto) nodes!: NavigationDraftNodeDto[];
  @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => NavigationDraftEdgeDto) edges!: NavigationDraftEdgeDto[];
}

export class NavigationDraftApplyV2Response {
  @ApiProperty({ example: 12 }) nodesCreated!: number;
  @ApiProperty({ example: 11 }) edgesCreated!: number;
  @ApiProperty({ example: 0, description: 'Nodes soft-deleted by REPLACE' }) nodesRemoved!: number;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string', format: 'uuid' } }) nodeIds!: Record<string, string>;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string', format: 'uuid' } }) edgeIds!: Record<string, string>;
  @ApiProperty({ example: 9, description: 'Floor.graphVersion after the apply' }) graphVersion!: number;
  @ApiProperty({ example: false, description: 'true when draftId was already applied and this is the stored first result' }) replayed!: boolean;
}
