import { IsEmail, IsString, MinLength, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RegisterDto {
  @ApiProperty({ format: 'email', example: 'guest@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ format: 'password', minLength: 8, example: 'Password123!' })
  @IsString()
  @MinLength(8)
  password!: string;

  @ApiPropertyOptional({ example: 'Nguyen Van A' })
  @IsString()
  @IsOptional()
  fullName?: string;
}

export class VerifyEmailDto {
  @ApiProperty({ format: 'email', example: 'guest@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ description: '6-digit OTP code', example: '123456' })
  @IsString()
  @MinLength(6)
  code!: string;
}

export class ResendOtpDto {
  @ApiProperty({ format: 'email', example: 'guest@example.com' })
  @IsEmail()
  email!: string;
}

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


export class ForgotPasswordDto {
  @ApiProperty({ format: 'email', example: 'user@example.com' })
  @IsEmail()
  email!: string;
}

export class ResetPasswordDto {
  @ApiProperty({ description: 'Password reset token from email link' })
  @IsString()
  token!: string;

  @ApiProperty({ format: 'password', minLength: 8, example: 'NewPassword123!' })
  @IsString()
  @MinLength(8)
  newPassword!: string;
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

