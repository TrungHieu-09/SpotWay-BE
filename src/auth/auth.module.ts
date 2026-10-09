import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { APP_GUARD } from '@nestjs/core';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { RolesGuard } from '../common/roles.guard';
import { TenantStatusGuard } from '../common/tenant-status.guard';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { GoogleStrategy } from './google.strategy';
@Global() @Module({ imports: [JwtModule.register({}), PassportModule], controllers: [AuthController], providers: [AuthService, GoogleStrategy, { provide: APP_GUARD, useClass: JwtAuthGuard }, { provide: APP_GUARD, useClass: TenantStatusGuard }, { provide: APP_GUARD, useClass: RolesGuard }], exports: [JwtModule, AuthService] }) export class AuthModule {}
