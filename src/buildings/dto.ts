import { BuildingStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
export class CreateBuildingDto { @IsString() @MaxLength(100) name!: string; @IsOptional() @IsString() @MaxLength(255) address?: string; @IsOptional() @IsString() tenantId?: string; }
export class UpdateBuildingDto { @IsOptional() @IsString() @MaxLength(100) name?: string; @IsOptional() @IsString() @MaxLength(255) address?: string; @IsOptional() @IsEnum(BuildingStatus) status?: BuildingStatus; }
