import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { TenantStatus, User, UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../database/prisma.service';
import { MailService } from './mail.service';

type GoogleProfile = { googleId: string; email?: string; emailVerified: boolean };

@Injectable()
export class AuthService {
  private static readonly FORGOT_PASSWORD_MESSAGE =
    'Nếu tài khoản tồn tại trong hệ thống, liên kết đặt lại mật khẩu đã được gửi đến email của bạn.';

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly mail: MailService,
  ) {}

  // ── Step 1: Register → Send OTP via email ──────────────────────────────────
  async register(email: string, password: string, fullName?: string) {
    const normalized = email.trim().toLowerCase();

    if (
      await this.prisma.user.findFirst({
        where: { email: normalized, deletedAt: null },
      })
    ) {
      throw new ConflictException({
        code: 'EMAIL_EXISTS',
        message: 'Email is already registered',
      });
    }

    const code = this.generateOtp();
    const codeHash = this.hashCode(code);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    // Remove any previous unused OTPs for this email
    await this.prisma.emailOtp.deleteMany({
      where: { email: normalized, usedAt: null },
    });

    // Store hashed OTP + pending user data. The password is only ever kept as a bcrypt hash.
    await this.prisma.emailOtp.create({
      data: {
        email: normalized,
        codeHash,
        fullName: fullName?.trim() || null,
        password: await bcrypt.hash(password, 12),
        expiresAt,
      },
    });

    // Send real email
    await this.mail.sendOtp(normalized, code, fullName);

    return {
      message: 'Mã xác thực đã được gửi tới email của bạn.',
      email: normalized,
    };
  }

  // ── Step 2: Verify OTP → Issue tokens ─────────────────────────────────────
  async verifyEmail(email: string, code: string) {
    const normalized = email.trim().toLowerCase();

    const otpEntry = await this.prisma.emailOtp.findFirst({
      where: { email: normalized, usedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    if (!otpEntry) {
      throw new BadRequestException({
        code: 'OTP_NOT_FOUND',
        message: 'Không tìm thấy mã xác thực. Vui lòng đăng ký lại.',
      });
    }

    if (otpEntry.expiresAt < new Date()) {
      throw new BadRequestException({
        code: 'CODE_EXPIRED',
        message: 'Mã xác thực đã hết hạn. Vui lòng gửi lại mã mới.',
      });
    }

    const isValid = await bcrypt.compare(code, otpEntry.codeHash).catch(() => false)
      || this.hashCode(code) === otpEntry.codeHash;

    if (!isValid) {
      throw new BadRequestException({
        code: 'INVALID_CODE',
        message: 'Mã xác thực không chính xác. Vui lòng kiểm tra lại.',
      });
    }

    // Mark OTP as used and drop the stored password material: it is no longer needed.
    await this.prisma.emailOtp.update({
      where: { id: otpEntry.id },
      data: { usedAt: new Date(), password: null },
    });

    // Create the user now
    const user = await this.prisma.user.create({
      data: {
        email: normalized,
        passwordHash: await this.toPasswordHash(otpEntry.password),
        role: UserRole.GUEST,
      },
    });

    return this.issueTokens(user);
  }

  // ── Resend OTP ─────────────────────────────────────────────────────────────
  async resendOtp(email: string) {
    const normalized = email.trim().toLowerCase();

    // Check user doesn't already exist as verified
    const existingUser = await this.prisma.user.findFirst({
      where: { email: normalized, deletedAt: null },
    });
    if (existingUser) {
      throw new ConflictException({
        code: 'EMAIL_EXISTS',
        message: 'Email này đã được xác thực. Vui lòng đăng nhập.',
      });
    }

    const existing = await this.prisma.emailOtp.findFirst({
      where: { email: normalized, usedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    const code = this.generateOtp();
    const codeHash = this.hashCode(code);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    await this.prisma.emailOtp.deleteMany({
      where: { email: normalized, usedAt: null },
    });

    await this.prisma.emailOtp.create({
      data: {
        email: normalized,
        codeHash,
        fullName: existing?.fullName || null,
        password: existing?.password || null,
        expiresAt,
      },
    });

    await this.mail.sendOtp(normalized, code, existing?.fullName || undefined);

    return {
      message: 'Mã xác thực mới đã được gửi tới email của bạn.',
      email: normalized,
    };
  }

  // ── Existing methods ───────────────────────────────────────────────────────
  async login(email: string, password: string) {
    const user = await this.prisma.user.findFirst({
      where: { email: email.trim().toLowerCase(), deletedAt: null },
      include: { tenant: true },
    });
    if (
      !user?.passwordHash ||
      !(await bcrypt.compare(password, user.passwordHash))
    ) {
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password',
      });
    }
    this.assertTenantActive(user);
    return this.issueTokens(user);
  }

  async refresh(refreshToken: string) {
    let payload: { sub: string; sid: string };
    try {
      payload = await this.jwt.verifyAsync(refreshToken, {
        secret: process.env.JWT_REFRESH_SECRET,
      });
    } catch {
      throw new UnauthorizedException({
        code: 'INVALID_REFRESH_TOKEN',
        message: 'Invalid refresh token',
      });
    }
    const session = await this.prisma.refreshSession.findUnique({
      where: { id: payload.sid },
      include: { user: { include: { tenant: true } } },
    });
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt < new Date() ||
      !(await bcrypt.compare(refreshToken, session.tokenHash))
    ) {
      throw new UnauthorizedException({
        code: 'INVALID_REFRESH_TOKEN',
        message: 'Refresh token has been revoked or expired',
      });
    }
    this.assertTenantActive(session.user);
    await this.prisma.refreshSession.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });
    return this.issueTokens(session.user);
  }

  async logout(refreshToken: string) {
    try {
      const payload = await this.jwt.verifyAsync<{ sid: string }>(
        refreshToken,
        { secret: process.env.JWT_REFRESH_SECRET },
      );
      await this.prisma.refreshSession.updateMany({
        where: { id: payload.sid, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    } catch {
      /* logout remains idempotent */
    }
    return { loggedOut: true };
  }

  async forgotPassword(email: string) {
    const normalized = email.trim().toLowerCase();
    const user = await this.prisma.user.findFirst({
      where: { email: normalized, deletedAt: null },
    });

    // Same response whether or not the account exists, so the endpoint cannot be used to probe emails.
    if (!user) {
      return { message: AuthService.FORGOT_PASSWORD_MESSAGE };
    }

    await this.prisma.emailOtp.deleteMany({
      where: { email: normalized, usedAt: null },
    });

    const resetToken = randomBytes(32).toString('hex');
    const tokenHash = this.hashCode(resetToken);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 mins

    await this.prisma.emailOtp.create({
      data: {
        email: normalized,
        codeHash: tokenHash,
        expiresAt,
      },
    });

    const frontendBase = process.env.FRONTEND_URL || 'http://localhost:5173';
    const resetUrl = `${frontendBase}/reset-password?token=${resetToken}&email=${encodeURIComponent(normalized)}`;

    await this.mail.sendPasswordReset(normalized, resetUrl);

    // The token must only travel by email: never return it in the response.
    return { message: AuthService.FORGOT_PASSWORD_MESSAGE };
  }

  async resetPassword(token: string, newPassword: string) {
    if (!token || !newPassword || newPassword.length < 8) {
      throw new BadRequestException({
        code: 'INVALID_REQUEST',
        message: 'Mật khẩu mới phải có tối thiểu 8 ký tự',
      });
    }

    const tokenHash = this.hashCode(token);
    const otpEntry = await this.prisma.emailOtp.findFirst({
      where: {
        codeHash: tokenHash,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
    });

    if (!otpEntry) {
      throw new BadRequestException({
        code: 'INVALID_TOKEN',
        message: 'Liên kết đặt lại mật khẩu không hợp lệ hoặc đã hết hạn. Vui lòng yêu cầu liên kết mới.',
      });
    }

    const user = await this.prisma.user.findFirst({
      where: { email: otpEntry.email, deletedAt: null },
    });

    if (!user) {
      throw new NotFoundException({
        code: 'USER_NOT_FOUND',
        message: 'Không tìm thấy tài khoản người dùng',
      });
    }

    await this.prisma.emailOtp.update({
      where: { id: otpEntry.id },
      data: { usedAt: new Date() },
    });

    const newHash = await bcrypt.hash(newPassword, 12);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: newHash },
    });

    await this.prisma.refreshSession.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    return {
      success: true,
      message: 'Đặt lại mật khẩu thành công. Bạn có thể đăng nhập ngay với mật khẩu mới.',
    };
  }

  async changePassword(userId: string, currentPassword?: string, newPassword?: string) {
    if (!newPassword || newPassword.length < 8) {
      throw new BadRequestException({
        code: 'INVALID_PASSWORD',
        message: 'Mật khẩu mới phải có tối thiểu 8 ký tự',
      });
    }

    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
    });

    if (!user) {
      throw new NotFoundException({
        code: 'USER_NOT_FOUND',
        message: 'Không tìm thấy tài khoản người dùng',
      });
    }

    // If the user already has a password set, currentPassword is required and must match
    if (user.passwordHash) {
      if (!currentPassword) {
        throw new BadRequestException({
          code: 'CURRENT_PASSWORD_REQUIRED',
          message: 'Vui lòng nhập mật khẩu hiện tại',
        });
      }
      const isMatch = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!isMatch) {
        throw new BadRequestException({
          code: 'INCORRECT_CURRENT_PASSWORD',
          message: 'Mật khẩu hiện tại không chính xác',
        });
      }
    }

    const newHash = await bcrypt.hash(newPassword, 12);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: newHash },
    });

    return {
      success: true,
      message: 'Mật khẩu đã được cập nhật thành công.',
    };
  }

  async googleLogin(profile: GoogleProfile) {
    if (!profile.emailVerified || !profile.email) {
      throw new ForbiddenException({
        code: 'GOOGLE_EMAIL_UNVERIFIED',
        message: 'Google account must have a verified email',
      });
    }
    const email = profile.email.toLowerCase();
    const user = await this.prisma.user.upsert({
      where: { email },
      update: { googleId: profile.googleId },
      create: {
        email,
        googleId: profile.googleId,
        role: UserRole.GUEST,
      },
      include: { tenant: true },
    });
    this.assertTenantActive(user);
    const code = randomBytes(32).toString('base64url');
    await this.prisma.oAuthCode.create({
      data: {
        userId: user.id,
        codeHash: this.hashCode(code),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    return code;
  }

  async exchangeCode(code: string) {
    const entry = await this.prisma.oAuthCode.findFirst({
      where: {
        codeHash: this.hashCode(code),
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    if (!entry) {
      throw new UnauthorizedException({
        code: 'INVALID_OAUTH_CODE',
        message: 'OAuth code is invalid or expired',
      });
    }
    const claimed = await this.prisma.oAuthCode.updateMany({
      where: { id: entry.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (claimed.count !== 1) {
      throw new UnauthorizedException({
        code: 'INVALID_OAUTH_CODE',
        message: 'OAuth code is invalid or expired',
      });
    }
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: entry.userId },
      include: { tenant: true },
    });
    return this.issueTokens(user);
  }

  private assertTenantActive(
    user: User & { tenant?: { status: TenantStatus } | null },
  ) {
    if (user.tenant?.status === TenantStatus.SUSPENDED) {
      throw new ForbiddenException({
        code: 'TENANT_SUSPENDED',
        message: 'Tenant is suspended',
      });
    }
  }

  /**
   * Workspaces are no longer created for free: an Owner buys a plan first (see BillingService),
   * and the workspace is provisioned when that order is paid. This stays idempotent for users
   * who already own a workspace and otherwise tells the client that payment is required.
   */
  async createWorkspace(userId: string) {
    const currentUser = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { tenant: true },
    });
    if (currentUser.tenantId && currentUser.tenant && !currentUser.tenant.deletedAt) {
      return this.issueSession(userId);
    }
    throw new HttpException(
      {
        code: 'PAYMENT_REQUIRED',
        message: 'Bạn cần mua gói dịch vụ trước khi tạo workspace.',
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }

  /** Fresh tokens plus the user/tenant payload the frontend stores after login-like events. */
  async issueSession(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { tenant: true },
    });
    const tokens = await this.issueTokens(user);
    const tenant =
      user.tenant && !user.tenant.deletedAt
        ? {
            id: user.tenant.id,
            name: user.tenant.name,
            subdomain: user.tenant.subdomain,
            status: user.tenant.status.toLowerCase(),
            planId: user.tenant.servicePackage,
            planExpiresAt: user.tenant.planExpiresAt?.toISOString() ?? null,
            createdAt: user.tenant.createdAt.toISOString(),
          }
        : null;
    return {
      tenant,
      user: {
        id: user.id,
        email: user.email,
        name: user.email.split('@')[0],
        role: user.role.toLowerCase(),
        tenantId: tenant?.id ?? null,
        tenant,
      },
      ...tokens,
    };
  }

  /**
   * OTP rows hold a bcrypt hash. Rows written before that change still hold the plain password, so hash those
   * here; a missing password gets an unusable hash so the account can only be entered via password reset.
   */
  private async toPasswordHash(stored: string | null) {
    if (stored && /^\$2[aby]\$\d{2}\$/.test(stored)) return stored;
    return bcrypt.hash(stored ?? randomBytes(32).toString('hex'), 12);
  }

  private generateOtp(): string {
    return String(Math.floor(100000 + Math.random() * 900000));
  }

  private hashCode(code: string) {
    return createHash('sha256').update(code).digest('hex');
  }

  private parseTtl(value: string | undefined, fallbackSeconds: number) {
    const match = value?.trim().match(/^(\d+)\s*(s|m|h|d)$/i);
    if (!match) return fallbackSeconds;
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    return amount * ({ s: 1, m: 60, h: 3600, d: 86400 }[unit] ?? 1);
  }

  private async issueTokens(user: User) {
    const accessTtl = this.parseTtl(process.env.JWT_ACCESS_TTL, 900);
    const refreshTtl = this.parseTtl(process.env.JWT_REFRESH_TTL, 604800);
    const accessToken = await this.jwt.signAsync(
      { userId: user.id, role: user.role, tenantId: user.tenantId },
      { secret: process.env.JWT_ACCESS_SECRET, expiresIn: accessTtl },
    );
    const sessionId = randomBytes(16).toString('hex');
    const refreshToken = await this.jwt.signAsync(
      { sub: user.id, sid: sessionId },
      { secret: process.env.JWT_REFRESH_SECRET, expiresIn: refreshTtl },
    );
    await this.prisma.refreshSession.create({
      data: {
        id: sessionId,
        userId: user.id,
        tokenHash: await bcrypt.hash(refreshToken, 12),
        expiresAt: new Date(Date.now() + refreshTtl * 1000),
      },
    });
    return { accessToken, refreshToken, tokenType: 'Bearer' };
  }
}
