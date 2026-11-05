import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  BadRequestException,
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

    // Store hashed OTP + pending user data
    await this.prisma.emailOtp.create({
      data: {
        email: normalized,
        codeHash,
        fullName: fullName?.trim() || null,
        password,
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

    // Mark OTP as used
    await this.prisma.emailOtp.update({
      where: { id: otpEntry.id },
      data: { usedAt: new Date() },
    });

    // Create the user now
    const user = await this.prisma.user.create({
      data: {
        email: normalized,
        passwordHash: await bcrypt.hash(otpEntry.password || '', 12),
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
