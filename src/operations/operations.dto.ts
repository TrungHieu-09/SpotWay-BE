import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, IsUUID, MaxLength, ValidateIf } from 'class-validator';

export class UpdateOperationsDto {
  @ApiPropertyOptional({ description: 'Every lift of the building is out of order' }) @IsOptional() @IsBoolean() elevator?: boolean;
  @ApiPropertyOptional({ description: 'Power cut: lifts and escalators stop' }) @IsOptional() @IsBoolean() power?: boolean;
  @ApiPropertyOptional({ format: 'uuid', nullable: true, description: 'Centre of a closed zone; null reopens it' }) @ValidateIf((_, v) => v !== null) @IsOptional() @IsUUID() zoneNodeId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) zoneName?: string;
  @ApiPropertyOptional({ nullable: true, description: 'Notice shown to the guests; null or empty removes it' }) @ValidateIf((_, v) => v !== null) @IsOptional() @IsString() @MaxLength(300) announcement?: string | null;
}
