import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export const CONTRACT_CURRENCIES = ['USD', 'VND'] as const;
export const CONTRACT_PAYMENT_STATUSES = ['paid', 'pending', 'custom'] as const;
/** Scans are kept as base64 data URLs; only documents and plain images are accepted. */
export const SCAN_MIME_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'] as const;

export const MAX_SCAN_PAGES = 10;
/** About 10 MB of binary once base64-encoded (the web client rejects larger files first). */
export const MAX_SCAN_PAGE_CHARS = 14_000_000;
export const MAX_SCAN_TOTAL_CHARS = 36_000_000;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export class ContractScanPageDto {
  @ApiProperty({ maxLength: 200 }) @IsString() @MaxLength(200) fileName!: string;
  @ApiProperty({ example: '1.24 MB' }) @IsString() @MaxLength(40) sizeText!: string;
  @ApiProperty({ enum: SCAN_MIME_TYPES }) @IsIn(SCAN_MIME_TYPES) mime!: string;
  @ApiProperty({ description: 'data:<mime>;base64,<content>' }) @IsString() @MaxLength(MAX_SCAN_PAGE_CHARS) dataUrl!: string;
}

export class CreateContractDto {
  @ApiPropertyOptional({ maxLength: 40, description: 'Generated (HD-<year>-NNN) when omitted' })
  @IsOptional() @IsString() @MinLength(1) @MaxLength(40) contractCode?: string;

  @ApiProperty({ format: 'uuid', description: 'Building Owner the contract is signed with; tenant and email come from this account' })
  @IsUUID() ownerId!: string;

  @ApiPropertyOptional({ maxLength: 200, description: 'Defaults to the name of the owner workspace' })
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) customerName?: string;
  @ApiPropertyOptional({ maxLength: 200 }) @IsOptional() @IsString() @MaxLength(200) representative?: string;
  @ApiPropertyOptional({ maxLength: 200 }) @IsOptional() @IsString() @MaxLength(200) workspaceDomain?: string;

  @ApiProperty({ example: '2026-01-01' }) @Matches(DAY, { message: 'startDate must be YYYY-MM-DD' }) startDate!: string;
  @ApiProperty({ example: '2026-12-31' }) @Matches(DAY, { message: 'endDate must be YYYY-MM-DD' }) endDate!: string;

  @ApiProperty({ minimum: 0 }) @IsNumber() @Min(0) @Max(1_000_000_000_000) annualValue!: number;
  @ApiProperty({ enum: CONTRACT_CURRENCIES }) @IsIn(CONTRACT_CURRENCIES) currency!: (typeof CONTRACT_CURRENCIES)[number];
  @ApiPropertyOptional({ maxLength: 100, nullable: true }) @IsOptional() @IsString() @MaxLength(100) billingLabel?: string | null;
  @ApiProperty({ enum: CONTRACT_PAYMENT_STATUSES }) @IsIn(CONTRACT_PAYMENT_STATUSES) paymentStatus!: (typeof CONTRACT_PAYMENT_STATUSES)[number];

  @ApiPropertyOptional({ minimum: 0, description: 'Limit written in the contract; 0 or omitted = not stated' })
  @IsOptional() @IsInt() @Min(0) @Max(100_000) maxBuildings?: number;
  @ApiPropertyOptional({ minimum: 0, description: 'Limit written in the contract; 0 or omitted = not stated' })
  @IsOptional() @IsInt() @Min(0) @Max(1_000_000) maxFloors?: number;

  @ApiProperty({ type: [ContractScanPageDto], description: `1 to ${MAX_SCAN_PAGES} scanned pages (PDF or image)` })
  @IsArray() @ArrayMaxSize(MAX_SCAN_PAGES) @ValidateNested({ each: true }) @Type(() => ContractScanPageDto)
  scanPages!: ContractScanPageDto[];

  @ApiPropertyOptional({ maxLength: 2000 }) @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

/** On update every field is optional; `scanPages` replaces the stored scan when present. */
export class UpdateContractDto extends PartialType(CreateContractDto) {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() renewalRequested?: boolean;
  @ApiPropertyOptional({ maxLength: 500, nullable: true }) @IsOptional() @IsString() @MaxLength(500) renewalNote?: string | null;
}

export class RenewalRequestDto {
  @ApiPropertyOptional({ maxLength: 500 }) @IsOptional() @IsString() @MaxLength(500) note?: string;
}
