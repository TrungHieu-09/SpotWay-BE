import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PoiCategory } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';

/** POI with its own pixel position. Omit nodeId to auto-snap to the nearest eligible node on the floor. */
export class CreatePoiV2Dto {
  @ApiProperty({ example: 240.5 }) @IsNumber() x!: number;
  @ApiProperty({ example: 120.25 }) @IsNumber() y!: number;
  @ApiProperty({ example: 'North restroom', maxLength: 100 }) @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @ApiProperty({ enum: PoiCategory }) @IsEnum(PoiCategory) category!: PoiCategory;
  @ApiPropertyOptional({ example: 'restroom' }) @IsOptional() @IsString() @MaxLength(100) icon?: string;
  @ApiPropertyOptional({ format: 'uuid', description: 'Explicit anchor node; skips auto-snapping' }) @IsOptional() @IsUUID() nodeId?: string;
  @ApiPropertyOptional({ example: 8, description: 'Override of the server snap limit, in metres (never above the server maximum)' })
  @IsOptional() @IsNumber() @Min(0) @Max(100) maxSnapMeters?: number;
}

export class UpdatePoiV2Dto {
  @ApiPropertyOptional() @IsOptional() @IsNumber() x?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() y?: number;
  @ApiPropertyOptional({ maxLength: 100 }) @IsOptional() @IsString() @MinLength(1) @MaxLength(100) name?: string;
  @ApiPropertyOptional({ enum: PoiCategory }) @IsOptional() @IsEnum(PoiCategory) category?: PoiCategory;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) icon?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() nodeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) @Max(100) maxSnapMeters?: number;
}

export class SnapPoiQuery {
  @ApiProperty({ example: 240.5 }) @Type(() => Number) @IsNumber() x!: number;
  @ApiProperty({ example: 120.25 }) @Type(() => Number) @IsNumber() y!: number;
  @ApiPropertyOptional({ example: 8 }) @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(100) maxSnapMeters?: number;
}

export class SnapResultResponse {
  @ApiProperty({ format: 'uuid' }) nodeId!: string;
  @ApiProperty({ example: 2.4, description: 'Distance from the requested point to the node, in metres' }) distanceMeters!: number;
}

export class PoiV2Response {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) floorId!: string;
  @ApiProperty({ format: 'uuid' }) nodeId!: string;
  @ApiProperty({ example: 240.5, nullable: true }) x!: number | null;
  @ApiProperty({ example: 120.25, nullable: true }) y!: number | null;
  @ApiProperty({ nullable: true, example: 2.4 }) snapDistanceMeters!: number | null;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: PoiCategory }) category!: PoiCategory;
  @ApiPropertyOptional({ nullable: true }) icon!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ format: 'date-time' }) updatedAt!: Date;
}
