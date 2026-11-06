import { ApiProperty } from '@nestjs/swagger';
import { ServicePackage } from '@prisma/client';
import { IsEnum, IsInt, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

export class CreateWorkspaceOrderDto {
  @ApiProperty({ enum: ServicePackage, example: ServicePackage.STARTER }) @IsEnum(ServicePackage) planId!: ServicePackage;
  @ApiProperty({ example: 12, minimum: 1, maximum: 36 }) @IsInt() @Min(1) @Max(36) months!: number;
  @ApiProperty({ example: 'Metro Transit Authority', maxLength: 100 }) @IsString() @MinLength(2) @MaxLength(100) workspaceName!: string;
  @ApiProperty({ example: 'metro-transit', pattern: '^[a-z0-9-]{3,30}$' }) @IsString() @Matches(/^[a-z0-9-]{3,30}$/) subdomain!: string;
}

export class CreateRenewalOrderDto {
  @ApiProperty({ enum: ServicePackage, example: ServicePackage.PRO }) @IsEnum(ServicePackage) planId!: ServicePackage;
  @ApiProperty({ example: 12, minimum: 1, maximum: 36 }) @IsInt() @Min(1) @Max(36) months!: number;
}
