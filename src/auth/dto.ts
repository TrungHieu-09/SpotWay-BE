import { IsEmail, IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
export class RegisterDto { @ApiProperty({ format: 'email', example: 'guest@example.com' }) @IsEmail() email!: string; @ApiProperty({ format: 'password', minLength: 8, example: 'Password123!' }) @IsString() @MinLength(8) password!: string; }
export class LoginDto { @ApiProperty({ format: 'email', example: 'admin@spotway.local' }) @IsEmail() email!: string; @ApiProperty({ format: 'password', example: 'ChangeMe123!' }) @IsString() password!: string; }
export class RefreshDto { @ApiProperty({ description: 'Refresh token returned by login or OAuth exchange' }) @IsString() refreshToken!: string; }
export class OAuthExchangeDto { @ApiProperty({ description: 'Single-use OAuth code returned to the frontend callback' }) @IsString() code!: string; }
