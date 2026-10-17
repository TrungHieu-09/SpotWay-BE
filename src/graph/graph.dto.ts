import { EdgeStatus, NodeType, PoiCategory } from '@prisma/client';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsEnum, IsNumber, IsOptional, IsString, IsUUID, MaxLength, ValidateNested } from 'class-validator';

export class CreateNodeDto {
  @ApiProperty({ example: 240.5 }) @IsNumber() x!: number;
  @ApiProperty({ example: 120.25 }) @IsNumber() y!: number;
  @ApiPropertyOptional({ example: 'Cửa vào Zara', maxLength: 100 }) @IsOptional() @IsString() @MaxLength(100) name?: string;
  @ApiProperty({ enum: NodeType, example: NodeType.JUNCTION }) @IsEnum(NodeType) type!: NodeType;
  @ApiPropertyOptional({ example: true, default: true }) @IsOptional() @IsBoolean() accessible?: boolean;
}
export class UpdateNodeDto {
  @ApiPropertyOptional({ example: 240.5 }) @IsOptional() @IsNumber() x?: number;
  @ApiPropertyOptional({ example: 120.25 }) @IsOptional() @IsNumber() y?: number;
  @ApiPropertyOptional({ enum: NodeType }) @IsOptional() @IsEnum(NodeType) type?: NodeType;
  @ApiPropertyOptional({ example: 'Thang máy A', maxLength: 100 }) @IsOptional() @IsString() @MaxLength(100) name?: string;
  @ApiPropertyOptional({ example: true }) @IsOptional() @IsBoolean() accessible?: boolean;
}
export class CreateEdgeDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() fromNodeId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() toNodeId!: string;
  @ApiPropertyOptional({ example: true, default: true }) @IsOptional() @IsBoolean() accessible?: boolean;
  @ApiPropertyOptional({ enum: EdgeStatus, default: EdgeStatus.ACTIVE }) @IsOptional() @IsEnum(EdgeStatus) status?: EdgeStatus;
}
export class UpdateEdgeDto {
  @ApiPropertyOptional({ example: true }) @IsOptional() @IsBoolean() accessible?: boolean;
  @ApiPropertyOptional({ enum: EdgeStatus }) @IsOptional() @IsEnum(EdgeStatus) status?: EdgeStatus;
}
export class CreatePoiDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() nodeId!: string;
  @ApiProperty({ example: 'North restroom', maxLength: 100 }) @IsString() @MaxLength(100) name!: string;
  @ApiProperty({ enum: PoiCategory, example: PoiCategory.RESTROOM }) @IsEnum(PoiCategory) category!: PoiCategory;
  @ApiPropertyOptional({ example: 'restroom' }) @IsOptional() @IsString() @MaxLength(100) icon?: string;
}
export class UpdatePoiDto {
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() nodeId?: string;
  @ApiPropertyOptional({ example: 'North restroom', maxLength: 100 }) @IsOptional() @IsString() @MaxLength(100) name?: string;
  @ApiPropertyOptional({ enum: PoiCategory }) @IsOptional() @IsEnum(PoiCategory) category?: PoiCategory;
  @ApiPropertyOptional({ example: 'restroom' }) @IsOptional() @IsString() @MaxLength(100) icon?: string;
}
export class CreateElevatorLinkDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() nodeIdFrom!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() nodeIdTo!: string;
}
export class NavigationDraftNodeDto {
  @IsString() id!: string;
  @IsNumber() x!: number;
  @IsNumber() y!: number;
  @IsOptional() @IsString() @MaxLength(100) name?: string | null;
  @IsEnum(NodeType) type!: NodeType;
  @IsOptional() @IsBoolean() accessible?: boolean;
  @IsOptional() @IsBoolean() confirmed?: boolean;
}
export class NavigationDraftEdgeDto {
  @IsString() id!: string;
  @IsString() fromNodeId!: string;
  @IsString() toNodeId!: string;
  @IsOptional() @IsBoolean() accessible?: boolean;
  @IsOptional() @IsBoolean() confirmed?: boolean;
}
export class ApplyNavigationDraftDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => NavigationDraftNodeDto) nodes!: NavigationDraftNodeDto[];
  @IsArray() @ValidateNested({ each: true }) @Type(() => NavigationDraftEdgeDto) edges!: NavigationDraftEdgeDto[];
}

export class NodeResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) tenantId!: string;
  @ApiProperty({ format: 'uuid' }) floorId!: string;
  @ApiProperty({ example: 240.5 }) x!: number;
  @ApiProperty({ example: 120.25 }) y!: number;
  @ApiPropertyOptional({ example: 'Cửa vào Zara', nullable: true }) name!: string | null;
  @ApiProperty({ enum: NodeType }) type!: NodeType;
  @ApiProperty({ example: true }) accessible!: boolean;
  @ApiProperty({ format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ format: 'date-time' }) updatedAt!: Date;
}

export class EdgeResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) floorId!: string;
  @ApiProperty({ format: 'uuid' }) fromNodeId!: string;
  @ApiProperty({ format: 'uuid' }) toNodeId!: string;
  @ApiProperty({ example: 120.42 }) weight!: number;
  @ApiProperty({ example: true }) accessible!: boolean;
  @ApiProperty({ enum: EdgeStatus }) status!: EdgeStatus;
  @ApiProperty({ format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ format: 'date-time' }) updatedAt!: Date;
}

export class PoiResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) floorId!: string;
  @ApiProperty({ format: 'uuid' }) nodeId!: string;
  @ApiProperty({ example: 'North restroom' }) name!: string;
  @ApiProperty({ enum: PoiCategory }) category!: PoiCategory;
  @ApiPropertyOptional({ example: 'restroom', nullable: true }) icon!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ format: 'date-time' }) updatedAt!: Date;
}

export class ElevatorLinkResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) buildingId!: string;
  @ApiProperty({ format: 'uuid' }) nodeIdFrom!: string;
  @ApiProperty({ format: 'uuid' }) nodeIdTo!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: Date;
}
