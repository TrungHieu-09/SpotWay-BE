import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Redirect,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import {
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiBearerAuth,
} from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { Request, Response } from "express";
import { Public } from "../common/public.decorator";
import { CurrentUser } from "../common/current-user.decorator";
import { AuthUser } from "../common/auth.types";
import { AuthService } from "./auth.service";
import {
  LoginDto,
  OAuthExchangeDto,
  RefreshDto,
  ChangePasswordDto,
} from "./dto";
import {
  ApiAuthTokenResponse,
  ApiEnvelopeResponse,
  ApiStandardErrors,
} from "../common/swagger";
import { PrismaService } from "../database/prisma.service";

@ApiTags("Authentication")
@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @Post("login")
  @ApiOperation({ summary: "Login with email and password" })
  @ApiAuthTokenResponse(201, "Login successful")
  @ApiStandardErrors()
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

  @Public()
  @Post("refresh")
  @ApiOperation({ summary: "Rotate a refresh token pair" })
  @ApiAuthTokenResponse(201, "Token pair refreshed successfully")
  @ApiStandardErrors()
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @Public()
  @Post("logout")
  @ApiOperation({ summary: "Revoke a refresh token" })
  @ApiEnvelopeResponse(201, "Logout successful", {
    type: "object",
    properties: { loggedOut: { type: "boolean", example: true } },
  })
  @ApiStandardErrors()
  logout(@Body() dto: RefreshDto) {
    return this.auth.logout(dto.refreshToken);
  }

  @Post("change-password")
  @ApiBearerAuth("bearerAuth")
  @ApiOperation({ summary: "Change or set user password" })
  @ApiStandardErrors()
  changePassword(
    @Req() request: Request & { user?: AuthUser },
    @Body() dto: ChangePasswordDto,
  ) {
    const authUser = request.user!;
    return this.auth.changePassword(
      authUser.userId,
      dto.currentPassword,
      dto.newPassword,
    );
  }

  @Get("me")
  @ApiBearerAuth("bearerAuth")
  @ApiOperation({ summary: "Get current authenticated user profile" })
  @ApiStandardErrors()
  async me(@Req() request: Request & { user?: AuthUser }) {
    const authUser = request.user!;
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: authUser.userId },
      include: { tenant: true },
    });
    return {
      id: user.id,
      email: user.email,
      name: user.email.split("@")[0],
      role: user.role.toLowerCase() as string,
      tenantId: user.tenantId,
      status: "active",
      mustChangePassword: false,
      createdAt: user.createdAt,
      tenant: user.tenant
        ? {
            id: user.tenant.id,
            name: user.tenant.name,
            subdomain: user.tenant.subdomain,
            status: user.tenant.status.toLowerCase(),
          }
        : null,
    };
  }

  @Public()
  @Get("google")
  @UseGuards(AuthGuard("google"))
  @ApiOperation({ summary: "Start Google OAuth in a browser" })
  @ApiResponse({
    status: 302,
    description: "Redirects to Google consent screen",
  })
  google() {
    return;
  }

  @Public()
  @Get("google/callback")
  @UseGuards(AuthGuard("google"))
  @ApiOperation({ summary: "Google OAuth callback" })
  @ApiResponse({
    status: 302,
    description: "Redirects to frontend callback with a one-time code",
  })
  async googleCallback(@Req() request: Request, @Res() response: Response) {
    const code = await this.auth.googleLogin(
      request.user as {
        googleId: string;
        email?: string;
        emailVerified: boolean;
      },
    );
    const target = new URL(
      process.env.FRONTEND_OAUTH_CALLBACK_URL ||
        "http://localhost:5173/auth/callback",
    );
    target.searchParams.set("code", code);
    return response.redirect(target.toString());
  }

  @Public()
  @Post("oauth/exchange")
  @ApiOperation({ summary: "Exchange one-time OAuth code for JWT tokens" })
  @ApiAuthTokenResponse(201, "OAuth exchange successful")
  @ApiStandardErrors()
  exchange(@Body() dto: OAuthExchangeDto) {
    return this.auth.exchangeCode(dto.code);
  }
}
