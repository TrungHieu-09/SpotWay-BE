import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsNumber, IsOptional, Max, Min, ValidateNested } from 'class-validator';

export class PixelPointDto {
  @ApiProperty({ example: 120 }) @IsNumber() x!: number;
  @ApiProperty({ example: 340 }) @IsNumber() y!: number;
}

/** Calibrate by a known real-world distance between two points on the map, or by a direct scale. Exactly one form is required (enforced in the service). */
export class CalibrateFloorDto {
  @ApiPropertyOptional({ example: 0.05, description: 'Direct scale: metres per pixel' })
  @IsOptional() @IsNumber() @Min(0.000001) @Max(100) metersPerPixel?: number;

  @ApiPropertyOptional({ type: PixelPointDto }) @IsOptional() @ValidateNested() @Type(() => PixelPointDto) pointA?: PixelPointDto;
  @ApiPropertyOptional({ type: PixelPointDto }) @IsOptional() @ValidateNested() @Type(() => PixelPointDto) pointB?: PixelPointDto;
  @ApiPropertyOptional({ example: 12.5, description: 'Real distance between pointA and pointB, in metres' })
  @IsOptional() @IsNumber() @Min(0.01) @Max(10000) realDistanceMeters?: number;

  @ApiPropertyOptional({ example: 7, description: 'Optimistic concurrency: rejected with GRAPH_VERSION_CONFLICT when it differs from the floor graphVersion' })
  @IsOptional() @IsInt() @Min(0) expectedGraphVersion?: number;
}

export class CalibrationResponse {
  @ApiProperty({ format: 'uuid' }) floorId!: string;
  @ApiProperty({ example: 0.05 }) metersPerPixel!: number;
  @ApiProperty({ example: 42, description: 'Edges whose weightMeters were recomputed' }) edgesRecomputed!: number;
  @ApiProperty({ example: 8 }) graphVersion!: number;
}
