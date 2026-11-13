import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsEmail, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export const STAFF_ROLES = ['building_manager', 'store_owner'] as const;
export const ADMIN_ASSIGNABLE_ROLES = ['building_owner', 'building_manager', 'store_owner'] as const;
export const ACCOUNT_STATUSES = ['active', 'locked'] as const;

export class UpdateProfileDto {
  @ApiProperty({ maxLength: 100 }) @IsString() @MinLength(1) @MaxLength(100) name!: string;
}

export class ChangePasswordDto {
  @ApiPropertyOptional({ description: 'Required unless the account must replace a temporary password' }) @IsOptional() @IsString() currentPassword?: string;
  @ApiProperty({ minLength: 8, maxLength: 72 }) @IsString() @MinLength(8) @MaxLength(72) newPassword!: string;
}

export class CreateStaffDto {
  @ApiProperty({ maxLength: 100 }) @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @ApiProperty({ format: 'email' }) @IsEmail() email!: string;
  @ApiPropertyOptional({ minLength: 8, maxLength: 72 }) @IsOptional() @IsString() @MinLength(8) @MaxLength(72) password?: string;
  @ApiProperty({ enum: STAFF_ROLES }) @IsIn(STAFF_ROLES as unknown as string[]) role!: (typeof STAFF_ROLES)[number];
  @ApiPropertyOptional({ type: [String], description: 'Ignored: the backend has no areas' }) @IsOptional() @IsArray() @IsString({ each: true }) areaIds?: string[];
}

export class UpdateStaffDto {
  @ApiPropertyOptional({ enum: ACCOUNT_STATUSES }) @IsOptional() @IsIn(ACCOUNT_STATUSES as unknown as string[]) status?: (typeof ACCOUNT_STATUSES)[number];
  @ApiPropertyOptional() @IsOptional() @IsBoolean() resetPassword?: boolean;
  @ApiPropertyOptional({ type: [String], description: 'Ignored: the backend has no areas' }) @IsOptional() @IsArray() @IsString({ each: true }) areaIds?: string[];
}

export class CreateStoreOwnerDto {
  @ApiProperty({ maxLength: 100 }) @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @ApiProperty({ format: 'email' }) @IsEmail() email!: string;
}

export class UpdateStoreOwnerDto {
  @ApiProperty({ enum: ACCOUNT_STATUSES }) @IsIn(ACCOUNT_STATUSES as unknown as string[]) status!: (typeof ACCOUNT_STATUSES)[number];
}

export class CreateAdminUserDto {
  @ApiProperty({ format: 'email' }) @IsEmail() email!: string;
  @ApiProperty({ minLength: 8, maxLength: 72 }) @IsString() @MinLength(8) @MaxLength(72) password!: string;
  @ApiProperty({ enum: ADMIN_ASSIGNABLE_ROLES }) @IsIn(ADMIN_ASSIGNABLE_ROLES as unknown as string[]) role!: (typeof ADMIN_ASSIGNABLE_ROLES)[number];
  @ApiPropertyOptional({ description: 'Building Owner the account belongs to (required for manager / store owner)' }) @IsOptional() @IsUUID() ownerId?: string;
}

export class ResetPasswordDto {
  @ApiPropertyOptional({ minLength: 8, maxLength: 72 }) @IsOptional() @IsString() @MinLength(8) @MaxLength(72) newPassword?: string;
}
