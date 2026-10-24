import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PromotionStatus } from '@prisma/client';
import { IsDateString, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
export class CreatePromotionDto {
  @ApiProperty({ maxLength: 150 }) @IsString() @MaxLength(150) title!: string;
  @ApiPropertyOptional({ maxLength: 1000 }) @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @ApiProperty({ format: 'date-time' }) @IsDateString() startAt!: string;
  @ApiProperty({ format: 'date-time' }) @IsDateString() endAt!: string;
  @ApiPropertyOptional({ enum: PromotionStatus }) @IsOptional() @IsEnum(PromotionStatus) status?: PromotionStatus;
}
export class UpdatePromotionDto {
  @ApiPropertyOptional({ maxLength: 150 }) @IsOptional() @IsString() @MaxLength(150) title?: string;
  @ApiPropertyOptional({ maxLength: 1000 }) @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @ApiPropertyOptional({ format: 'date-time' }) @IsOptional() @IsDateString() startAt?: string;
  @ApiPropertyOptional({ format: 'date-time' }) @IsOptional() @IsDateString() endAt?: string;
  @ApiPropertyOptional({ enum: PromotionStatus }) @IsOptional() @IsEnum(PromotionStatus) status?: PromotionStatus;
}
