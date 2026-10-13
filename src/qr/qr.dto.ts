import { ApiProperty } from '@nestjs/swagger'; import { IsString, MaxLength } from 'class-validator';
export class CreateQrAnchorDto { @ApiProperty({ example: 'North entrance QR' }) @IsString() @MaxLength(100) label!: string; }
