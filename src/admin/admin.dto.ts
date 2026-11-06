import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

/** Roles an admin can hand out. Admins and guests are not created by hand. */
export const ASSIGNABLE_ROLES = ['building_owner', 'building_manager', 'store_owner'] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export class CreateAdminUserDto {
  @ApiProperty({ format: 'email', example: 'owner@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ format: 'password', minLength: 8, maxLength: 72, example: 'Password123!' })
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;

  @ApiProperty({ enum: ASSIGNABLE_ROLES })
  @IsIn(ASSIGNABLE_ROLES)
  role!: AssignableRole;

  @ApiPropertyOptional({ description: 'Required for building_manager / store_owner: the Building Owner this account belongs to.' })
  @IsOptional()
  @IsUUID()
  ownerId?: string;
}

export class ResetAdminPasswordDto {
  @ApiPropertyOptional({ format: 'password', minLength: 8, maxLength: 72, description: 'Omit to get a generated temporary password back.' })
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  newPassword?: string;
}
