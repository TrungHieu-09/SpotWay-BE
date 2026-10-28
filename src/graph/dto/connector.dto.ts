import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ConnectorKind } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsEnum, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateNested } from 'class-validator';

export class ConnectorStopDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() floorId!: string;
  @ApiProperty({ format: 'uuid', description: 'Node on floorId that this connector serves' }) @IsUUID() nodeId!: string;
}

export class CreateConnectorDto {
  @ApiProperty({ enum: ConnectorKind, example: ConnectorKind.ELEVATOR }) @IsEnum(ConnectorKind) kind!: ConnectorKind;
  @ApiProperty({ example: 'Thang máy A', maxLength: 100 }) @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @ApiPropertyOptional({ example: true, default: true }) @IsOptional() @IsBoolean() accessible?: boolean;
  @ApiProperty({ type: [ConnectorStopDto], description: 'At least two stops on distinct floors of this building' })
  @IsArray() @ArrayMinSize(2) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => ConnectorStopDto) stops!: ConnectorStopDto[];
}

export class UpdateConnectorDto {
  @ApiPropertyOptional({ maxLength: 100 }) @IsOptional() @IsString() @MinLength(1) @MaxLength(100) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() accessible?: boolean;
  @ApiPropertyOptional({ type: [ConnectorStopDto], description: 'Replaces the full stop list when present' })
  @IsOptional() @IsArray() @ArrayMinSize(2) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => ConnectorStopDto) stops?: ConnectorStopDto[];
}

export class ConnectorStopResponse {
  @ApiProperty({ format: 'uuid' }) floorId!: string;
  @ApiProperty({ format: 'uuid' }) nodeId!: string;
}

export class ConnectorResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) buildingId!: string;
  @ApiProperty({ enum: ConnectorKind }) kind!: ConnectorKind;
  @ApiProperty() name!: string;
  @ApiProperty() accessible!: boolean;
  @ApiProperty({ type: [ConnectorStopResponse] }) stops!: ConnectorStopResponse[];
  @ApiProperty({ format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ format: 'date-time' }) updatedAt!: Date;
}
