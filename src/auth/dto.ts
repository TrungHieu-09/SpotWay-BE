import { IsEmail, IsString, MinLength, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({ format: 'email', example: 'admin@spotway.local' })
  @IsEmail()
  email!: string;

  @ApiProperty({ format: 'password', example: 'ChangeMe123!' })
  @IsString()
  password!: string;
}

export class RefreshDto {
  @ApiProperty({ description: 'Refresh token returned by login or OAuth exchange' })
  @IsString()
  refreshToken!: string;
}

export class OAuthExchangeDto {
  @ApiProperty({ description: 'Single-use OAuth code returned to the frontend callback' })
  @IsString()
  code!: string;
}

export class ChangePasswordDto {
  @ApiPropertyOptional({ format: 'password', example: 'OldPassword123!' })
  @IsString()
  @IsOptional()
  currentPassword?: string;

  @ApiProperty({ format: 'password', minLength: 8, example: 'NewPassword123!' })
  @IsString()
  @MinLength(8)
  newPassword!: string;
}

export class UpdateProfileDto {
  @ApiProperty({ description: 'Display name of the user', example: 'Nguyễn Văn A' })
  @IsString()
  @MinLength(2)
  name!: string;
}


