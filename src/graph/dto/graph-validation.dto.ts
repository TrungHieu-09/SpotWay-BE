import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export type GraphIssueSeverity = 'ERROR' | 'WARNING';

export class GraphIssue {
  @ApiProperty({ example: 'FLOOR_NOT_CALIBRATED' }) code!: string;
  @ApiProperty({ enum: ['ERROR', 'WARNING'] }) severity!: GraphIssueSeverity;
  @ApiProperty() message!: string;
  @ApiPropertyOptional({ type: [String], description: 'Ids of the offending nodes/edges/POIs' }) ids?: string[];
}

export class GraphValidationReport {
  @ApiProperty({ format: 'uuid' }) floorId!: string;
  @ApiProperty() graphVersion!: number;
  @ApiProperty({ description: 'true when there is no ERROR issue; a floor may only be published when true' }) valid!: boolean;
  @ApiProperty({ type: [GraphIssue] }) issues!: GraphIssue[];
}
