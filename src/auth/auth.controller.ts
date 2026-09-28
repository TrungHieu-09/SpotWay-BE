import { Body, Controller, Get, Post, Query, Redirect, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { Request, Response } from 'express';
import { Public } from '../common/public.decorator';
import { AuthService } from './auth.service';
import { LoginDto, OAuthExchangeDto, RefreshDto, RegisterDto } from './dto';
@ApiTags('Auth') @Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}
  @Public() @Post('register') register(@Body() dto: RegisterDto) { return this.auth.register(dto.email, dto.password); }
  @Public() @Post('login') login(@Body() dto: LoginDto) { return this.auth.login(dto.email, dto.password); }
  @Public() @Post('refresh') refresh(@Body() dto: RefreshDto) { return this.auth.refresh(dto.refreshToken); }
  @Public() @Post('logout') logout(@Body() dto: RefreshDto) { return this.auth.logout(dto.refreshToken); }
  @Public() @Get('google') @UseGuards(AuthGuard('google')) google() { return; }
  @Public() @Get('google/callback') @UseGuards(AuthGuard('google')) async googleCallback(@Req() request: Request, @Res() response: Response) {
    const code = await this.auth.googleLogin(request.user as { googleId: string; email?: string; emailVerified: boolean });
    const target = new URL(process.env.FRONTEND_OAUTH_CALLBACK_URL || 'http://localhost:5173/auth/callback'); target.searchParams.set('code', code); return response.redirect(target.toString());
  }
  @Public() @Post('oauth/exchange') exchange(@Body() dto: OAuthExchangeDto) { return this.auth.exchangeCode(dto.code); }
}
