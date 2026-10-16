import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

export class PublicSearchQuery {
  @ApiPropertyOptional({ example: 'coffee', maxLength: 100 }) @IsOptional() @IsString() @MaxLength(100) q?: string;
  @ApiPropertyOptional({ enum: ['STORE', 'POI', 'NODE'] }) @IsOptional() @IsIn(['STORE', 'POI', 'NODE']) type?: 'STORE' | 'POI' | 'NODE';
  @ApiPropertyOptional({ example: 1, default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @ApiPropertyOptional({ example: 20, default: 20 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 20;
}

export class CreateRouteDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() fromNodeId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() toStoreId!: string;
  @ApiProperty({ example: false, default: false }) @IsBoolean() wheelchairMode!: boolean;
}

export class PublicSearchResult {
  @ApiProperty({ enum: ['STORE', 'POI', 'NODE'] }) type!: 'STORE' | 'POI' | 'NODE';
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'Demo Store' }) name!: string;
  @ApiProperty({ format: 'uuid' }) floorId!: string;
  @ApiProperty({ format: 'uuid' }) nodeId!: string;
  @ApiProperty({ example: 100 }) x!: number;
  @ApiProperty({ example: 200 }) y!: number;
}

export class RouteStepResponse {
  @ApiProperty({ format: 'uuid' }) nodeId!: string;
  @ApiProperty({ format: 'uuid' }) floorId!: string;
  @ApiProperty({ example: 100 }) x!: number;
  @ApiProperty({ example: 200 }) y!: number;
  @ApiPropertyOptional({ example: 90, minimum: 0, maximum: 360, nullable: true }) bearing!: number | null;
  @ApiPropertyOptional({ enum: ['ELEVATOR'], nullable: true }) transition?: 'ELEVATOR';
  @ApiPropertyOptional({ format: 'uuid', nullable: true }) targetFloorId?: string;
  @ApiProperty({ example: 'Continue straight' }) instruction!: string;
}

export class RouteResponse {
  @ApiProperty({ example: 320.5 }) totalDistance!: number;
  @ApiProperty({ example: 267 }) estimatedDurationSeconds!: number;
  @ApiProperty({ type: [String], format: 'uuid' }) nodeIds!: string[];
  @ApiProperty({ type: [RouteStepResponse] }) steps!: RouteStepResponse[];
}
