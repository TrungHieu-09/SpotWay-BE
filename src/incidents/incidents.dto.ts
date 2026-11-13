import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class ClaimExitDto {
  @ApiProperty({ format: 'uuid', description: 'Random id the phone keeps while the app is open (no account, no personal data)' }) @IsUUID() deviceId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() exitNodeId!: string;
}

export const INCIDENT_TYPES = ['FIRE'] as const;

export class StartIncidentDto {
  @ApiPropertyOptional({ enum: INCIDENT_TYPES, default: 'FIRE' }) @IsOptional() @IsIn(INCIDENT_TYPES as unknown as string[]) type?: (typeof INCIDENT_TYPES)[number];
  @ApiProperty({ type: [String], description: 'Nodes on fire; routing avoids them and guests are told to evacuate' }) @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @IsUUID('all', { each: true }) nodeIds!: string[];
  @ApiPropertyOptional({ maxLength: 200 }) @IsOptional() @IsString() @MaxLength(200) message?: string;
}
