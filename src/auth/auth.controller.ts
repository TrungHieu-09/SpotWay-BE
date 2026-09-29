import { Body, Controller, Get, Post, Query, Redirect, Req, Res, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { Request, Response } from 'express';
import { Public } from '../common/public.decorator';
import { AuthService } from './auth.service';
import { LoginDto, OAuthExchangeDto, RefreshDto, RegisterDto } from './dto';
import { ApiAuthTokenResponse, ApiEnvelopeResponse, ApiStandardErrors } from '../common/swagger';
@ApiTags('Authentication') @Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}
  @Public() @Post('register') @ApiOperation({ summary: 'Register a Guest account' }) @ApiAuthTokenResponse(201, 'Guest registered successfully') @ApiStandardErrors() register(@Body() dto: RegisterDto) { return this.auth.register(dto.email, dto.password); }
  @Public() @Post('login') @ApiOperation({ summary: 'Login with email and password' }) @ApiAuthTokenResponse(201, 'Login successful') @ApiStandardErrors() login(@Body() dto: LoginDto) { return this.auth.login(dto.email, dto.password); }
  @Public() @Post('refresh') @ApiOperation({ summary: 'Rotate a refresh token pair' }) @ApiAuthTokenResponse(201, 'Token pair refreshed successfully') @ApiStandardErrors() refresh(@Body() dto: RefreshDto) { return this.auth.refresh(dto.refreshToken); }
  @Public() @Post('logout') @ApiOperation({ summary: 'Revoke a refresh token' }) @ApiEnvelopeResponse(201, 'Logout successful', { type: 'object', properties: { loggedOut: { type: 'boolean', example: true } } }) @ApiStandardErrors() logout(@Body() dto: RefreshDto) { return this.auth.logout(dto.refreshToken); }
  @Public() @Get('google') @UseGuards(AuthGuard('google')) @ApiOperation({ summary: 'Start Google OAuth in a browser' }) @ApiResponse({ status: 302, description: 'Redirects to Google consent screen' }) google() { return; }
  @Public() @Get('google/callback') @UseGuards(AuthGuard('google')) @ApiOperation({ summary: 'Google OAuth callback' }) @ApiResponse({ status: 302, description: 'Redirects to frontend callback with a one-time code' }) async googleCallback(@Req() request: Request, @Res() response: Response) {
    const code = await this.auth.googleLogin(request.user as { googleId: string; email?: string; emailVerified: boolean });
    const target = new URL(process.env.FRONTEND_OAUTH_CALLBACK_URL || 'http://localhost:5173/auth/callback'); target.searchParams.set('code', code); return response.redirect(target.toString());
  }
  @Public() @Post('oauth/exchange') @ApiOperation({ summary: 'Exchange one-time OAuth code for JWT tokens' }) @ApiAuthTokenResponse(201, 'OAuth exchange successful') @ApiStandardErrors() exchange(@Body() dto: OAuthExchangeDto) { return this.auth.exchangeCode(dto.code); }
}
