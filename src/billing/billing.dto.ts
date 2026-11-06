import { ApiProperty } from '@nestjs/swagger';
import { ServicePackage } from '@prisma/client';
import { IsEnum, IsInt, Max, Min } from 'class-validator';

export class CreateRenewalOrderDto {
  @ApiProperty({ enum: ServicePackage, example: ServicePackage.PRO }) @IsEnum(ServicePackage) planId!: ServicePackage;
  @ApiProperty({ example: 12, minimum: 1, maximum: 36 }) @IsInt() @Min(1) @Max(36) months!: number;
}
