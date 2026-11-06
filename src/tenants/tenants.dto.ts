import { ApiPropertyOptional } from '@nestjs/swagger';
import { TenantStatus } from '@prisma/client';
import { IsBoolean, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateTenantDto {
  @ApiPropertyOptional({ maxLength: 100 }) @IsOptional() @IsString() @MaxLength(100) name?: string;
  @ApiPropertyOptional({ enum: TenantStatus }) @IsOptional() @IsEnum(TenantStatus) status?: TenantStatus;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() archived?: boolean;
}
