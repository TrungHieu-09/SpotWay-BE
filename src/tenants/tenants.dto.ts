import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ServicePackage, TenantStatus } from '@prisma/client';
import { IsBoolean, IsEmail, IsEnum, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
export class CreateTenantDto {
  @ApiProperty({ example: 'Example Mall', maxLength: 100 }) @IsString() @MaxLength(100) name!: string;
  @ApiProperty({ example: 'example-mall', pattern: '^[a-z0-9-]{3,30}$' }) @IsString() @Matches(/^[a-z0-9-]{3,30}$/) subdomain!: string;
  @ApiProperty({ example: 'owner@example.com', format: 'email' }) @IsEmail() ownerEmail!: string;
  @ApiPropertyOptional({ enum: ServicePackage }) @IsOptional() @IsEnum(ServicePackage) servicePackage?: ServicePackage;
}
export class UpdateTenantDto {
  @ApiPropertyOptional({ maxLength: 100 }) @IsOptional() @IsString() @MaxLength(100) name?: string;
  @ApiPropertyOptional({ enum: ServicePackage }) @IsOptional() @IsEnum(ServicePackage) servicePackage?: ServicePackage;
  @ApiPropertyOptional({ enum: TenantStatus }) @IsOptional() @IsEnum(TenantStatus) status?: TenantStatus;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() archived?: boolean;
}
