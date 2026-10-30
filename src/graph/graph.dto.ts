import { EdgeStatus, NodeType } from '@prisma/client';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsInt, IsNumber, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength } from 'class-validator';

export class CreateNodeDto {
  @ApiProperty({ example: 240.5 }) @IsNumber() x!: number;
  @ApiProperty({ example: 120.25 }) @IsNumber() y!: number;
  @ApiPropertyOptional({ example: 'Cửa vào Zara', maxLength: 100 }) @IsOptional() @IsString() @MaxLength(100) name?: string;
  @ApiProperty({ enum: NodeType, example: NodeType.JUNCTION }) @IsEnum(NodeType) type!: NodeType;
  @ApiPropertyOptional({ example: true, default: true }) @IsOptional() @IsBoolean() accessible?: boolean;
  @ApiPropertyOptional({ example: 7, description: 'Optimistic concurrency: rejected with GRAPH_VERSION_CONFLICT when it differs from Floor.graphVersion' }) @IsOptional() @IsInt() @Min(0) expectedGraphVersion?: number;
}
export class UpdateNodeDto {
  @ApiPropertyOptional({ example: 240.5 }) @IsOptional() @IsNumber() x?: number;
  @ApiPropertyOptional({ example: 120.25 }) @IsOptional() @IsNumber() y?: number;
  @ApiPropertyOptional({ enum: NodeType }) @IsOptional() @IsEnum(NodeType) type?: NodeType;
  @ApiPropertyOptional({ example: 'Thang máy A', maxLength: 100 }) @IsOptional() @IsString() @MaxLength(100) name?: string;
  @ApiPropertyOptional({ example: true }) @IsOptional() @IsBoolean() accessible?: boolean;
  @ApiPropertyOptional({ example: 7, description: 'Optimistic concurrency: rejected with GRAPH_VERSION_CONFLICT when it differs from Floor.graphVersion' }) @IsOptional() @IsInt() @Min(0) expectedGraphVersion?: number;
}
export class CreateEdgeDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() fromNodeId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() toNodeId!: string;
  @ApiPropertyOptional({ example: true, default: true }) @IsOptional() @IsBoolean() accessible?: boolean;
  @ApiPropertyOptional({ enum: EdgeStatus, default: EdgeStatus.ACTIVE }) @IsOptional() @IsEnum(EdgeStatus) status?: EdgeStatus;
  @ApiPropertyOptional({ example: 7, description: 'Optimistic concurrency: rejected with GRAPH_VERSION_CONFLICT when it differs from Floor.graphVersion' }) @IsOptional() @IsInt() @Min(0) expectedGraphVersion?: number;
}
export class UpdateEdgeDto {
  @ApiPropertyOptional({ example: true }) @IsOptional() @IsBoolean() accessible?: boolean;
  @ApiPropertyOptional({ enum: EdgeStatus }) @IsOptional() @IsEnum(EdgeStatus) status?: EdgeStatus;
}
export class CreateElevatorLinkDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() nodeIdFrom!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() nodeIdTo!: string;
}
export class NavigationDraftNodeDto {
  @IsString() @MinLength(1) @MaxLength(100) id!: string;
  @IsNumber() x!: number;
  @IsNumber() y!: number;
  @IsOptional() @IsString() @MaxLength(100) name?: string | null;
  @IsEnum(NodeType) type!: NodeType;
  @IsOptional() @IsBoolean() accessible?: boolean;
  @IsOptional() @IsBoolean() confirmed?: boolean;
}
export class NavigationDraftEdgeDto {
  @IsString() @MinLength(1) @MaxLength(100) id!: string;
  @IsString() @MinLength(1) @MaxLength(100) fromNodeId!: string;
  @IsString() @MinLength(1) @MaxLength(100) toNodeId!: string;
  @IsOptional() @IsBoolean() accessible?: boolean;
  @IsOptional() @IsBoolean() confirmed?: boolean;
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
  @ApiProperty({ example: 120.42, description: 'Legacy length in map pixels; superseded by weightMeters' }) weight!: number;
  @ApiProperty({ example: 6.02, nullable: true, description: 'Length in metres; null until the floor is calibrated' }) weightMeters!: number | null;
  @ApiProperty({ example: true }) accessible!: boolean;
  @ApiProperty({ enum: EdgeStatus }) status!: EdgeStatus;
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
